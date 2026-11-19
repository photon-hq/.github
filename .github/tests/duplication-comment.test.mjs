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
  const scan = (count, rows, before = existing, after = existing, env = {}) => publish(context, github, {
    env: { REPORT: JSON.stringify({ base: 'b'.repeat(40), before, after, count, rows }), ...env },
  });
  const semantic = { count: 1, rows: [[['one.ts', 2, 12], ['two.ts', 3, 14], 0.843]] };
  const emptyGroup = { count: 0, rows: [] };
  const renamed = { count: 1, rows: [[['left.ts', 3, 8], ['right.ts', 9, 14]]] };
  await scan(1, renamed.rows, existing, larger, { STRUCTURAL: JSON.stringify({
    exact: emptyGroup, renamed, gap: emptyGroup, ast: emptyGroup,
  }) });
  assert.match(comments[0].body, /1 new finding[\s\S]*Renamed[\s\S]*right\.ts#L9-L14/);
  await scan(1, [[['a #1.ts', 1, 8], ['b.ts', 4, 11]]], existing, larger, { SEMANTIC: JSON.stringify(semantic) });
  assert.ok(comments[0].body.includes([
    '### Duplicated code', '', '| Exact duplication | Before `bbbbbbb` | After `abc` |', '| --- | ---: | ---: |',
    '| Duplicated lines | 10 (20.00%) | 20 (28.57%) |', '| Clone pairs | 1 | 2 |', '| Scanned files | 3 | 4 |',
  ].join('\n')));
  assert.match(comments[0].body, /a%20%231\.ts#L1-L8[\s\S]*Semantic candidate\*\* · similarity 0\.843[\s\S]*one\.ts#L2-L12[\s\S]*two\.ts#L3-L14/);
  const clean = { STRUCTURAL: JSON.stringify({ exact: emptyGroup, renamed: emptyGroup, gap: emptyGroup, ast: emptyGroup }),
    SEMANTIC: JSON.stringify(emptyGroup) };
  await scan(0, [], existing, existing, clean);
  assert.ok(comments[0].body.endsWith('| Scanned files | 3 | 3 |\n\nNo new duplication or semantic candidates.'));
  await scan(0, []);
  assert.match(comments[0].body, /No new findings in completed scans · structural scan unavailable · semantic scan unavailable/);
  await scan(0, [], existing, existing, { ...clean, SEMANTIC: '', SEMANTIC_STATE: 'limit' });
  assert.match(comments[0].body, /No new findings in completed scans · semantic scan incomplete \(inference limit\)/);
  await scan(0, [], empty, empty, { STRUCTURE_STATE: 'unchanged', ELIGIBILITY: 'too-few-files' });
  assert.ok(comments[0].body.endsWith('| Scanned files | 0 | 0 |\n\nNo files met the exact scan criteria · structural scan skipped · semantic scan skipped.'));
  await scan(0, [], empty, empty, { ELIGIBILITY: 'too-few-files', STRUCTURAL: JSON.stringify({
    exact: emptyGroup, renamed: emptyGroup, gap: emptyGroup,
    ast: { count: 1, rows: [[['candidate.js', 1, 14], ['original.js', 1, 14], 0.967]] },
  }) });
  assert.match(comments[0].body, /Scanned files \| 0 \| 0 \|\n\n\*\*1 new finding\*\* · semantic scan skipped\.\n\n- \*\*AST\*\* · similarity 0\.967/);
  const many = Array.from({ length: 20 }, (_, i) => [[`private/${i}/<leaf>.ts`, 1, 10], ['public/<leaf>.ts', i + 1, i + 2]]);
  await scan(23, many);
  const [visible, overflow] = comments[0].body.split('<details>');
  assert.equal(visible.match(/^- /gm).length, 5);
  assert.equal(overflow.match(/^- /gm).length, 15);
  assert.equal(overflow.match(/<\/details>/g).length, 1);
  assert.match(visible, /private\/0\/%3Cleaf%3E.ts#L1-L10"><code>0\/&lt;leaf&gt;\.ts:1–10/);
  assert.doesNotMatch(comments[0].body, /<leaf>/);
  assert.match(overflow, /Showing 20 of 23/);
  await scan(1, [[['a'.repeat(32500) + '.ts', 1, 8], ['b.ts', 4, 11]]]);
  assert.ok(comments[0].body.length < 65536);
  assert.match(comments[0].body, /Showing 0 of 1/);
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
