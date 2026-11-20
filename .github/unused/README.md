# Unused code pull request check

`.github/workflows/check-unused-code.yml` checks pull requests in JavaScript and TypeScript repositories for newly introduced dead code using pinned `knip@6.46.1` without installing repository `node_modules` or executing repository JavaScript/TypeScript configuration files.

## Enrollment

The workflow supports organization branch rulesets (`on: pull_request`), merge queues (`on: merge_group`), and explicit per-repository callers (`on: workflow_call`). On `merge_group` events, `scan` passes immediately because the pull request was already checked before entering the merge queue and merge-group payloads do not carry pull request labels.

For an explicit caller workflow, replace `REVIEWED_SHA` with the full commit SHA in `photon-hq/.github` (include `merge_group:` as well if the target branch uses a GitHub merge queue):

```yaml
name: Unused code
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
  merge_group:
permissions: {}
jobs:
  unused:
    permissions:
      contents: read
      pull-requests: write
    uses: photon-hq/.github/.github/workflows/check-unused-code.yml@REVIEWED_SHA
```

Before enrolling a repository, confirm it can use the `blacksmith-4vcpu-ubuntu-2404` runner for same-repository pull requests (fork pull requests and the comment publisher run on `ubuntu-latest`). Concurrency is serialized per pull request on the `comment` job with `queue: max` so pending publishers queue without replacing each other while `scan` runs uncancelled.

## Behavior

1. **Fast non-JS/TS skip:** Repositories with zero tracked `*.js`, `*.es`, `*.es6`, `*.jsx`, `*.mjs`, `*.cjs`, `*.ts`, `*.tsx`, `*.mts`, or `*.cts` files emit `scope=skip` and exit `0` immediately without installing `knip`.
2. **Zero-configuration workspace inference:**
   - Discovers the repository root `.` and workspace subdirectories containing `package.json`.
   - Classifies each manifest with `isPublicLib = pkg && pkg.private !== true && Boolean(pkg.exports || pkg.main || pkg.module || pkg.bin)`:
     - **Published libraries (`isPublicLib === true`):** Sets `includeEntryExports: false`, maps built targets in `exports`, `main`, `module`, and `bin` (such as `./dist/foo.mjs` or `./build/cli.cjs`) back to existing source files under `src/` or the workspace root, and treats `examples/**` as runnable entrypoints.
     - **Private services, applications, and internal packages (`isPublicLib === false`):** Sets `includeEntryExports: true` with standard entrypoints (`src/{index,main,bin,*-index}.*`, `{index,main,bin,server}.*`) alongside framework routes/pages (React Router, Remix, Astro, Next.js, Nuxt, Cloudflare Workers), scripts, tests, and static `drizzle` schema paths.
   - Maps workspace `package.json#name` and subpath `exports`, `package.json#imports`, and local `tsconfig.json` `compilerOptions.paths` into per-workspace `paths` so cross-workspace imports resolve without `node_modules`.
   - Merges static `ignore`, `ignoreIssues`, and workspace `entry` / `project` / `ignore` overrides from a root `knip.json` or `knip.jsonc` when present.
   - Diffs workspace `package.json` `dependencies` (excluding `devDependencies`, `peerDependencies`, and `@types/*`) between base and head, reporting newly added runtime dependencies that have zero import or `require` references across the repository.
3. **Rename-aware base-versus-head comparison:**
   - Compares merge-base and head findings by stable `(category, file, symbol)` keys and maps files renamed in `git diff -M` so pre-existing findings and line shifts never fail unrelated pull requests.
   - Fails CI (`exit 1`) only when new unused files, unused exports/types/enum members, duplicate exports, or newly added unreferenced runtime `dependencies` are introduced without a waiver.
   - Fails open (`state=unavailable`, `exit 0`) if the base commit cannot be resolved or the scanner exits unexpectedly (`exit >= 2`).
4. **Waivers:**
   - Tag intentional public or stacked-PR exports with `/** @public */` (in non-library packages where lint rules require JSDoc descriptions, include a summary line above `@public`).
   - Apply the `allow-unused` label on the pull request to waive the check for the entire PR (`state=waived`, `exit 0`). Explicit caller workflows that include `labeled` and `unlabeled` in `on.pull_request.types` rerun automatically when the label changes. Organization branch rulesets ignore `types:` filters and run only on `opened`, `synchronize`, and `reopened`; after applying `allow-unused` on a ruleset-enrolled repository, click **Re-run jobs** on the failed check (the `scan` step re-fetches live pull request labels from the GitHub API) or push a new commit.
5. **Comment and job-summary policy:**
   - Clean pull requests (`0` new and `0` resolved items) post no comment.
   - When items are newly introduced or resolved, the `scan` step writes the summary table and findings to `GITHUB_STEP_SUMMARY`.
   - When `GITHUB_TOKEN` has `pull-requests: write` permission (same-repository pull requests), the `comment` job creates or updates one sticky `<!-- photon-knip -->` comment with a Before/After summary table and up to 10 direct source links (plus `<details>` overflow), updates the comment to a resolved-only summary when a push resolves pre-existing items without adding new ones, and deletes any prior bot comment when the scan is skipped, unavailable, or clean (`0` new and `0` resolved items). On fork pull requests, GitHub provides a read-only `GITHUB_TOKEN`, so sticky comment creation, updates, and deletion do not apply (`continue-on-error: true`) and findings are reported through `GITHUB_STEP_SUMMARY` instead.
