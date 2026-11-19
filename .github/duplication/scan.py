"""Collect advisory PR findings; only compact, tracked locations leave the scan job."""
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

JS_FORMATS = ("javascript", "jsx", "typescript", "tsx")
JS_SUFFIXES = (b".js", b".es", b".es6", b".mjs", b".cjs", b".jsx", b".ts", b".cts", b".mts", b".tsx")
RULES = {
    "jscpd/duplicate-code": "exact",
    "jscpd/renamed-code": "renamed",
    "jscpd/similar-code": "gap",
    "jscpd/similar-function": "ast",
    "jscpd/semantic-code": "semantic",
}
MODES = {"exact": ["exact"], "structural": ["renamed", "gap", "ast"], "semantic": ["semantic"]}


def git(*args, cwd=None):
    return subprocess.check_output(["git", *args], cwd=cwd)


def emit(key, value):
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        print(f"{key}={value}", file=output)


def config():
    defaults = {
        "format": list(JS_FORMATS), "mode": "mild", "minTokens": 50, "minLines": 5,
        "ignore": ["**/{node_modules,dist,generated,gen,test,tests,__tests__,fixtures}/**",
                   "**/*.test.*", "**/*.spec.*"],
    }
    path = Path(".jscpd.json")
    if path.is_symlink():
        raise ValueError("Expected a regular .jscpd.json")
    if path.is_file():
        options = json.loads(path.read_text())
        # Only accept detection settings, never providers, plugins or alternate I/O paths.
        for key in (*defaults, "pattern", "maxLines", "maxSize", "ignorePattern", "skipLocal"):
            if key in options:
                defaults[key] = options[key]
    defaults["format"] = [f for f in defaults["format"] if f in JS_FORMATS]
    if not defaults["format"]:
        raise ValueError("No configured JS/TS formats")
    return defaults


def detect(mode, tool, root, side, args):
    output = tool / f"{mode}-{side}"
    command = [tool / "node_modules/.bin/jscpd", ".", "--config", tool / "config.json", "--absolute",
               "--reporters", "json,sarif" if mode == "exact" else "sarif", "--output", output, *args]
    with (tool / f"{mode}-{side}.log").open("w+") as log:
        subprocess.run(command, cwd=root, stdout=log, stderr=subprocess.STDOUT, check=True)
        if mode == "semantic":
            log.seek(0)
            for line in log:
                if re.fullmatch(r"Semantic clones \(experimental\): (?:embedding \d+(?: of \d+)? functions with nomic-ai/CodeRankEmbed on this machine(?:, the rest cached)?|\d+ functions, all embeddings cached \(nomic-ai/CodeRankEmbed\))\n", line):
                    print(f"{side}: {line.rstrip()}")
                    if "all embeddings cached" not in line:
                        emit("embedded", "true")
    tracked = set(os.fsdecode(git("ls-files", "-z", cwd=root)).split("\0"))
    results = json.loads((output / "jscpd-report.sarif").read_text())["runs"][0]["results"]
    pairs = []
    for entry in results:
        kind = RULES[entry["ruleId"]]
        if kind not in MODES[mode]:
            continue
        pair = []
        for loc in (entry["locations"][0], entry["relatedLocations"][0]):
            physical = loc["physicalLocation"]
            name = os.path.relpath(physical["artifactLocation"]["uri"], root)
            if name not in tracked:
                raise ValueError("Unexpected source outside the scanned tree")
            region = physical["region"]
            pair.append([name, region["startLine"], region["endLine"]])
        pairs.append((kind, entry["partialFingerprints"]["jscpdCloneHash/v1"], sorted(pair),
                      entry["properties"].get("similarity")))
    return pairs


def added(before, after, renames):
    # Content alone can assign an existing pair's baseline allowance to a third copy in a new file.
    def key(kind, fingerprint, pair, moved):
        return (kind, fingerprint, *sorted(moved.get(f[0], f[0]) for f in pair))
    known = Counter(key(k, h, p, renames) for k, h, p, _ in before)
    new = []
    for kind, fingerprint, pair, score in after:
        observed = key(kind, fingerprint, pair, {})
        if known[observed]:
            known[observed] -= 1
        else:
            new.append((kind, pair, score))
    return new


def grouped(entries, kinds, prior=()):
    coverage = defaultdict(list)
    for pair in prior:
        coverage[tuple(f[0] for f in pair)].append(pair)
    groups = {k: [] for k in kinds}
    # Report the widest matching spans once; prefer the lower type when both spans are identical.
    for kind, pair, score in sorted(entries, key=lambda r: (
            -sum(f[2] - f[1] for f in r[1]), kinds.index(r[0]), r[1])):
        covered = coverage[tuple(f[0] for f in pair)]
        if any(all(a[1] <= b[1] and b[2] <= a[2] for a, b in zip(old, pair)) for old in covered):
            continue
        covered.append(pair)
        groups[kind].append([*pair, score] if score is not None else pair)
    return {k: {"count": len(rows), "rows": rows[:20]} for k, rows in groups.items()}


def main(mode):
    source = Path.cwd()
    tool = Path(os.environ["RUNNER_TEMP"]) / "jscpd"
    tree = tool / "base"
    base = git("merge-base", os.environ["BASE"], "HEAD").decode().strip()
    head = git("rev-parse", "HEAD").decode().strip()
    if mode == "exact":
        (tool / "config.json").write_text(json.dumps(config()))
        git("worktree", "add", "--quiet", "--detach", str(tree), base)
        args = ["--kind", "exact"]
    elif mode == "structural":
        args = ["--ignore-identifiers=consistent", "--ignore-literals", "--ignore-annotations",
                "--max-gap-lines", "2", "--similarity=0.90", "--min-nodes", "40", "--kind", "renamed,gap,ast"]
    else:
        args = ["--semantic", "--semantic-provider", "local", "--semantic-model", os.environ["MODEL"],
                "--kind", "semantic"]
    before = detect(mode, tool, tree, "base", args)
    if mode == "semantic":
        # jscpd keys vectors by canonical scan path. Switch revisions at one stable path.
        git("checkout", "--quiet", "--detach", head, cwd=tree)
    after = detect(mode, tool, tree if mode == "semantic" else source, "head", args)

    fields = os.fsdecode(git("diff", "-M", "--name-status", "-z", "--diff-filter=R", base, head)).split("\0")
    coverage_file = tool / "coverage.json"
    prior = json.loads(coverage_file.read_text()) if coverage_file.exists() else []
    new = added(before, after, dict(zip(fields[1::3], fields[2::3])))
    exact_new = tool / "exact-new.json"
    if mode == "exact":
        exact_new.write_text(json.dumps(new))
    if mode == "structural":
        new += json.loads(exact_new.read_text())
    kinds = ["exact", *MODES["structural"]] if mode == "structural" else MODES[mode]
    groups = grouped(new, kinds, prior if mode == "semantic" else [])
    if mode != "semantic":
        coverage_file.write_text(json.dumps(prior + [pair for _, _, pair, _ in after]))

    if mode == "exact":
        def totals(side):
            stats = json.loads((tool / f"exact-{side}/jscpd-report.json").read_text())["statistics"]["total"]
            return {k: stats[k] for k in ("percentage", "duplicatedLines", "clones", "sources")}
        head_stats = totals("head")
        emit("report", json.dumps({**groups["exact"], "base": base, "before": totals("base"), "after": head_stats}))
        changes = git("diff", "--no-renames", "--name-only", "-z", base, head).split(b"\0")
        relevant = any(p.lower().endswith(JS_SUFFIXES) or p.split(b"/")[-1] in (
            b".gitignore", b".ignore", b".jscpd.json", b".gitattributes") for p in changes)
        state = "run" if relevant else "unchanged"
        emit("structural", state if head_stats["sources"] else "empty")
        emit("eligibility", state if head_stats["sources"] >= 2 else "too-few-files")
    else:
        emit(mode, json.dumps(groups["semantic"] if mode == "semantic" else groups, separators=(",", ":")))


if __name__ == "__main__":
    main(sys.argv[1])
