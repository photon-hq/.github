"""Transport one jscpd 5.4.3 native vector file between GitHub-hosted runs."""
import ctypes
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from http.client import HTTPException
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


WORKFLOW = ".github/workflows/seed-duplication-vectors.yml"
NATIVE_NAME = "nomic-ai_CodeRankEmbed-62da982e9d958d5f.bin"
HEADER = b"JSCPDEM1" + (768).to_bytes(4, "little")
RECORD = 16 + 768 * 4
MAX_BYTES = 64 * 1024 * 1024
RUN_LIMIT = 8


def native_file():
    if (os.environ["JSCPD_VERSION"], os.environ["MODEL"]) != ("5.4.3", "CodeRankEmbed"):
        raise ValueError("unsupported native layout")
    base = (Path(os.environ["RUNNER_TEMP"]) / "jscpd/base").resolve()
    # jscpd's embed/cache.rs uses XXH3_64 over the canonical scan path.
    xxh3 = ctypes.CDLL("libxxhash.so.0").XXH3_64bits
    xxh3.argtypes, xxh3.restype = [ctypes.c_char_p, ctypes.c_size_t], ctypes.c_uint64
    encoded = os.fsencode(base)
    project = f"base-{xxh3(encoded, len(encoded)):016x}"
    cache_home = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    root = Path(os.environ.get("JSCPD_CACHE_DIR") or cache_home / "jscpd")
    return root / "embeddings" / project / NATIVE_NAME


def pr_file():
    return Path(os.environ["RUNNER_TEMP"]) / "jscpd-pr-cache/vectors.bin"


def artifact_name(attempt):
    return (f"jscpd-vectors-v1-{os.environ['RUNNER_OS']}-{os.environ['RUNNER_ARCH']}-"
            f"{os.environ['JSCPD_VERSION']}-{os.environ['MODEL']}-a{attempt}.bin")


def valid_size(size):
    return len(HEADER) < size <= MAX_BYTES and (size - len(HEADER)) % RECORD == 0


def read_vectors(path):
    if path.parent.is_symlink() or path.is_symlink() or not path.is_file():
        raise ValueError("invalid native snapshot")
    size = path.stat().st_size
    if not valid_size(size):
        raise ValueError("invalid native snapshot")
    data = path.read_bytes()
    if len(data) != size or not data.startswith(HEADER):
        raise ValueError("invalid native snapshot")
    return data


def write_atomic(target, data):
    if target.parent.is_symlink() or target.is_symlink():
        raise ValueError("invalid native snapshot")
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as tmp:
            tmp.write(data)
        os.replace(name, target)
    except BaseException:
        Path(name).unlink(missing_ok=True)
        raise


def merge_vectors(*blobs):
    max_records = (MAX_BYTES - len(HEADER)) // RECORD
    seen = {}
    for data in blobs:
        if not data:
            continue
        if not data.startswith(HEADER) or not valid_size(len(data)):
            raise ValueError("invalid native snapshot")
        for offset in range(len(HEADER), len(data), RECORD):
            record = data[offset:offset + RECORD]
            key = record[:16]
            if key not in seen:
                if len(seen) >= max_records:
                    break
                seen[key] = record
    if not seen:
        raise ValueError("invalid native snapshot")
    return HEADER + b"".join(seen.values())


def emit(key, value):
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        print(f"{key}={value}", file=output)


def stage():
    source = native_file()
    if not source.is_symlink() and not source.exists():
        print("No native vectors to publish.")
        return
    data = read_vectors(source)
    out = Path(os.environ["RUNNER_TEMP"]) / artifact_name(int(os.environ["GITHUB_RUN_ATTEMPT"]))
    write_atomic(out, data)
    emit("file", out)


def apply_pr():
    source = pr_file()
    if source.parent.is_symlink() or source.is_symlink():
        raise ValueError("invalid native snapshot")
    if not source.exists():
        print("No pull-request vectors to restore.")
        return
    pr_data = read_vectors(source)
    target = native_file()
    if target.parent.is_symlink() or target.is_symlink():
        raise ValueError("invalid native snapshot")
    if target.exists():
        dedup_seed = merge_vectors(read_vectors(target))
        merged = merge_vectors(dedup_seed, pr_data)
        write_atomic(target, merged)
        seed_count = (len(dedup_seed) - len(HEADER)) // RECORD
        added_count = (len(merged) - len(dedup_seed)) // RECORD
        print(f"Merged {added_count} pull-request vectors with {seed_count} seed vectors.")
    else:
        deduped = merge_vectors(pr_data)
        write_atomic(target, deduped)
        print(f"Restored {(len(deduped) - len(HEADER)) // RECORD} pull-request vectors.")
    emit("restored", "true")


def stage_pr():
    source = native_file()
    if source.parent.is_symlink() or source.is_symlink():
        raise ValueError("invalid native snapshot")
    if not source.exists():
        print("No native vectors to cache.")
        return
    data = read_vectors(source)
    out = pr_file()
    write_atomic(out, data)
    emit("file", out)
    print(f"Staged {(len(data) - len(HEADER)) // RECORD} pull-request vectors.")


def eligible(run, repository_id, branch, current):
    return (run["id"] != current and run["event"] == "push" and run["status"] == "completed"
            and run["conclusion"] == "success" and run["path"] == WORKFLOW
            and run["repository"]["id"] == (run["head_repository"] or {}).get("id") == repository_id
            and run["head_branch"] == branch and run["display_title"] == f"Seed vectors on refs/heads/{branch}"
            and re.fullmatch("[0-9a-f]{40}", run["head_sha"]) is not None)


def trusted_commit(sha, branch):
    default = f"refs/remotes/origin/{branch}"
    git = ["git", "--no-replace-objects"]
    # A merge can make side-branch commits reachable. Require the trusted caller blob too.
    return (subprocess.run([*git, "merge-base", "--is-ancestor", sha, default],
                           stderr=subprocess.DEVNULL).returncode == 0 and
            subprocess.check_output([*git, "rev-parse", "--verify", f"{sha}:{WORKFLOW}"],
                                    stderr=subprocess.DEVNULL) ==
            subprocess.check_output([*git, "rev-parse", "--verify", f"{default}:{WORKFLOW}"],
                                    stderr=subprocess.DEVNULL))


def compatible(artifact, run, repository_id):
    owner = artifact.get("workflow_run") or {}
    return (artifact["name"] == artifact_name(run["run_attempt"]) and not artifact["expired"]
            and valid_size(artifact["size_in_bytes"]) and owner.get("id") == run["id"]
            and owner.get("head_sha") == run["head_sha"] and owner.get("head_branch") == run["head_branch"]
            and owner.get("repository_id") == owner.get("head_repository_id") == repository_id
            and re.fullmatch("sha256:[0-9a-f]{64}", artifact.get("digest") or "") is not None)


def restore():
    target = native_file()
    token = os.environ.pop("GITHUB_TOKEN")
    repo = os.environ["GITHUB_REPOSITORY"]
    repository_id = int(os.environ["GITHUB_REPOSITORY_ID"])
    branch = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())["repository"]["default_branch"]
    current = int(os.environ["GITHUB_RUN_ID"])

    def get(path, limit=1024 * 1024):
        req = Request(f"https://api.github.com/repos/{repo}/{path}")
        # Do not forward the token to the signed blob-storage redirect.
        req.add_unredirected_header("Authorization", f"Bearer {token}")
        with urlopen(req, timeout=10) as response:
            data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError("response exceeds size limit")
        return data

    query = urlencode(dict(branch=branch, event="push", status="success", per_page=RUN_LIMIT))
    runs = json.loads(get(f"actions/workflows/{Path(WORKFLOW).name}/runs?{query}"))["workflow_runs"]
    for run in runs[:RUN_LIMIT]:
        if not eligible(run, repository_id, branch, current):
            continue
        try:
            if not trusted_commit(run["head_sha"], branch):
                continue
            name = artifact_name(run["run_attempt"])
            run_id = int(run["id"])
            listing = json.loads(get(f"actions/runs/{run_id}/artifacts?" + urlencode(dict(name=name, per_page=2))))
            if len(listing["artifacts"]) != 1:
                continue
            artifact = listing["artifacts"][0]
            if not compatible(artifact, run, repository_id):
                continue
            data = get(f"actions/artifacts/{int(artifact['id'])}/zip", artifact["size_in_bytes"])
            if (len(data) != artifact["size_in_bytes"] or not data.startswith(HEADER)
                    or artifact["digest"] != f"sha256:{hashlib.sha256(data).hexdigest()}"):
                continue
            write_atomic(target, data)
            emit("restored", "true")
            print(f"Restored {len(data) // RECORD} native vectors from push run {run_id}.")
            return
        except (HTTPException, OSError, ValueError, subprocess.CalledProcessError):
            continue
    print("No compatible default-branch snapshot.")


if __name__ == "__main__":
    if sys.argv[1:] == ["stage"]:
        stage()
    elif sys.argv[1:] == ["restore"]:
        try:
            restore()
        except (HTTPException, OSError, ValueError, KeyError) as exc:
            print(f"Default-branch snapshot unavailable ({type(exc).__name__}).")
    elif sys.argv[1:] == ["apply-pr"]:
        apply_pr()
    elif sys.argv[1:] == ["stage-pr"]:
        stage_pr()
    else:
        raise SystemExit("usage: baseline.py {restore|stage|apply-pr|stage-pr}")
