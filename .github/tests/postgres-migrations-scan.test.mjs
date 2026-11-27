import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CONCURRENT_INDEX_RULES,
  classifySqlFile,
  createClassifierCache,
  DEFAULT_EXCLUDED_RULES,
  DEFAULT_PG_VERSION,
  isNonTransactionalMigrationFile,
  isRealPathInsideRepo,
  matchesExcludedPath,
  parseSquawkToml,
  resolveSquawkProfile,
  serializeSquawkToml,
} from '../migrations/config.mjs';
import {
  collectChangedSqlEntries,
  diffMigrationFindings,
  executePrCheck,
  extractStatementSignature,
  formatMigrationStepSummary,
  hasAllowUnsafeMigrationLabel,
  runSquawkScan,
  stripSqlCommentsAndCollapseWhitespace,
} from '../migrations/scan.mjs';

const SQUAWK_VERSION = '2.74.0';

function isSquawkInstalled(dir) {
  try {
    const pkgFile = path.join(dir, 'node_modules/squawk-cli/package.json');
    const binFile = path.join(dir, 'node_modules/.bin/squawk');
    if (!existsSync(pkgFile) || !existsSync(binFile)) return false;
    return JSON.parse(readFileSync(pkgFile, 'utf8'))?.version === SQUAWK_VERSION;
  } catch {
    return false;
  }
}

let cachedSquawkDir = null;

function ensureSquawkInstall() {
  if (cachedSquawkDir && isSquawkInstalled(cachedSquawkDir)) return cachedSquawkDir;
  const staged = mkdtempSync(
    path.join(os.tmpdir(), `migrations-test-squawk-${SQUAWK_VERSION}-${process.pid}-`),
  );
  try {
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', `squawk-cli@${SQUAWK_VERSION}`],
      { cwd: staged, stdio: 'inherit' },
    );
    assert.equal(isSquawkInstalled(staged), true);
  } catch (err) {
    rmSync(staged, { recursive: true, force: true });
    throw err;
  }
  process.once('exit', () => rmSync(staged, { recursive: true, force: true }));
  cachedSquawkDir = staged;
  return staged;
}

function populateFiles(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  }
}

function createRepoWithCommit(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pg-mig-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  populateFiles(dir, files);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, baseSha };
}

function commitAll(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', msg], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

test('parses static .squawk.toml profiles and enforces default zero-config rules', () => {
  assert.equal(DEFAULT_PG_VERSION, '17.0');
  assert.equal(DEFAULT_EXCLUDED_RULES.length, 9);
  for (const rule of CONCURRENT_INDEX_RULES) {
    assert.ok(DEFAULT_EXCLUDED_RULES.includes(rule));
  }

  const parsed = parseSquawkToml(
    [
      '\ufeff# repository config',
      'pg_version = "16.0"',
      'assume_in_transaction = false',
      'excluded_rules = [',
      '  "ban-drop-column", # intentional',
      '  "invalid rule!",',
      ']',
      'included_rules = ["require-table-schema"]',
      'excluded_paths = ["drizzle/legacy/*", "../escape.sql", "/abs.sql", "0001_init.sql"]',
      '[ignored_section]',
      'assume_in_transaction = true',
    ].join('\n'),
  );

  assert.deepEqual(parsed, {
    pg_version: '16.0',
    assume_in_transaction: false,
    excluded_rules: ['ban-drop-column'],
    included_rules: ['require-table-schema'],
    excluded_paths: ['drizzle/legacy/*', '0001_init.sql'],
  });

  assert.equal(matchesExcludedPath('apps/api/drizzle/0001_init.sql', '0001_init.sql'), true);
  assert.equal(matchesExcludedPath('drizzle/legacy/0002_old.sql', 'drizzle/legacy/*'), true);
  assert.equal(matchesExcludedPath('drizzle/active/0002_old.sql', 'drizzle/legacy/*'), false);

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pg-mig-cfg-'));
  try {
    // 1. Default zero-config profile when no `.squawk.toml` exists.
    const defaultProfile = resolveSquawkProfile(tmp, 'apps/api/drizzle/0001_init.sql');
    assert.equal(defaultProfile.pgVersion, '17.0');
    assert.equal(defaultProfile.assumeInTransaction, true);
    assert.deepEqual(defaultProfile.excludedRules, DEFAULT_EXCLUDED_RULES);

    // 2. `assume_in_transaction = false` without explicit `excluded_rules` keeps `require-concurrent-index-*` active.
    populateFiles(tmp, {
      '.squawk.toml': 'assume_in_transaction = false\nincluded_rules = ["prefer-text-field"]\n',
    });
    const nonTxProfile = resolveSquawkProfile(tmp, 'migrations/0001_idx.sql');
    assert.equal(nonTxProfile.assumeInTransaction, false);
    assert.equal(nonTxProfile.excludedRules.includes('require-concurrent-index-creation'), false);
    assert.equal(nonTxProfile.excludedRules.includes('require-concurrent-index-deletion'), false);
    assert.equal(nonTxProfile.excludedRules.includes('prefer-text-field'), false);
    assert.equal(nonTxProfile.excludedRules.includes('require-lock-timeout'), true);

    const serialized = serializeSquawkToml(nonTxProfile);
    assert.match(serialized, /assume_in_transaction = false/);
    assert.match(serialized, /included_rules = \["prefer-text-field"\]/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('classifies PostgreSQL migrations and skips ClickHouse, SQLite, MySQL, dumps, and test fixtures', () => {
  const { dir } = createRepoWithCommit({
    'apps/api/drizzle/meta/_journal.json': JSON.stringify({ dialect: 'postgresql', version: '7', entries: [] }),
    'apps/api/drizzle/0000_init.sql': 'CREATE TABLE "accounts" ("id" uuid PRIMARY KEY);',
    'apps/api/test/fixtures/drizzle/meta/_journal.json': JSON.stringify({ dialect: 'postgresql', version: '7' }),
    'apps/api/test/fixtures/drizzle/0000_fixture.sql': 'CREATE TABLE "f" ("id" text);',
    'packages/db/package.json': JSON.stringify({
      name: '@acme/db',
      dependencies: { pg: '^8.13.0', 'drizzle-orm': '^0.40.0' },
    }),
    'packages/db/migrations/0001_sessions.sql': 'CREATE TABLE sessions (id text PRIMARY KEY);',
    'packages/db/ops/grants.sql': 'GRANT SELECT ON sessions TO reader;',
    'apps/analytics/clickhouse/migrations/0001_events.sql':
      'CREATE TABLE events (id String) ENGINE = MergeTree ORDER BY id;',
    'apps/analytics/migrations/0002_ch_header.sql':
      'CREATE TABLE metrics (ts DateTime64(3), tag LowCardinality(String)) ENGINE = ReplacingMergeTree ORDER BY ts;',
    'apps/local-sqlite/drizzle/meta/_journal.json': JSON.stringify({ dialect: 'sqlite', version: '7' }),
    'apps/local-sqlite/drizzle/0000_local.sql': 'CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT);',
    'apps/legacy-mysql/migrations/0001_mysql.sql':
      'CREATE TABLE orders (id BIGINT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;',
    'db/structure.sql': 'SET statement_timeout = 0; CREATE TABLE schema_migrations (version varchar);',
    'db/views/active_accounts_v01.sql': 'SELECT id FROM accounts;',
  });

  try {
    const cache = createClassifierCache(dir);
    assert.equal(isRealPathInsideRepo(path.join(dir, 'db/structure.sql'), cache.realRepoRoot), true);
    assert.equal(classifySqlFile(dir, 'apps/api/drizzle/0000_init.sql', cache).include, true);
    assert.equal(classifySqlFile(dir, 'packages/db/migrations/0001_sessions.sql', cache).include, true);

    assert.equal(classifySqlFile(dir, 'apps/api/test/fixtures/drizzle/0000_fixture.sql', cache).include, false);
    assert.equal(classifySqlFile(dir, 'packages/db/ops/grants.sql', cache).include, false);
    assert.equal(classifySqlFile(dir, 'apps/analytics/clickhouse/migrations/0001_events.sql', cache).include, false);
    assert.equal(classifySqlFile(dir, 'apps/analytics/migrations/0002_ch_header.sql', cache).include, false);
    assert.equal(classifySqlFile(dir, 'apps/local-sqlite/drizzle/0000_local.sql', cache).include, false);
    assert.equal(classifySqlFile(dir, 'apps/legacy-mysql/migrations/0001_mysql.sql', cache).include, false);
    assert.equal(classifySqlFile(dir, 'db/structure.sql', cache).include, false);
    assert.equal(classifySqlFile(dir, 'db/views/active_accounts_v01.sql', cache).include, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('passes safe Drizzle CREATE TABLE migrations and fails newly introduced unsafe DDL with 1-based lines', () => {
  const squawkDir = ensureSquawkInstall();
  const { dir, baseSha } = createRepoWithCommit({
    'apps/service/drizzle/meta/_journal.json': JSON.stringify({
      dialect: 'postgresql',
      version: '7',
      entries: [{ idx: 0, tag: '0000_initial' }],
    }),
    'apps/service/drizzle/0000_initial.sql': [
      'CREATE TABLE "accounts" (',
      '  "id" uuid PRIMARY KEY NOT NULL,',
      '  "slug" varchar(120) NOT NULL',
      ');',
      '--> statement-breakpoint',
      'CREATE INDEX "accounts_slug_idx" ON "accounts" ("slug");',
    ].join('\n'),
  });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'pg-mig-out-'));

  try {
    // 1. Safe additive migration with Drizzle `--> statement-breakpoint` and `varchar`/`CREATE INDEX` passes `0`.
    populateFiles(dir, {
      'apps/service/drizzle/0001_safe_table.sql': [
        'CREATE TYPE "public"."item_state" AS ENUM(\'draft\', \'published\');--> statement-breakpoint',
        'CREATE TABLE "items" (',
        '  "id" serial PRIMARY KEY NOT NULL,',
        '  "label" varchar(255) NOT NULL,',
        '  "state" "item_state" DEFAULT \'draft\' NOT NULL',
        ');',
        '--> statement-breakpoint',
        'CREATE INDEX "items_label_idx" ON "items" ("label");',
      ].join('\n'),
    });
    commitAll(dir, 'add safe table');

    const cleanOut = path.join(scratch, 'clean-output.txt');
    const cleanRes = executePrCheck({
      sourceDir: dir,
      baseRef: baseSha,
      squawkInstallDir: squawkDir,
      runnerTemp: scratch,
      githubOutput: cleanOut,
    });
    assert.equal(cleanRes.exitCode, 0);
    assert.equal(cleanRes.scope, 'sql');
    assert.equal(cleanRes.state, 'clean');
    assert.equal(cleanRes.report.addedCount, 0);

    // 2. Unsafe migration adding NOT NULL without default, DROP COLUMN, unvalidated FK, and CONCURRENTLY in tx fails `1`.
    populateFiles(dir, {
      'apps/service/drizzle/0002_unsafe_alter.sql': [
        '/* UTF-8 header: 数据库迁移 */ ALTER TABLE "accounts" ADD COLUMN "tier" text NOT NULL;',
        '--> statement-breakpoint',
        'ALTER TABLE "accounts" DROP COLUMN "slug";',
        '--> statement-breakpoint',
        'ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_fk" FOREIGN KEY ("id") REFERENCES "orgs"("id");',
        '--> statement-breakpoint',
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "accounts_tier_idx" ON "accounts" ("tier");',
      ].join('\n'),
    });
    commitAll(dir, 'add unsafe alter');

    const failOut = path.join(scratch, 'fail-output.txt');
    const summaryFile = path.join(scratch, 'summary.md');
    const failRes = executePrCheck({
      sourceDir: dir,
      baseRef: baseSha,
      squawkInstallDir: squawkDir,
      runnerTemp: scratch,
      githubOutput: failOut,
      githubStepSummary: summaryFile,
    });

    assert.equal(failRes.exitCode, 1);
    assert.equal(failRes.state, 'failed');
    assert.equal(failRes.report.checkedFiles, 2);

    const rulesByLine = failRes.report.added.map((r) => `${r.line}:${r.rule}`);
    assert.ok(rulesByLine.includes('1:adding-required-field'), `Got: ${rulesByLine.join(', ')}`);
    assert.ok(rulesByLine.includes('3:ban-drop-column'), `Got: ${rulesByLine.join(', ')}`);
    assert.ok(rulesByLine.includes('5:constraint-missing-not-valid'), `Got: ${rulesByLine.join(', ')}`);
    assert.ok(rulesByLine.includes('5:adding-foreign-key-constraint'), `Got: ${rulesByLine.join(', ')}`);
    assert.ok(
      rulesByLine.includes('7:ban-concurrent-index-creation-in-transaction'),
      `Got: ${rulesByLine.join(', ')}`,
    );

    const summaryMd = readFileSync(summaryFile, 'utf8');
    assert.match(summaryMd, /https:\/\/squawkhq\.com\/docs\/ban-drop-column/);
    assert.match(summaryMd, /allow-unsafe-migration/);
    assert.equal(formatMigrationStepSummary({ ...failRes.report, addedCount: 0, added: [] }), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('diffs modified and renamed historical migrations so comment/format edits pass while new unsafe statements fail', () => {
  const squawkDir = ensureSquawkInstall();
  const { dir, baseSha } = createRepoWithCommit({
    'drizzle/meta/_journal.json': JSON.stringify({ dialect: 'postgresql', version: '7', entries: [] }),
    'drizzle/0001_historical.sql': [
      '-- Historical cutover migration applied in production',
      'CREATE TABLE "audit_events" (',
      '  "id" uuid PRIMARY KEY NOT NULL,',
      '  "actor_id" uuid NOT NULL,',
      '  "payload" jsonb NOT NULL',
      ');',
      '--> statement-breakpoint',
      'ALTER TABLE "members" DROP COLUMN "legacy_flag";',
      '--> statement-breakpoint',
      'ALTER TABLE "members" ADD COLUMN "role" text NOT NULL;',
    ].join('\n'),
  });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'pg-mig-diff-'));

  try {
    // 1. Rename file + add comments + reformat existing unsafe statements -> 0 newly introduced violations!
    execFileSync('git', ['mv', 'drizzle/0001_historical.sql', 'drizzle/0001_historical_renamed.sql'], {
      cwd: dir,
    });
    populateFiles(dir, {
      'drizzle/0001_historical_renamed.sql': [
        '-- Historical cutover migration applied in production (note updated)',
        '-- Second header line shifting every subsequent line number',
        'CREATE TABLE "audit_events" (',
        '  "id" uuid PRIMARY KEY NOT NULL,',
        '  "actor_id" uuid NOT NULL,',
        '  "payload" jsonb NOT NULL',
        ');',
        '--> statement-breakpoint',
        'ALTER TABLE "members"',
        '  DROP COLUMN "legacy_flag"; -- inline comment',
        '--> statement-breakpoint',
        'ALTER TABLE "members" ADD COLUMN "role" text NOT NULL;',
      ].join('\n'),
    });
    const head1 = commitAll(dir, 'rename and reformat historical migration');
    assert.equal(collectChangedSqlEntries(dir, baseSha, head1)[0].kind, 'renamed');

    const res1 = executePrCheck({
      sourceDir: dir,
      baseRef: baseSha,
      squawkInstallDir: squawkDir,
      runnerTemp: scratch,
    });
    assert.equal(res1.exitCode, 0);
    assert.equal(res1.state, 'clean');
    assert.equal(res1.report.beforeCount, 2);
    assert.equal(res1.report.afterCount, 2);
    assert.equal(res1.report.addedCount, 0);

    // 2. Appending a new unsafe DROP COLUMN on another column in that same file flags ONLY the 1 new violation!
    populateFiles(dir, {
      'drizzle/0001_historical_renamed.sql': [
        '-- Historical cutover migration applied in production (note updated)',
        'CREATE TABLE "audit_events" (',
        '  "id" uuid PRIMARY KEY NOT NULL,',
        '  "actor_id" uuid NOT NULL,',
        '  "payload" jsonb NOT NULL',
        ');',
        '--> statement-breakpoint',
        'ALTER TABLE "members" DROP COLUMN "legacy_flag";',
        '--> statement-breakpoint',
        'ALTER TABLE "members" ADD COLUMN "role" text NOT NULL;',
        '--> statement-breakpoint',
        'ALTER TABLE "members" DROP COLUMN "newly_dropped_col";',
      ].join('\n'),
    });
    commitAll(dir, 'append new drop column');

    const res2 = executePrCheck({
      sourceDir: dir,
      baseRef: baseSha,
      squawkInstallDir: squawkDir,
      runnerTemp: scratch,
    });
    assert.equal(res2.exitCode, 1);
    assert.equal(res2.state, 'failed');
    assert.equal(res2.report.addedCount, 1);
    assert.equal(res2.report.added[0].rule, 'ban-drop-column');
    assert.equal(res2.report.added[0].line, 12);

    // Exercise helper signatures directly as well.
    assert.equal(
      stripSqlCommentsAndCollapseWhitespace('ALTER /* c */ TABLE "x"\n  DROP COLUMN "y"; -- end'),
      'ALTER TABLE "x" DROP COLUMN "y";',
    );
    assert.equal(
      extractStatementSignature(['ALTER TABLE "x" DROP COLUMN "y";'], {
        line: 0,
        line_end: 0,
        column: 16,
        column_end: 31,
      }),
      'ALTER TABLE "x" :: DROP COLUMN "y"',
    );
    assert.equal(diffMigrationFindings(res2.report.added, []).resolvedCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('skips ClickHouse-only PRs, honors -- squawk-ignore and allow-unsafe-migration waivers, and respects .squawk.toml', () => {
  const squawkDir = ensureSquawkInstall();
  const { dir, baseSha } = createRepoWithCommit({
    'package.json': JSON.stringify({ name: 'svc', dependencies: { pg: '^8.0.0' } }),
    'README.md': '# Demo\n',
  });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'pg-mig-waive-'));

  try {
    // 1. ClickHouse SQL touched -> `scope=skip`, `state=clean`, `exit 0`.
    populateFiles(dir, {
      'clickhouse/migrations/0001_telemetry.sql':
        'CREATE TABLE telemetry (ts DateTime64(3)) ENGINE = MergeTree ORDER BY ts;',
    });
    commitAll(dir, 'add clickhouse migration');
    const skipOut = path.join(scratch, 'skip.out');
    const skipRes = executePrCheck({
      sourceDir: dir,
      baseRef: baseSha,
      squawkInstallDir: squawkDir,
      runnerTemp: scratch,
      githubOutput: skipOut,
    });
    assert.equal(skipRes.exitCode, 0);
    assert.equal(skipRes.scope, 'skip');
    assert.equal(skipRes.state, 'clean');
    assert.match(readFileSync(skipOut, 'utf8'), /scope=skip/);

    // 2. Inline `-- squawk-ignore` (after `--> statement-breakpoint`) and `-- squawk-ignore-file` pass `exit 0`.
    populateFiles(dir, {
      'migrations/0001_waived_inline.sql': [
        'CREATE TABLE IF NOT EXISTS "orders" ("id" uuid PRIMARY KEY);',
        '--> statement-breakpoint',
        '-- squawk-ignore ban-drop-column',
        'ALTER TABLE "customers" DROP COLUMN IF EXISTS "obsolete_phone";',
      ].join('\n'),
      'migrations/0002_waived_file.sql': [
        '-- squawk-ignore-file',
        'ALTER TABLE "customers" DROP COLUMN "obsolete_fax";',
      ].join('\n'),
    });
    commitAll(dir, 'add inline-ignored migrations');
    const inlineRes = executePrCheck({
      sourceDir: dir,
      baseRef: baseSha,
      squawkInstallDir: squawkDir,
      runnerTemp: scratch,
    });
    assert.equal(inlineRes.exitCode, 0);
    assert.equal(inlineRes.state, 'clean');

    // 3. Unwaived violation waived via `allow-unsafe-migration` PR label -> `state=waived`, `exit 0`.
    assert.equal(hasAllowUnsafeMigrationLabel('["bug","allow-unsafe-migration"]'), true);
    assert.equal(hasAllowUnsafeMigrationLabel('["other"]'), false);
    assert.equal(hasAllowUnsafeMigrationLabel('not-json'), false);

    populateFiles(dir, {
      'migrations/[v2]/0003_unwaived.sql': 'ALTER TABLE "customers" DROP COLUMN "legacy_notes";',
    });
    commitAll(dir, 'add unwaived drop');

    const waivedSummary = path.join(scratch, 'waived-summary.md');
    const waivedRes = executePrCheck({
      sourceDir: dir,
      baseRef: baseSha,
      labelsJson: JSON.stringify(['allow-unsafe-migration']),
      squawkInstallDir: squawkDir,
      runnerTemp: scratch,
      githubStepSummary: waivedSummary,
    });
    assert.equal(waivedRes.exitCode, 0);
    assert.equal(waivedRes.state, 'waived');
    assert.equal(waivedRes.report.waived, true);
    assert.equal(waivedRes.report.addedCount, 1);
    assert.equal(waivedRes.report.added[0].file, 'migrations/[v2]/0003_unwaived.sql');
    assert.match(readFileSync(waivedSummary, 'utf8'), /waived via `allow-unsafe-migration` label/);

    // 4. `.squawk.toml` override (`assume_in_transaction = false` + `excluded_paths`) + symlink safety.
    populateFiles(dir, {
      '.squawk.toml': [
        'assume_in_transaction = false',
        'excluded_paths = ["migrations/[[]v2]/*"]',
      ].join('\n'),
      'migrations/0004_non_concurrent_idx.sql': 'CREATE INDEX IF NOT EXISTS "orders_created_idx" ON "orders" ("id");',
      'migrations/0005_concurrent_idx.sql':
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_conc_idx" ON "orders" ("id");',
    });
    commitAll(dir, 'configure non-transactional squawk toml');

    const tomlRes = executePrCheck({
      sourceDir: dir,
      baseRef: baseSha,
      squawkInstallDir: squawkDir,
      runnerTemp: scratch,
    });
    assert.equal(tomlRes.exitCode, 1);
    assert.equal(tomlRes.report.addedCount, 1);
    assert.equal(tomlRes.report.added[0].file, 'migrations/0004_non_concurrent_idx.sql');
    assert.equal(tomlRes.report.added[0].rule, 'require-concurrent-index-creation');

    // Direct `runSquawkScan` check with dash-prefixed filename and symlinked `.squawk.toml` ignored.
    const outsideFile = path.join(scratch, 'outside.toml');
    writeFileSync(outsideFile, 'excluded_rules = ["ban-drop-column"]\n', 'utf8');
    rmSync(path.join(dir, '.squawk.toml'), { force: true });
    symlinkSync(outsideFile, path.join(dir, '.squawk.toml'));
    populateFiles(dir, {
      'migrations/-e=ban-drop-column.sql': 'ALTER TABLE "customers" DROP COLUMN "x";',
    });
    const symlinkProfile = resolveSquawkProfile(dir, 'migrations/-e=ban-drop-column.sql');
    assert.equal(symlinkProfile.tomlRelDir, null);
    const dashFindings = runSquawkScan({
      targetDir: dir,
      squawkInstallDir: squawkDir,
      tempDir: scratch,
      side: 'dash',
      files: ['migrations/-e=ban-drop-column.sql'],
      profile: symlinkProfile,
    });
    assert.equal(dashFindings.length, 1);
    assert.equal(dashFindings[0].rule, 'ban-drop-column');

    // 5. Unreachable BASE SHA fails open (`state=unavailable`, `exit 0`).
    const unavailOut = path.join(scratch, 'unavail.out');
    const unavailRes = executePrCheck({
      sourceDir: dir,
      baseRef: 'deadbeef'.repeat(5),
      squawkInstallDir: squawkDir,
      runnerTemp: scratch,
      githubOutput: unavailOut,
    });
    assert.equal(unavailRes.exitCode, 0);
    assert.equal(unavailRes.state, 'unavailable');
    assert.match(readFileSync(unavailOut, 'utf8'), /state=unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('auto-detects non-transactional filename and leading header markers unless .squawk.toml sets assume_in_transaction', () => {
  const squawkDir = ensureSquawkInstall();
  assert.equal(isNonTransactionalMigrationFile('migrations/0001.nontransactional.sql', ''), true);
  assert.equal(isNonTransactionalMigrationFile('migrations/0001.no-transaction.sql', ''), true);
  assert.equal(
    isNonTransactionalMigrationFile(
      'migrations/0001.sql',
      '/* header */\n-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY idx ON t (c);',
    ),
    true,
  );
  assert.equal(
    isNonTransactionalMigrationFile(
      'migrations/0001.sql',
      '-- scope:no-transaction\nDROP INDEX CONCURRENTLY idx;',
    ),
    true,
  );
  assert.equal(
    isNonTransactionalMigrationFile(
      'migrations/0001.sql',
      '-- nontransactional\nCREATE INDEX CONCURRENTLY idx ON t (c);',
    ),
    true,
  );
  assert.equal(
    isNonTransactionalMigrationFile(
      'migrations/0001.sql',
      'CREATE TABLE t (id int);\n-- migrate:no-transaction after first statement',
    ),
    false,
  );

  const { dir, baseSha } = createRepoWithCommit({
    'package.json': JSON.stringify({ name: 'svc', dependencies: { pg: '^8.12.0' } }),
    'billing-migrations/0000_init.sql': 'CREATE TABLE "invoices" ("id" bigint PRIMARY KEY);',
  });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'pg-mig-nontx-'));

  try {
    // 1. Concurrent indexes in `*.nontransactional.sql`, `*.no-transaction.sql`, and `-- migrate:no-transaction` pass cleanly.
    populateFiles(dir, {
      'billing-migrations/0001_idx.nontransactional.sql':
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "invoices_a_idx" ON "invoices" ("id");',
      'billing-migrations/0002_idx.no-transaction.sql':
        'DROP INDEX CONCURRENTLY IF EXISTS "invoices_a_idx";',
      'billing-migrations/0003_hdr.sql': [
        '-- migrate:no-transaction',
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "invoices_b_idx" ON "invoices" ("id");',
      ].join('\n'),
    });
    commitAll(dir, 'add valid concurrent index migrations');

    const cleanRes = executePrCheck({
      sourceDir: dir,
      baseRef: baseSha,
      squawkInstallDir: squawkDir,
      runnerTemp: scratch,
    });
    assert.equal(cleanRes.exitCode, 0);
    assert.equal(cleanRes.state, 'clean');
    assert.equal(cleanRes.report.checkedFiles, 3);
    assert.equal(cleanRes.report.addedCount, 0);

    // 2. Non-concurrent `CREATE INDEX` in explicitly non-transactional files triggers `require-concurrent-index-creation`.
    populateFiles(dir, {
      'billing-migrations/0004_blocking.no-transaction.sql':
        'CREATE INDEX IF NOT EXISTS "invoices_blocking_idx" ON "invoices" ("id");',
      'billing-migrations/0005_blocking_hdr.sql': [
        '-- scope:no-transaction',
        'CREATE INDEX IF NOT EXISTS "invoices_blocking_hdr_idx" ON "invoices" ("id");',
      ].join('\n'),
    });
    commitAll(dir, 'add blocking indexes in non-transactional files');

    const failRes = executePrCheck({
      sourceDir: dir,
      baseRef: baseSha,
      squawkInstallDir: squawkDir,
      runnerTemp: scratch,
    });
    assert.equal(failRes.exitCode, 1);
    assert.equal(failRes.report.addedCount, 2);
    assert.deepEqual(
      failRes.report.added.map((r) => [r.file, r.rule]),
      [
        ['billing-migrations/0004_blocking.no-transaction.sql', 'require-concurrent-index-creation'],
        ['billing-migrations/0005_blocking_hdr.sql', 'require-concurrent-index-creation'],
      ],
    );

    // 3. Explicit `assume_in_transaction = true` in `.squawk.toml` overrides automatic file markers.
    populateFiles(dir, {
      '.squawk.toml': 'assume_in_transaction = true',
    });
    const explicitProfile = resolveSquawkProfile(
      dir,
      'billing-migrations/0001_idx.nontransactional.sql',
    );
    assert.equal(explicitProfile.assumeInTransaction, true);
    assert.equal(
      CONCURRENT_INDEX_RULES.every((r) => explicitProfile.excludedRules.includes(r)),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('handles TOML whitespace/continuations, quoted SQL identifiers, comment semicolons, typechange, and metadata-added renames', () => {
  const squawkDir = ensureSquawkInstall();

  // TOML U+00A0 non-breaking space does not hang and returns empty fallback profile.
  assert.deepEqual(parseSquawkToml('pg_version =\u00a0"16.0"'), {});

  // Multiline basic string continuation with trailing spaces before newline.
  assert.deepEqual(parseSquawkToml('pg_version = """16.\\   \n  4"""'), { pg_version: '16.4' });

  // Whitespace inside quoted identifiers/literals stays intact while outer whitespace collapses.
  const normSingleSpace = stripSqlCommentsAndCollapseWhitespace(
    'ALTER   TABLE  "accounts"   DROP COLUMN "old flag"',
  );
  const normDoubleSpace = stripSqlCommentsAndCollapseWhitespace(
    'ALTER TABLE "accounts" DROP COLUMN "old  flag"',
  );
  assert.notEqual(normSingleSpace, normDoubleSpace);
  assert.equal(normDoubleSpace, 'ALTER TABLE "accounts" DROP COLUMN "old  flag"');

  // Semicolons inside `--` and `/* */` comments do not split statement prefix signatures.
  const baseLines = [
    'CREATE TABLE "accounts" ("id" bigint);',
    'ALTER TABLE "accounts" DROP COLUMN "legacy";',
  ];
  const commentedLines = [
    'CREATE TABLE "accounts" ("id" bigint);',
    '-- historical note; keep context',
    '/* block comment; another semi */',
    'ALTER TABLE "accounts" DROP COLUMN "legacy";',
  ];
  const baseSig = extractStatementSignature(baseLines, {
    line: 1,
    line_end: 1,
    column: 23,
    column_end: 43,
  });
  const commentedSig = extractStatementSignature(commentedLines, {
    line: 3,
    line_end: 3,
    column: 23,
    column_end: 43,
  });
  assert.equal(commentedSig, baseSig);

  // Repo where base has SQL without `pg` yet, plus a symlinked SQL file.
  const { dir, baseSha } = createRepoWithCommit({
    'package.json': JSON.stringify({ name: 'app', dependencies: {} }),
    'migrations/0001_old.sql': 'ALTER TABLE "accounts" DROP COLUMN "legacy";',
    'notes/target.txt': 'placeholder',
  });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'pg-mig-edge-'));

  try {
    // Commit base symlink for typechange test.
    symlinkSync('../notes/target.txt', path.join(dir, 'migrations/0002_replaced.sql'));
    const symlinkBaseSha = commitAll(dir, 'add symlinked sql');

    // Now add `pg` to package.json, rename `0001_old.sql` -> `0001_renamed.sql` with a semicolon comment,
    // replace symlink `0002_replaced.sql` with a regular SQL file dropping quoted `"UInt64"` column!
    rmSync(path.join(dir, 'migrations/0001_old.sql'));
    rmSync(path.join(dir, 'migrations/0002_replaced.sql'));
    populateFiles(dir, {
      'package.json': JSON.stringify({ name: 'app', dependencies: { pg: '^8.12.0' } }),
      'migrations/0001_renamed.sql': [
        '-- renamed migration; SQL unchanged',
        'ALTER TABLE "accounts" DROP COLUMN "legacy";',
      ].join('\n'),
      'migrations/0002_replaced.sql': 'ALTER TABLE "accounts" DROP COLUMN "UInt64";',
    });
    const headSha = commitAll(dir, 'enable pg, rename old sql, replace symlink with UInt64 drop');

    // Quoted `"UInt64"` Postgres identifier must NOT be skipped as ClickHouse!
    const uintDecision = classifySqlFile(
      dir,
      'migrations/0002_replaced.sql',
      createClassifierCache(dir),
    );
    assert.equal(uintDecision.include, true);

    const changed = collectChangedSqlEntries(dir, symlinkBaseSha, headSha);
    assert.deepEqual(
      changed.map((c) => [c.kind, c.headFile]),
      [
        ['renamed', 'migrations/0001_renamed.sql'],
        ['added', 'migrations/0002_replaced.sql'],
      ],
    );

    const checkRes = executePrCheck({
      sourceDir: dir,
      baseRef: symlinkBaseSha,
      squawkInstallDir: squawkDir,
      runnerTemp: scratch,
    });
    assert.equal(checkRes.exitCode, 1);
    // `0001_renamed.sql` had pre-existing DROP COLUMN in base -> 0 new findings;
    // `0002_replaced.sql` replaced symlink and drops `"UInt64"` -> 1 new finding!
    assert.equal(checkRes.report.checkedFiles, 2);
    assert.equal(checkRes.report.addedCount, 1);
    assert.equal(checkRes.report.added[0].file, 'migrations/0002_replaced.sql');
    assert.equal(checkRes.report.added[0].rule, 'ban-drop-column');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('handles escaped multiline TOML quotes, embedded $ identifiers, >16KiB headers, BOM offsets, icase .Sql, and opted-in dir renames', () => {
  const squawkDir = ensureSquawkInstall();

  // Escaped quotes inside `"""..."""` do not prematurely close the multiline string.
  assert.deepEqual(
    parseSquawkToml('note = """a \\""" b"""\nassume_in_transaction = false'),
    { assume_in_transaction: false },
  );

  // Embedded `$` inside an SQL identifier does not open an unclosed dollar quote.
  const embeddedDollarBase = [
    'SELECT 1 AS foo$tag$;',
    'ALTER TABLE "accounts" DROP COLUMN "legacy";',
  ];
  const embeddedDollarCommented = [
    'SELECT 1 AS foo$tag$;',
    '-- added context comment',
    'ALTER TABLE "accounts" DROP COLUMN "legacy";',
  ];
  assert.equal(
    extractStatementSignature(embeddedDollarCommented, {
      line: 2,
      line_end: 2,
      column: 23,
      column_end: 43,
    }),
    extractStatementSignature(embeddedDollarBase, {
      line: 1,
      line_end: 1,
      column: 23,
      column_end: 43,
    }),
  );

  // >16 KiB leading license comment before `-- migrate:no-transaction` still triggers non-transactional mode.
  const longComment = `-- ${'x'.repeat(18 * 1024)}\n-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY idx ON t (c);`;
  assert.equal(isNonTransactionalMigrationFile('migrations/01.sql', longComment), true);

  const { dir, baseSha } = createRepoWithCommit({
    'package.json': JSON.stringify({ name: 'svc2', dependencies: { pg: '^8.12.0' } }),
    'migrations/0001_bom.sql': 'ALTER TABLE "accounts" DROP COLUMN "legacy_bom";',
    'tests/.squawk.toml': 'pg_version = "17.0"',
    'tests/old/0001_optin.sql': 'ALTER TABLE "accounts" DROP COLUMN "legacy_optin";',
  });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'pg-mig-followup-'));

  try {
    rmSync(path.join(dir, 'tests/old/0001_optin.sql'));
    populateFiles(dir, {
      // Prepend UTF-8 BOM to existing first-line DROP COLUMN -> must remain 0 added findings.
      'migrations/0001_bom.sql': '\ufeffALTER TABLE "accounts" DROP COLUMN "legacy_bom";',
      // Rename from `tests/old` (with `tests/.squawk.toml`) to `fixtures/new` (with `fixtures/.squawk.toml`) -> 0 added findings.
      'fixtures/.squawk.toml': 'pg_version = "17.0"',
      'fixtures/new/0001_optin.sql': 'ALTER TABLE "accounts" DROP COLUMN "legacy_optin";',
      // Mixed-case `.Sql` in compound hyphenated `customer-billing-migrations` with `-- dialect: sqlite` inside dollar-quoted body -> scanned and flagged!
      'customer-billing-migrations/0002_func.Sql': [
        'CREATE OR REPLACE FUNCTION demo() RETURNS text LANGUAGE sql AS $fn$',
        '-- dialect: sqlite',
        "SELECT 'ok'::text;",
        '$fn$;',
        'ALTER TABLE "accounts" DROP COLUMN "newly_dropped";',
      ].join('\n'),
    });
    commitAll(dir, 'test bom, opt-in dir rename, compound dir, and dollar-quoted dialect line');

    const res = executePrCheck({
      sourceDir: dir,
      baseRef: baseSha,
      squawkInstallDir: squawkDir,
      runnerTemp: scratch,
    });
    assert.equal(res.exitCode, 1);
    assert.equal(res.report.checkedFiles, 3);
    assert.equal(res.report.addedCount, 1);
    assert.equal(res.report.added[0].file, 'customer-billing-migrations/0002_func.Sql');
    assert.equal(res.report.added[0].rule, 'ban-drop-column');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

