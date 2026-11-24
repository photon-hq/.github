import hashlib
import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import baseline


def make_record(key_byte, payload_byte=0):
    return bytes([key_byte]) * 16 + bytes([payload_byte]) * (baseline.RECORD - 16)


RUN = {
    "id": 2, "event": "push", "status": "completed", "conclusion": "success", "path": baseline.WORKFLOW,
    "repository": {"id": 7}, "head_repository": {"id": 7}, "head_branch": "main", "head_sha": "a" * 40,
    "display_title": "Seed vectors on refs/heads/main", "run_attempt": 3,
}
DATA = baseline.HEADER + bytes(baseline.RECORD)


class BaselineTest(unittest.TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        event = root / "event"
        event.write_text('{"repository":{"default_branch":"main"}}')
        self.output = root / "outputs"
        self.output.touch()
        self.enterContext(patch.dict(os.environ, {
            "JSCPD_VERSION": "5.4.3", "MODEL": "CodeRankEmbed", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64",
            "RUNNER_TEMP": str(root), "JSCPD_CACHE_DIR": str(root / "cache"), "GITHUB_OUTPUT": str(self.output),
            "GITHUB_REPOSITORY": "example/repo", "GITHUB_RUN_ID": "9", "GITHUB_RUN_ATTEMPT": "3",
            "GITHUB_REPOSITORY_ID": "7", "GITHUB_EVENT_PATH": str(event), "GITHUB_TOKEN": "unit-test",
        }))

    def test_eligible_run(self):
        self.assertTrue(baseline.eligible(RUN, 7, "main", 9))
        for change in ({"event": "pull_request"}, {"event": "workflow_run"}, {"id": 9}, {"path": "another.yml"},
                       {"head_branch": "topic"}, {"display_title": "Seed vectors on refs/tags/main"},
                       {"status": "in_progress"}, {"conclusion": "cancelled"}, {"head_sha": "main"},
                       {"repository": {"id": 42}}, {"head_repository": {"id": 42}}, {"head_repository": None}):
            with self.subTest(change=change):
                self.assertFalse(baseline.eligible({**RUN, **change}, 7, "main", 9))

    def test_trusted_commit_requires_default_history_and_the_same_caller_blob(self):
        with patch("baseline.subprocess.run") as check, patch("baseline.subprocess.check_output") as blob:
            check.return_value.returncode = 1
            self.assertFalse(baseline.trusted_commit(RUN["head_sha"], "main"))
            blob.assert_not_called()
            self.assertEqual(check.call_args.args[0][-2:], [RUN["head_sha"], "refs/remotes/origin/main"])
            check.return_value.returncode = 0
            blob.side_effect = [b"old", b"trusted", b"trusted", b"trusted"]
            self.assertFalse(baseline.trusted_commit(RUN["head_sha"], "main"))
            self.assertTrue(baseline.trusted_commit(RUN["head_sha"], "main"))

    def test_same_named_artifact_has_to_belong_to_the_verified_attempt_and_commit(self):
        owner = dict(id=2, head_sha=RUN["head_sha"], head_branch="main", repository_id=7, head_repository_id=7)
        artifact = dict(name=baseline.artifact_name(3), expired=False, size_in_bytes=len(DATA), workflow_run=owner,
                        digest="sha256:" + "0" * 64)
        self.assertTrue(baseline.compatible(artifact, RUN, 7))
        for field, value in (("id", 4), ("head_sha", "b" * 40), ("head_branch", "other"),
                             ("repository_id", 8), ("head_repository_id", 8)):
            self.assertFalse(baseline.compatible({**artifact, "workflow_run": {**owner, field: value}}, RUN, 7))
        for field, value in (("expired", True), ("size_in_bytes", len(DATA) + 1),
                             ("digest", None), ("name", baseline.artifact_name(2))):
            self.assertFalse(baseline.compatible({**artifact, field: value}, RUN, 7))

    def test_stage_and_restore_only_raw_native_file(self):
        native = baseline.native_file()
        native.parent.mkdir(parents=True)
        native.write_bytes(DATA)
        (native.parent / "not-source-to-upload.txt").touch()
        baseline.stage()
        artifact_file = Path(self.output.read_text().strip().removeprefix("file="))
        self.assertEqual(artifact_file.read_bytes(), DATA)
        self.assertEqual(artifact_file.name, "jscpd-vectors-v1-Linux-X64-5.4.3-CodeRankEmbed-a3.bin")
        native.unlink()
        self.output.write_text("")
        calls = []

        def api(request, timeout):
            self.assertNotIn("Authorization", request.headers)
            self.assertIn("Authorization", request.unredirected_hdrs)
            url = urlsplit(request.full_url)
            self.assertEqual(url.hostname, "api.github.com")
            prefix = "/repos/example/repo/actions/"
            self.assertTrue(url.path.startswith(prefix))
            path = url.path.removeprefix(prefix)
            calls.append(path)
            if path == "workflows/seed-duplication-vectors.yml/runs":
                self.assertEqual(parse_qs(url.query)["branch"], ["main"])
                # Ignore a PR with the same file name and fall through a damaged latest push.
                return io.BytesIO(json.dumps({"workflow_runs": [{**RUN, "event": "pull_request"},
                                                              {**RUN, "id": 4}, RUN]}).encode())
            if path in ("runs/4/artifacts", "runs/2/artifacts"):
                self.assertEqual(parse_qs(url.query)["name"], [artifact_file.name])
                run_id = int(path.split("/")[1])
                owner = dict(id=run_id, head_sha=RUN["head_sha"], head_branch="main", repository_id=7,
                             head_repository_id=7)
                digest = "sha256:" + hashlib.sha256(DATA).hexdigest()
                artifact = dict(id=run_id + 100, name=artifact_file.name, size_in_bytes=len(DATA),
                                expired=False, workflow_run=owner, digest=digest)
                return io.BytesIO(json.dumps({"artifacts": [artifact]}).encode())
            if path == "artifacts/104/zip":
                return io.BytesIO(DATA[:-1] + b"X")
            self.assertEqual(path, "artifacts/102/zip")
            return io.BytesIO(artifact_file.read_bytes())

        with patch("baseline.urlopen", side_effect=api), patch("baseline.trusted_commit", return_value=True):
            baseline.restore()
        self.assertEqual(self.output.read_text(), "restored=true\n")
        self.assertEqual(native.read_bytes(), DATA)
        self.assertEqual(len(calls), 5)

    def test_rejects_truncated_oversized_and_foreign_layouts(self):
        for size in (0, len(baseline.HEADER), len(DATA) - 1, baseline.MAX_BYTES + 1):
            self.assertFalse(baseline.valid_size(size))
        native = baseline.native_file()
        native.parent.mkdir(parents=True)
        for bad in (b"PK" + DATA[2:], b"JSCPDEM1" + bytes(4) + DATA[12:]):
            native.write_bytes(bad)
            with self.assertRaises(ValueError):
                baseline.stage()
            self.assertEqual(self.output.read_text(), "")

    def test_pr_cache_restore_merge_and_stage(self):
        script = Path(baseline.__file__).resolve()
        native = baseline.native_file()
        staged = baseline.pr_file()

        # Missing PR cache and missing native file are clean no-ops.
        baseline.apply_pr()
        baseline.stage_pr()
        self.assertEqual(self.output.read_text(), "")
        self.assertFalse(native.exists())
        self.assertFalse(staged.exists())

        # Unseeded repo: apply-pr restores and deduplicates PR cache records.
        rec1 = make_record(1, 10)
        rec1_dup = make_record(1, 99)
        rec2 = make_record(2, 20)
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(baseline.HEADER + rec1 + rec1_dup + rec2)
        subprocess.run([sys.executable, "-I", script, "apply-pr"], check=True)
        self.assertEqual(self.output.read_text(), "restored=true\n")
        self.assertEqual(native.read_bytes(), baseline.HEADER + rec1 + rec2)

        # Seeded repo + PR cache: seed records stay first (including hash collisions), unseen PR records append.
        self.output.write_text("")
        seed_rec1 = make_record(1, 11)
        seed_rec3 = make_record(3, 33)
        pr_rec4 = make_record(4, 44)
        native.write_bytes(baseline.HEADER + seed_rec1 + seed_rec3)
        staged.write_bytes(baseline.HEADER + rec1_dup + rec2 + pr_rec4)
        baseline.apply_pr()
        self.assertEqual(self.output.read_text(), "restored=true\n")
        self.assertEqual(native.read_bytes(), baseline.HEADER + seed_rec1 + seed_rec3 + rec2 + pr_rec4)

        # stage-pr validates native_file() and copies it back to pr_file().
        self.output.write_text("")
        staged.unlink()
        subprocess.run([sys.executable, "-I", script, "stage-pr"], check=True)
        self.assertEqual(self.output.read_text(), f"file={staged}\n")
        self.assertEqual(staged.read_bytes(), native.read_bytes())

    def test_merge_vectors_respects_max_bytes_cap(self):
        rec_a = make_record(1, 1)
        rec_b = make_record(2, 2)
        rec_c = make_record(3, 3)
        rec_d = make_record(4, 4)
        with patch.object(baseline, "MAX_BYTES", len(baseline.HEADER) + 3 * baseline.RECORD):
            merged = baseline.merge_vectors(
                baseline.HEADER + rec_a + rec_b,
                baseline.HEADER + rec_a + rec_c + rec_d,
            )
        self.assertEqual(merged, baseline.HEADER + rec_a + rec_b + rec_c)

    def test_pr_cache_rejects_corrupt_oversized_and_symlink_inputs_without_clobbering_seed(self):
        native = baseline.native_file()
        native.parent.mkdir(parents=True, exist_ok=True)
        seed_bytes = baseline.HEADER + make_record(7, 7)
        native.write_bytes(seed_bytes)
        staged = baseline.pr_file()
        staged.parent.mkdir(parents=True, exist_ok=True)

        for bad in (b"", baseline.HEADER, DATA[:-1], b"BADMAGIC" + DATA[8:]):
            staged.write_bytes(bad)
            with self.assertRaises(ValueError):
                baseline.apply_pr()
            self.assertEqual(native.read_bytes(), seed_bytes)
            self.assertEqual(self.output.read_text(), "")

        with patch.object(baseline, "MAX_BYTES", len(baseline.HEADER) + baseline.RECORD):
            staged.write_bytes(baseline.HEADER + make_record(1) + make_record(2))
            with self.assertRaises(ValueError):
                baseline.apply_pr()
            self.assertEqual(native.read_bytes(), seed_bytes)

        # Symlinked vectors.bin (pointing to valid file and dangling) must be rejected.
        elsewhere = staged.parent.parent / "elsewhere.bin"
        elsewhere.write_bytes(DATA)
        staged.unlink()
        staged.symlink_to(elsewhere)
        with self.assertRaises(ValueError):
            baseline.apply_pr()
        elsewhere.unlink()
        with self.assertRaises(ValueError):
            baseline.apply_pr()
        self.assertEqual(native.read_bytes(), seed_bytes)

        # Symlinked parent directory must be rejected on both apply_pr and stage_pr.
        staged.unlink()
        staged.parent.rmdir()
        real_dir = Path(os.environ["RUNNER_TEMP"]) / "real-dir"
        real_dir.mkdir()
        (real_dir / "vectors.bin").write_bytes(DATA)
        staged.parent.symlink_to(real_dir)
        with self.assertRaises(ValueError):
            baseline.apply_pr()
        with self.assertRaises(ValueError):
            baseline.stage_pr()
        self.assertEqual(native.read_bytes(), seed_bytes)


if __name__ == "__main__":
    unittest.main()
