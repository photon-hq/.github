import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildKnipConfig,
  parseJsonc,
  SKIP_DIRS,
  writeKnipConfigModule,
} from './config.mjs';

const EXPORT_AND_TYPE_CATEGORIES = new Set([
  'exports',
  'types',
  'nsExports',
  'nsTypes',
  'enumMembers',
]);

const CATEGORY_ORDER = [
  'files',
  'exports',
  'nsExports',
  'types',
  'nsTypes',
  'enumMembers',
  'duplicates',
  'dependencies',
];

const DEP_SCAN_EXT_RE = /\.(?:[cm]?[jt]sx?|es6?|astro|mdx|vue|svelte|s?css)$/i;

function gitBuffer(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function getTrackedFiles(dir) {
  const out = gitBuffer(['ls-files', '-z'], dir).toString('utf8');
  const set = new Set();
  for (const entry of out.split('\0')) {
    if (entry) set.add(entry.replace(/\\/g, '/'));
  }
  return set;
}

export function getRenameMap(repoDir, baseSha, headSha) {
  const out = gitBuffer(
    ['diff', '--find-renames', '--name-status', '-z', '--diff-filter=R', baseSha, headSha],
    repoDir,
  ).toString('utf8');
  const fields = out.split('\0');
  const renames = new Map();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const status = fields[i];
    const oldPath = fields[i + 1];
    const newPath = fields[i + 2];
    if (status && status.startsWith('R') && oldPath && newPath) {
      renames.set(oldPath.replace(/\\/g, '/'), newPath.replace(/\\/g, '/'));
    }
  }
  return renames;
}

export function parseKnipJsonReport(reportObj, trackedFiles = null) {
  if (!reportObj || typeof reportObj !== 'object') {
    throw new Error('Invalid Knip JSON output');
  }

  const findings = [];
  const seenFileIssues = new Set();

  if (Array.isArray(reportObj.files)) {
    for (const rawFile of reportObj.files) {
      if (typeof rawFile !== 'string') continue;
      const file = rawFile.replace(/\\/g, '/');
      if (trackedFiles && !trackedFiles.has(file)) continue;
      if (!seenFileIssues.has(file)) {
        seenFileIssues.add(file);
        findings.push({ category: 'files', file, symbol: '', keySymbol: '', line: 1 });
      }
    }
  }

  const rows = Array.isArray(reportObj.issues) ? reportObj.issues : [];
  for (const row of rows) {
    if (!row || typeof row.file !== 'string') continue;
    const file = row.file.replace(/\\/g, '/');
    if (trackedFiles && !trackedFiles.has(file)) continue;

    if (Array.isArray(row.files) && row.files.length > 0 && !seenFileIssues.has(file)) {
      seenFileIssues.add(file);
      findings.push({ category: 'files', file, symbol: '', keySymbol: '', line: 1 });
    }

    for (const category of EXPORT_AND_TYPE_CATEGORIES) {
      const items = row[category];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const rawName = String(item.name ?? '');
        if (!rawName) continue;
        const sym = item.namespace ? `${item.namespace}.${rawName}` : rawName;
        const line = Number.isSafeInteger(item.line) && item.line > 0 ? item.line : 1;
        findings.push({
          category,
          file,
          symbol: sym,
          keySymbol: sym,
          line,
        });
      }
    }

    if (Array.isArray(row.duplicates)) {
      for (const dupGroup of row.duplicates) {
        if (!Array.isArray(dupGroup) || dupGroup.length === 0) continue;
        const names = dupGroup
          .map((d) => (d && typeof d === 'object' ? String(d.name ?? '') : ''))
          .filter(Boolean);
        if (names.length === 0) continue;
        const keySymbol = [...names].sort().join('|');
        const symbol = names.join(', ');
        const validLines = dupGroup
          .map((d) => d?.line)
          .filter((l) => Number.isSafeInteger(l) && l > 0);
        const line = validLines.length > 0 ? Math.min(...validLines) : 1;
        findings.push({
          category: 'duplicates',
          file,
          symbol,
          keySymbol,
          line,
        });
      }
    }
  }

  return findings;
}

export function stripCodeComments(source) {
  let out = '';
  let state = 'code';
  let quote = '';
  let escaped = false;
  let inRegexCharClass = false;
  let prevNonSpace = '';

  const canStartRegex = (prev) =>
    !prev || '=(:[!&|?+{};,~^%*<>-'.includes(prev);

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === 'lineComment') {
      if (ch === '\n' || ch === '\r') {
        state = 'code';
        out += ch;
      }
      continue;
    }
    if (state === 'blockComment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        out += ch;
      }
      continue;
    }
    if (state === 'string') {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote || ((ch === '\n' || ch === '\r') && quote !== '`')) {
        state = 'code';
        prevNonSpace = quote;
      }
      continue;
    }
    if (state === 'regex') {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '[') {
        inRegexCharClass = true;
      } else if (ch === ']' && inRegexCharClass) {
        inRegexCharClass = false;
      } else if ((ch === '/' && !inRegexCharClass) || ch === '\n' || ch === '\r') {
        state = 'code';
        prevNonSpace = '/';
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      state = 'lineComment';
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'blockComment';
      i++;
      continue;
    }
    if (ch === '/' && canStartRegex(prevNonSpace)) {
      state = 'regex';
      inRegexCharClass = false;
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      state = 'string';
      quote = ch;
      out += ch;
      continue;
    }
    if (!/\s/.test(ch)) prevNonSpace = ch;
    out += ch;
  }

  return out;
}

export function extractPackageNameFromSpecifier(rawSpec) {
  if (typeof rawSpec !== 'string') return null;
  let spec = rawSpec.trim();
  if (
    !spec ||
    spec.startsWith('.') ||
    spec.startsWith('/') ||
    spec.startsWith('#') ||
    spec.includes(':')
  ) {
    return null;
  }
  const qIdx = spec.indexOf('?');
  if (qIdx >= 0) spec = spec.slice(0, qIdx);
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 2 && parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  }
  const slashIdx = spec.indexOf('/');
  const name = slashIdx >= 0 ? spec.slice(0, slashIdx) : spec;
  return name || null;
}

export function collectReferencedPackagesInSource(rawSource) {
  const source = stripCodeComments(rawSource);
  const refs = new Set();

  const patterns = [
    /\b(?:from|import)\s*(['"])([^'"\r\n]+)\1/g,
    /(?:\b(?:import|require)|\.resolve)\s*\(\s*(['"`])([^'"`\r\n${}]+)\1\s*\)/g,
    /@(?:import|plugin)\s+(?:url\(\s*)?(['"])([^'"\r\n]+)\1/g,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      const pkgName = extractPackageNameFromSpecifier(m[2]);
      if (pkgName) refs.add(pkgName);
    }
  }
  return refs;
}

function isSkippedManifestRelPath(relPath) {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (SKIP_DIRS.has(parts[i])) return true;
  }
  return false;
}

function findDependencyLineInManifest(rawManifestText, depName) {
  const lines = rawManifestText.split(/\r?\n/);
  let inDependenciesBlock = false;
  let braceDepth = 0;
  const escapedDep = depName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyRe = new RegExp(`^\\s*"${escapedDep}"\\s*:`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inDependenciesBlock) {
      if (/^\s*"dependencies"\s*:\s*\{/.test(line)) {
        inDependenciesBlock = true;
        braceDepth = 1;
        // Handle single-line `"dependencies": { "pkg": "1.0.0" }`.
        if (new RegExp(`"dependencies"\\s*:\\s*\\{[^}]*"${escapedDep}"\\s*:`).test(line)) {
          return i + 1;
        }
        for (const ch of line.slice(line.indexOf('{') + 1)) {
          if (ch === '{') braceDepth++;
          else if (ch === '}') braceDepth--;
        }
        if (braceDepth <= 0) inDependenciesBlock = false;
      }
    } else {
      if (keyRe.test(line)) return i + 1;
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      }
      if (braceDepth <= 0) inDependenciesBlock = false;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (keyRe.test(lines[i])) return i + 1;
  }
  return 1;
}

export function findNewUnusedDependencies({
  baseDir,
  headDir,
  baseTrackedFiles,
  headTrackedFiles,
  renamesOldToNew = new Map(),
}) {
  const allBaseDeps = new Set();
  const baseDepsByHeadManifest = new Map();

  for (const relPath of baseTrackedFiles) {
    if (path.posix.basename(relPath) !== 'package.json') continue;
    if (isSkippedManifestRelPath(relPath)) continue;
    const absPath = path.join(baseDir, relPath);
    let pkg;
    try {
      if (!lstatSync(absPath).isFile()) continue;
      pkg = parseJsonc(readFileSync(absPath, 'utf8'));
    } catch {
      continue;
    }
    if (!pkg || typeof pkg.dependencies !== 'object' || !pkg.dependencies || Array.isArray(pkg.dependencies)) {
      continue;
    }
    const mappedRel = renamesOldToNew.get(relPath) ?? relPath;
    const depSet = baseDepsByHeadManifest.get(mappedRel) ?? new Set();
    for (const dep of Object.keys(pkg.dependencies)) {
      allBaseDeps.add(dep);
      depSet.add(dep);
    }
    baseDepsByHeadManifest.set(mappedRel, depSet);
  }

  const candidateAdditions = [];
  for (const relPath of [...headTrackedFiles].sort()) {
    if (path.posix.basename(relPath) !== 'package.json') continue;
    if (isSkippedManifestRelPath(relPath)) continue;
    const absPath = path.join(headDir, relPath);
    let rawText;
    let pkg;
    try {
      if (!lstatSync(absPath).isFile()) continue;
      rawText = readFileSync(absPath, 'utf8');
      pkg = parseJsonc(rawText);
    } catch {
      continue;
    }
    if (!pkg || typeof pkg.dependencies !== 'object' || !pkg.dependencies || Array.isArray(pkg.dependencies)) {
      continue;
    }
    const priorSet = baseDepsByHeadManifest.get(relPath);
    for (const dep of Object.keys(pkg.dependencies)) {
      if (dep.startsWith('@types/')) continue;
      if (allBaseDeps.has(dep) || priorSet?.has(dep)) continue;
      candidateAdditions.push({
        manifestFile: relPath,
        depName: dep,
        line: findDependencyLineInManifest(rawText, dep),
      });
    }
  }

  if (candidateAdditions.length === 0) return [];

  const referencedAnywhere = new Set();
  for (const relPath of headTrackedFiles) {
    if (!DEP_SCAN_EXT_RE.test(relPath)) continue;
    if (isSkippedManifestRelPath(relPath)) continue;
    const absPath = path.join(headDir, relPath);
    let content;
    try {
      const st = lstatSync(absPath);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
      content = readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    for (const pkgName of collectReferencedPackagesInSource(content)) {
      referencedAnywhere.add(pkgName);
    }
  }

  const unusedAdded = [];
  for (const cand of candidateAdditions) {
    if (!referencedAnywhere.has(cand.depName)) {
      unusedAdded.push({
        category: 'dependencies',
        file: cand.manifestFile,
        symbol: cand.depName,
        keySymbol: cand.depName,
        line: cand.line,
      });
    }
  }
  return unusedAdded;
}

export function summarizeTotals(findings, newDepsCount = 0) {
  let files = 0;
  let exportsAndTypes = 0;
  let duplicates = 0;
  for (const f of findings) {
    if (f.category === 'files') files++;
    else if (EXPORT_AND_TYPE_CATEGORIES.has(f.category)) exportsAndTypes++;
    else if (f.category === 'duplicates') duplicates++;
  }
  return {
    files,
    exports: exportsAndTypes,
    duplicates,
    dependencies: newDepsCount,
  };
}

export function diffFindings(baseFindings, headFindings, renamesOldToNew = new Map()) {
  const makeKey = (category, file, keySymbol) => `${category}\0${file}\0${keySymbol}`;
  const known = new Map();

  for (const item of baseFindings) {
    const mappedFile = renamesOldToNew.get(item.file) ?? item.file;
    const k = makeKey(item.category, mappedFile, item.keySymbol ?? item.symbol ?? '');
    known.set(k, (known.get(k) ?? 0) + 1);
  }

  const added = [];
  for (const item of headFindings) {
    const k = makeKey(item.category, item.file, item.keySymbol ?? item.symbol ?? '');
    const count = known.get(k) ?? 0;
    if (count > 0) {
      known.set(k, count - 1);
    } else {
      added.push(item);
    }
  }

  let resolvedCount = 0;
  for (const remaining of known.values()) {
    if (remaining > 0) resolvedCount += remaining;
  }

  added.sort((a, b) => {
    const catDiff = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (catDiff !== 0) return catDiff;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    return a.symbol.localeCompare(b.symbol);
  });

  return { added, resolvedCount };
}

export function hasAllowUnusedLabel(rawLabelsEnv) {
  if (!rawLabelsEnv) return false;
  try {
    const parsed = JSON.parse(rawLabelsEnv);
    return (
      Array.isArray(parsed) &&
      parsed.some((label) => typeof label === 'string' && label.trim() === 'allow-unused')
    );
  } catch {
    return false;
  }
}

export function runKnipScan({ targetDir, knipInstallDir, tempDir, side, trackedFiles = null }) {
  const knipBin = path.join(knipInstallDir, 'node_modules/.bin/knip');
  if (!existsSync(knipBin)) {
    throw new Error(`Knip binary not found at ${knipBin}`);
  }

  mkdirSync(tempDir, { recursive: true });
  const configPath = path.join(tempDir, `knip-${side}.config.mjs`);
  const reportPath = path.join(tempDir, `knip-${side}-report.json`);
  rmSync(reportPath, { force: true });

  const rootManifestPath = path.join(targetDir, 'package.json');
  let createdTempRootManifest = false;
  try {
    try {
      lstatSync(rootManifestPath);
    } catch {
      writeFileSync(
        rootManifestPath,
        `${JSON.stringify({ name: 'workspace-root', private: true, type: 'module' })}\n`,
        'utf8',
      );
      createdTempRootManifest = true;
    }

    const configObj = buildKnipConfig(targetDir);
    writeKnipConfigModule(configObj, knipInstallDir, configPath);

    const proc = spawnSync(
      knipBin,
      [
        '--config',
        configPath,
        '--no-config-hints',
        '--no-tag-hints',
        '--reporter',
        'json',
        '--output-file',
        `json=${reportPath}`,
      ],
      {
        cwd: targetDir,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, CI: 'true' },
      },
    );

    // Knip exits 0 (no issues) or 1 (issues found). Exit >= 2, signal, or missing output is an error.
    if (
      proc.error ||
      proc.signal ||
      typeof proc.status !== 'number' ||
      proc.status < 0 ||
      proc.status >= 2 ||
      !existsSync(reportPath)
    ) {
      const detail = [proc.stderr, proc.stdout, proc.error?.message]
        .filter(Boolean)
        .join('\n')
        .trim();
      throw new Error(
        `Knip ${side} scan failed (exit ${proc.status ?? proc.signal ?? 'unknown'}): ${detail.slice(0, 1000)}`,
      );
    }

    const reportObj = JSON.parse(readFileSync(reportPath, 'utf8'));
    return parseKnipJsonReport(reportObj, trackedFiles);
  } finally {
    if (createdTempRootManifest) {
      rmSync(rootManifestPath, { force: true });
    }
  }
}

function emitGithubOutput(outputFile, key, value) {
  if (!outputFile) return;
  const safeVal = String(value).replace(/[\r\n\u2028\u2029]/g, '');
  appendFileSync(outputFile, `${key}=${safeVal}\n`, 'utf8');
}

export function executePrCheck({
  sourceDir = process.cwd(),
  baseRef = process.env.BASE,
  labelsJson = process.env.LABELS,
  runnerTemp = process.env.RUNNER_TEMP,
  knipInstallDir = runnerTemp ? path.join(runnerTemp, 'knip') : '',
  githubOutput = process.env.GITHUB_OUTPUT,
} = {}) {
  if (!baseRef) {
    emitGithubOutput(githubOutput, 'state', 'unavailable');
    return { exitCode: 0, state: 'unavailable', reason: 'Missing BASE ref' };
  }

  const workScratch = path.join(runnerTemp || '/tmp', `knip-run-${process.pid}-${Date.now()}`);
  const baseWorktree = path.join(workScratch, 'base');
  mkdirSync(workScratch, { recursive: true });

  try {
    const mergeBase = gitBuffer(['merge-base', baseRef, 'HEAD'], sourceDir).toString('utf8').trim();
    const headSha = gitBuffer(['rev-parse', 'HEAD'], sourceDir).toString('utf8').trim();
    if (!/^[0-9a-f]{40}$/i.test(mergeBase) || !/^[0-9a-f]{40}$/i.test(headSha)) {
      throw new Error('Could not resolve 40-char merge-base and HEAD SHAs');
    }

    gitBuffer(['worktree', 'add', '--quiet', '--detach', baseWorktree, mergeBase], sourceDir);

    const baseTracked = getTrackedFiles(baseWorktree);
    const headTracked = getTrackedFiles(sourceDir);
    const renames = getRenameMap(sourceDir, mergeBase, headSha);

    // If BASE had zero JS/TS files yet (brand-new JS/TS repo), baseline is empty.
    const jsExtRe = /\.(?:[cm]?[jt]sx?|es6?)$/i;
    const baseHasJs = [...baseTracked].some((f) => jsExtRe.test(f));

    const baseKnipFindings = baseHasJs
      ? runKnipScan({
          targetDir: baseWorktree,
          knipInstallDir,
          tempDir: workScratch,
          side: 'base',
          trackedFiles: baseTracked,
        })
      : [];

    const headKnipFindings = runKnipScan({
      targetDir: sourceDir,
      knipInstallDir,
      tempDir: workScratch,
      side: 'head',
      trackedFiles: headTracked,
    });

    const newUnusedDeps = findNewUnusedDependencies({
      baseDir: baseWorktree,
      headDir: sourceDir,
      baseTrackedFiles: baseTracked,
      headTrackedFiles: headTracked,
      renamesOldToNew: renames,
    });

    const allHeadFindings = [...headKnipFindings, ...newUnusedDeps];
    const { added, resolvedCount } = diffFindings(baseKnipFindings, allHeadFindings, renames);

    const before = summarizeTotals(baseKnipFindings, 0);
    const after = summarizeTotals(headKnipFindings, newUnusedDeps.length);
    const waived = hasAllowUnusedLabel(labelsJson);
    const state = added.length === 0 ? 'clean' : waived ? 'waived' : 'failed';

    const report = {
      base: mergeBase.toLowerCase(),
      before,
      after,
      addedCount: added.length,
      resolvedCount,
      waived,
      added: added.slice(0, 50).map(({ category, file, symbol, line }) => ({
        category,
        file,
        symbol,
        line,
      })),
    };

    emitGithubOutput(githubOutput, 'report', JSON.stringify(report));
    emitGithubOutput(githubOutput, 'state', state);

    const exitCode = added.length > 0 && !waived ? 1 : 0;
    return { exitCode, state, report };
  } catch (error) {
    console.error('[unused-code] Scan unavailable (failing open):', error?.message ?? error);
    emitGithubOutput(githubOutput, 'state', 'unavailable');
    return { exitCode: 0, state: 'unavailable', reason: error?.message ?? String(error) };
  } finally {
    try {
      if (existsSync(baseWorktree)) {
        gitBuffer(['worktree', 'remove', '--force', baseWorktree], sourceDir);
      }
    } catch {
      // Best-effort worktree cleanup.
    }
    rmSync(workScratch, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { exitCode } = executePrCheck();
  process.exit(exitCode);
}
