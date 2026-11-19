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
  const scan = async (count, rows) => publish(context, github, { env: { REPORT: JSON.stringify({ count, rows }) } });
  await scan(1, [[['a #1.ts', 1, 8], ['b.ts', 4, 11]]]);
  assert.match(comments[0].body, /a%20%231\.ts#L1-L8/);
  await scan(0, []);
  assert.match(comments[0].body, /No new duplicated code\./);
  await publish(context, github, { env: {} });
  assert.match(comments[0].body, /Scan unavailable/);
  context.payload.pull_request = { ...pr, head: { sha: 'old' } };
  await scan(0, []);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /Scan unavailable/);
});
