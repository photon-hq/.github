# PostgreSQL migration pull request check

`.github/workflows/check-postgres-migrations.yml` checks pull requests for newly introduced table-locking or backwards-incompatible PostgreSQL DDL using pinned `squawk-cli@2.74.0`, without installing target repository dependencies or executing repository configuration code.

## Enrollment

The workflow supports organization branch rulesets (`on: pull_request`), merge queues (`on: merge_group`), and explicit per-repository callers (`on: workflow_call`). On `merge_group` events, `scan` passes immediately because the pull request was already checked before entering the merge queue and merge-group payloads do not carry pull request labels.

For an explicit caller workflow, replace `REVIEWED_SHA` with the full commit SHA in `photon-hq/.github` (include `merge_group:` as well if the target branch uses a GitHub merge queue):

```yaml
name: PostgreSQL migrations
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
  merge_group:
permissions: {}
jobs:
  migrations:
    permissions:
      contents: read
      pull-requests: write
    uses: photon-hq/.github/.github/workflows/check-postgres-migrations.yml@REVIEWED_SHA
```

Before enrolling a repository, confirm it can use the `blacksmith-4vcpu-ubuntu-2404` runner for same-repository pull requests (fork pull requests and the comment publisher run on `ubuntu-latest`). Concurrency is serialized per pull request on the `comment` job with `queue: max` so pending publishers queue without replacing each other while `scan` runs uncancelled.

## Behavior

1. **Fast skip when zero `.sql` files changed:**
   - Before checking out the policy helper or installing `squawk-cli`, `scan` runs `git diff --find-renames --name-only --diff-filter=ACMR` between `merge-base` and `HEAD` for `*.sql`. Pull requests with zero added, copied, modified, or renamed `.sql` files emit `scope=skip`, `state=clean`, and exit `0` immediately.
2. **Zero-configuration PostgreSQL migration classification:**
   - Classifies changed `.sql` files as PostgreSQL migrations when they belong to:
     - Drizzle PostgreSQL folders (`meta/_journal.json` or `*_snapshot.json` with `"dialect": "postgresql"` in the directory or parent directory),
     - Supabase (`supabase/migrations/*.sql`) or Prisma (`prisma/migrations/**/migration.sql` with `provider = "postgresql"`),
     - A repository or workspace carrying a `.squawk.toml` file, or
     - Migration directories (`drizzle*`, `migrations`, `migrate`, `*-migrations`, `sql`, `db`) in workspaces whose `package.json`, `drizzle.config.*`, or `Cargo.toml` declares PostgreSQL drivers or ORMs (`pg`, `postgres`, `drizzle-orm`, `@neondatabase/serverless`, `@electric-sql/pglite`, `kysely`, `sqlx`, `tokio-postgres`, `diesel`, `sea-orm`, etc.).
   - Excludes non-PostgreSQL `.sql` files (ClickHouse, MySQL, SQLite paths or engine/type syntax), schema dumps and view snapshots (`db/structure.sql`, `db/views/**`), `node_modules`, and `test` / `fixtures` / `examples` / `docs` directories (unless a `.squawk.toml` lives inside that directory). When every changed `.sql` file in a pull request is non-PostgreSQL or excluded, `scan` emits `scope=skip`, `state=clean`, and exits `0`.
3. **Default zero-config rule profile & static `.squawk.toml` overrides:**
   - Defaults to `pg_version = "17.0"` and `assume_in_transaction = true` (matching transactional runners such as `drizzle-kit migrate`).
   - Excludes generator boilerplate and style-only rules by default: `require-lock-timeout`, `require-statement-timeout`, `require-concurrent-index-creation`, `require-concurrent-index-deletion`, `identifier-too-long`, `prefer-bigint-over-int`, `prefer-text-field`, `prefer-identity`, and `require-enum-value-ordering`.
   - Reads `.squawk.toml` statically (regular files inside the checkout realpath only) and honors `pg_version`, `assume_in_transaction`, `excluded_rules`, `included_rules`, and `excluded_paths`. When a repository's `.squawk.toml` sets `assume_in_transaction = false` without overriding `excluded_rules`, `require-concurrent-index-creation` and `require-concurrent-index-deletion` remain enabled.
4. **Base-versus-head diffing:**
   - Newly added `.sql` files report all unwaived violations.
   - Modified or renamed `.sql` files run `squawk` on both `merge-base` and `HEAD` and report only newly introduced violations (`head` minus `base` by normalized statement and span signature), so fixing a comment, formatting, or filename in a historical migration does not fail on pre-existing DDL.
   - Fails open (`state=unavailable`, `exit 0`) on unreachable base SHAs or internal scanner errors.
5. **Waivers:**
   - **Inline comment:** Place `-- squawk-ignore <rule>` (comma-separated for multiple rules) directly above the statement, or `-- squawk-ignore-file` at the top of the file. In Drizzle migrations, put `-- squawk-ignore <rule>` *after* `--> statement-breakpoint` directly above the SQL statement so the comment attaches to that statement. For a single non-transactional migration file in an otherwise transactional repository, `-- squawk-disable-assume-in-transaction` disables transaction assumptions for that file.
   - **Pull request label:** Apply `allow-unsafe-migration` on the pull request to waive the gate (`state=waived`, `exit 0`). On ruleset-enrolled repositories, click **Re-run jobs** on the failed check (or push a commit) after applying the label so `scan` re-fetches live pull request labels.
6. **Comment and job-summary policy:**
   - Clean, skipped, or unavailable runs post no comment when none exists, and delete any stale `<!-- photon-squawk -->` comment left by an earlier commit once resolved.
   - Active (`state=failed`, `exit 1`) or label-waived (`state=waived`, `exit 0`) violations write a Markdown report to `GITHUB_STEP_SUMMARY` (visible on fork pull requests as well) and create or update one sticky `<!-- photon-squawk -->` pull request comment linking each `<file>:<line>` and `https://squawkhq.com/docs/<rule>`.
