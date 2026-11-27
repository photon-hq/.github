import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canCompareAsBaseMigrationSql,
  classifySqlFile,
  createClassifierCache,
  isRealPathInsideRepo,
  normalizeGitRelPath,
  resolveBaseFileProfile,
  scanSqlTokens,
  serializeSquawkToml,
} from './config.mjs';

function gitBuffer(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function escapeSquawkGlobPath(relPath) {
  return relPath.replace(/([*?\[])/g, '[$1]');
}

export function collectChangedSqlEntries(repoDir, baseSha, headSha) {
  const out = gitBuffer(
    [
      'diff',
      '--find-renames',
      '--name-status',
      '-z',
      '--diff-filter=ACMRT',
      baseSha,
      headSha,
      '--',
      '*.sql',
      '*.SQL',
    ],
    repoDir,
  ).toString('utf8');

  const fields = out.split('\0');
  const entries = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i++];
    if (!status) continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const oldPath = normalizeGitRelPath(fields[i++] ?? '');
      const newPath = normalizeGitRelPath(fields[i++] ?? '');
      if (!newPath) continue;
      if (code === 'R') {
        entries.push({ kind: 'renamed', baseFile: oldPath, headFile: newPath });
      } else {
        entries.push({ kind: 'added', baseFile: null, headFile: newPath });
      }
    } else {
      const filePath = normalizeGitRelPath(fields[i++] ?? '');
      if (!filePath) continue;
      if (code === 'A' || code === 'T') {
        entries.push({ kind: 'added', baseFile: null, headFile: filePath });
      } else if (code === 'M') {
        entries.push({ kind: 'modified', baseFile: filePath, headFile: filePath });
      }
    }
  }
  return entries;
}

export function stripSqlCommentsAndCollapseWhitespace(sqlFragment) {
  return scanSqlTokens(sqlFragment, { keepQuotes: true });
}

function sliceLineUtf8Bytes(lineText, startByte, endByte = null) {
  const buf = Buffer.from(lineText, 'utf8');
  const s = Math.max(0, Math.min(buf.length, startByte));
  const e = endByte === null ? buf.length : Math.max(s, Math.min(buf.length, endByte));
  return buf.subarray(s, e).toString('utf8');
}

export function extractStatementSignature(fileLines, row) {
  if (!Array.isArray(fileLines) || fileLines.length === 0) {
    return String(row.message ?? '');
  }
  const startLine = Number.isSafeInteger(row.line) && row.line >= 0 ? row.line : 0;
  const endLine =
    Number.isSafeInteger(row.line_end) && row.line_end >= startLine ? row.line_end : startLine;
  const startCol = Number.isSafeInteger(row.column) && row.column >= 0 ? row.column : 0;
  const endCol = Number.isSafeInteger(row.column_end) && row.column_end >= 0 ? row.column_end : null;

  if (startLine >= fileLines.length) {
    return String(row.message ?? '');
  }

  // Extract exact AST span reported by Squawk using UTF-8 byte column offsets.
  const clampedEndLine = Math.min(endLine, fileLines.length - 1);
  const spanParts = [];
  for (let ln = startLine; ln <= clampedEndLine; ln++) {
    const lineStr = fileLines[ln];
    const fromB = ln === startLine ? startCol : 0;
    const toB = ln === clampedEndLine ? endCol : null;
    spanParts.push(sliceLineUtf8Bytes(lineStr, fromB, toB));
  }
  const normalizedSpan = stripSqlCommentsAndCollapseWhitespace(spanParts.join('\n'));

  // Capture statement head preceding the span (after the last top-level `;` or `--> statement-breakpoint`),
  // ignoring semicolons inside SQL comments or quoted strings/identifiers.
  const lookbackMin = startLine > 5000 ? startLine - 5000 : 0;
  const prefixParts = [];
  for (let ln = lookbackMin; ln < startLine; ln++) {
    prefixParts.push(fileLines[ln]);
  }
  prefixParts.push(sliceLineUtf8Bytes(fileLines[startLine], 0, startCol));
  const prefixText = prefixParts.join('\n');

  let stmtStart = 0;
  scanSqlTokens(prefixText, {
    keepQuotes: true,
    onStatementBreak: (nextIdx) => {
      stmtStart = nextIdx;
    },
  });
  const normalizedPrefix = stripSqlCommentsAndCollapseWhitespace(prefixText.slice(stmtStart));
  return normalizedPrefix ? `${normalizedPrefix} :: ${normalizedSpan}` : normalizedSpan;
}

function normalizeReportedPath(rawFile, targetDir) {
  if (typeof rawFile !== 'string' || !rawFile) return '';
  if (path.isAbsolute(rawFile)) {
    const rel = path.relative(targetDir, rawFile);
    return process.platform === 'win32' ? rel.replace(/\\/g, '/') : rel;
  }
  return normalizeGitRelPath(rawFile);
}

export function runSquawkScan({
  targetDir,
  squawkInstallDir,
  tempDir,
  side,
  files,
  profile,
  timeoutMs = 60_000,
}) {
  if (!Array.isArray(files) || files.length === 0) return [];

  const squawkBin = path.join(squawkInstallDir, 'node_modules/.bin/squawk');
  if (!existsSync(squawkBin)) {
    throw new Error(`Squawk binary not found at ${squawkBin}`);
  }

  const realTargetDir = realpathSync(targetDir);
  const verifiedFiles = [];
  for (const rel of files) {
    const abs = path.join(targetDir, rel);
    const lst = lstatSync(abs, { throwIfNoEntry: false });
    if (lst?.isFile() && lst.size <= 16 * 1024 * 1024 && isRealPathInsideRepo(abs, realTargetDir)) {
      verifiedFiles.push(rel);
    }
  }
  if (verifiedFiles.length === 0) return [];

  mkdirSync(tempDir, { recursive: true });
  const configPath = path.join(tempDir, `squawk-${side}.toml`);
  writeFileSync(configPath, serializeSquawkToml(profile), 'utf8');

  const passthroughVars = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT'];
  const squawkEnv = Object.fromEntries(
    [['CI', 'true'], ...passthroughVars.filter((k) => process.env[k]).map((k) => [k, process.env[k]])],
  );

  const cliArgs = ['check', '--no-error-on-unmatched-pattern'];
  if (!profile.assumeInTransaction) {
    cliArgs.push('--no-assume-in-transaction');
  }
  cliArgs.push('--config', configPath, '--reporter', 'json', '--', ...verifiedFiles.map(escapeSquawkGlobPath));

  const proc = spawnSync(squawkBin, cliArgs, {
    cwd: targetDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    env: squawkEnv,
  });

  const stdoutTrimmed = (proc.stdout ?? '').trim();
  if (
    proc.error ||
    proc.signal ||
    typeof proc.status !== 'number' ||
    proc.status < 0 ||
    proc.status >= 2 ||
    !stdoutTrimmed
  ) {
    const detail = [proc.stderr, proc.stdout, proc.error?.message]
      .filter(Boolean)
      .join('\n')
      .trim();
    throw new Error(
      `Squawk ${side} scan failed (exit ${proc.status ?? proc.signal ?? 'unknown'}): ${detail.slice(0, 1000)}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stdoutTrimmed);
  } catch (parseErr) {
    throw new Error(`Invalid Squawk JSON on ${side}: ${parseErr?.message ?? parseErr}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array from Squawk on ${side}`);
  }

  const allowedSet = new Set(verifiedFiles);
  const linesByFile = new Map();
  const getFileLines = (relFile) => {
    if (linesByFile.has(relFile)) return linesByFile.get(relFile);
    let lines = [];
    try {
      lines = readFileSync(path.join(targetDir, relFile), 'utf8').split(/\r?\n/);
    } catch {
      lines = [];
    }
    linesByFile.set(relFile, lines);
    return lines;
  };

  const findings = [];
  const seenSyntaxErrorLines = new Set();

  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const file = normalizeReportedPath(row.file, targetDir);
    if (!allowedSet.has(file)) continue;

    const rule = typeof row.rule_name === 'string' && row.rule_name ? row.rule_name : 'unknown-rule';
    const oneBasedLine = (Number.isSafeInteger(row.line) && row.line >= 0 ? row.line : 0) + 1;
    const zeroBasedCol = Number.isSafeInteger(row.column) && row.column >= 0 ? row.column : 0;

    if (rule === 'syntax-error') {
      const syntaxKey = `${file}:${oneBasedLine}`;
      if (seenSyntaxErrorLines.has(syntaxKey)) continue;
      seenSyntaxErrorLines.add(syntaxKey);
    }

    const message = typeof row.message === 'string' ? row.message : '';
    const help = typeof row.help === 'string' ? row.help : '';
    const note = typeof row.note === 'string' ? row.note : '';
    const statementKey =
      rule === 'syntax-error' ? message : extractStatementSignature(getFileLines(file), row);

    findings.push({
      file,
      line: oneBasedLine,
      column: zeroBasedCol + 1,
      rule,
      message,
      help,
      note,
      statementKey,
    });
  }

  return findings;
}

export function diffMigrationFindings(baseFindings, headFindings, baseToHeadMap = new Map()) {
  const makeKey = (file, rule, statementKey) => `${file}\0${rule}\0${statementKey}`;
  const known = new Map();

  for (const item of baseFindings) {
    const mappedFile = baseToHeadMap.get(item.file) ?? item.file;
    const key = makeKey(mappedFile, item.rule, item.statementKey ?? item.message);
    known.set(key, (known.get(key) ?? 0) + 1);
  }

  const added = [];
  for (const item of headFindings) {
    const key = makeKey(item.file, item.rule, item.statementKey ?? item.message);
    const count = known.get(key) ?? 0;
    if (count > 0) {
      known.set(key, count - 1);
    } else {
      added.push(item);
    }
  }

  let resolvedCount = 0;
  for (const rem of known.values()) {
    if (rem > 0) resolvedCount += rem;
  }

  added.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    return a.rule.localeCompare(b.rule);
  });

  return { added, resolvedCount };
}

export function hasAllowUnsafeMigrationLabel(labelsText) {
  try {
    const list = JSON.parse(labelsText || '[]');
    return Array.isArray(list) && list.some((entry) => typeof entry === 'string' && entry.trim() === 'allow-unsafe-migration');
  } catch {
    return false;
  }
}

function emitOutput(outputFile, key, value) {
  if (!outputFile) return;
  const clean = String(value).replace(/[\r\n\u2028\u2029]/g, '');
  appendFileSync(outputFile, `${key}=${clean}\n`, 'utf8');
}

function ruleDocUrl(rule) {
  return rule === 'syntax-error'
    ? 'https://squawkhq.com/docs/rules'
    : `https://squawkhq.com/docs/${encodeURIComponent(rule)}`;
}

function sanitizeInlineMd(text) {
  return String(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/([[\]<>])/g, '\\$1')
    .trim();
}

export function formatMigrationStepSummary(report) {
  const { checkedFiles, addedCount, waived, added } = report;
  if (addedCount === 0) return '';

  const issueNoun = addedCount === 1 ? 'violation' : 'violations';
  const fileNoun = checkedFiles === 1 ? 'migration file' : 'migration files';
  const header = waived
    ? `**${addedCount} new unsafe PostgreSQL migration ${issueNoun}** across ${checkedFiles} ${fileNoun} (waived via \`allow-unsafe-migration\` label).`
    : `**${addedCount} new unsafe PostgreSQL migration ${issueNoun}** across ${checkedFiles} ${fileNoun}. Rewrite using an expand-and-contract migration, suppress an intentional statement with \`-- squawk-ignore <rule>\` (or \`-- squawk-ignore-file\`), or apply the \`allow-unsafe-migration\` PR label.`;

  const lines = ['### PostgreSQL migration check', '', header, ''];
  for (const item of added) {
    const impact = item.note
      ? `${sanitizeInlineMd(item.message)} (${sanitizeInlineMd(item.note)})`
      : sanitizeInlineMd(item.message);
    const fixPart = item.help ? ` — *Fix:* ${sanitizeInlineMd(item.help)}` : '';
    const waivePart =
      item.rule === 'syntax-error' ? '' : ` · waive inline with \`-- squawk-ignore ${item.rule}\``;
    lines.push(
      `- \`${item.file}:${item.line}\` · [\`${item.rule}\`](${ruleDocUrl(item.rule)}): ${impact}${fixPart}${waivePart}`,
    );
  }
    const omittedCount = addedCount - added.length;
    if (omittedCount > 0) {
      lines.push(`- _…${omittedCount} additional findings omitted_`);
    }
    return `${lines.join('\n')}\n`;
}

function resolveCommitPair(repoDir, targetRef) {
  const base = gitBuffer(['merge-base', targetRef, 'HEAD'], repoDir).toString('utf8').trim();
  const head = gitBuffer(['rev-parse', 'HEAD'], repoDir).toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/i.test(base) || !/^[0-9a-f]{40}$/i.test(head)) {
    throw new Error('Failed to resolve 40-hex merge-base and HEAD commits');
  }
  return { mergeBase: base, headSha: head };
}

export function executePrCheck(options = {}) {
  const {
    sourceDir = process.cwd(),
    baseRef = process.env.BASE,
    labelsJson = process.env.LABELS,
    runnerTemp = process.env.RUNNER_TEMP,
    githubOutput = process.env.GITHUB_OUTPUT,
    githubStepSummary = process.env.GITHUB_STEP_SUMMARY,
    squawkTimeoutMs = 60_000,
  } = options;
  const squawkInstallDir =
    options.squawkInstallDir ?? (runnerTemp ? path.join(runnerTemp, 'squawk') : '');

  if (!baseRef) {
    emitOutput(githubOutput, 'state', 'unavailable');
    return { exitCode: 0, scope: 'unavailable', state: 'unavailable', reason: 'Missing BASE ref' };
  }

  const workScratch = path.join(runnerTemp || '/tmp', `squawk-check-${process.pid}-${Date.now()}`);
  const baseWorktree = path.join(workScratch, 'base-tree');

  try {
    const { mergeBase, headSha } = resolveCommitPair(sourceDir, baseRef);

    const diffEntries = collectChangedSqlEntries(sourceDir, mergeBase, headSha);
    if (diffEntries.length === 0) {
      emitOutput(githubOutput, 'scope', 'skip');
      emitOutput(githubOutput, 'state', 'clean');
      return { exitCode: 0, scope: 'skip', state: 'clean', report: null };
    }

    const headCache = createClassifierCache(sourceDir);
    const classifiedEntries = [];
    for (const entry of diffEntries) {
      const decision = classifySqlFile(sourceDir, entry.headFile, headCache);
      if (decision.include && decision.profile) {
        classifiedEntries.push({ ...entry, profile: decision.profile });
      }
    }

    if (classifiedEntries.length === 0) {
      emitOutput(githubOutput, 'scope', 'skip');
      emitOutput(githubOutput, 'state', 'clean');
      return { exitCode: 0, scope: 'skip', state: 'clean', report: null };
    }

    mkdirSync(workScratch, { recursive: true });

    // Group head files by effective Squawk config profile so monorepos with per-package `.squawk.toml` work seamlessly.
    const headGroups = new Map();
    for (const item of classifiedEntries) {
      const profileKey = JSON.stringify({
        pgVersion: item.profile.pgVersion,
        assumeInTransaction: item.profile.assumeInTransaction,
        excludedRules: item.profile.excludedRules,
        includedRules: item.profile.includedRules,
        excludedPaths: item.profile.excludedPaths,
      });
      let group = headGroups.get(profileKey);
      if (!group) {
        group = { profile: item.profile, entries: [] };
        headGroups.set(profileKey, group);
      }
      group.entries.push(item);
    }

    const headFindings = [];
    let groupIdx = 0;
    for (const { profile, entries } of headGroups.values()) {
      groupIdx++;
      const found = runSquawkScan({
        targetDir: sourceDir,
        squawkInstallDir,
        tempDir: workScratch,
        side: `head-${groupIdx}`,
        files: entries.map((e) => e.headFile),
        profile,
        timeoutMs: squawkTimeoutMs,
      });
      headFindings.push(...found);
    }

    const existingEntries = classifiedEntries.filter(
      (e) => (e.kind === 'modified' || e.kind === 'renamed') && e.baseFile,
    );

    const baseFindings = [];
    const baseToHeadMap = new Map();

    if (existingEntries.length > 0) {
      gitBuffer(['worktree', 'add', '--quiet', '--detach', baseWorktree, mergeBase], sourceDir);
      const baseCache = createClassifierCache(baseWorktree);

      const baseGroups = new Map();
      for (const entry of existingEntries) {
        if (!canCompareAsBaseMigrationSql(baseWorktree, entry.baseFile, entry.profile, baseCache)) {
          continue;
        }
        baseToHeadMap.set(entry.baseFile, entry.headFile);
        const baseProfile = resolveBaseFileProfile(
          baseWorktree,
          entry.baseFile,
          entry.profile,
          baseCache,
        );
        const key = JSON.stringify({
          pgVersion: baseProfile.pgVersion,
          assumeInTransaction: baseProfile.assumeInTransaction,
          excludedRules: baseProfile.excludedRules,
          includedRules: baseProfile.includedRules,
        });
        let group = baseGroups.get(key);
        if (!group) {
          group = { profile: baseProfile, files: [] };
          baseGroups.set(key, group);
        }
        group.files.push(entry.baseFile);
      }

      let baseIdx = 0;
      for (const { profile, files } of baseGroups.values()) {
        baseIdx++;
        const found = runSquawkScan({
          targetDir: baseWorktree,
          squawkInstallDir,
          tempDir: workScratch,
          side: `base-${baseIdx}`,
          files,
          profile,
          timeoutMs: squawkTimeoutMs,
        });
        baseFindings.push(...found);
      }
    }

    const { added, resolvedCount } = diffMigrationFindings(baseFindings, headFindings, baseToHeadMap);
    const waived = hasAllowUnsafeMigrationLabel(labelsJson);
    const state = added.length === 0 ? 'clean' : waived ? 'waived' : 'failed';

    const report = {
      base: mergeBase.toLowerCase(),
      checkedFiles: classifiedEntries.length,
      beforeCount: baseFindings.length,
      afterCount: headFindings.length,
      addedCount: added.length,
      resolvedCount,
      waived,
      added: added.slice(0, 50).map(({ file, line, rule, message, help, note }) => ({
        file,
        line,
        rule,
        message,
        help,
        note,
      })),
    };

    emitOutput(githubOutput, 'scope', 'sql');
    emitOutput(githubOutput, 'report', JSON.stringify(report));
    emitOutput(githubOutput, 'state', state);

    if (githubStepSummary && added.length > 0) {
      try {
        const md = formatMigrationStepSummary(report);
        if (md) appendFileSync(githubStepSummary, md, 'utf8');
      } catch (summaryErr) {
        console.warn(
          '[postgres-migrations] Failed to write job summary:',
          summaryErr?.message ?? summaryErr,
        );
      }
    }

    if (added.length > 0 && !waived) {
      for (const item of report.added) {
        console.error(`[postgres-migrations] ${item.rule}: ${item.file}:${item.line} — ${item.message}`);
      }
    }

    const outcomeCode = added.length > 0 && !waived ? 1 : 0;
    return { exitCode: outcomeCode, scope: 'sql', state, report };
  } catch (err) {
    const reason = err?.message ?? String(err);
    console.error('[postgres-migrations] Scan unavailable (failing open):', reason);
    emitOutput(githubOutput, 'state', 'unavailable');
    return { exitCode: 0, scope: 'unavailable', state: 'unavailable', reason };
  } finally {
    if (existsSync(baseWorktree)) {
      try {
        gitBuffer(['worktree', 'remove', '--force', baseWorktree], sourceDir);
      } catch {
        // Ignore cleanup failure on temporary detached worktree.
      }
    }
    rmSync(workScratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(executePrCheck().exitCode);
}
