import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import baseline
from scan import added, detect, grouped, miss_limit


class ClassificationTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("jscpd"), "requires jscpd 5.4.3 on PATH")
    def test_structural_schedule_with_no_exact_sources(self):
        fixtures = Path(__file__).resolve().parents[1] / "tests/fixtures"
        script = Path(__file__).with_name("scan.py").resolve()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "source"
            subprocess.run(["git", "init", "-q", root], check=True)
            env = {**os.environ, "EMAIL": "fixture@example.invalid"}
            def commit():
                subprocess.run(["git", "add", "."], cwd=root, check=True)
                subprocess.run(["git", "commit", "-qm", "fixture"], cwd=root, env=env, check=True)
                return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
            def scan(mode):
                output = Path(env["GITHUB_OUTPUT"])
                output.write_text("")
                subprocess.run([sys.executable, "-I", script, mode], cwd=root, env=env, check=True)
                return dict(line.split("=", 1) for line in output.read_text().splitlines())

            (root / ".jscpd.json").write_text('{"minTokens":10000}')
            shutil.copyfile(fixtures / "spectral-ledger.js.txt", root / "original.js")
            base = commit()
            shutil.copyfile(fixtures / "spectral-ledger-alt.js.txt", root / "candidate.js")
            code_head = commit()
            for name, parent, state in (("code", base, "run"), ("docs", code_head, "unchanged")):
                if name == "docs":
                    (root / "README.md").write_text("Docs only.")
                    commit()
                runner = Path(tmp) / name
                bin_dir = runner / "jscpd/node_modules/.bin"
                bin_dir.mkdir(parents=True)
                (bin_dir / "jscpd").symlink_to(shutil.which("jscpd"))
                env.update(BASE=parent, RUNNER_TEMP=str(runner), GITHUB_OUTPUT=str(runner / "outputs"))
                exact = scan("exact")
                self.assertEqual(json.loads(exact["report"])["after"]["sources"], 0)
                self.assertEqual(exact["structural"], state)
                if exact["structural"] == "run":
                    ast = json.loads(scan("structural")["structural"])["ast"]
                    self.assertEqual(ast["count"], 1)
                    self.assertEqual(ast["rows"][0], [["candidate.js", 1, 14], ["original.js", 1, 14], 0.967])

    @unittest.skipUnless(shutil.which("jscpd"), "requires jscpd 5.4.3 on PATH")
    def test_relative_ignore_globs_do_not_exclude_the_base_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            tool = Path(tmp)
            bin_dir = tool / "node_modules/.bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "jscpd").symlink_to(shutil.which("jscpd"))
            (tool / "config.json").write_text(json.dumps({"ignore": ["**/base/**"], "minLines": 3, "minTokens": 12}))
            scans = []
            for side in ("base", "head"):
                root = tool / side
                subprocess.run(["git", "init", "-q", root], check=True)
                for name in ("a.ts", "b.ts"):
                    (root / name).write_text("function sum(values) {\n let total = 0;\n for (const v of values) total += v;\n return total;\n}\n")
                subprocess.run(["git", "add", "."], cwd=root, check=True)
                scans.append(detect("exact", tool, root, side, ["--kind", "exact"]))
            self.assertEqual(len(scans[0]), 1)
            self.assertEqual(added(*scans, {}), [])

    def test_old_and_renamed_pairs_do_not_mask_the_new_copy(self):
        old = [["original.ts", 1, 8], ["reader.ts", 2, 10]]
        moved = [["moved.ts", 15, 22], ["reader.ts", 2, 10]]
        third = [["added.ts", 1, 8], ["reader.ts", 2, 10]]
        record = lambda p: ("semantic", "same-content", p, 0.884)
        result = added([record(old)], [record(third), record(moved)], {"original.ts": "moved.ts"})
        self.assertEqual(result, [("semantic", third, 0.884)])

    def test_gap_subsumes_exact_fragments_but_not_other_file_pairs(self):
        gapped = [["a.ts", 1, 14], ["b.ts", 1, 15]]
        short = [["a.ts", 1, 7], ["b.ts", 1, 7]]
        other = [["a.ts", 1, 7], ["c.ts", 1, 7]]
        entries = [("exact", short, None), ("renamed", other, None), ("gap", gapped, 0.93), ("ast", gapped, 0.96)]
        groups = grouped(entries, ["exact", "renamed", "gap", "ast"])
        self.assertEqual([g["count"] for g in groups.values()], [0, 1, 1, 0])
        self.assertEqual(grouped([("semantic", short, 0.8)], ["semantic"], [gapped])["semantic"]["count"], 0)

    def test_semantic_miss_limits_and_embedded_output(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SAME_REPO", None)
            self.assertEqual(miss_limit(), 32)
        with patch.dict(os.environ, {"SAME_REPO": "false"}):
            self.assertEqual(miss_limit(), 32)
        with patch.dict(os.environ, {"SAME_REPO": "true"}):
            self.assertEqual(miss_limit(), 1500)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            subprocess.run(["git", "init", "-q", root], check=True)
            (root / "a.ts").write_text("export const a = 1;\n")
            subprocess.run(["git", "add", "."], cwd=root, check=True)

            tool = Path(tmp) / "tool"
            bin_dir = tool / "node_modules/.bin"
            bin_dir.mkdir(parents=True)
            (tool / "config.json").write_text("{}")
            fake_jscpd = bin_dir / "jscpd"
            fake_jscpd.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, pathlib, sys\n"
                "out = pathlib.Path(sys.argv[sys.argv.index('--output') + 1])\n"
                "out.mkdir(parents=True, exist_ok=True)\n"
                "(out / 'jscpd-report.sarif').write_text(json.dumps({'runs': [{'results': []}]}))\n"
                "sys.stderr.write(os.environ['FAKE_PROGRESS'])\n"
            )
            fake_jscpd.chmod(fake_jscpd.stat().st_mode | stat.S_IEXEC)
            outputs = Path(tmp) / "outputs"

            def run_detect(side, progress, same_repo=None):
                outputs.write_text("")
                env = {"GITHUB_OUTPUT": str(outputs), "FAKE_PROGRESS": progress}
                if same_repo is not None:
                    env["SAME_REPO"] = same_repo
                with patch.dict(os.environ, env, clear=False):
                    if same_repo is None:
                        os.environ.pop("SAME_REPO", None)
                    return detect("semantic", tool, root, side, ["--kind", "semantic"])

            # Cached scan does not emit embedded=true.
            run_detect("base", "Semantic clones (experimental): 40 functions, all embeddings cached (nomic-ai/CodeRankEmbed)\n")
            self.assertEqual(outputs.read_text(), "")

            # Fork/default allows 32 misses and emits embedded=true, but rejects 33 on both base and head.
            run_detect("base", "Semantic clones (experimental): embedding 32 of 40 functions with nomic-ai/CodeRankEmbed on this machine, the rest cached\n", "false")
            self.assertEqual(outputs.read_text(), "embedded=true\n")
            for side in ("base", "head"):
                with self.assertRaisesRegex(RuntimeError, f"{side}: exceeds the 32-function PR inference limit"):
                    run_detect(side, "Semantic clones (experimental): embedding 33 functions with nomic-ai/CodeRankEmbed on this machine\n", "false")
                self.assertEqual(outputs.read_text(), "semantic_state=limit\n")

            # Same-repo Blacksmith allows up to 1500 misses per side and rejects 1501.
            run_detect("base", "Semantic clones (experimental): embedding 1500 functions with nomic-ai/CodeRankEmbed on this machine\n", "true")
            self.assertEqual(outputs.read_text(), "embedded=true\n")
            with self.assertRaisesRegex(RuntimeError, "head: exceeds the 1500-function PR inference limit"):
                run_detect("head", "Semantic clones (experimental): embedding 1501 of 1600 functions with nomic-ai/CodeRankEmbed on this machine, the rest cached\n", "true")
            self.assertEqual(outputs.read_text(), "semantic_state=limit\n")

    def test_semantic_main_preserves_prior_and_base_vectors_under_isolated_python(self):
        script = Path(__file__).with_name("scan.py").resolve()

        def rec(byte_val):
            return bytes([byte_val]) * 16 + bytes([byte_val]) * (baseline.RECORD - 16)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "source"
            subprocess.run(["git", "init", "-q", root], check=True)
            git_env = {**os.environ, "EMAIL": "fixture@example.invalid"}
            (root / "a.js").write_text("export function alpha() { return 1; }\n")
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=root, env=git_env, check=True)
            base_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()

            (root / "a.js").write_text("export function beta() { return 2; }\n")
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "commit", "-qm", "head"], cwd=root, env=git_env, check=True)

            runner = Path(tmp) / "runner"
            tool = runner / "jscpd"
            bin_dir = tool / "node_modules/.bin"
            bin_dir.mkdir(parents=True)
            (tool / "config.json").write_text("{}")
            (tool / "coverage.json").write_text("[]")
            subprocess.run(["git", "worktree", "add", "--quiet", "--detach", str(tool / "base"), base_sha],
                           cwd=root, check=True)

            env = {
                **os.environ,
                "RUNNER_TEMP": str(runner),
                "JSCPD_CACHE_DIR": str(Path(tmp) / "cache"),
                "JSCPD_VERSION": "5.4.3",
                "MODEL": "CodeRankEmbed",
                "BASE": base_sha,
                "SAME_REPO": "true",
                "GITHUB_OUTPUT": str(Path(tmp) / "outputs"),
            }
            with patch.dict(os.environ, env):
                native = baseline.native_file()
            native.parent.mkdir(parents=True, exist_ok=True)
            # Prior cache holds rec(9); base rewrite drops rec(9), head sees rec(9) restored and rewrites only rec(2),
            # and final merge retains rec(2), rec(1), and rec(9).
            native.write_bytes(baseline.HEADER + rec(9))

            fake_jscpd = bin_dir / "jscpd"
            fake_jscpd.write_text(
                "#!/usr/bin/env python3\n"
                "import json, pathlib, sys\n"
                f"native = pathlib.Path({str(native)!r})\n"
                f"header = {baseline.HEADER!r}\n"
                f"rec1, rec2, rec9 = {rec(1)!r}, {rec(2)!r}, {rec(9)!r}\n"
                "out = pathlib.Path(sys.argv[sys.argv.index('--output') + 1])\n"
                "out.mkdir(parents=True, exist_ok=True)\n"
                "(out / 'jscpd-report.sarif').write_text(json.dumps({'runs': [{'results': []}]}))\n"
                "if out.name.endswith('-base'):\n"
                "    native.write_bytes(header + rec1)\n"
                "    sys.stderr.write('Semantic clones (experimental): embedding 1 functions with nomic-ai/CodeRankEmbed on this machine\\n')\n"
                "else:\n"
                "    assert rec9 in native.read_bytes(), 'prior vector should survive base rewrite'\n"
                "    native.write_bytes(header + rec2)\n"
                "    sys.stderr.write('Semantic clones (experimental): embedding 1 of 2 functions with nomic-ai/CodeRankEmbed on this machine, the rest cached\\n')\n"
            )
            fake_jscpd.chmod(fake_jscpd.stat().st_mode | stat.S_IEXEC)

            Path(env["GITHUB_OUTPUT"]).write_text("")
            subprocess.run([sys.executable, "-I", script, "semantic"], cwd=root, env=env, check=True)
            self.assertEqual(native.read_bytes(), baseline.HEADER + rec(2) + rec(1) + rec(9))
            output_lines = Path(env["GITHUB_OUTPUT"]).read_text().splitlines()
            self.assertIn("embedded=true", output_lines)


if __name__ == "__main__":
    unittest.main()
