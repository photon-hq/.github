import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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
  buildKnipConfig,
  discoverWorkspaces,
  extractDrizzleSchemas,
  isPublicLibrary,
  mapBuiltTargetToSource,
  parseJsonc,
} from '../unused/config.mjs';
import {
  collectReferencedPackagesInSource,
  diffFindings,
  executePrCheck,
  runKnipScan,
} from '../unused/scan.mjs';

const KNIP_VERSION = '6.46.1';

function ensureTestKnipInstall() {
  const scratchCandidate = path.join(os.homedir(), '.capy/work/PLAT-801/knip');
  if (existsSync(path.join(scratchCandidate, 'node_modules/.bin/knip'))) {
    return scratchCandidate;
  }
  const cached = path.join(os.tmpdir(), `unused-test-knip-${KNIP_VERSION}`);
  if (!existsSync(path.join(cached, 'node_modules/.bin/knip'))) {
    mkdirSync(cached, { recursive: true });
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', `knip@${KNIP_VERSION}`],
      { cwd: cached, stdio: 'inherit' },
    );
  }
  return cached;
}

function writeFiles(rootDir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(rootDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  }
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test Bot'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
}

function commitAll(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString('utf8').trim();
}

function parseGithubOutputs(outputFile) {
  if (!existsSync(outputFile)) return {};
  const map = {};
  for (const line of readFileSync(outputFile, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq > 0) map[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return map;
}

test('workspace discovery, public library dist->src mapping, cross-workspace paths, drizzle & jsonc overrides', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'unused-cfg-'));
  try {
    writeFiles(root, {
      'package.json': JSON.stringify({ name: 'monorepo', private: true }),
      'knip.jsonc': `{
        // Comment with https://example.com//url inside string and trailing commas
        "ignore": ["legacy/**"],
        "ignoreIssues": {
          "scripts/allow.ts": ["files"],
        },
        "workspaces": {
          "packages/*": {
            "entry": ["custom-entry.ts"],
          },
        },
      }`,
      'packages/sdk/package.json': JSON.stringify({
        name: '@acme/sdk',
        version: '1.0.0',
        main: './dist/index.cjs',
        module: './dist/index.mjs',
        bin: { 'acme-cli': './build/cli.cjs' },
        exports: {
          '.': { types: './dist/src/index.d.ts', import: './dist/index.mjs' },
          './button': { types: './dist/src/components/button/index.d.ts', import: './dist/components/button.js' },
        },
      }),
      'packages/sdk/src/index.ts': 'export const sdkMain = 1;\n',
      'packages/sdk/src/cli.ts': 'export const runCli = () => sdkMain;\nimport { sdkMain } from "./index.js";\n',
      'packages/sdk/src/components/button/index.tsx': 'export const Button = () => null;\n',
      'packages/sdk/examples/basic.ts': 'import { sdkMain } from "../src/index.js";\nconsole.log(sdkMain);\n',
      'apps/api/package.json': JSON.stringify({ name: '@acme/api', private: true }),
      'apps/api/publish/package.json': JSON.stringify({
        name: '@acme/api',
        exports: { '.': './dist/index.js' },
      }),
      'apps/api/tsconfig.json': `{
        "extends": "@acme/missing-preset/tsconfig.json",
        "compilerOptions": {
          // Local path alias survives uninstalled extends
          "paths": { "@app/*": ["./src/*"] }
        }
      }`,
      'apps/api/drizzle.config.ts': `
        import { defineConfig } from "drizzle-kit";
        export default defineConfig({
          schema: ["./src/db/schema", "./node_modules/@acme/db/outbox.js"],
        });
      `,
      'apps/api/src/db/schema/users.ts': 'export const usersTable = {};\n',
      'apps/api/src/index.ts': 'export const start = () => 1;\n',
      'node_modules/fake-pkg/package.json': JSON.stringify({ name: 'fake-pkg' }),
      'node_modules/fake-pkg/index.js': 'module.exports = 1;\n',
      'dist/built/package.json': JSON.stringify({ name: 'built' }),
      'dist/built/index.js': 'export default 1;\n',
      'test/fixtures/sample-pkg/package.json': JSON.stringify({ name: 'fixture-pkg' }),
      'test/fixtures/sample-pkg/index.ts': 'export const f = 1;\n',
    });

    symlinkSync(path.join(root, 'packages/sdk'), path.join(root, 'symlink-ws'));

    assert.equal(isPublicLibrary({ name: 'a', private: true, exports: './dist/index.js' }), false);
    assert.equal(isPublicLibrary({ name: 'a', exports: './dist/index.js' }), true);
    assert.equal(isPublicLibrary({ name: 'a', version: '1.0.0' }), false);

    const parsedJsonc = parseJsonc(readFileSync(path.join(root, 'knip.jsonc'), 'utf8'));
    assert.deepEqual(parsedJsonc.ignore, ['legacy/**']);

    const workspaces = discoverWorkspaces(root);
    assert.deepEqual(
      workspaces.map((w) => w.key),
      ['.', 'apps/api', 'packages/sdk'],
    );

    const sdkDir = path.join(root, 'packages/sdk');
    assert.deepEqual(mapBuiltTargetToSource(sdkDir, './dist/index.mjs'), ['src/index.ts']);
    assert.deepEqual(mapBuiltTargetToSource(sdkDir, './build/cli.cjs'), ['src/cli.ts']);
    assert.deepEqual(mapBuiltTargetToSource(sdkDir, './dist/components/button.js'), [
      'src/components/button/index.tsx',
    ]);

    assert.deepEqual(extractDrizzleSchemas(path.join(root, 'apps/api')), [
      'src/db/schema/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
    ]);

    const cfg = buildKnipConfig(root);
    assert.equal(cfg.workspaces['packages/sdk'].includeEntryExports, false);
    assert.equal(cfg.workspaces['apps/api'].includeEntryExports, true);
    assert.ok(cfg.workspaces['packages/sdk'].entry.includes('src/index.ts'));
    assert.ok(cfg.workspaces['packages/sdk'].entry.includes('src/cli.ts'));
    assert.ok(cfg.workspaces['packages/sdk'].entry.includes('src/components/button/index.tsx'));
    assert.ok(cfg.workspaces['packages/sdk'].entry.includes('custom-entry.ts'));
    assert.ok(
      cfg.workspaces['packages/sdk'].entry.some((e) => e.startsWith('examples/')),
      'Expected examples/** entry on public library',
    );
    assert.deepEqual(cfg.workspaces['apps/api'].paths['@acme/sdk'], [
      '../../packages/sdk/src/index.ts',
    ]);
    assert.deepEqual(cfg.workspaces['apps/api'].paths['@acme/sdk/button'], [
      '../../packages/sdk/src/components/button/index.tsx',
    ]);
    assert.deepEqual(cfg.workspaces['apps/api'].paths['@app/*'], ['./src/*']);
    assert.ok(cfg.ignore.includes('legacy/**'));
    assert.deepEqual(cfg.ignoreIssues['scripts/allow.ts'], ['files']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('monorepo cross-workspace imports & public library entry exports produce zero false positives with knip@6.46.1', () => {
  const knipInstallDir = ensureTestKnipInstall();
  const root = mkdtempSync(path.join(os.tmpdir(), 'unused-monorepo-'));
  try {
    writeFiles(root, {
      'package.json': JSON.stringify({ name: 'acme-workspace', private: true, type: 'module' }),
      'packages/lib/package.json': JSON.stringify({
        name: '@acme/lib',
        version: '0.1.0',
        type: 'module',
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.mjs' },
          './math': './dist/math.mjs',
        },
      }),
      'packages/lib/src/index.ts': [
        'import { internalHelper } from "./internal.js";',
        'export const publicSdkApi = () => internalHelper();',
        'export type PublicSdkOptions = { timeoutMs: number };',
      ].join('\n'),
      'packages/lib/src/math.ts': [
        'export const add = (a: number, b: number) => a + b;',
        'export const unusedPublicSubpathFn = () => 0;',
      ].join('\n'),
      'packages/lib/src/internal.ts': [
        'export const internalHelper = () => 42;',
        'export const deadInternalExport = () => 99;',
      ].join('\n'),
      'packages/lib/examples/demo.ts': [
        'import { publicSdkApi } from "../src/index.js";',
        'console.log(publicSdkApi());',
      ].join('\n'),
      'apps/service/package.json': JSON.stringify({
        name: '@acme/service',
        private: true,
        type: 'module',
        dependencies: { '@acme/lib': 'workspace:*' },
      }),
      'apps/service/src/main.ts': [
        'import { add } from "@acme/lib/math";',
        'console.log(add(1, 2));',
      ].join('\n'),
    });

    initGitRepo(root);
    commitAll(root, 'initial');

    const findings = runKnipScan({
      targetDir: root,
      knipInstallDir,
      tempDir: path.join(root, '.tmp-scan'),
      side: 'head',
    });

    // Public library entry exports (`publicSdkApi`, `PublicSdkOptions`, `unusedPublicSubpathFn`) and `examples/demo.ts`
    // are NOT flagged, while `deadInternalExport` inside internal module `packages/lib/src/internal.ts` IS caught!
    assert.equal(findings.length, 1);
    assert.equal(findings[0].category, 'exports');
    assert.equal(findings[0].file, 'packages/lib/src/internal.ts');
    assert.equal(findings[0].symbol, 'deadInternalExport');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('end-to-end PR comparison: line shifts, file renames, @public waiver, allow-unused label, new dead code, and new unused dependencies', () => {
  const knipInstallDir = ensureTestKnipInstall();
  const root = mkdtempSync(path.join(os.tmpdir(), 'unused-e2e-'));
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'unused-runner-'));
  try {
    writeFiles(root, {
      'package.json': JSON.stringify(
        {
          name: 'demo-service',
          private: true,
          type: 'module',
          dependencies: {
            zod: '^4.0.0',
          },
        },
        null,
        2,
      ),
      'src/index.ts': [
        'import { z } from "zod";',
        'import { activeFn } from "./legacy-util.js";',
        'console.log(z.string().parse(activeFn()));',
      ].join('\n'),
      'src/legacy-util.ts': [
        'const PREFIX = "service";',
        'const SEPARATOR = ":";',
        'const formatLabel = (value: string) => `${PREFIX}${SEPARATOR}${value}`;',
        'export const activeFn = () => formatLabel("ok");',
        'export const preExistingDead = () => formatLabel("old");',
      ].join('\n'),
    });

    initGitRepo(root);
    const baseSha = commitAll(root, 'base commit with pre-existing unused export');

    // 1. Rename `src/legacy-util.ts` -> `src/renamed-util.ts` and shift lines by adding comments above `preExistingDead`.
    execFileSync('git', ['mv', 'src/legacy-util.ts', 'src/renamed-util.ts'], { cwd: root });
    writeFiles(root, {
      'src/index.ts': [
        'import { z } from "zod";',
        'import { activeFn } from "./renamed-util.js";',
        'console.log(z.string().parse(activeFn()));',
      ].join('\n'),
      'src/renamed-util.ts': [
        '// Header line 1',
        '// Header line 2',
        'const PREFIX = "service";',
        'const SEPARATOR = ":";',
        'const formatLabel = (value: string) => `${PREFIX}${SEPARATOR}${value}`;',
        'export const activeFn = () => formatLabel("ok");',
        'export const preExistingDead = () => formatLabel("old");',
      ].join('\n'),
    });
    commitAll(root, 'rename file and shift lines');

    const out1 = path.join(scratch, 'out1.txt');
    const resRename = executePrCheck({
      sourceDir: root,
      baseRef: baseSha,
      labelsJson: '[]',
      runnerTemp: scratch,
      knipInstallDir,
      githubOutput: out1,
    });
    assert.equal(resRename.exitCode, 0);
    assert.equal(resRename.state, 'clean');
    assert.equal(resRename.report.addedCount, 0);
    assert.equal(resRename.report.resolvedCount, 0);

    // 2. Inject a newly introduced dead export -> fails with exitCode 1 and writes GITHUB_OUTPUT before exit.
    writeFiles(root, {
      'src/renamed-util.ts': [
        'const PREFIX = "service";',
        'const SEPARATOR = ":";',
        'const formatLabel = (value: string) => `${PREFIX}${SEPARATOR}${value}`;',
        'export const activeFn = () => formatLabel("ok");',
        'export const preExistingDead = () => formatLabel("old");',
        'export const newlyAddedDead = () => "bad";',
      ].join('\n'),
    });
    commitAll(root, 'add dead export');

    const out2 = path.join(scratch, 'out2.txt');
    const resFail = executePrCheck({
      sourceDir: root,
      baseRef: baseSha,
      labelsJson: '[]',
      runnerTemp: scratch,
      knipInstallDir,
      githubOutput: out2,
    });
    assert.equal(resFail.exitCode, 1);
    assert.equal(resFail.state, 'failed');
    assert.equal(resFail.report.addedCount, 1);
    assert.equal(resFail.report.added[0].symbol, 'newlyAddedDead');
    const parsedOut2 = parseGithubOutputs(out2);
    assert.equal(parsedOut2.state, 'failed');
    assert.equal(JSON.parse(parsedOut2.report).addedCount, 1);

    // 3. `allow-unused` PR label waives the failure (`exitCode: 0`, `state: 'waived'`).
    const out3 = path.join(scratch, 'out3.txt');
    const resLabelWaived = executePrCheck({
      sourceDir: root,
      baseRef: baseSha,
      labelsJson: JSON.stringify(['enhancement', 'allow-unused']),
      runnerTemp: scratch,
      knipInstallDir,
      githubOutput: out3,
    });
    assert.equal(resLabelWaived.exitCode, 0);
    assert.equal(resLabelWaived.state, 'waived');
    assert.equal(resLabelWaived.report.waived, true);

    // 4. Multiline `/** Description.\n * @public */` JSDoc tag waives the export cleanly (`exitCode: 0`, `addedCount: 0`).
    writeFiles(root, {
      'src/renamed-util.ts': [
        'const PREFIX = "service";',
        'const SEPARATOR = ":";',
        'const formatLabel = (value: string) => `${PREFIX}${SEPARATOR}${value}`;',
        'export const activeFn = () => formatLabel("ok");',
        'export const preExistingDead = () => formatLabel("old");',
        '/**',
        ' * Exported for stacked PR consumer.',
        ' * @public',
        ' */',
        'export const newlyAddedDead = () => "waived";',
      ].join('\n'),
    });
    commitAll(root, 'waive with multiline @public');

    const resPublicTag = executePrCheck({
      sourceDir: root,
      baseRef: baseSha,
      labelsJson: '[]',
      runnerTemp: scratch,
      knipInstallDir,
      githubOutput: path.join(scratch, 'out4.txt'),
    });
    assert.equal(resPublicTag.exitCode, 0);
    assert.equal(resPublicTag.state, 'clean');
    assert.equal(resPublicTag.report.addedCount, 0);

    // 5. Add unused runtime `dependencies` entry (plus @types/* and devDependencies which must NOT trigger, and a used dep).
    writeFiles(root, {
      'package.json': JSON.stringify(
        {
          name: 'demo-service',
          private: true,
          type: 'module',
          dependencies: {
            zod: '^4.0.0',
            picocolors: '^1.1.0',
            'unreferenced-pkg': '^2.0.0',
            '@types/node': '^24.0.0',
          },
          devDependencies: {
            'unused-dev-tool': '^1.0.0',
          },
        },
        null,
        2,
      ),
      'src/index.ts': [
        'import pc from "picocolors";',
        'import { z } from "zod";',
        'import { activeFn } from "./renamed-util.js";',
        '// Comment mentioning unreferenced-pkg: import "unreferenced-pkg"',
        'console.log(pc.green(z.string().parse(activeFn())));',
      ].join('\n'),
    });
    commitAll(root, 'add unused runtime dependency');

    const resDep = executePrCheck({
      sourceDir: root,
      baseRef: baseSha,
      labelsJson: '[]',
      runnerTemp: scratch,
      knipInstallDir,
      githubOutput: path.join(scratch, 'out5.txt'),
    });
    assert.equal(resDep.exitCode, 1);
    assert.equal(resDep.state, 'failed');
    assert.equal(resDep.report.addedCount, 1);
    assert.deepEqual(resDep.report.added[0], {
      category: 'dependencies',
      file: 'package.json',
      symbol: 'unreferenced-pkg',
      line: 8,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('fails open (exit 0, state=unavailable) on unreachable BASE or scanner crash (exit >= 2)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'unused-failopen-'));
  const fakeKnipInstall = mkdtempSync(path.join(os.tmpdir(), 'unused-fakeknip-'));
  try {
    writeFiles(root, {
      'package.json': JSON.stringify({ name: 'demo', private: true }),
      'src/index.ts': 'export const x = 1;\n',
    });
    initGitRepo(root);
    const baseSha = commitAll(root, 'init');

    // 1. Unreachable BASE SHA -> fails open with exit 0 and state=unavailable.
    const out1 = path.join(fakeKnipInstall, 'out1.txt');
    const resBadBase = executePrCheck({
      sourceDir: root,
      baseRef: 'deadbeef'.repeat(5),
      runnerTemp: fakeKnipInstall,
      knipInstallDir: fakeKnipInstall,
      githubOutput: out1,
    });
    assert.equal(resBadBase.exitCode, 0);
    assert.equal(resBadBase.state, 'unavailable');
    assert.equal(parseGithubOutputs(out1).state, 'unavailable');

    // 2. Scanner crash (exit 2) -> fails open with exit 0 and state=unavailable.
    const binPath = path.join(fakeKnipInstall, 'node_modules/.bin/knip');
    mkdirSync(path.dirname(binPath), { recursive: true });
    writeFileSync(binPath, '#!/usr/bin/env bash\necho "Internal parser error" >&2\nexit 2\n', 'utf8');
    chmodSync(binPath, 0o755);

    const out2 = path.join(fakeKnipInstall, 'out2.txt');
    const resCrash = executePrCheck({
      sourceDir: root,
      baseRef: baseSha,
      runnerTemp: fakeKnipInstall,
      knipInstallDir: fakeKnipInstall,
      githubOutput: out2,
    });
    assert.equal(resCrash.exitCode, 0);
    assert.equal(resCrash.state, 'unavailable');
    assert.equal(parseGithubOutputs(out2).state, 'unavailable');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeKnipInstall, { recursive: true, force: true });
  }
});

test('diffFindings matches duplicate exports regardless of export order and handles multiset counts', () => {
  const base = [
    { category: 'duplicates', file: 'src/a.ts', symbol: 'foo, default', keySymbol: 'default|foo', line: 10 },
  ];
  const head = [
    { category: 'duplicates', file: 'src/moved.ts', symbol: 'default, foo', keySymbol: 'default|foo', line: 42 },
  ];
  const renames = new Map([['src/a.ts', 'src/moved.ts']]);
  const { added, resolvedCount } = diffFindings(base, head, renames);
  assert.equal(added.length, 0);
  assert.equal(resolvedCount, 0);

  const refs = collectReferencedPackagesInSource(
    [
      "const stripped = raw.replace(/'/g, '');",
      '// import "commented-out-pkg";',
      "import { helper } from '@acme/runtime/subpath';",
      'const schema = createRequire(import.meta.url).resolve("@acme/db/outbox");',
    ].join('\n'),
  );
  assert.deepEqual([...refs].sort(), ['@acme/db', '@acme/runtime']);
});

test('tolerates repositories with JS/TS files and no root package.json without dirtying the working tree', () => {
  const knipInstallDir = ensureTestKnipInstall();
  const root = mkdtempSync(path.join(os.tmpdir(), 'unused-norootpkg-'));
  try {
    writeFiles(root, {
      'web/package.json': JSON.stringify({ name: 'web-ui', private: true, type: 'module' }),
      'web/src/index.ts': 'import { greet } from "./util.js";\nconsole.log(greet());',
      'web/src/util.ts': 'export const greet = () => "hi";\nexport const unusedWebFn = () => 0;',
    });
    initGitRepo(root);
    commitAll(root, 'init polyglot');

    const findings = runKnipScan({
      targetDir: root,
      knipInstallDir,
      tempDir: path.join(root, '.tmp'),
      side: 'head',
    });
    assert.equal(existsSync(path.join(root, 'package.json')), false);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'web/src/util.ts');
    assert.equal(findings[0].symbol, 'unusedWebFn');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
