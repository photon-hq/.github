import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/check-unused-code.yml', import.meta.url));
const script = execFileSync(
  'ruby',
  [
    '-ryaml',
    '-e',
    "print YAML.safe_load(STDIN.read).fetch('jobs').fetch('comment').fetch('steps').first.fetch('with').fetch('script')",
  ],
  { input: workflow, encoding: 'utf8' },
);
const publish = new (async () => {}).constructor('context', 'github', 'process', script);

const BASE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'a'.repeat(40);

function createMockGithub(initialPr, initialComments = []) {
  let currentPr = initialPr;
  let comments = [...initialComments];
  let nextId = 100;
  const calls = { created: 0, updated: 0, deleted: 0 };

  const github = {
    paginate: async () => comments,
    rest: {
      pulls: {
        get: async () => ({ data: currentPr }),
      },
      issues: {
        createComment: async ({ body }) => {
          calls.created++;
          comments.push({ id: nextId++, user: { login: 'github-actions[bot]' }, body });
        },
        updateComment: async ({ comment_id, body }) => {
          calls.updated++;
          const target = comments.find((c) => c.id === comment_id);
          assert.ok(target, `Expected comment ${comment_id} to exist`);
          target.body = body;
        },
        deleteComment: async ({ comment_id }) => {
          calls.deleted++;
          comments = comments.filter((c) => c.id !== comment_id);
        },
      },
    },
  };

  return {
    github,
    calls,
    getComments: () => comments,
    setCurrentPr: (pr) => {
      currentPr = pr;
    },
  };
}

test('stays silent on clean PRs with zero new and zero resolved items', async () => {
  const pr = { number: 12, state: 'open', head: { sha: HEAD_SHA } };
  const context = {
    repo: { owner: 'example', repo: 'demo' },
    payload: { pull_request: pr },
    serverUrl: 'https://github.com',
  };
  const { github, calls, getComments } = createMockGithub(pr);

  await publish(context, github, {
    env: {
      SCOPE: 'js',
      STATE: 'clean',
      REPORT: JSON.stringify({
        base: BASE_SHA,
        before: { files: 1, exports: 4, duplicates: 0, dependencies: 0 },
        after: { files: 1, exports: 4, duplicates: 0, dependencies: 0 },
        addedCount: 0,
        resolvedCount: 0,
        waived: false,
        added: [],
      }),
    },
  });

  assert.equal(getComments().length, 0);
  assert.deepEqual(calls, { created: 0, updated: 0, deleted: 0 });
});

test('creates, updates on resolution or waiver, escapes HTML/URLs, and deletes once clean', async () => {
  const pr = { number: 15, state: 'open', head: { sha: HEAD_SHA } };
  const context = {
    repo: { owner: 'example', repo: 'demo' },
    payload: { pull_request: pr },
    serverUrl: 'https://github.com',
  };
  const { github, calls, getComments, setCurrentPr } = createMockGithub(pr, [
    { id: 1, user: { login: 'contributor' }, body: '<!-- photon-knip --> user note' },
    { id: 2, user: { login: 'github-actions[bot]' }, body: '<!-- photon-jscpd -->\n### Duplicated code' },
  ]);

  // 1. Introduce 12 findings (including special path/symbol characters) -> creates comment with 10 visible + details overflow.
  const added = Array.from({ length: 12 }, (_, i) => ({
    category: i === 0 ? 'dependencies' : i === 1 ? 'files' : 'exports',
    file: i === 0 ? 'package.json' : `src/dir #${i}/<item>.ts`,
    symbol: i === 0 ? 'left-pad' : i === 1 ? '' : `deadFn_${i}<T>`,
    line: i + 3,
  }));

  await publish(context, github, {
    env: {
      SCOPE: 'js',
      STATE: 'failed',
      REPORT: JSON.stringify({
        base: BASE_SHA,
        before: { files: 0, exports: 2, duplicates: 0, dependencies: 0 },
        after: { files: 1, exports: 12, duplicates: 0, dependencies: 1 },
        addedCount: 12,
        resolvedCount: 0,
        waived: false,
        added,
      }),
    },
  });

  assert.equal(calls.created, 1);
  assert.equal(getComments().length, 3);
  const created = getComments()[2].body;
  assert.ok(created.startsWith('<!-- photon-knip -->\n### Unused code\n\n'));
  assert.ok(
    created.includes(
      [
        `| Category | Before \`bbbbbbb\` | After \`aaaaaaa\` |`,
        '| --- | ---: | ---: |',
        '| Unused files | 0 | 1 |',
        '| Unused exports & types | 2 | 12 |',
        '| Duplicate exports | 0 | 0 |',
        '| New unused dependencies | 0 | 1 |',
      ].join('\n'),
    ),
  );
  assert.match(created, /\*\*12 new unused items\*\*[\s\S]*\/\*\* @public \*\/[\s\S]*allow-unused/);
  const [visible, overflow] = created.split('<details>');
  assert.equal(visible.match(/^- /gm).length, 10);
  assert.equal(overflow.match(/^- /gm).length, 2);
  assert.match(visible, /src\/dir%20%231\/%3Citem%3E\.ts#L4"><code>src\/dir #1\/&lt;item&gt;\.ts:4<\/code><\/a>/);
  assert.match(visible, /<code>deadFn_2&lt;T&gt;<\/code>/);
  assert.doesNotMatch(created, /<item>/);

  // 2. Label waiver updates status line in place.
  await publish(context, github, {
    env: {
      SCOPE: 'js',
      STATE: 'waived',
      REPORT: JSON.stringify({
        base: BASE_SHA,
        before: { files: 0, exports: 2, duplicates: 0, dependencies: 0 },
        after: { files: 0, exports: 3, duplicates: 0, dependencies: 0 },
        addedCount: 1,
        resolvedCount: 1,
        waived: true,
        added: [{ category: 'exports', file: 'src/api.ts', symbol: 'nextStep', line: 9 }],
      }),
    },
  });
  assert.equal(calls.updated, 1);
  assert.match(
    getComments()[2].body,
    /\*\*1 new unused item\*\* \(waived via `allow-unused` label\) · resolved 1 pre-existing\./,
  );

  // 3. Resolving pre-existing items with 0 new celebrates resolution.
  await publish(context, github, {
    env: {
      SCOPE: 'js',
      STATE: 'clean',
      REPORT: JSON.stringify({
        base: BASE_SHA,
        before: { files: 1, exports: 4, duplicates: 0, dependencies: 0 },
        after: { files: 0, exports: 2, duplicates: 0, dependencies: 0 },
        addedCount: 0,
        resolvedCount: 3,
        waived: false,
        added: [],
      }),
    },
  });
  assert.equal(calls.updated, 2);
  assert.match(getComments()[2].body, /Resolved 3 pre-existing unused items · 0 new\./);

  // 4. Stale run on an older SHA does not overwrite or delete the comment.
  setCurrentPr({ ...pr, head: { sha: 'c'.repeat(40) } });
  await publish(context, github, {
    env: {
      SCOPE: 'js',
      STATE: 'clean',
      REPORT: JSON.stringify({
        base: BASE_SHA,
        before: { files: 1, exports: 4, duplicates: 0, dependencies: 0 },
        after: { files: 1, exports: 4, duplicates: 0, dependencies: 0 },
        addedCount: 0,
        resolvedCount: 0,
        waived: false,
        added: [],
      }),
    },
  });
  assert.equal(calls.deleted, 0);
  assert.equal(getComments().length, 3);

  // 5. Subsequent push on current SHA resolves all PR-introduced items (0 added, 0 resolved vs base) -> deletes bot comment!
  setCurrentPr(pr);
  await publish(context, github, {
    env: {
      SCOPE: 'js',
      STATE: 'clean',
      REPORT: JSON.stringify({
        base: BASE_SHA,
        before: { files: 1, exports: 4, duplicates: 0, dependencies: 0 },
        after: { files: 1, exports: 4, duplicates: 0, dependencies: 0 },
        addedCount: 0,
        resolvedCount: 0,
        waived: false,
        added: [],
      }),
    },
  });
  assert.equal(calls.deleted, 1);
  assert.equal(getComments().length, 2);
  assert.equal(getComments()[0].id, 1);
  assert.equal(getComments()[1].id, 2);
});

test('skip and unavailable states stay silent or clean up an outdated bot comment', async () => {
  const pr = { number: 21, state: 'open', head: { sha: HEAD_SHA } };
  const context = {
    repo: { owner: 'example', repo: 'demo' },
    payload: { pull_request: pr },
    serverUrl: 'https://github.com',
  };
  const { github, calls, getComments } = createMockGithub(pr, [
    { id: 9, user: { login: 'github-actions[bot]' }, body: '<!-- photon-knip -->\n### Unused code' },
  ]);

  await publish(context, github, { env: { SCOPE: 'skip' } });
  assert.equal(calls.deleted, 1);
  assert.equal(getComments().length, 0);

  await publish(context, github, { env: { SCOPE: 'js', STATE: 'unavailable' } });
  assert.equal(calls.created, 0);
  assert.equal(getComments().length, 0);

  // Oversized path respects 65536 GitHub comment limit and prints truncation summary.
  await publish(context, github, {
    env: {
      SCOPE: 'js',
      STATE: 'failed',
      REPORT: JSON.stringify({
        base: BASE_SHA,
        before: { files: 0, exports: 0, duplicates: 0, dependencies: 0 },
        after: { files: 0, exports: 1, duplicates: 0, dependencies: 0 },
        addedCount: 1,
        resolvedCount: 0,
        waived: false,
        added: [{ category: 'exports', file: `${'a'.repeat(33000)}.ts`, symbol: 'x', line: 1 }],
      }),
    },
  });
  assert.equal(getComments().length, 1);
  assert.ok(getComments()[0].body.length < 65536);
  assert.match(getComments()[0].body, /Showing 0 of 1 findings\./);
});
