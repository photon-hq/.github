import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
  globToRegExp,
  isPublicLibrary,
  mapBuiltTargetToSource,
  parseJsonc,
} from '../unused/config.mjs';
import {
  collectReferencedPackagesInSource,
  diffFindings,
  executePrCheck,
  findNewUnusedDependencies,
  runKnipScan,
} from '../unused/scan.mjs';

const KNIP_VERSION = '6.46.1';

function hasExpectedKnipVersion(installDir) {
  try {
    const pkgPath = path.join(installDir, 'node_modules/knip/package.json');
    const binPath = path.join(installDir, 'node_modules/.bin/knip');
    if (!existsSync(binPath) || !existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg?.version === KNIP_VERSION;
  } catch {
    return false;
  }
}

let processKnipDir = null;

function ensureTestKnipInstall() {
  if (processKnipDir && hasExpectedKnipVersion(processKnipDir)) {
    return processKnipDir;
  }
  const shared = path.join(os.tmpdir(), `unused-test-knip-${KNIP_VERSION}`);
  if (hasExpectedKnipVersion(shared)) {
    processKnipDir = shared;
    return shared;
  }
  const staged = mkdtempSync(path.join(os.tmpdir(), `unused-test-knip-${KNIP_VERSION}-${process.pid}-`));
  try {
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', `knip@${KNIP_VERSION}`],
      { cwd: staged, stdio: 'inherit' },
    );
    assert.equal(hasExpectedKnipVersion(staged), true, `Expected knip@${KNIP_VERSION} in staged dir`);
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
  if (!existsSync(shared)) {
    try {
      renameSync(staged, shared);
      processKnipDir = shared;
      return shared;
    } catch {
      if (hasExpectedKnipVersion(shared)) {
        rmSync(staged, { recursive: true, force: true });
        processKnipDir = shared;
        return shared;
      }
    }
  }
  process.once('exit', () => {
    rmSync(staged, { recursive: true, force: true });
  });
  processKnipDir = staged;
  return staged;
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
      'const help = \'import "string-example-pkg"\';',
      'const doc = `Run require("template-example-pkg")`;',
      'const ratio = 10 / 2; const scale = require("@acme/scale");',
      'const fsTarget = path.resolve("not-a-module-pkg");',
      'const dyn = await import("@acme/json-data/file.json", { with: { type: "json" } });',
      "import { helper } from '@acme/runtime/subpath';",
      'const schema = createRequire(import.meta.url).resolve("@acme/db/outbox", { paths: ["."] });',
      'const metaUrl = import.meta.resolve("@acme/meta-pkg/entry");',
    ].join('\n'),
  );
  assert.deepEqual([...refs].sort(), [
    '@acme/db',
    '@acme/json-data',
    '@acme/meta-pkg',
    '@acme/runtime',
    '@acme/scale',
  ]);
});

test('tolerates repositories with JS/TS files and no root package.json without dirtying the working tree', () => {
  const knipInstallDir = ensureTestKnipInstall();
  const root = mkdtempSync(path.join(os.tmpdir(), 'unused-norootpkg-'));
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'unused-norootpkg-tmp-'));
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
      tempDir,
      side: 'head',
    });
    const gitStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    assert.equal(gitStatus, '');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'web/src/util.ts');
    assert.equal(findings[0].symbol, 'unusedWebFn');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('handles Object.prototype package names, realpath tsconfig containment, quoted drizzle schema, globstars, per-manifest deps, and step summary', () => {
  const knipInstallDir = ensureTestKnipInstall();
  const root = mkdtempSync(path.join(os.tmpdir(), 'unused-edgecases-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'unused-outside-'));
  const runnerTemp = mkdtempSync(path.join(os.tmpdir(), 'unused-summary-tmp-'));
  try {
    writeFiles(outside, {
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: { '@escaped/*': ['./secret/*'] },
        },
      }),
      'secret/index.ts': 'export const secret = 1;',
    });

    writeFiles(root, {
      'package.json': JSON.stringify({
        name: 'constructor',
        private: true,
        workspaces: ['packages/**'],
        dependencies: { 'unused-shared': '1.0.0' },
      }),
      'index.ts': 'export const rootEntry = 1;',
      'knip.json': JSON.stringify({
        workspaces: {
          'packages/**/tools': {
            entry: ['custom-entry.ts'],
          },
        },
      }),
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: {
          paths: { '@shared/*': ['./packages/tools/src/*'] },
        },
      }),
      'packages/tools/package.json': JSON.stringify({
        name: 'toString',
        private: true,
        exports: {
          '.': './src/index.ts',
          './sub': './src/index.ts',
        },
      }),
      'packages/tools/tsconfig.json': JSON.stringify({
        extends: '../../tsconfig.base.json',
        references: [{ path: '../symlinked-escape/tsconfig.json' }],
      }),
      'packages/tools/drizzle.config.ts': 'export default { "schema": "./src/db/schema.ts" };',
      'packages/tools/src/db/schema.ts': 'export const usersTable = {};',
      'packages/tools/custom-entry.ts': 'export const directWorkspaceOverride = 1;',
      'packages/tools/src/index.ts': 'export const runTool = () => "ok";',
      'packages/team/tools/package.json': JSON.stringify({
        name: 'nested-tools',
        private: true,
      }),
      'packages/team/tools/custom-entry.ts':
        'import { runTool } from "toString/sub";\nconsole.log(runTool());',
    });
    symlinkSync(outside, path.join(root, 'packages/symlinked-escape'));

    assert.equal(globToRegExp('packages/**/tools').test('packages/tools'), true);
    assert.equal(globToRegExp('packages/**/tools').test('packages/team/tools'), true);
    assert.deepEqual(extractDrizzleSchemas(path.join(root, 'packages/tools')), ['src/db/schema.ts']);

    const cfg = buildKnipConfig(root);
    assert.equal(Object.hasOwn(cfg.workspaces['.'].paths, 'constructor'), false);
    assert.equal(Object.hasOwn(cfg.workspaces['.'].paths, 'toString'), false);
    assert.ok(Array.isArray(cfg.workspaces['.'].paths['toString/sub']));
    assert.equal('@escaped/*' in cfg.workspaces['packages/tools'].paths, false);
    assert.ok(Array.isArray(cfg.workspaces['packages/tools'].paths['@shared/*']));
    assert.ok(cfg.workspaces['packages/tools'].entry.includes('custom-entry.ts'));
    assert.ok(cfg.workspaces['packages/team/tools'].entry.includes('custom-entry.ts'));

    initGitRepo(root);
    commitAll(root, 'base');
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    // Add the same unused dependency `unused-shared` to a second workspace manifest: must still be flagged!
    writeFiles(root, {
      'packages/tools/package.json': JSON.stringify({
        name: 'toString',
        private: true,
        exports: {
          '.': './src/index.ts',
          './sub': './src/index.ts',
        },
        dependencies: { 'unused-shared': '1.0.0' },
      }),
    });
    commitAll(root, 'add duplicate unused dep in second workspace');

    const depFindings = findNewUnusedDependencies({
      baseDir: root,
      headDir: root,
      baseTrackedFiles: new Set(['package.json', 'packages/tools/package.json']),
      headTrackedFiles: new Set(['package.json', 'packages/tools/package.json']),
    });
    assert.equal(depFindings.length, 0);

    const ghOutput = path.join(runnerTemp, 'github-output.txt');
    const stepSummary = path.join(runnerTemp, 'step-summary.md');
    writeFileSync(ghOutput, '', 'utf8');
    writeFileSync(stepSummary, '', 'utf8');

    const res = executePrCheck({
      sourceDir: root,
      baseRef: baseSha,
      labelsJson: '[]',
      runnerTemp,
      knipInstallDir,
      githubOutput: ghOutput,
      githubStepSummary: stepSummary,
    });
    assert.equal(res.exitCode, 1);
    assert.equal(res.state, 'failed');
    assert.equal(res.report.addedCount, 1);
    assert.equal(res.report.added[0].category, 'dependencies');
    assert.equal(res.report.added[0].file, 'packages/tools/package.json');
    assert.equal(res.report.added[0].symbol, 'unused-shared');

    const summaryMd = readFileSync(stepSummary, 'utf8');
    assert.match(summaryMd, /### Unused code/);
    assert.match(summaryMd, /\*\*Unused dependency\*\*: `packages\/tools\/package\.json:/);
    assert.match(summaryMd, /`unused-shared`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test('enforces package.json#knip preprocessor isolation, inherited tsconfig baseUrl, single-quoted drizzle globstars, brace workspace globs, explicit workspace rebasing, #imports package refs, and summary error resilience', () => {
  const knipInstallDir = ensureTestKnipInstall();
  const root = mkdtempSync(path.join(os.tmpdir(), 'unused-security-'));
  const runnerTemp = mkdtempSync(path.join(os.tmpdir(), 'unused-security-tmp-'));
  const pwnMarker = path.join(runnerTemp, 'preprocessor-ran.txt');
  try {
    writeFiles(root, {
      'package.json': JSON.stringify({
        name: 'sec-monorepo',
        private: true,
        workspaces: ['packages/*'],
        knip: {
          preprocessor: './evil-preprocessor.mjs',
          workspaces: {
            'packages/{web,api}/**': {
              entry: ['extra-entry.ts'],
            },
            'tools/cli': {
              entry: ['run.ts'],
            },
          },
        },
      }),
      'evil-preprocessor.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pwnMarker)}, 'pwned');\nexport default (r) => r;`,
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: './shared',
          paths: { '@root-shared/*': ['./*'] },
        },
      }),
      'shared/utils/math.ts': 'export const double = (n) => n * 2;',
      'packages/web/package.json': JSON.stringify({
        name: '@acme/web',
        private: true,
        imports: {
          '#logger': 'pino',
          '#unused-alias': 'unreferenced-via-alias',
        },
      }),
      'packages/web/tsconfig.json': JSON.stringify({
        extends: '../../tsconfig.json',
        compilerOptions: {
          paths: { '@util/*': ['utils/*'] },
        },
      }),
      'packages/web/drizzle.config.ts': "export default { schema: './src/db/**/*.ts' };",
      'packages/web/src/db/nested/tables.ts': 'export const accountsTable = {};',
      'packages/web/extra-entry.ts':
        'import log from "#logger";\nimport { double } from "@util/math";\nconsole.log(log, double(2));',
      'tools/cli/run.ts': 'import { double } from "@root-shared/utils/math";\nconsole.log(double(3));',
    });

    assert.equal(globToRegExp('packages/{web,api}/**').test('packages/web'), true);
    assert.equal(globToRegExp('packages/{web,api}/**').test('packages/api/nested'), true);
    assert.equal(globToRegExp('packages/{web,api}/**').test('packages/other'), false);
    assert.deepEqual(extractDrizzleSchemas(path.join(root, 'packages/web')), ['src/db/**/*.ts']);

    const cfg = buildKnipConfig(root);
    assert.deepEqual(cfg.workspaces['packages/web'].paths['@util/*'], ['../../shared/utils/*']);
    assert.deepEqual(cfg.workspaces['tools/cli'].paths['@root-shared/*'], ['../../shared/*']);
    assert.ok(cfg.workspaces['packages/web'].entry.includes('extra-entry.ts'));

    initGitRepo(root);
    commitAll(root, 'base');
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    // Add `pino` (used only through `#logger`) and `unreferenced-direct` (unused) to packages/web/package.json.
    writeFiles(root, {
      'packages/web/package.json': JSON.stringify({
        name: '@acme/web',
        private: true,
        dependencies: {
          pino: '^9.0.0',
          'unreferenced-direct': '^1.0.0',
        },
        imports: {
          '#logger': 'pino',
          '#unused-alias': 'unreferenced-via-alias',
        },
      }),
    });
    commitAll(root, 'head deps');

    // Pass a directory path as `githubStepSummary` so appendFileSync throws EISDIR: must still exit 1!
    const badSummaryDir = path.join(runnerTemp, 'summary-is-a-dir');
    mkdirSync(badSummaryDir, { recursive: true });
    const ghOutput = path.join(runnerTemp, 'gh-out.txt');
    writeFileSync(ghOutput, '', 'utf8');

    process.env.GH_TOKEN = 'secret-test-token-should-not-leak';
    let res;
    try {
      res = executePrCheck({
        sourceDir: root,
        baseRef: baseSha,
        labelsJson: '[]',
        runnerTemp,
        knipInstallDir,
        githubOutput: ghOutput,
        githubStepSummary: badSummaryDir,
      });
    } finally {
      delete process.env.GH_TOKEN;
    }

    assert.equal(existsSync(pwnMarker), false, 'PR-controlled package.json#knip preprocessor must not run');
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
      '',
    );
    assert.equal(res.exitCode, 1);
    assert.equal(res.state, 'failed');
    assert.deepEqual(
      res.report.added.map((a) => `${a.category}:${a.symbol}`),
      ['dependencies:unreferenced-direct'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test('isolates pnpm-workspace.yaml#include, preserves UTF-8 BOM manifests, allows ..prefixed in-repo paths, ignores control-header regex literals, and follows Node #imports specificity and wildcard substitution', () => {
  const knipInstallDir = ensureTestKnipInstall();
  const root = mkdtempSync(path.join(os.tmpdir(), 'unused-pass3-'));
  const runnerTemp = mkdtempSync(path.join(os.tmpdir(), 'unused-pass3-tmp-'));
  const wsIncludeMarker = path.join(runnerTemp, 'pnpm-include-ran.txt');
  const bomPreprocessorMarker = path.join(runnerTemp, 'bom-preprocessor-ran.txt');
  try {
    // 1. Tokenizer: regex after control headers (`if`, `while`, `for`, `for await`, `with`) must not register fake deps,
    //    while division after parenthesized/call expressions preserves real imports following it.
    const controlRegexRefs = collectReferencedPackagesInSource(
      [
        'if (ready && (count > 0)) /require("fake-if-pkg")/gi.test(line);',
        'while (running) /import "fake-while-pkg"/.test(line);',
        'for (const x of items) /import("fake-for-pkg")/.test(x);',
        'for await (const x of stream) /require("fake-for-await-pkg")/.test(x);',
        'const ratio = (total + 1) / 2; const usedA = require("real-after-div-pkg");',
        'const half = compute() / 2; import "real-after-call-div-pkg";',
        'class Meter { #for() { return 4; } run() { return this.#for() / require("real-after-private-for-pkg"); } }',
      ].join('\n'),
    );
    assert.deepEqual([...controlRegexRefs].sort(), [
      'real-after-call-div-pkg',
      'real-after-div-pkg',
      'real-after-private-for-pkg',
    ]);
    const hashbangUnicodeRefs = collectReferencedPackagesInSource(
      '\ufeff#!/usr/bin/env node\u2028import "hashbang-ls-pkg";\u2029import "hashbang-ps-pkg";',
    );
    assert.deepEqual([...hashbangUnicodeRefs].sort(), ['hashbang-ls-pkg', 'hashbang-ps-pkg']);

    // 2. Full repo scan with UTF-8 BOM root `package.json#knip`, `pnpm-workspace.yaml#include`,
    //    in-repo `..shared` tsconfig path target, and Node `#imports` exact/specificity/wildcard substitution.
    const bomRootPkg = `\ufeff${JSON.stringify(
      {
        name: 'bom-monorepo',
        private: true,
        knip: {
          preprocessor: './evil-bom-preprocessor.mjs',
        },
      },
      null,
      2,
    )}\n`;

    writeFiles(root, {
      'pnpm-workspace.yaml': [
        'packages:',
        '  - packages/*',
        'include:',
        '  ./evil-workspace-include.mjs: true',
      ].join('\n'),
      'evil-workspace-include.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(wsIncludeMarker)}, 'pwned');\nexport default {};`,
      'evil-bom-preprocessor.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(bomPreprocessorMarker)}, 'pwned');\nexport default (r) => r;`,
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: {
            '@dotdot/*': ['./..shared/*'],
          },
        },
      }),
      '..shared/util.ts': 'export const dotdotHelper = () => 42;',
      'packages/app/package.json': JSON.stringify({
        name: '@demo/app',
        private: true,
        type: 'module',
        imports: {
          '#log/main': './src/local-log.ts',
          '#log/*': 'unused-wildcard-log/*',
          '#svc/*': 'unused-broad-svc/*',
          '#svc/http/*': 'used-specific-svc/*',
          '#scoped/*': '@demo-ext/*',
          '#cond-dead/*': {
            default: './src/local-log.ts',
            node: 'unused-after-default-pkg/*',
          },
          '#cond-require-only': {
            require: 'unused-require-only-pkg',
            default: './src/local-log.ts',
          },
          '#cond-live/*': {
            node: 'used-node-cond-pkg/*',
            default: './src/local-log.ts',
          },
          '#fallback-url': ['node:fs', 'used-after-url-fallback-pkg'],
          '#fallback-null': [null, 'used-after-null-fallback-pkg'],
          '#cond-null': {
            default: null,
            node: 'unused-after-null-cond-pkg',
          },
          '#cond-cts': {
            require: 'used-cts-require-pkg',
            default: './src/local-log.ts',
          },
          '#cond-cts-typeonly': {
            require: 'unused-cts-typeonly-require-pkg',
            default: './src/local-log.ts',
          },
          '#cond-cts-dyn': {
            require: 'unused-cts-dyn-require-pkg',
            default: './src/local-log.ts',
          },
          '#local-cond': {
            default: './dist/local-log.js',
            node: './dist/unreachable-cond-file.js',
          },
        },
      }),
      'packages/app/tsconfig.json': JSON.stringify({
        extends: '../../tsconfig.json',
      }),
      'packages/app/src/local-log.ts': 'export type LogKind = string;\nexport const logMain = () => "local";',
      'packages/app/bin/cli.cts': [
        'import ctsVal from "#cond-cts";',
        'export type { LogKind } from "#cond-cts-typeonly";',
        'const loadDyn = () => import("#cond-cts-dyn");',
        'console.log(ctsVal, loadDyn);',
      ].join('\n'),
      'packages/app/src/index.ts': [
        'import { dotdotHelper } from "@dotdot/util";',
        'import { logMain } from "#log/main";',
        'import client from "#svc/http/v2/client";',
        'import sdk from "#scoped/used-sdk/deep/entry";',
        'import deadCond from "#cond-dead/main";',
        'import reqCond from "#cond-require-only";',
        'import liveCond from "#cond-live/main";',
        'import urlFb from "#fallback-url";',
        'import nullFb from "#fallback-null";',
        'import nullCond from "#cond-null";',
        'import localCond from "#local-cond";',
        'console.log(dotdotHelper(), logMain(), client, sdk, deadCond, reqCond, liveCond, urlFb, nullFb, nullCond, localCond);',
      ].join('\n'),
    });
    // Write `package.json` directly so the leading UTF-8 BOM is exact, and mark `pnpm-workspace.yaml` executable (`0o755`)
    // to verify file mode restoration under `core.filemode=true`.
    writeFileSync(path.join(root, 'package.json'), bomRootPkg, 'utf8');
    chmodSync(path.join(root, 'pnpm-workspace.yaml'), 0o755);
    assert.equal(parseJsonc(bomRootPkg).name, 'bom-monorepo');

    const cfg = buildKnipConfig(root);
    assert.ok(Array.isArray(cfg.workspaces['packages/app'].paths['@dotdot/*']));

    initGitRepo(root);
    execFileSync('git', ['config', 'core.filemode', 'true'], { cwd: root });
    const baseSha = commitAll(root, 'base');

    // Add dependencies and an unreachable `#local-cond` file on HEAD:
    writeFiles(root, {
      'packages/app/src/unreachable-cond-file.ts': 'export const deadCondBranch = 1;',
      'packages/app/package.json': JSON.stringify({
        name: '@demo/app',
        private: true,
        type: 'module',
        dependencies: {
          'used-specific-svc': '^1.0.0',
          '@demo-ext/used-sdk': '^1.0.0',
          'used-node-cond-pkg': '^1.0.0',
          'used-after-url-fallback-pkg': '^1.0.0',
          'used-after-null-fallback-pkg': '^1.0.0',
          'used-cts-require-pkg': '^1.0.0',
          'unused-wildcard-log': '^1.0.0',
          'unused-broad-svc': '^1.0.0',
          'unused-after-default-pkg': '^1.0.0',
          'unused-after-null-cond-pkg': '^1.0.0',
          'unused-require-only-pkg': '^1.0.0',
          'unused-cts-typeonly-require-pkg': '^1.0.0',
          'unused-cts-dyn-require-pkg': '^1.0.0',
          '@demo-ext/unused-sdk': '^1.0.0',
        },
        imports: {
          '#log/main': './src/local-log.ts',
          '#log/*': 'unused-wildcard-log/*',
          '#svc/*': 'unused-broad-svc/*',
          '#svc/http/*': 'used-specific-svc/*',
          '#scoped/*': '@demo-ext/*',
          '#cond-dead/*': {
            default: './src/local-log.ts',
            node: 'unused-after-default-pkg/*',
          },
          '#cond-require-only': {
            require: 'unused-require-only-pkg',
            default: './src/local-log.ts',
          },
          '#cond-live/*': {
            node: 'used-node-cond-pkg/*',
            default: './src/local-log.ts',
          },
          '#fallback-url': ['node:fs', 'used-after-url-fallback-pkg'],
          '#fallback-null': [null, 'used-after-null-fallback-pkg'],
          '#cond-null': {
            default: null,
            node: 'unused-after-null-cond-pkg',
          },
          '#cond-cts': {
            require: 'used-cts-require-pkg',
            default: './src/local-log.ts',
          },
          '#cond-cts-typeonly': {
            require: 'unused-cts-typeonly-require-pkg',
            default: './src/local-log.ts',
          },
          '#cond-cts-dyn': {
            require: 'unused-cts-dyn-require-pkg',
            default: './src/local-log.ts',
          },
          '#local-cond': {
            default: './dist/local-log.js',
            node: './dist/unreachable-cond-file.js',
          },
        },
      }),
    });
    commitAll(root, 'head');

    const headCfg = buildKnipConfig(root);
    assert.equal(headCfg.workspaces['packages/app'].entry.includes('src/local-log.ts'), true);
    assert.equal(
      headCfg.workspaces['packages/app'].entry.includes('src/unreachable-cond-file.ts'),
      false,
    );

    const res = executePrCheck({
      sourceDir: root,
      baseRef: baseSha,
      labelsJson: '[]',
      runnerTemp,
      knipInstallDir,
    });

    assert.equal(existsSync(wsIncludeMarker), false, 'pnpm-workspace.yaml#include must not execute code');
    assert.equal(existsSync(bomPreprocessorMarker), false, 'BOM package.json#knip must not execute code');
    const restoredPkgBytes = readFileSync(path.join(root, 'package.json'));
    assert.equal(restoredPkgBytes[0], 0xef);
    assert.equal(restoredPkgBytes[1], 0xbb);
    assert.equal(restoredPkgBytes[2], 0xbf);
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
      '',
    );
    assert.equal(res.exitCode, 1);
    assert.equal(res.state, 'failed');
    assert.deepEqual(
      res.report.added.map((a) => `${a.category}:${a.symbol || a.file}`),
      [
        'files:packages/app/src/unreachable-cond-file.ts',
        'dependencies:@demo-ext/unused-sdk',
        'dependencies:unused-after-default-pkg',
        'dependencies:unused-after-null-cond-pkg',
        'dependencies:unused-broad-svc',
        'dependencies:unused-cts-dyn-require-pkg',
        'dependencies:unused-cts-typeonly-require-pkg',
        'dependencies:unused-require-only-pkg',
        'dependencies:unused-wildcard-log',
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

