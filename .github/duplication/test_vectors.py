"""RUN_JSCPD_VECTORS=1 python3 .github/duplication/test_vectors.py (pinned jscpd on PATH, weights installed)."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

SCAN = Path(__file__).resolve().with_name("scan.py")
FIXTURES = SCAN.parents[1] / "tests/fixtures"


def sample(name):
    return (FIXTURES / f"{name}.js.txt").read_text()


def git(cwd, *args):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True,
                                   env={**os.environ, "EMAIL": "fixture@example.invalid"}).strip()


def commit(repo):
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "fixture")
    return git(repo, "rev-parse", "HEAD")


@unittest.skipUnless(os.environ.get("RUN_JSCPD_VECTORS") == "1", "opt in with RUN_JSCPD_VECTORS=1")
class NativeVectorTest(unittest.TestCase):
    def setUp(self):
        cache = Path(os.environ.get("JSCPD_CACHE_DIR", Path.home() / ".cache/jscpd"))
        self.models = (cache / "models").resolve()
        revisions = (self.models / "nomic-ai--CodeRankEmbed").glob("*")
        if not any(all((r / f).is_file() for f in ("model.safetensors", "tokenizer.json", "config.json"))
                   for r in revisions):
            self.skipTest("requires previously downloaded local CodeRankEmbed weights")
        self.binary = shutil.which("jscpd")
        self.assertIsNotNone(self.binary, "install jscpd@5.4.3 on PATH")
        self.assertEqual(subprocess.check_output([self.binary, "--version"], text=True).strip(), "jscpd 5.4.3")
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.tool = self.root / "runner/jscpd"

    def job(self, name, revision, *, producer=False, restore=None):
        # Actions jobs start with a clean filesystem but the same absolute runner-temp path.
        if self.tool.exists():
            shutil.rmtree(self.tool)
        bin_dir = self.tool / "node_modules/.bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "jscpd").symlink_to(self.binary)
        self.source = self.tool / "base" if producer else self.root / f"{name}-source"
        git(self.root, "clone", "-q", str(revision), str(self.source))
        self.cache = self.root / f"{name}-cache"
        self.cache.mkdir()
        (self.cache / "models").symlink_to(self.models)
        if restore:
            target = self.cache / "embeddings" / restore.parent.name / restore.name
            target.parent.mkdir(parents=True)
            shutil.copyfile(restore, target)
        self.env = {**os.environ, "RUNNER_TEMP": str(self.tool.parent), "MODEL": "CodeRankEmbed",
                    "JSCPD_CACHE_DIR": str(self.cache), "GITHUB_OUTPUT": str(self.tool / "outputs"),
                    "VECTOR_BASELINE": "true" if restore else ""}
        self.env.pop("BASE", None)
        if not producer:
            self.env["BASE"] = self.base
        self.name = name

    def scan(self, mode, counts=(), limited=False):
        output = Path(self.env["GITHUB_OUTPUT"])
        output.write_text("")
        start = time.monotonic()
        result = subprocess.run([sys.executable, "-I", SCAN, mode], cwd=self.source, env=self.env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if limited:
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("head: exceeds the 32-function PR inference limit", result.stdout)
        else:
            self.assertEqual(result.returncode, 0, result.stdout)
        for side, embedded, total in counts:
            if embedded == 0:
                message = f"{total} functions, all embeddings cached (nomic-ai/CodeRankEmbed)"
            else:
                amount = str(total) if embedded == total else f"{embedded} of {total}"
                message = f"embedding {amount} functions with nomic-ai/CodeRankEmbed on this machine"
                if embedded < total:
                    message += ", the rest cached"
            self.assertIn(f"{side}: Semantic clones (experimental): {message}\n", result.stdout)
            log = (self.tool / f"semantic-{side}.log").read_text()
            elapsed = re.search(r"time: ([.\d]+(?:ms|µs|s))", log)
            print(f"{self.name}/{side}: embedded={embedded} reused={total - embedded}"
                  + (f" native={elapsed[1]}" if elapsed else ""), flush=True)
        if counts:
            print(f"{self.name}: wall={time.monotonic() - start:.2f}s", flush=True)
        return dict(line.split("=", 1) for line in output.read_text().splitlines())

    def pull_request(self, repo, name, baseline, new, total, *, base_total=5, base_misses=0, full=False):
        self.job(name, repo, restore=baseline)
        exact = self.scan("exact")
        self.assertEqual((exact["eligibility"], exact["structural"]), ("run", "run"))
        structural = json.loads(self.scan("structural")["structural"])
        if full:
            # The cold oracle must re-embed the head too, not reuse its own merge-base scan.
            config = self.tool / "config.json"
            config.write_text(json.dumps({**json.loads(config.read_text()), "semantic": {"cache": False}}))
        counts = [("base", base_misses if baseline else base_total, base_total), ("head", total if full else new, total)]
        semantic = json.loads(self.scan("semantic", counts)["semantic"])
        native = [json.loads((self.tool / f"semantic-{side}/jscpd-report.sarif").read_text())
                  ["runs"][0]["results"] for side in ("base", "head")]
        return json.loads(exact["report"]), structural, semantic, native

    def test_independent_pull_requests(self):
        default = self.root / "default"
        git(self.root, "init", "-q", str(default))
        for path, fixture in (("words", "word-frequencies"), ("retire", "parse-pixel"),
                              ("rewrite", "pixel-channels"), ("ledger", "spectral-ledger"),
                              ("second", "spectral-ledger-alt")):
            (default / f"{path}.js").write_text(sample(fixture))
        self.base = commit(default)
        self.job("seed", default, producer=True)
        self.scan("seed", [("seed", 5, 5)])
        baseline, = (self.cache / "embeddings").glob("*/*.bin")

        one, two = (self.root / n for n in ("one", "two"))
        for repo in (one, two):
            git(self.root, "clone", "-q", str(default), str(repo))
        (one / "added.js").write_text(sample("word-histogram"))
        advanced = commit(one)

        (two / "words.js").rename(two / "moved.js")
        (two / "moved.js").write_text("\n\n" + sample("word-frequencies"))
        (two / "retire.js").unlink()
        (two / "second.js").write_text(sample("parse-pixel").replace("parsePixel", "parseRgb"))
        (two / "rewrite.js").write_text(sample("word-histogram") + "\n" +
                                        sample("pixel-channels").replace("pixelChannels", "rgbChannels"))
        (two / "copy.js").write_text(sample("spectral-ledger-alt") + "\n" +
                                     sample("spectral-ledger").replace("spectralLedger", "copyLedger"))
        commit(two)

        for repo, misses, total, expected in (
            (one, 1, 6, {(("added.js", 1, 7), ("words.js", 1, 9))}),
            (two, 4, 7, {(("moved.js", 3, 11), ("rewrite.js", 1, 7)),
                         (("rewrite.js", 9, 17), ("second.js", 1, 8))}),
        ):
            warm = self.pull_request(repo, repo.name + "-restored", baseline, misses, total)
            miss = self.pull_request(repo, repo.name + "-miss", None, misses, total)
            oracle = self.pull_request(repo, repo.name + "-full", None, misses, total, full=True)
            self.assertEqual(warm, oracle)
            self.assertEqual(miss, oracle)
            exact, structural, semantic, _ = warm
            if repo == two:
                self.assertGreater(exact["count"], 0)
                self.assertGreater(sum(g["count"] for k, g in structural.items() if k != "exact"), 0)
            pairs = {(tuple(a), tuple(b)) for a, b, score in semantic["rows"] if 0 < score <= 1}
            self.assertEqual(pairs, expected)
            print(f"{repo.name}: semantic={semantic['rows']}", flush=True)

        self.job("refresh", two, producer=True, restore=baseline)
        self.scan("seed", [("seed", 4, 7)])
        refreshed, = (self.cache / "embeddings").glob("*/*.bin")
        self.job("refresh-hit", two, producer=True, restore=refreshed)
        self.scan("seed", [("seed", 0, 7)])

        # PR1 has since landed. Its semantic pair belongs to the actual base, not this PR.
        self.base = advanced
        later = self.root / "later"
        git(self.root, "clone", "-q", str(one), str(later))
        (later / "added.js").write_text("\n" + sample("word-histogram"))
        commit(later)
        stale = self.pull_request(later, "stale", baseline, 0, 6, base_total=6, base_misses=1)
        oracle = self.pull_request(later, "stale-full", None, 0, 6, base_total=6, full=True)
        self.assertEqual(stale, oracle)
        self.assertEqual(stale[2], {"count": 0, "rows": []})

        (one / "many.js").write_text("\n".join(sample("word-histogram").replace("wordHistogram", f"hist{i}")
                                               for i in range(33)))
        commit(one)
        self.job("over-budget", one)
        self.scan("exact")
        self.scan("structural")
        self.assertEqual(self.scan("semantic", limited=True), {"semantic_state": "limit"})


if __name__ == "__main__":
    unittest.main()
