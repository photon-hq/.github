# Advisory duplication report

After the reusable workflow is merged, an opted-in repository can add the following ordinary pull request workflow. Replace `REVIEWED_SHA` with the full commit SHA of the reviewed workflow in `photon-hq/.github`. No secrets or `.jscpd.json` are required.

```yaml
name: Duplication report
on: pull_request
permissions: {}
jobs:
  report:
    permissions:
      contents: read
      actions: read
      pull-requests: write
    uses: photon-hq/.github/.github/workflows/report-duplicated-code.yml@REVIEWED_SHA
```

Use one trigger per target repository. For an organization-managed pilot, remove the repository caller first. Then have an organization owner select `photon-hq/.github` and `.github/workflows/report-duplicated-code.yml` at a reviewed revision in a standalone **Evaluate** branch ruleset. Target only the pilot repository and the PR base branches that should receive reports (for example, only `main`); PRs into other branches will not receive a ruleset report. Exclude `photon-hq/.github` from the targets because its own PRs already run the workflow directly.

Creating the rule does not backfill open PRs. After cutover, update the branch or reopen an affected PR to trigger its report. The workflow scans the PR head using the implementation from the defining workflow revision.

**Never use an Active required-workflow ruleset or require these status checks.** A merge must not wait for reporting, even if Actions is queued or unavailable. To roll back an Evaluate pilot, disable that rule before restoring the pinned repository caller.

Before adopting a new workflow revision, verify that the repository where the run appears can use the Blacksmith x64 Ubuntu 24.04 runner. This applies to the source repository's own runs, pinned callers and Evaluate targets. An unavailable runner leaves the job queued. Same-repository PR scans and default-branch seeds use Blacksmith; fork PR scans and the comment publisher stay on GitHub-hosted runners. The runner change does not grant fork tokens permission to comment.

The two providers keep separate model-weight caches even though they use the same Linux-X64 key. On a miss, the runner downloads and verifies the 548 MB public model. A new fork PR can miss even after a Blacksmith seed. The trusted vector snapshot is a GitHub run artifact, not an entry in either weight cache.

The bot updates one comment, when the PR token permits it. The table always comes from two unnormalized jscpd 5.4.3 scans, followed by new locations:

- **Type 1:** exact matching; by default at least 50 tokens and 5 lines, in mild mode.
- **Type 2:** consistent identifier renaming, with literals and annotations normalized where supported.
- **Type 3:** gaps up to 2 lines and function AST similarity of at least 0.90 with at least 40 nodes. These are detection thresholds, not merge criteria.
- **Type 4:** experimental local CPU inference with CodeRankEmbed and its calibrated cosine thresholds (0.4125 across languages, 0.6375 within one language). Review these candidates; a similarity score is not a probability.

Each scan compares the full eligible JS/TS tree at the merge base and head. A finding is identified by its scanner fingerprint and both file paths (following Git-detected renames), not by line numbers or score. Rewritten fragments can become new observations. When a wider Type 1–3 finding covers both ranges of a smaller one, only the wider location is listed; identical ranges prefer the lower type. A semantic candidate contained in an exact or structural finding is omitted. Exact table totals still count all exact spans, including spans grouped into a wider finding. The publisher shows up to 20 pairs per category, subject to the comment-size limit.

### Seed the semantic scan

Install [the seed caller](examples/seed-duplication-vectors.yml) as `.github/workflows/seed-duplication-vectors.yml` **in the repository being scanned**. Set its push branch to that repository's default branch and pin its reusable workflow to the reviewed full SHA. The push that lands the caller can build the first snapshot. Later default-branch pushes restore the previous snapshot and embed missing function texts. Do not make the producer a required check.

An organization Evaluate rule can trigger the PR report; it does **not** install a push trigger in a target repository. A push to the shared workflow repository cannot populate a consumer's snapshot. An owner must install the caller and allow the scan job `actions: read` to read that repository's artifacts. No PAT, secret, write token for the scanner, or new service is needed.

The 548 MB public CodeRankEmbed model runs locally. Its weights have a fixed Actions cache key and are checked against jscpd's pinned checksums. Vectors travel separately: a successful, trusted default-branch push publishes only jscpd's native binary index as a run artifact. A PR reads an eligible producer run in its own repository first and never publishes a default-branch vector baseline. Ordinary [Actions cache restore](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#cache-key-matching) searches the current ref first: a key named `main` would not establish who wrote the bytes. For repositories without a producer workflow—and for stacked or multi-push PRs—each PR also keeps a PR-scoped Actions cache fallback (`<family>-vectors-pr<number>-<head_sha>`) staged through `$RUNNER_TEMP` so `baseline.py` checks regular-file status, the native header, record alignment and the 64 MiB bound before jscpd reads or saves it. When both a trusted seed and a prior PR cache entry exist, `baseline.py` preserves seed records first and appends unseen 3,088-byte PR records by content hash up to 64 MiB. The vector snapshot contains text hashes and floats, not function text, paths, pairs, logs or credentials. Treat it as repository data, visible to readers of the repository's artifacts.

Only **inference** is incremental. jscpd 5.4.3 still parses and compares the full eligible inventory twice, using the actual Git merge base and PR head under the same effective configuration. A vector belongs to the model input text (clipped by jscpd), not a path or line. Moving a function can reuse it; editing model input needs a new vector. Deleted functions cannot participate in a head comparison. A stale vector snapshot does not replace the merge base or supply any findings. Scanner/model identity changes require a compatible seed; changes to scan filters change which functions are considered, not a vector's meaning.

The reader considers the eight latest successful push runs for the named caller on the default branch. It checks the run's repository, full-ref title, commit ancestry and caller file against the fetched default branch; then it verifies artifact identity, size, digest and native header. Keep the caller filename and `run-name` from the example. A caller change requires a new seed. Each snapshot is at most 64 MiB and expires after 30 days (or earlier under repository policy). Refreshes publish a snapshot even when no new text was embedded, so active repositories keep one in the lookup window. If the initial seed exceeds 12 minutes or 64 MiB, do not roll that repository over on the assumption that its seed succeeded.

Same-repository PR runs on Blacksmith use a 12-minute semantic step budget with or without a default-branch seed and allow up to 1,500 missing functions per revision (`base` and `head`), saving updated PR vectors whenever new functions are embedded so later pushes reuse them. Fork PR runs on GitHub-hosted runners keep a 32-missing-function ceiling per revision and a two-minute semantic budget when unseeded. A limit, model failure or timeout reports incomplete or unavailable semantics, without discarding exact totals or completed structural results. No PR result repairs or overwrites a seed. The next successful producer refresh is the recovery path.

**Rollout and smoke test:** Merge the shared implementation, install the pinned producer in one consumer, and verify its successful default-branch push run and vector artifact. Pin the advisory PR caller or Evaluate rule to the reviewed revision. Open **two different PRs** from that base, each adding a different function; include a semantic match to an untouched file. Check that both scan logs identify the trusted producer run, the base logs say `all embeddings cached`, the head embeds only the misses, and the comment links the expected pair. A second push to one PR does not prove cross-PR reuse. To roll back, restore the previous reporter pin and remove the seed caller. Neither step needs to block merges.

**Can a laptop build the first snapshot?** The native file is portable in a two-function fixture: Linux x64 reused both vectors from macOS arm64, embedded one new function and reported the same 0.798 match as cold Linux inference. But a local `gh` or PAT upload is not an artifact of a verified default-branch run. This workflow intentionally has no manual import. A future bootstrap would need a separately reviewed, trusted default-branch Actions job: compute on a dedicated owner-controlled runner, or ingest a repository-private file from a trusted builder with independently verified commit, model and digest. Neither route should run PR code or accept PR-supplied data. The supported first seed here runs on hosted Linux.
