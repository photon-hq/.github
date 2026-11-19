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
      pull-requests: write
    uses: photon-hq/.github/.github/workflows/report-duplicated-code.yml@REVIEWED_SHA
```

Use one trigger per target repository. For an organization-managed pilot, remove the repository caller first. Then have an organization owner select `photon-hq/.github` and `.github/workflows/report-duplicated-code.yml` at a reviewed revision in a standalone **Evaluate** branch ruleset scoped to the pilot repository. The workflow handles `pull_request` directly and scans the target PR, while its implementation comes from the defining workflow revision. This repository's own PRs run the same entry directly.

**Never use an Active required-workflow ruleset or require these status checks.** A merge must not wait for reporting, even if Actions is queued or unavailable. To roll back an Evaluate pilot, disable that rule before restoring the pinned repository caller.

The bot updates one comment, when the PR token permits it. The table always comes from two unnormalized jscpd 5.4.3 scans, followed by new locations:

- **Type 1:** exact matching; by default at least 50 tokens and 5 lines, in mild mode.
- **Type 2:** consistent identifier renaming, with literals and annotations normalized where supported.
- **Type 3:** gaps up to 2 lines and function AST similarity of at least 0.90 with at least 40 nodes. These are detection thresholds, not merge criteria.
- **Type 4:** experimental local CPU inference with CodeRankEmbed and its calibrated cosine thresholds (0.4125 across languages, 0.6375 within one language). Review these candidates; a similarity score is not a probability.

Each scan compares the full eligible JS/TS tree at the merge base and head. A finding is identified by its scanner fingerprint and both file paths (following Git-detected renames), not by line numbers or score. Rewritten fragments can become new observations. When a wider Type 1–3 finding covers both ranges of a smaller one, only the wider location is listed; identical ranges prefer the lower type. A semantic candidate contained in an exact or structural finding is omitted. Exact table totals still count all exact spans, including spans grouped into a wider finding. The publisher shows up to 20 pairs per category, subject to the comment-size limit.

CodeRankEmbed runs on the runner; source is not sent to an embeddings API. Only the public weights and binary vector indexes are cached, never source, reports or credentials. The fixed model key avoids reuploading the 548 MB weights on each push. A separate PR-specific vector key restores a preceding revision's vectors and saves a new snapshot only after embedding new function text; GitHub isolates caches written on a PR's merge ref from other PRs. A new PR without an accessible matching model cache still pays for a cold download. The base and head use the same physical scan directory so unchanged functions can reuse vectors. Empty or irrelevant semantic scans are labeled skipped. A failed or timed-out semantic step is labeled unavailable and does not discard the exact report.
