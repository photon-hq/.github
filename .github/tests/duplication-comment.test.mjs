import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/report-duplicated-code.yml', import.meta.url));
const script = execFileSync('ruby', ['-ryaml', '-e',
  "print YAML.safe_load(STDIN.read).fetch('jobs').fetch('comment').fetch('steps').first.fetch('with').fetch('script')"
], { input: workflow, encoding: 'utf8' });
const publish = new (async () => {}).constructor('context', 'github', 'process', script);

test('one report is created, updated on a clean push, and not overwritten by a stale run', async () => {
  const comments = [];
  const pr = { number: 1, state: 'open', head: { sha: 'abc' } };
  const context = { repo: { owner: 'example', repo: 'demo' }, payload: { pull_request: pr }, serverUrl: 'https://github.com' };
  const github = {
    paginate: async () => comments,
    rest: {
      pulls: { get: async () => ({ data: pr }) },
      issues: {
        createComment: async ({ body }) => comments.push({ id: 1, user: { login: 'github-actions[bot]' }, body }),
        updateComment: async ({ comment_id, body }) => { assert.equal(comment_id, 1); comments[0].body = body; },
      },
    },
  };
  const existing = { percentage: 20, duplicatedLines: 10, clones: 1, sources: 3 };
  const larger = { percentage: 28.5714, duplicatedLines: 20, clones: 2, sources: 4 };
  const empty = { percentage: 0, duplicatedLines: 0, clones: 0, sources: 0 };
  const scan = (count, rows, before = existing, after = existing) => publish(context, github, {
    env: { REPORT: JSON.stringify({ base: 'b'.repeat(40), before, after, count, rows }) },
  });
  await scan(1, [[['a #1.ts', 1, 8], ['b.ts', 4, 11]]], existing, larger);
  assert.ok(comments[0].body.includes([
    '### Duplicated code', '', '| Metric | Before | After |', '| --- | --- | --- |',
    '| Revision | `bbbbbbb` (merge base) | `abc` (PR head) |',
    '| Duplicated lines (%) | 20.00% | 28.57% |', '| Duplicate line count | 10 | 20 |',
    '| Clone pairs | 1 | 2 |', '| Scanned source files | 3 | 4 |', '', 'New clone pairs: **1**',
  ].join('\n')));
  assert.match(comments[0].body, /a%20%231\.ts#L1-L8/);
  await scan(0, []);
  assert.ok(comments[0].body.includes('| Scanned source files | 3 | 3 |\n\nNo new duplicated code.'));
  await scan(0, [], empty, empty);
  assert.ok(comments[0].body.includes('| Duplicated lines (%) | — | — |'));
  assert.ok(comments[0].body.includes('| Scanned source files | 0 (no files scanned) | 0 (no files scanned) |'));
  await publish(context, github, { env: {} });
  assert.match(comments[0].body, /Scan unavailable/);
  context.payload.pull_request = { ...pr, head: { sha: 'old' } };
  await scan(0, []);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /Scan unavailable/);
});

test('dropping JS/TS removes only the current report, and a second run is a no-op', async () => {
  const marker = '<!-- photon-jscpd -->';
  const bot = { login: 'github-actions[bot]' };
  const other = [
    { id: 1, user: { login: 'contributor' }, body: marker },
    { id: 2, user: bot, body: 'A different check' },
  ];
  let comments = [...other, { id: 3, user: bot, body: marker + '\nNew clone pairs: **1**' }];
  const pr = { number: 7, head: { sha: 'last-js-removed' } };
  const context = { repo: { owner: 'example', repo: 'demo' }, payload: { pull_request: pr } };
  let current = { state: 'open', head: { sha: 'newer' } };
  const github = {
    paginate: async () => comments,
    rest: {
      pulls: { get: async () => ({ data: current }) },
      issues: { deleteComment: async ({ comment_id }) => {
        assert.equal(comment_id, 3);
        comments = comments.filter(c => c.id !== comment_id);
      } },
    },
  };
  const skip = () => publish(context, github, { env: { SCOPE: 'skip' } });
  await skip();
  assert.equal(comments.length, 3);
  current = { state: 'open', head: pr.head };
  await skip();
  assert.deepEqual(comments, other);
  await skip();
  assert.deepEqual(comments, other);
});
