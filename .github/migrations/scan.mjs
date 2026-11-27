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
  classifySqlFile,
  createClassifierCache,
  isRealPathInsideRepo,
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
    ['diff', '--find-renames', '--name-status', '-z', '--diff-filter=ACMR', baseSha, headSha, '--', '*.sql', '*.SQL'],
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
      const oldPath = (fields[i++] ?? '').replace(/\\/g, '/');
      const newPath = (fields[i++] ?? '').replace(/\\/g, '/');
      if (!newPath) continue;
      if (code === 'R') {
        entries.push({ kind: 'renamed', baseFile: oldPath, headFile: newPath });
      } else {
        entries.push({ kind: 'added', baseFile: null, headFile: newPath });
      }
    } else {
      const filePath = (fields[i++] ?? '').replace(/\\/g, '/');
      if (!filePath) continue;
      if (code === 'A') {
        entries.push({ kind: 'added', baseFile: null, headFile: filePath });
      } else if (code === 'M') {
        entries.push({ kind: 'modified', baseFile: filePath, headFile: filePath });
      }
    }
  }
  return entries;
}

export function stripSqlCommentsAndCollapseWhitespace(sqlFragment) {
  let out = '';
  let i = 0;
  while (i < sqlFragment.length) {
    const ch = sqlFragment[i];
    if (ch === '-' && sqlFragment[i + 1] === '-') {
      i += 2;
      while (i < sqlFragment.length && sqlFragment[i] !== '\n' && sqlFragment[i] !== '\r') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && sqlFragment[i + 1] === '*') {
      i += 2;
      let depth = 1;
      while (i < sqlFragment.length && depth > 0) {
        if (sqlFragment[i] === '/' && sqlFragment[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sqlFragment[i] === '*' && sqlFragment[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < sqlFragment.length) {
        const c = sqlFragment[i++];
        out += c;
        if (c === quote) {
          if (sqlFragment[i] === quote) {
            out += sqlFragment[i++];
            continue;
          }
          break;
        }
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/\s+/g, ' ').trim();
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

  // Also capture statement head preceding the span (back to previous `;` or `--> statement-breakpoint`)
  // so `DROP COLUMN "x"` on two different tables in the same migration file stay distinct.
  const prefixLines = [];
  const lookbackMin = Math.max(0, startLine - 50);
  for (let ln = startLine; ln >= lookbackMin; ln--) {
    const rawLine = ln === startLine ? sliceLineUtf8Bytes(fileLines[ln], 0, startCol) : fileLines[ln];
    if (ln < startLine && /-->\s*statement-breakpoint/i.test(rawLine)) {
      const afterBp = rawLine.split(/-->\s*statement-breakpoint/i).pop() ?? '';
      if (afterBp.trim()) prefixLines.unshift(afterBp);
      break;
    }
    const semiIdx = rawLine.lastIndexOf(';');
    if (semiIdx >= 0) {
      prefixLines.unshift(rawLine.slice(semiIdx + 1));
      break;
    }
    prefixLines.unshift(rawLine);
  }
  const normalizedPrefix = stripSqlCommentsAndCollapseWhitespace(prefixLines.join('\n'));
  return normalizedPrefix ? `${normalizedPrefix} :: ${normalizedSpan}` : normalizedSpan;
}

function normalizeReportedPath(rawFile, targetDir) {
  if (typeof rawFile !== 'string' || !rawFile) return '';
  const asPosix = rawFile.replace(/\\/g, '/');
  if (path.isAbsolute(rawFile)) {
    return path.relative(targetDir, rawFile).replace(/\\/g, '/');
  }
  return asPosix.replace(/^(?:\.\/)+/, '');
}

export function runSquawkScan({ targetDir, squawkInstallDir, tempDir, side, files, profile }) {
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

  const proc = spawnSync(
    squawkBin,
    [
      'check',
      '--no-error-on-unmatched-pattern',
      '--config',
      configPath,
      '--reporter',
      'json',
      '--',
      ...verifiedFiles.map(escapeSquawkGlobPath),
    ],
    {
      cwd: targetDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: squawkEnv,
    },
  );

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
        if (entry.kind === 'renamed') {
          const baseDecision = classifySqlFile(baseWorktree, entry.baseFile, baseCache);
          if (!baseDecision.include) continue;
        }
        baseToHeadMap.set(entry.baseFile, entry.headFile);
        const baseProfile = { ...entry.profile, excludedPaths: [] };
        const key = JSON.stringify(baseProfile);
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
