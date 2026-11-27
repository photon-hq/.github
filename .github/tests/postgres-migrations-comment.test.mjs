import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflowYaml = readFileSync(new URL('../workflows/check-postgres-migrations.yml', import.meta.url));
const commentScript = execFileSync(
  'ruby',
  [
    '-ryaml',
    '-e',
    "print YAML.safe_load(STDIN.read).fetch('jobs').fetch('comment').fetch('steps').first.fetch('with').fetch('script')",
  ],
  { input: workflowYaml, encoding: 'utf8' },
);
const runCommentStep = new (async () => {}).constructor('context', 'github', 'process', commentScript);

const MERGE_BASE = '1'.repeat(40);
const BASE_TIP = '2'.repeat(40);
const HEAD_TIP = '3'.repeat(40);

function buildGithubHarness(initialPr, seededComments = []) {
  let livePr = initialPr;
  let items = [...seededComments];
  let seq = 500;
  const stats = { created: 0, updated: 0, deleted: 0 };

  const github = {
    paginate: async () => items,
    rest: {
      pulls: {
        get: async () => ({ data: livePr }),
      },
      issues: {
        createComment: async ({ body }) => {
          stats.created++;
          items.push({ id: seq++, user: { login: 'github-actions[bot]' }, body });
        },
        updateComment: async ({ comment_id, body }) => {
          stats.updated++;
          const row = items.find((c) => c.id === comment_id);
          assert.ok(row, `Missing comment ${comment_id}`);
          row.body = body;
        },
        deleteComment: async ({ comment_id }) => {
          stats.deleted++;
          items = items.filter((c) => c.id !== comment_id);
        },
      },
    },
  };

  return {
    github,
    stats,
    list: () => items,
    setLivePr: (next) => {
      livePr = next;
    },
  };
}

function makePr(overrides = {}) {
  return {
    number: 88,
    state: 'open',
    head: { sha: HEAD_TIP },
    base: { ref: 'main', sha: BASE_TIP },
    labels: [],
    ...overrides,
  };
}

function makeContext(pr) {
  return {
    repo: { owner: 'example', repo: 'service' },
    payload: { pull_request: pr },
    serverUrl: 'https://github.com',
  };
}

test('stays completely silent on clean, skipped, or unavailable runs when no prior squawk comment exists', async () => {
  const pr = makePr();
  const ctx = makeContext(pr);
  const { github, stats, list } = buildGithubHarness(pr, [
    { id: 1, user: { login: 'github-actions[bot]' }, body: '<!-- photon-knip -->\n### Unused code' },
    { id: 2, user: { login: 'reviewer' }, body: '<!-- photon-squawk --> manual comment' },
  ]);

  for (const env of [
    { SCOPE: 'skip', STATE: 'clean' },
    { SCOPE: 'unavailable', STATE: 'unavailable' },
    {
      SCOPE: 'sql',
      STATE: 'clean',
      REPORT: JSON.stringify({
        base: MERGE_BASE,
        checkedFiles: 1,
        beforeCount: 0,
        afterCount: 0,
        addedCount: 0,
        resolvedCount: 0,
        waived: false,
        added: [],
      }),
    },
  ]) {
    await runCommentStep(ctx, github, { env });
  }

  assert.deepEqual(stats, { created: 0, updated: 0, deleted: 0 });
  assert.equal(list().length, 2);
});

test('creates, updates, waives, and deletes sticky <!-- photon-squawk --> comments across pushes', async () => {
  const pr = makePr();
  const ctx = makeContext(pr);
  const { github, stats, list, setLivePr } = buildGithubHarness(pr, [
    { id: 10, user: { login: 'github-actions[bot]' }, body: '<!-- photon-jscpd -->\n### Duplicated code' },
  ]);

  // 1. First push introduces 2 unsafe DDL violations -> posts sticky comment with rule links, impact, and waiver hints.
  await runCommentStep(ctx, github, {
    env: {
      SCOPE: 'sql',
      STATE: 'failed',
      REPORT: JSON.stringify({
        base: MERGE_BASE,
        checkedFiles: 1,
        beforeCount: 0,
        afterCount: 2,
        addedCount: 2,
        resolvedCount: 0,
        waived: false,
        added: [
          {
            file: 'drizzle/0002_alter_<users>.sql',
            line: 4,
            rule: 'adding-required-field',
            message: 'adding a new column that is `not null` without a default',
            help: 'make the field nullable or add a non-volatile default',
            note: 'statement requires: `access exclusive` lock',
          },
          {
            file: 'drizzle/0002_alter_<users>.sql',
            line: 9,
            rule: 'syntax-error',
            message: 'expected command, found `<script>`',
            help: '',
            note: '',
          },
        ],
      }),
    },
  });

  assert.deepEqual(stats, { created: 1, updated: 0, deleted: 0 });
  assert.equal(list().length, 2);
  const posted = list()[1].body;
  assert.ok(posted.startsWith('<!-- photon-squawk -->\n### PostgreSQL migration check\n\n'));
  assert.match(posted, /2 new unsafe PostgreSQL migration violations/);
  assert.match(posted, /https:\/\/squawkhq\.com\/docs\/adding-required-field/);
  assert.match(posted, /https:\/\/squawkhq\.com\/docs\/rules/);
  assert.match(posted, /drizzle\/0002_alter_%3Cusers%3E\.sql#L4/);
  assert.doesNotMatch(posted, /<script>/);
  assert.doesNotMatch(posted, /<users>/);
  assert.match(posted, /-- squawk-ignore adding-required-field/);
  assert.match(posted, /allow-unsafe-migration/);

  // 2. Apply `allow-unsafe-migration` label -> updates same comment in place with waived status.
  setLivePr(makePr({ labels: [{ name: 'allow-unsafe-migration' }] }));
  await runCommentStep(ctx, github, {
    env: {
      SCOPE: 'sql',
      STATE: 'waived',
      REPORT: JSON.stringify({
        base: MERGE_BASE,
        checkedFiles: 1,
        beforeCount: 1,
        afterCount: 1,
        addedCount: 1,
        resolvedCount: 1,
        waived: true,
        added: [
          {
            file: 'drizzle/0002_alter.sql',
            line: 3,
            rule: 'ban-drop-column',
            message: 'dropping a column may break existing clients',
            help: '',
            note: '',
          },
        ],
      }),
    },
  });

  assert.deepEqual(stats, { created: 1, updated: 1, deleted: 0 });
  assert.match(list()[1].body, /waived via `allow-unsafe-migration` label/);
  assert.match(list()[1].body, /resolved 1 pre-existing/);

  // 3. Subsequent push resolves all migration violations (`SCOPE=skip` or `STATE=clean`) -> deletes stale squawk comment!
  setLivePr(makePr({ labels: [] }));
  await runCommentStep(ctx, github, {
    env: { SCOPE: 'skip', STATE: 'clean' },
  });
  assert.deepEqual(stats, { created: 1, updated: 1, deleted: 1 });
  assert.equal(list().length, 1);
  assert.equal(list()[0].id, 10);
});

test('collapses >10 findings into details, deduplicates bot comments, and guards against stale PR state', async () => {
  const pr = makePr();
  const ctx = makeContext(pr);
  const { github, stats, list, setLivePr } = buildGithubHarness(pr, [
    { id: 30, user: { login: 'github-actions[bot]' }, body: '<!-- photon-squawk -->\nfirst' },
    { id: 31, user: { login: 'github-actions[bot]' }, body: '<!-- photon-squawk -->\nduplicate' },
  ]);

  const fifteen = Array.from({ length: 15 }, (_, idx) => ({
    file: `drizzle/00${idx + 10}_step.sql`,
    line: idx + 1,
    rule: 'ban-drop-column',
    message: 'dropping a column may break existing clients',
    help: '',
    note: '',
  }));

  await runCommentStep(ctx, github, {
    env: {
      SCOPE: 'sql',
      STATE: 'failed',
      REPORT: JSON.stringify({
        base: MERGE_BASE,
        checkedFiles: 15,
        beforeCount: 0,
        afterCount: 15,
        addedCount: 15,
        resolvedCount: 0,
        waived: false,
        added: fifteen,
      }),
    },
  });

  assert.deepEqual(stats, { created: 0, updated: 1, deleted: 1 });
  assert.equal(list().length, 1);
  assert.equal(list()[0].id, 30);
  assert.match(list()[0].body, /<details><summary>5 more shown<\/summary>/);

  // Stale head SHA, retargeted base branch, or mismatched live waiver label must not overwrite or delete comment!
  setLivePr(makePr({ labels: [{ name: 'allow-unsafe-migration' }] }));
  await runCommentStep(ctx, github, {
    env: {
      SCOPE: 'sql',
      STATE: 'failed',
      REPORT: JSON.stringify({
        base: MERGE_BASE,
        checkedFiles: 1,
        beforeCount: 0,
        afterCount: 1,
        addedCount: 1,
        resolvedCount: 0,
        waived: false,
        added: [fifteen[0]],
      }),
    },
  });
  setLivePr(makePr({ base: { ref: 'release', sha: BASE_TIP } }));
  await runCommentStep(ctx, github, { env: { SCOPE: 'skip', STATE: 'clean' } });
  setLivePr(makePr({ head: { sha: '9'.repeat(40) } }));
  await runCommentStep(ctx, github, { env: { SCOPE: 'skip', STATE: 'clean' } });

  assert.deepEqual(stats, { created: 0, updated: 1, deleted: 1 });
  assert.equal(list().length, 1);
});
