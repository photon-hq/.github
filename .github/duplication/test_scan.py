import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from scan import added, detect, grouped


class ClassificationTest(unittest.TestCase):
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
