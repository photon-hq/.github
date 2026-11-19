import hashlib
import io
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import baseline


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


if __name__ == "__main__":
    unittest.main()
