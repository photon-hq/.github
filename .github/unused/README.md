# Unused code pull request check

`.github/workflows/check-unused-code.yml` checks pull requests in JavaScript and TypeScript repositories for newly introduced dead code using pinned `knip@6.46.1` without installing repository `node_modules` or executing repository JavaScript/TypeScript configuration files.

## Enrollment

The workflow supports both organization branch rulesets (`on: pull_request`) and explicit per-repository callers (`on: workflow_call`).

For an explicit caller workflow, replace `REVIEWED_SHA` with the full commit SHA in `photon-hq/.github`:

```yaml
name: Unused code
on: pull_request
permissions: {}
jobs:
  unused:
    permissions:
      contents: read
      pull-requests: write
    uses: photon-hq/.github/.github/workflows/check-unused-code.yml@REVIEWED_SHA
```

Before enrolling a repository, confirm it can use the `blacksmith-4vcpu-ubuntu-2404` runner for same-repository pull requests (fork pull requests and the comment publisher run on `ubuntu-latest`). Concurrency is serialized only on the lightweight `comment` job so overlapping dispatches never cancel `scan`.

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
   - Apply the `allow-unused` label on the pull request to waive the check for the entire PR (`state=waived`, `exit 0`).
5. **Comment policy:**
   - Clean pull requests (`0` new and `0` resolved items) post no comment.
   - When items are newly introduced or resolved, one sticky `<!-- photon-knip -->` comment is created or updated with a Before/After summary table and up to 10 direct source links (plus `<details>` overflow). If a later push resolves all findings, the prior bot comment is deleted automatically.
