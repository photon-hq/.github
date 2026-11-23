import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildKnipConfig,
  collectReachableImportTargets,
  extractPackageNameFromSpecifier,
  isRealPathInsideRepo,
  parseJsonc,
  SKIP_DIRS,
  tokenizeModuleSource,
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

function isTypeOnlyFromClause(tokens, fromIdx) {
  let kwIdx = -1;
  for (let k = fromIdx - 1; k >= 0; k--) {
    const t = tokens[k];
    if (t.type === 'punct' && t.value === ';') break;
    if (t.type === 'ident' && t.value === 'from' && tokens[k - 1]?.value !== '.') break;
    if (
      t.type === 'ident' &&
      (t.value === 'import' || t.value === 'export') &&
      tokens[k - 1]?.value !== '.'
    ) {
      kwIdx = k;
      break;
    }
  }
  if (kwIdx < 0) return false;

  if (
    tokens[kwIdx + 1]?.type === 'ident' &&
    tokens[kwIdx + 1]?.value === 'type' &&
    kwIdx + 1 < fromIdx - 1 &&
    tokens[kwIdx + 2]?.value !== ','
  ) {
    return true;
  }

  if (
    tokens[kwIdx + 1]?.type === 'punct' &&
    tokens[kwIdx + 1]?.value === '{' &&
    tokens[fromIdx - 1]?.type === 'punct' &&
    tokens[fromIdx - 1]?.value === '}'
  ) {
    const groups = [];
    let current = [];
    for (let k = kwIdx + 2; k < fromIdx - 1; k++) {
      if (tokens[k].type === 'punct' && tokens[k].value === ',') {
        if (current.length > 0) groups.push(current);
        current = [];
      } else {
        current.push(tokens[k]);
      }
    }
    if (current.length > 0) groups.push(current);
    if (
      groups.length > 0 &&
      groups.every(
        (g) =>
          g.length >= 2 &&
          g[0].type === 'ident' &&
          g[0].value === 'type' &&
          !(g.length === 3 && g[1].type === 'ident' && g[1].value === 'as'),
      )
    ) {
      return true;
    }
  }

  return false;
}

function collectReferencedSpecifiersInSource(rawSource, staticImportMode = 'any') {
  const tokens = tokenizeModuleSource(rawSource);
  const packages = new Set();
  const subpathImports = new Map();

  const addSpec = (spec, mode = 'import') => {
    if (typeof spec !== 'string') return;
    const trimmed = spec.trim();
    if (trimmed.startsWith('#')) {
      const qIdx = trimmed.indexOf('?');
      const cleanHash = qIdx >= 0 ? trimmed.slice(0, qIdx) : trimmed;
      let modes = subpathImports.get(cleanHash);
      if (!modes) {
        modes = new Set();
        subpathImports.set(cleanHash, modes);
      }
      if (mode === 'any') {
        modes.add('import');
        modes.add('require');
      } else {
        modes.add(mode);
      }
      return;
    }
    const pkgName = extractPackageNameFromSpecifier(trimmed);
    if (pkgName) packages.add(pkgName);
  };
  const isCloseOrComma = (tok) => tok?.type === 'punct' && (tok.value === ')' || tok.value === ',');

  const requireBindings = new Set(['require']);
  const openParenForClose = new Map();
  const parenStack = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === 'punct' && tok.value === '(') {
      parenStack.push(i);
    } else if (tok.type === 'punct' && tok.value === ')' && parenStack.length > 0) {
      openParenForClose.set(i, parenStack.pop());
    }
    if (
      tok.type === 'ident' &&
      tokens[i + 1]?.type === 'punct' &&
      tokens[i + 1]?.value === '=' &&
      tokens[i + 2]?.type === 'ident' &&
      tokens[i + 2]?.value === 'createRequire' &&
      tokens[i + 3]?.type === 'punct' &&
      tokens[i + 3]?.value === '('
    ) {
      requireBindings.add(tok.value);
    }
  }

  const getModuleResolverMode = (dotIdx) => {
    const recv = tokens[dotIdx - 1];
    if (recv?.type === 'ident' && requireBindings.has(recv.value) && tokens[dotIdx - 2]?.value !== '.') {
      return 'require';
    }
    if (
      recv?.type === 'ident' &&
      recv.value === 'meta' &&
      tokens[dotIdx - 2]?.type === 'punct' &&
      tokens[dotIdx - 2]?.value === '.' &&
      tokens[dotIdx - 3]?.type === 'ident' &&
      tokens[dotIdx - 3]?.value === 'import'
    ) {
      return 'import';
    }
    if (recv?.type === 'punct' && recv.value === ')') {
      const openIdx = openParenForClose.get(dotIdx - 1);
      if (openIdx !== undefined && tokens[openIdx - 1]?.type === 'ident') {
        return tokens[openIdx - 1].value === 'createRequire' ? 'require' : null;
      }
    }
    return null;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = tokens[i - 1];

    if (tok.type === 'ident' && tok.value === 'from' && prev?.value !== '.') {
      if (tokens[i + 1]?.type === 'string') {
        const clauseMode = isTypeOnlyFromClause(tokens, i) ? 'import' : staticImportMode;
        addSpec(tokens[i + 1].value, clauseMode);
      }
      continue;
    }

    if (tok.type === 'ident' && tok.value === 'import' && prev?.value !== '.') {
      if (tokens[i + 1]?.type === 'string') {
        addSpec(tokens[i + 1].value, staticImportMode);
      } else if (
        tokens[i + 1]?.type === 'punct' &&
        tokens[i + 1].value === '(' &&
        tokens[i + 2]?.type === 'string' &&
        isCloseOrComma(tokens[i + 3])
      ) {
        addSpec(tokens[i + 2].value, 'import');
      }
      continue;
    }

    if (
      tok.type === 'ident' &&
      requireBindings.has(tok.value) &&
      prev?.value !== '.' &&
      tokens[i + 1]?.type === 'punct' &&
      tokens[i + 1].value === '(' &&
      tokens[i + 2]?.type === 'string' &&
      isCloseOrComma(tokens[i + 3])
    ) {
      addSpec(tokens[i + 2].value, 'require');
      continue;
    }

    if (
      tok.type === 'punct' &&
      tok.value === '.' &&
      tokens[i + 1]?.type === 'ident' &&
      tokens[i + 1]?.value === 'resolve' &&
      tokens[i + 2]?.type === 'punct' &&
      tokens[i + 2]?.value === '(' &&
      tokens[i + 3]?.type === 'string' &&
      isCloseOrComma(tokens[i + 4])
    ) {
      const resolverMode = getModuleResolverMode(i);
      if (resolverMode) addSpec(tokens[i + 3].value, resolverMode);
      continue;
    }

    if (tok.type === 'at' && (tok.value === '@import' || tok.value === '@plugin')) {
      if (tokens[i + 1]?.type === 'string') {
        addSpec(tokens[i + 1].value, 'any');
      } else if (
        tok.value === '@import' &&
        tokens[i + 1]?.type === 'ident' &&
        tokens[i + 1].value === 'url' &&
        tokens[i + 2]?.type === 'punct' &&
        tokens[i + 2].value === '(' &&
        tokens[i + 3]?.type === 'string'
      ) {
        addSpec(tokens[i + 3].value, 'any');
      }
    }
  }

  return { packages, subpathImports };
}

export function collectReferencedPackagesInSource(rawSource) {
  return collectReferencedSpecifiersInSource(rawSource).packages;
}

function inferStaticImportMode(relPath, pkgType) {
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.mts') || lower.endsWith('.mjs')) return 'import';
  if (lower.endsWith('.cts') || lower.endsWith('.cjs')) return 'require';
  return pkgType === 'module' ? 'import' : 'any';
}

function resolveSubpathImportTargets(owningImports, hashSpec, mode = 'import') {
  if (!hashSpec.includes('*') && Object.hasOwn(owningImports, hashSpec)) {
    return collectReachableImportTargets(owningImports[hashSpec], null, mode).targets;
  }
  let bestKey = null;
  let bestMatch = null;
  for (const impKey of Object.keys(owningImports)) {
    const starIdx = impKey.indexOf('*');
    if (starIdx < 0 || impKey.indexOf('*', starIdx + 1) >= 0) continue;
    const prefix = impKey.slice(0, starIdx);
    const trailer = impKey.slice(starIdx + 1);
    if (
      hashSpec.length < impKey.length ||
      !hashSpec.startsWith(prefix) ||
      !hashSpec.endsWith(trailer)
    ) {
      continue;
    }
    if (bestKey !== null) {
      const bestStar = bestKey.indexOf('*');
      if (starIdx < bestStar) continue;
      if (starIdx === bestStar && impKey.length <= bestKey.length) continue;
    }
    bestKey = impKey;
    bestMatch = hashSpec.slice(starIdx, hashSpec.length - trailer.length);
  }
  if (bestKey === null) return [];
  return collectReachableImportTargets(owningImports[bestKey], bestMatch, mode).targets;
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
      depSet.add(dep);
    }
    baseDepsByHeadManifest.set(mappedRel, depSet);
  }

  const candidateAdditions = [];
  const importsByDir = new Map();
  const pkgTypeByDir = new Map();
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
    if (!pkg || typeof pkg !== 'object') continue;
    const manifestDir = path.posix.dirname(relPath);
    pkgTypeByDir.set(manifestDir, pkg.type === 'module' ? 'module' : 'commonjs');
    if (pkg.imports && typeof pkg.imports === 'object' && !Array.isArray(pkg.imports)) {
      importsByDir.set(manifestDir, pkg.imports);
    }
    if (typeof pkg.dependencies !== 'object' || !pkg.dependencies || Array.isArray(pkg.dependencies)) {
      continue;
    }
    const priorSet = baseDepsByHeadManifest.get(relPath);
    for (const dep of Object.keys(pkg.dependencies)) {
      if (dep.startsWith('@types/')) continue;
      if (priorSet?.has(dep)) continue;
      candidateAdditions.push({
        manifestFile: relPath,
        depName: dep,
        line: findDependencyLineInManifest(rawText, dep),
      });
    }
  }

  if (candidateAdditions.length === 0) return [];

  const findNearestDirValue = (map, fileRelPath) => {
    let cur = path.posix.dirname(fileRelPath);
    while (true) {
      if (map.has(cur)) return map.get(cur);
      if (cur === '.' || !cur) return null;
      const next = path.posix.dirname(cur);
      if (next === cur) return null;
      cur = next;
    }
  };

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
    const pkgType = findNearestDirValue(pkgTypeByDir, relPath) ?? 'commonjs';
    const { packages, subpathImports } = collectReferencedSpecifiersInSource(
      content,
      inferStaticImportMode(relPath, pkgType),
    );
    for (const pkgName of packages) {
      referencedAnywhere.add(pkgName);
    }
    if (subpathImports.size > 0) {
      const owningImports = findNearestDirValue(importsByDir, relPath);
      if (owningImports) {
        for (const [hashSpec, modes] of subpathImports) {
          for (const mode of modes) {
            for (const target of resolveSubpathImportTargets(owningImports, hashSpec, mode)) {
              const pkgName = extractPackageNameFromSpecifier(target);
              if (pkgName) referencedAnywhere.add(pkgName);
            }
          }
        }
      }
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

  const realTargetDir = realpathSync(targetDir);
  const rootManifestPath = path.join(targetDir, 'package.json');
  const pnpmWorkspacePath = path.join(targetDir, 'pnpm-workspace.yaml');
  const yarnrcPath = path.join(targetDir, '.yarnrc.yml');
  const restoreEntries = [];

  const saveForRestore = (filePath, lstat, existingBytes = null) => {
    if (lstat.isSymbolicLink()) {
      const symlinkTarget = readlinkSync(filePath);
      rmSync(filePath, { force: true });
      restoreEntries.push({ filePath, symlinkTarget });
    } else {
      const rawBytes = existingBytes ?? readFileSync(filePath);
      const mode = lstat.mode & 0o777;
      rmSync(filePath, { force: true });
      restoreEntries.push({ filePath, rawBytes, mode });
    }
  };

  try {
    const rootLstat = lstatSync(rootManifestPath, { throwIfNoEntry: false });
    let wroteSyntheticRootManifest = false;
    if (!rootLstat) {
      restoreEntries.push({ filePath: rootManifestPath });
      writeFileSync(
        rootManifestPath,
        `${JSON.stringify({ name: 'workspace-root', private: true, type: 'module' })}\n`,
        'utf8',
      );
      wroteSyntheticRootManifest = true;
    } else if (
      rootLstat.isSymbolicLink() &&
      (!isRealPathInsideRepo(rootManifestPath, realTargetDir) ||
        !statSync(rootManifestPath, { throwIfNoEntry: false })?.isFile())
    ) {
      saveForRestore(rootManifestPath, rootLstat);
      writeFileSync(
        rootManifestPath,
        `${JSON.stringify({ name: 'workspace-root', private: true, type: 'module' })}\n`,
        'utf8',
      );
      wroteSyntheticRootManifest = true;
    }

    const configObj = buildKnipConfig(targetDir);
    writeKnipConfigModule(configObj, knipInstallDir, configPath);

    // Strip `package.json#knip` before invoking Knip so PR-controlled preprocessors or plugins never run.
    if (!wroteSyntheticRootManifest && statSync(rootManifestPath, { throwIfNoEntry: false })?.isFile()) {
      const rawBytes = readFileSync(rootManifestPath);
      const parsedRoot = parseJsonc(rawBytes.toString('utf8'));
      if (
        parsedRoot &&
        typeof parsedRoot === 'object' &&
        !Array.isArray(parsedRoot) &&
        'knip' in parsedRoot
      ) {
        saveForRestore(rootManifestPath, rootLstat, rawBytes);
        const sanitized = { ...parsedRoot };
        delete sanitized.knip;
        writeFileSync(rootManifestPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
      }
    }

    // Strip `pnpm-workspace.yaml#include` so Knip never calls `_load` on PR-controlled paths.
    const wsLstat = lstatSync(pnpmWorkspacePath, { throwIfNoEntry: false });
    if (wsLstat) {
      if (
        wsLstat.isSymbolicLink() &&
        (!isRealPathInsideRepo(pnpmWorkspacePath, realTargetDir) ||
          !statSync(pnpmWorkspacePath, { throwIfNoEntry: false })?.isFile())
      ) {
        saveForRestore(pnpmWorkspacePath, wsLstat);
      } else if (statSync(pnpmWorkspacePath, { throwIfNoEntry: false })?.isFile()) {
        const knipPkgPath = path.join(knipInstallDir, 'node_modules/knip/package.json');
        if (existsSync(knipPkgPath)) {
          const { parse: parseYaml, stringify: stringifyYaml } = createRequire(knipPkgPath)('yaml');
          const rawWsBytes = readFileSync(pnpmWorkspacePath);
          let parsedWs;
          try {
            parsedWs = parseYaml(rawWsBytes.toString('utf8').replace(/^\ufeff/, ''), {
              logLevel: 'error',
            });
          } catch {
            parsedWs = null;
          }
          if (
            parsedWs &&
            typeof parsedWs === 'object' &&
            !Array.isArray(parsedWs) &&
            'include' in parsedWs
          ) {
            saveForRestore(pnpmWorkspacePath, wsLstat, rawWsBytes);
            const sanitizedWs = { ...parsedWs };
            delete sanitizedWs.include;
            writeFileSync(pnpmWorkspacePath, stringifyYaml(sanitizedWs), 'utf8');
          }
        } else {
          saveForRestore(pnpmWorkspacePath, wsLstat);
          rmSync(pnpmWorkspacePath, { force: true });
        }
      }
    }

    const yarnLstat = lstatSync(yarnrcPath, { throwIfNoEntry: false });
    if (yarnLstat?.isSymbolicLink() && !isRealPathInsideRepo(yarnrcPath, realTargetDir)) {
      saveForRestore(yarnrcPath, yarnLstat);
    }

    const childEnv = { CI: 'true' };
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT']) {
      if (process.env[key]) childEnv[key] = process.env[key];
    }

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
        env: childEnv,
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
    for (let i = restoreEntries.length - 1; i >= 0; i--) {
      const entry = restoreEntries[i];
      rmSync(entry.filePath, { force: true });
      if (entry.symlinkTarget !== undefined) {
        symlinkSync(entry.symlinkTarget, entry.filePath);
      } else if (entry.rawBytes !== undefined) {
        writeFileSync(entry.filePath, entry.rawBytes);
        if (entry.mode !== undefined) {
          chmodSync(entry.filePath, entry.mode);
        }
      }
    }
  }
}

function emitGithubOutput(outputFile, key, value) {
  if (!outputFile) return;
  const safeVal = String(value).replace(/[\r\n\u2028\u2029]/g, '');
  appendFileSync(outputFile, `${key}=${safeVal}\n`, 'utf8');
}

const SUMMARY_CATEGORY_LABELS = {
  files: 'Unused file',
  exports: 'Unused export',
  nsExports: 'Unused namespace export',
  types: 'Unused type',
  nsTypes: 'Unused namespace type',
  enumMembers: 'Unused enum member',
  duplicates: 'Duplicate export',
  dependencies: 'Unused dependency',
};

function formatStepSummary(report, headSha) {
  const { base, before, after, addedCount, resolvedCount, waived, added } = report;
  if (addedCount === 0 && resolvedCount === 0) return '';

  const lines = [
    '### Unused code',
    '',
    `| Category | Before \`${base.slice(0, 7)}\` | After \`${headSha.slice(0, 7)}\` |`,
    '| --- | ---: | ---: |',
    `| Unused files | ${before.files} | ${after.files} |`,
    `| Unused exports & types | ${before.exports} | ${after.exports} |`,
    `| Duplicate exports | ${before.duplicates} | ${after.duplicates} |`,
    `| New unused dependencies | ${before.dependencies} | ${after.dependencies} |`,
    '',
  ];

  const resolvedNote = resolvedCount ? ` · resolved ${resolvedCount} pre-existing` : '';
  if (addedCount > 0) {
    const noun = addedCount === 1 ? 'item' : 'items';
    lines.push(
      waived
        ? `**${addedCount} new unused ${noun}** (waived via \`allow-unused\` label)${resolvedNote}.`
        : `**${addedCount} new unused ${noun}**${resolvedNote}. Remove unused code, mark intentional stacked-PR or public exports with \`/** @public */\`, or apply the \`allow-unused\` PR label.`,
    );
    lines.push('');
    for (const item of added) {
      const label = SUMMARY_CATEGORY_LABELS[item.category] ?? item.category;
      const sym = item.symbol ? ` — \`${item.symbol.replace(/`/g, "'")}\`` : '';
      lines.push(`- **${label}**: \`${item.file}:${item.line}\`${sym}`);
    }
    if (addedCount > added.length) {
      lines.push(`- _…and ${addedCount - added.length} more not shown_`);
    }
  } else {
    const noun = resolvedCount === 1 ? 'item' : 'items';
    lines.push(`Resolved ${resolvedCount} pre-existing unused ${noun} · 0 new.`);
  }

  return `${lines.join('\n')}\n`;
}

export function executePrCheck({
  sourceDir = process.cwd(),
  baseRef = process.env.BASE,
  labelsJson = process.env.LABELS,
  runnerTemp = process.env.RUNNER_TEMP,
  knipInstallDir = runnerTemp ? path.join(runnerTemp, 'knip') : '',
  githubOutput = process.env.GITHUB_OUTPUT,
  githubStepSummary = process.env.GITHUB_STEP_SUMMARY,
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

    if (githubStepSummary) {
      try {
        const summaryMd = formatStepSummary(report, headSha.toLowerCase());
        if (summaryMd) appendFileSync(githubStepSummary, summaryMd, 'utf8');
      } catch (summaryError) {
        console.warn(
          '[unused-code] Failed to write job summary:',
          summaryError?.message ?? summaryError,
        );
      }
    }

    if (added.length > 0 && !waived) {
      for (const item of report.added) {
        const sym = item.symbol ? ` (${item.symbol})` : '';
        console.error(`[unused-code] ${item.category}: ${item.file}:${item.line}${sym}`);
      }
    }

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
