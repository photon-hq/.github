import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_PG_VERSION = '17.0';

export const CONCURRENT_INDEX_RULES = [
  'require-concurrent-index-creation',
  'require-concurrent-index-deletion',
];

export const DEFAULT_EXCLUDED_RULES = [
  'require-lock-timeout',
  'require-statement-timeout',
  ...CONCURRENT_INDEX_RULES,
  'identifier-too-long',
  'prefer-bigint-over-int',
  'prefer-text-field',
  'prefer-identity',
  'require-enum-value-ordering',
];

const ALWAYS_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  '.next',
  '.nuxt',
  '.output',
  '.astro',
  '.turbo',
  '.wrangler',
]);

const NON_MIGRATION_DIRS = new Set([
  'test',
  'tests',
  '__tests__',
  'test-kit',
  'fixture',
  'fixtures',
  '__fixtures__',
  'examples',
  'docs',
]);

const DEDICATED_MIGRATION_DIR_RE =
  /^(?:drizzle(?:-[a-z0-9_]+)?|migrations?|migrate|[a-z0-9_]+[-_]migrations?)$/i;
const GENERIC_SQL_DIR_RE = /^(?:sql|db)$/i;
const NON_PG_SEGMENT_RE =
  /(?:clickhouse|^\.signoz$|^(?:mysql|mariadb|vitess|tidb|sqlite3?|libsql|turso|d1|bigquery|snowflake|duckdb)$|(?:^|[-_])(?:mysql|mariadb|sqlite3?|libsql)(?:$|[-_]))/i;
const TEST_OR_SEED_FILENAME_RE = /(?:^|[-_.])(?:fixture|seed|test|spec)\.sql$/i;
const NON_TRANSACTIONAL_FILENAME_RE = /\.(?:nontransactional|no-transaction)\.sql$/i;
const NON_TRANSACTIONAL_HEADER_RE =
  /(?:^|[^a-z0-9])(?:no-transaction|nontransactional)(?:$|[^a-z0-9])/i;

const DIRECT_PG_PACKAGES = new Set([
  'pg',
  'postgres',
  '@neondatabase/serverless',
  '@electric-sql/pglite',
  '@vercel/postgres',
  'slonik',
  'pg-promise',
  'postgres-pool',
]);
const SCOPED_PG_DB_PACKAGE_RE = /^@[^/]+\/(?:db|.*-db|postgres|pg)$/;
const MULTI_DIALECT_PG_PACKAGES = new Set(['drizzle-orm', 'drizzle-kit', 'kysely']);
const NON_PG_DRIVER_PACKAGES = new Set([
  'better-sqlite3',
  'sqlite3',
  '@libsql/client',
  'mysql',
  'mysql2',
  '@planetscale/database',
  '@clickhouse/client',
]);

const DRIZZLE_CONFIG_NAMES = [
  'drizzle.config.ts',
  'drizzle.config.mts',
  'drizzle.config.cts',
  'drizzle.config.js',
  'drizzle.config.mjs',
  'drizzle.config.cjs',
];

const CLICKHOUSE_SQL_RE =
  /\b(?:ENGINE\s*=\s*(?:[A-Za-z0-9_]*MergeTree|Log|TinyLog|StripeLog|Memory|Null|Kafka|S3|Distributed|MaterializedView|Dictionary|Buffer)\b|DateTime64\s*\(|LowCardinality\s*\(|UInt(?:8|16|32|64|128|256)\b|ON\s+CLUSTER\b|SETTINGS\s+index_granularity\b|GRANULARITY\s+\d+\b|simpleJSONExtract\w*\s*\()/i;
const MYSQL_SQL_RE =
  /\b(?:ENGINE\s*=\s*(?:InnoDB|MyISAM|NDB)\b|AUTO_INCREMENT\b|DEFAULT\s+CHARSET\s*=)/i;
const SQLITE_SQL_RE =
  /\b(?:AUTOINCREMENT\b|PRAGMA\s+(?:foreign_keys|journal_mode|synchronous|table_info|user_version)\b|WITHOUT\s+ROWID\b)/i;
const DIALECT_HEADER_RE = /^\s*--\s*(?:squawk-)?dialect\s*:\s*([a-z0-9_-]+)/im;

const RULE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PG_VERSION_RE = /^\d+(?:\.\d+)*$/;

export function isRealPathInsideRepo(targetPath, realRepoRoot) {
  try {
    const resolved = realpathSync(targetPath);
    return resolved === realRepoRoot || resolved.startsWith(`${realRepoRoot}${path.sep}`);
  } catch {
    return false;
  }
}

function isRegularRepoFile(absPath, realRepoRoot, maxBytes = 16 * 1024 * 1024) {
  try {
    const lst = lstatSync(absPath);
    if (!lst.isFile() || lst.size > maxBytes) return false;
    return isRealPathInsideRepo(absPath, realRepoRoot);
  } catch {
    return false;
  }
}

function isSafeRelativeGlob(pattern) {
  if (typeof pattern !== 'string') return false;
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.startsWith('/') || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  const normalized = trimmed.replace(/\\/g, '/');
  return normalized.split('/').every((seg) => seg !== '..');
}

export function normalizeGitRelPath(rawPath) {
  if (typeof rawPath !== 'string') return '';
  const platformNormalized = process.platform === 'win32' ? rawPath.replace(/\\/g, '/') : rawPath;
  return platformNormalized.replace(/^(?:\.\/)+/, '');
}

function unescapeTomlBasicString(body, isMultiline = false) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    if (isMultiline) {
      const cont = body.slice(i).match(/^\\[ \t]*\r?\n[ \t\r\n]*/);
      if (cont) {
        i += cont[0].length - 1;
        continue;
      }
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '"' || next === '\\') out += next;
    else if (next === 'u' || next === 'U') {
      const len = next === 'u' ? 4 : 8;
      const hex = body.slice(i + 1, i + 1 + len);
      if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === len) {
        const cp = Number.parseInt(hex, 16);
        if (cp >= 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
          out += String.fromCodePoint(cp);
          i += len;
          continue;
        }
      }
      out += next;
    } else {
      out += next;
    }
  }
  return out;
}

function tokenizeToml(source) {
  const src = source.replace(/^\ufeff/, '');
  const tokens = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      i++;
      tokens.push({ type: 'nl' });
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (ch === '=' || ch === '[' || ch === ']' || ch === ',') {
      tokens.push({ type: ch });
      i++;
      continue;
    }
    if (src.startsWith('"""', i) || src.startsWith("'''", i)) {
      const delim = src.slice(i, i + 3);
      const isBasic = delim === '"""';
      i += 3;
      if (src[i] === '\r' && src[i + 1] === '\n') i += 2;
      else if (src[i] === '\n') i++;
      const end = src.indexOf(delim, i);
      if (end < 0) return null;
      const raw = src.slice(i, end);
      i = end + 3;
      tokens.push({ type: 'string', value: isBasic ? unescapeTomlBasicString(raw, true) : raw });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const isBasic = ch === '"';
      i++;
      let raw = '';
      let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (c === '\n' || c === '\r') return null;
        if (isBasic && c === '\\') {
          raw += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          i++;
          break;
        }
        raw += c;
        i++;
      }
      if (!closed) return null;
      tokens.push({ type: 'string', value: isBasic ? unescapeTomlBasicString(raw, false) : raw });
      continue;
    }
    let word = '';
    while (i < src.length && !/[\s#=\[\],"']/.test(src[i])) {
      word += src[i++];
    }
    if (word === '') return null;
    tokens.push({ type: 'bare', value: word });
  }

  return tokens;
}

export function parseSquawkToml(rawSource) {
  if (typeof rawSource !== 'string') return {};
  const tokens = tokenizeToml(rawSource);
  if (!tokens) return {};

  const out = {};
  let idx = 0;
  let inTableSection = false;

  const skipNewlines = () => {
    while (idx < tokens.length && tokens[idx].type === 'nl') idx++;
  };

  while (idx < tokens.length) {
    skipNewlines();
    if (idx >= tokens.length) break;

    // `[section]` or `[[array_section]]` header at start of statement: skip non-root keys.
    if (tokens[idx].type === '[') {
      inTableSection = true;
      while (idx < tokens.length && tokens[idx].type !== 'nl') idx++;
      continue;
    }

    const keyTok = tokens[idx];
    if ((keyTok.type !== 'bare' && keyTok.type !== 'string') || tokens[idx + 1]?.type !== '=') {
      while (idx < tokens.length && tokens[idx].type !== 'nl') idx++;
      continue;
    }

    const key = keyTok.value;
    idx += 2;
    if (idx >= tokens.length) break;

    if (inTableSection) {
      if (tokens[idx].type === '[') {
        let depth = 0;
        while (idx < tokens.length) {
          if (tokens[idx].type === '[') depth++;
          else if (tokens[idx].type === ']') {
            depth--;
            if (depth <= 0) {
              idx++;
              break;
            }
          }
          idx++;
        }
      } else {
        while (idx < tokens.length && tokens[idx].type !== 'nl') idx++;
      }
      continue;
    }

    const valTok = tokens[idx];
    if (valTok.type === 'string') {
      idx++;
      if (key === 'pg_version' && PG_VERSION_RE.test(valTok.value.trim())) {
        out.pg_version = valTok.value.trim();
      }
    } else if (valTok.type === 'bare') {
      idx++;
      if (key === 'assume_in_transaction' && (valTok.value === 'true' || valTok.value === 'false')) {
        out.assume_in_transaction = valTok.value === 'true';
      } else if (key === 'pg_version' && PG_VERSION_RE.test(valTok.value)) {
        out.pg_version = valTok.value;
      }
    } else if (valTok.type === '[') {
      idx++;
      const items = [];
      let validArray = true;
      while (idx < tokens.length) {
        skipNewlines();
        if (idx >= tokens.length) {
          validArray = false;
          break;
        }
        if (tokens[idx].type === ']') {
          idx++;
          break;
        }
        if (tokens[idx].type !== 'string') {
          validArray = false;
          while (idx < tokens.length && tokens[idx].type !== ']') idx++;
          if (tokens[idx]?.type === ']') idx++;
          break;
        }
        items.push(tokens[idx].value);
        idx++;
        skipNewlines();
        if (tokens[idx]?.type === ',') idx++;
      }

      if (validArray) {
        if (key === 'excluded_rules' || key === 'included_rules') {
          const validRules = [];
          for (const rawRule of items) {
            const r = rawRule.trim();
            if (RULE_NAME_RE.test(r) && !validRules.includes(r)) validRules.push(r);
          }
          out[key] = validRules;
        } else if (key === 'excluded_paths') {
          const validPaths = [];
          for (const rawPath of items) {
            if (isSafeRelativeGlob(rawPath)) {
              const normalized = rawPath.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
              if (normalized && !validPaths.includes(normalized)) validPaths.push(normalized);
            }
          }
          out.excluded_paths = validPaths;
        }
      }
    }

    while (idx < tokens.length && tokens[idx].type !== 'nl') idx++;
  }

  return out;
}

export function serializeSquawkToml(profile) {
  const lines = [
    `pg_version = ${JSON.stringify(profile.pgVersion)}`,
    `assume_in_transaction = ${Boolean(profile.assumeInTransaction)}`,
    `excluded_rules = [${profile.excludedRules.map((r) => JSON.stringify(r)).join(', ')}]`,
  ];
  if (profile.includedRules.length > 0) {
    lines.push(`included_rules = [${profile.includedRules.map((r) => JSON.stringify(r)).join(', ')}]`);
  }
  if (profile.excludedPaths.length > 0) {
    lines.push(`excluded_paths = [${profile.excludedPaths.map((p) => JSON.stringify(p)).join(', ')}]`);
  }
  return `${lines.join('\n')}\n`;
}

function globToRegExp(globPattern) {
  let re = '^';
  let i = 0;
  while (i < globPattern.length) {
    if (globPattern.startsWith('**/', i)) {
      re += '(?:.+/)?';
      i += 3;
      continue;
    }
    if (globPattern.startsWith('/**', i) && i + 3 === globPattern.length) {
      re += '(?:/.*)?';
      i += 3;
      continue;
    }
    if (globPattern.startsWith('**', i)) {
      re += '.*';
      i += 2;
      continue;
    }
    if (globPattern[i] === '[') {
      let end = i + 1;
      if (globPattern[end] === '!' || globPattern[end] === '^') end++;
      if (globPattern[end] === ']') end++;
      while (end < globPattern.length && globPattern[end] !== ']') end++;
      if (end < globPattern.length) {
        let cls = globPattern.slice(i + 1, end);
        const neg = cls.startsWith('!') || cls.startsWith('^');
        if (neg) cls = cls.slice(1);
        const escapedCls = cls.replace(/([\\\]])/g, '\\$1');
        re += `[${neg ? '^' : ''}${escapedCls}]`;
        i = end + 1;
        continue;
      }
    }
    const ch = globPattern[i++];
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(ch)) re += `\\${ch}`;
    else re += ch;
  }
  re += '$';
  return new RegExp(re);
}

export function matchesExcludedPath(relFilePath, pattern) {
  const cleanRel = relFilePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  const cleanPat = pattern.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (!cleanPat) return false;
  if (!cleanPat.includes('/')) {
    const baseRe = globToRegExp(cleanPat);
    return baseRe.test(cleanRel) || baseRe.test(path.posix.basename(cleanRel));
  }
  return globToRegExp(cleanPat).test(cleanRel);
}

function getAncestorDirs(relFilePath) {
  const dirs = [];
  let cur = path.posix.dirname(relFilePath);
  while (true) {
    dirs.push(cur);
    if (cur === '.' || !cur) break;
    const parent = path.posix.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

export function createClassifierCache(repoDir) {
  return {
    repoDir,
    realRepoRoot: realpathSync(repoDir),
    tomlByDir: new Map(),
    pkgDialectByDir: new Map(),
    drizzleJournalByDir: new Map(),
    drizzleConfigByDir: new Map(),
    prismaByDir: new Map(),
  };
}

function readTomlAtDir(cache, relDir) {
  if (cache.tomlByDir.has(relDir)) return cache.tomlByDir.get(relDir);
  const absPath = relDir === '.' ? path.join(cache.repoDir, '.squawk.toml') : path.join(cache.repoDir, relDir, '.squawk.toml');
  let parsed = null;
  if (isRegularRepoFile(absPath, cache.realRepoRoot, 256 * 1024)) {
    try {
      parsed = parseSquawkToml(readFileSync(absPath, 'utf8'));
    } catch {
      parsed = null;
    }
  }
  cache.tomlByDir.set(relDir, parsed);
  return parsed;
}

export function scanSqlTokens(sql, { keepQuotes = true, onStatementBreak = null } = {}) {
  if (typeof sql !== 'string' || !sql) return '';
  let out = '';
  const pushSpace = () => {
    if (out.length > 0 && !out.endsWith(' ')) out += ' ';
  };

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const commentStart = i;
      i += 2;
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      const commentLine = sql.slice(commentStart, i);
      if (sql[i] === '\r' && sql[i + 1] === '\n') i += 2;
      else if (sql[i] === '\n' || sql[i] === '\r') i++;
      if (onStatementBreak && /^-->\s*statement-breakpoint\s*$/i.test(commentLine)) {
        onStatementBreak(i);
      }
      pushSpace();
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      pushSpace();
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const prev = i > 0 ? sql[i - 1] : '';
      const prev2 = i > 1 ? sql[i - 2] : '';
      const cEscape =
        quote === "'" &&
        (prev === 'E' || prev === 'e') &&
        (i === 1 || !/[A-Za-z0-9_$]/.test(prev2));
      const tokenStart = i++;
      while (i < sql.length) {
        const c = sql[i++];
        if (cEscape && c === '\\' && i < sql.length) {
          i++;
          continue;
        }
        if (c === quote) {
          if (sql[i] === quote) {
            i++;
            continue;
          }
          break;
        }
      }
      if (keepQuotes) out += sql.slice(tokenStart, i);
      else pushSpace();
      continue;
    }
    if (ch === '$') {
      const dollarMatch = sql.slice(i).match(/^\$(?:[A-Za-z_\x80-\uffff][A-Za-z0-9_\x80-\uffff]*)?\$/);
      if (dollarMatch) {
        const delim = dollarMatch[0];
        const closeIdx = sql.indexOf(delim, i + delim.length);
        const tokenEnd = closeIdx >= 0 ? closeIdx + delim.length : sql.length;
        if (keepQuotes) out += sql.slice(i, tokenEnd);
        else pushSpace();
        i = tokenEnd;
        continue;
      }
    }
    if (/\s/.test(ch)) {
      pushSpace();
      i++;
      continue;
    }
    out += ch;
    i++;
    if (ch === ';' && onStatementBreak) {
      onStatementBreak(i);
    }
  }
  return out.trim();
}

export function isNonTransactionalMigrationFile(relFilePath, sqlSample = '') {
  const cleanRel = normalizeGitRelPath(relFilePath);
  if (NON_TRANSACTIONAL_FILENAME_RE.test(path.posix.basename(cleanRel))) {
    return true;
  }
  if (typeof sqlSample !== 'string' || !sqlSample) return false;
  let i = sqlSample.startsWith('\ufeff') ? 1 : 0;
  while (i < sqlSample.length) {
    const ch = sqlSample[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '-' && sqlSample[i + 1] === '-') {
      let end = i + 2;
      while (end < sqlSample.length && sqlSample[end] !== '\n' && sqlSample[end] !== '\r') end++;
      if (NON_TRANSACTIONAL_HEADER_RE.test(sqlSample.slice(i + 2, end))) return true;
      i = end;
      continue;
    }
    if (ch === '/' && sqlSample[i + 1] === '*') {
      i += 2;
      let depth = 1;
      while (i < sqlSample.length && depth > 0) {
        if (sqlSample[i] === '/' && sqlSample[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sqlSample[i] === '*' && sqlSample[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    break;
  }
  return false;
}

function computeExcludedRules(assumeInTransaction, explicitExcludedRules, includedRules) {
  if (explicitExcludedRules !== null) return explicitExcludedRules;
  const includedSet = new Set(includedRules);
  const baseExcluded = assumeInTransaction
    ? DEFAULT_EXCLUDED_RULES
    : DEFAULT_EXCLUDED_RULES.filter((r) => !CONCURRENT_INDEX_RULES.includes(r));
  return baseExcluded.filter((r) => !includedSet.has(r));
}

function readSqlSampleIfRegular(repoDir, relFilePath, realRepoRoot) {
  const absPath = path.join(repoDir, relFilePath);
  if (!isRegularRepoFile(absPath, realRepoRoot)) return null;
  try {
    return readFileSync(absPath).subarray(0, 16 * 1024).toString('utf8');
  } catch {
    return null;
  }
}

export function resolveSquawkProfile(repoDir, rawRelFilePath, existingCache = null, sqlSample = null) {
  const cache = existingCache ?? createClassifierCache(repoDir);
  const relFilePath = normalizeGitRelPath(rawRelFilePath);
  let foundDir = null;
  let parsed = null;

  for (const dir of getAncestorDirs(relFilePath)) {
    const candidate = readTomlAtDir(cache, dir);
    if (candidate !== null) {
      foundDir = dir;
      parsed = candidate;
      break;
    }
  }

  const pgVersion = parsed?.pg_version ?? DEFAULT_PG_VERSION;
  const explicitAssumeInTransaction = parsed?.assume_in_transaction !== undefined;
  const sample =
    !explicitAssumeInTransaction && sqlSample === null
      ? (readSqlSampleIfRegular(repoDir, relFilePath, cache.realRepoRoot) ?? '')
      : (sqlSample ?? '');
  const nonTransactionalMarker =
    !explicitAssumeInTransaction && isNonTransactionalMigrationFile(relFilePath, sample);
  const assumeInTransaction = explicitAssumeInTransaction
    ? parsed.assume_in_transaction
    : !nonTransactionalMarker;

  const includedRules = parsed?.included_rules ?? [];
  const explicitExcludedRules = parsed?.excluded_rules !== undefined ? parsed.excluded_rules : null;
  const excludedRules = computeExcludedRules(
    assumeInTransaction,
    explicitExcludedRules,
    includedRules,
  );

  const rawExcludedPaths = parsed?.excluded_paths ?? [];
  const excludedPaths = [];
  for (const pat of rawExcludedPaths) {
    if (!foundDir || foundDir === '.') {
      excludedPaths.push(pat);
    } else if (pat.includes('/')) {
      excludedPaths.push(`${foundDir}/${pat}`);
    } else {
      excludedPaths.push(`${foundDir}/**/${pat}`);
      excludedPaths.push(`${foundDir}/${pat}`);
    }
  }

  return {
    pgVersion,
    assumeInTransaction,
    explicitAssumeInTransaction,
    explicitExcludedRules,
    excludedRules,
    includedRules,
    excludedPaths,
    tomlRelDir: foundDir,
  };
}

export function resolveBaseFileProfile(baseRepoDir, rawBaseRelPath, headProfile, baseCache) {
  const baseRelPath = normalizeGitRelPath(rawBaseRelPath);
  if (headProfile.explicitAssumeInTransaction) {
    return { ...headProfile, excludedPaths: [] };
  }
  const sample = readSqlSampleIfRegular(baseRepoDir, baseRelPath, baseCache.realRepoRoot) ?? '';
  const assumeInTransaction = !isNonTransactionalMigrationFile(baseRelPath, sample);
  return {
    ...headProfile,
    assumeInTransaction,
    excludedRules: computeExcludedRules(
      assumeInTransaction,
      headProfile.explicitExcludedRules ?? null,
      headProfile.includedRules,
    ),
    excludedPaths: [],
  };
}

function readDrizzleDialectFromMetaDir(cache, relDir) {
  if (cache.drizzleJournalByDir.has(relDir)) return cache.drizzleJournalByDir.get(relDir);
  const baseAbs = relDir === '.' ? cache.repoDir : path.join(cache.repoDir, relDir);
  const journalAbs = path.join(baseAbs, 'meta', '_journal.json');
  let dialect = null;

  if (isRegularRepoFile(journalAbs, cache.realRepoRoot, 2 * 1024 * 1024)) {
    try {
      const parsed = JSON.parse(readFileSync(journalAbs, 'utf8'));
      if (typeof parsed?.dialect === 'string' && parsed.dialect.trim()) {
        dialect = parsed.dialect.trim().toLowerCase();
      }
    } catch {
      // Fall through to snapshot check.
    }
  }

  if (!dialect) {
    for (const sub of ['meta', '.']) {
      const scanAbs = sub === '.' ? baseAbs : path.join(baseAbs, sub);
      try {
        if (!existsSync(scanAbs) || !lstatSync(scanAbs).isDirectory()) continue;
        const entries = readdirSync(scanAbs)
          .filter((f) => f.endsWith('_snapshot.json'))
          .sort();
        if (entries.length === 0) continue;
        const snapAbs = path.join(scanAbs, entries[entries.length - 1]);
        if (!isRegularRepoFile(snapAbs, cache.realRepoRoot, 4 * 1024 * 1024)) continue;
        const snap = JSON.parse(readFileSync(snapAbs, 'utf8'));
        if (typeof snap?.dialect === 'string' && snap.dialect.trim()) {
          dialect = snap.dialect.trim().toLowerCase();
          break;
        }
      } catch {
        // Ignore unreadable directory or snapshot.
      }
    }
  }

  cache.drizzleJournalByDir.set(relDir, dialect);
  return dialect;
}

function readDrizzleConfigAtDir(cache, relDir) {
  if (cache.drizzleConfigByDir.has(relDir)) return cache.drizzleConfigByDir.get(relDir);
  const dirAbs = relDir === '.' ? cache.repoDir : path.join(cache.repoDir, relDir);
  let result = null;

  for (const name of DRIZZLE_CONFIG_NAMES) {
    const cfgAbs = path.join(dirAbs, name);
    if (!isRegularRepoFile(cfgAbs, cache.realRepoRoot, 512 * 1024)) continue;
    try {
      const text = readFileSync(cfgAbs, 'utf8');
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\r\n]*/g, ' ');
      const hasNonPg = /\bdialect\s*:\s*['"`](?:sqlite|mysql|turso|singlestore|gel)['"`]/i.test(stripped);
      const hasPg =
        /\bdialect\s*:\s*['"`]postgresql['"`]/i.test(stripped) ||
        /\bdriver\s*:\s*['"`](?:pg|pglite|aws-data-api|neon-http|vercel-postgres)['"`]/i.test(stripped) ||
        /\bdefine\w*DrizzleConfig\s*\(/.test(stripped);
      if (hasNonPg && !/\bdialect\s*:\s*['"`]postgresql['"`]/i.test(stripped)) {
        result = 'non-postgresql';
      } else if (hasPg) {
        result = 'postgresql';
      }
      break;
    } catch {
      // Ignore unreadable config.
    }
  }

  cache.drizzleConfigByDir.set(relDir, result);
  return result;
}

function readManifestPostgresSupportAtDir(cache, relDir) {
  if (cache.pkgDialectByDir.has(relDir)) return cache.pkgDialectByDir.get(relDir);
  const dirAbs = relDir === '.' ? cache.repoDir : path.join(cache.repoDir, relDir);
  let status = null;

  const pkgAbs = path.join(dirAbs, 'package.json');
  if (isRegularRepoFile(pkgAbs, cache.realRepoRoot, 2 * 1024 * 1024)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgAbs, 'utf8').replace(/^\ufeff/, ''));
      const depNames = new Set([
        ...Object.keys(pkg?.dependencies ?? {}),
        ...Object.keys(pkg?.devDependencies ?? {}),
        ...Object.keys(pkg?.peerDependencies ?? {}),
      ]);
      let hasDirectPg = false;
      let hasMultiDialectOrm = false;
      let hasNonPgDriver = false;

      for (const dep of depNames) {
        if (DIRECT_PG_PACKAGES.has(dep) || SCOPED_PG_DB_PACKAGE_RE.test(dep)) hasDirectPg = true;
        if (MULTI_DIALECT_PG_PACKAGES.has(dep)) hasMultiDialectOrm = true;
        if (NON_PG_DRIVER_PACKAGES.has(dep)) hasNonPgDriver = true;
      }

      if (hasDirectPg || (hasMultiDialectOrm && !hasNonPgDriver)) {
        status = 'postgresql';
      } else if (hasNonPgDriver && !hasDirectPg) {
        status = 'non-postgresql';
      }
    } catch {
      // Ignore malformed package.json.
    }
  }

  if (!status) {
    const cargoAbs = path.join(dirAbs, 'Cargo.toml');
    if (isRegularRepoFile(cargoAbs, cache.realRepoRoot, 512 * 1024)) {
      try {
        const cargo = readFileSync(cargoAbs, 'utf8');
        if (/\b(?:tokio-postgres|postgres|sqlx|diesel|sea-orm)\b/.test(cargo)) {
          const hasPgFeature =
            /\btokio-postgres\b/.test(cargo) ||
            /\bpostgres\b/.test(cargo) ||
            !/\b(?:sqlite|mysql)\b/.test(cargo);
          if (hasPgFeature) status = 'postgresql';
        }
      } catch {
        // Ignore unreadable Cargo.toml.
      }
    }
  }

  cache.pkgDialectByDir.set(relDir, status);
  return status;
}

function hasPostgresPrismaSchema(cache, relDir) {
  if (cache.prismaByDir.has(relDir)) return cache.prismaByDir.get(relDir);
  const dirAbs = relDir === '.' ? cache.repoDir : path.join(cache.repoDir, relDir);
  let result = null;
  for (const candidate of ['schema.prisma', 'prisma/schema.prisma']) {
    const p = path.join(dirAbs, candidate);
    if (!isRegularRepoFile(p, cache.realRepoRoot, 512 * 1024)) continue;
    try {
      const content = readFileSync(p, 'utf8');
      if (/\bprovider\s*=\s*"postgresql"/i.test(content) || /\bprovider\s*=\s*"cockroachdb"/i.test(content)) {
        result = 'postgresql';
      } else if (/\bprovider\s*=\s*"(?:mysql|sqlite|sqlserver|mongodb)"/i.test(content)) {
        result = 'non-postgresql';
      }
      break;
    } catch {
      // Ignore unreadable schema.prisma.
    }
  }
  cache.prismaByDir.set(relDir, result);
  return result;
}

function detectNonPostgresSqlContent(sqlSample) {
  const headerMatch = sqlSample.match(DIALECT_HEADER_RE);
  if (headerMatch) {
    const declared = headerMatch[1].toLowerCase();
    if (declared !== 'postgres' && declared !== 'postgresql' && declared !== 'pg') {
      return true;
    }
  }
  const unquoted = scanSqlTokens(sqlSample, { keepQuotes: false });
  return (
    CLICKHOUSE_SQL_RE.test(unquoted) ||
    MYSQL_SQL_RE.test(unquoted) ||
    SQLITE_SQL_RE.test(unquoted)
  );
}

function checkCandidateSqlPreconditions(relPath, parts, tomlRelDir, sqlSample) {
  const dirSegments = parts.slice(0, -1);
  const fileName = parts[parts.length - 1];

  if (dirSegments.some((seg) => NON_PG_SEGMENT_RE.test(seg))) {
    return 'non-postgres-path';
  }

  const lowerParts = parts.map((p) => p.toLowerCase());
  const dbIdx = lowerParts.lastIndexOf('db');
  if (dbIdx >= 0) {
    if (dbIdx === lowerParts.length - 2 && lowerParts[lowerParts.length - 1] === 'structure.sql') {
      return 'schema-dump';
    }
    if (lowerParts[dbIdx + 1] === 'views') {
      return 'view-snapshot';
    }
  }

  const tomlSegments = tomlRelDir && tomlRelDir !== '.' ? tomlRelDir.split('/') : [];
  const hasUntargetedNonMigrationDir = dirSegments.some(
    (seg, idx) => NON_MIGRATION_DIRS.has(seg.toLowerCase()) && tomlSegments[idx] !== seg,
  );
  if (
    hasUntargetedNonMigrationDir ||
    (tomlSegments.length === 0 && TEST_OR_SEED_FILENAME_RE.test(fileName))
  ) {
    return 'test-or-fixture';
  }

  if (detectNonPostgresSqlContent(sqlSample)) {
    return 'non-postgres-sql';
  }

  return null;
}

function readVerifiedSqlCandidate(repoDir, rawRelPath, cache) {
  const relPath = normalizeGitRelPath(rawRelPath);
  const parts = relPath.split('/');
  if (
    !relPath ||
    !relPath.toLowerCase().endsWith('.sql') ||
    relPath.startsWith('/') ||
    parts.some((p) => !p || p === '.' || p === '..' || ALWAYS_SKIP_DIRS.has(p))
  ) {
    return { ok: false, reason: 'ignored-path', relPath, parts, sqlSample: null };
  }
  const sqlSample = readSqlSampleIfRegular(repoDir, relPath, cache.realRepoRoot);
  if (sqlSample === null) {
    return { ok: false, reason: 'missing-or-irregular', relPath, parts, sqlSample: null };
  }
  return { ok: true, reason: null, relPath, parts, sqlSample };
}

export function canCompareAsBaseMigrationSql(repoDir, rawRelPath, headProfile, existingCache = null) {
  const cache = existingCache ?? createClassifierCache(repoDir);
  const candidate = readVerifiedSqlCandidate(repoDir, rawRelPath, cache);
  if (!candidate.ok) return false;
  return (
    checkCandidateSqlPreconditions(
      candidate.relPath,
      candidate.parts,
      headProfile?.tomlRelDir ?? null,
      candidate.sqlSample,
    ) === null
  );
}

export function classifySqlFile(repoDir, rawRelPath, existingCache = null) {
  const cache = existingCache ?? createClassifierCache(repoDir);
  const candidate = readVerifiedSqlCandidate(repoDir, rawRelPath, cache);
  if (!candidate.ok) {
    return { include: false, reason: candidate.reason, profile: null };
  }
  const { relPath, parts, sqlSample } = candidate;

  const profile = resolveSquawkProfile(repoDir, relPath, cache, sqlSample);
  if (profile.excludedPaths.some((pat) => matchesExcludedPath(relPath, pat))) {
    return { include: false, reason: 'excluded-path', profile };
  }

  const rejection = checkCandidateSqlPreconditions(relPath, parts, profile.tomlRelDir, sqlSample);
  if (rejection) {
    return { include: false, reason: rejection, profile };
  }

  const dirSegments = parts.slice(0, -1);
  const lowerParts = parts.map((p) => p.toLowerCase());

  // 1. Drizzle `meta/_journal.json` or `*_snapshot.json` in file dir or parent dir.
  const fileDir = path.posix.dirname(relPath);
  const parentDir = fileDir === '.' ? null : path.posix.dirname(fileDir);
  for (const checkDir of [fileDir, parentDir]) {
    if (!checkDir) continue;
    const journalDialect = readDrizzleDialectFromMetaDir(cache, checkDir);
    if (journalDialect === 'postgresql' || journalDialect === 'postgres') {
      return { include: true, reason: 'drizzle-journal', profile };
    }
    if (journalDialect) {
      return { include: false, reason: `drizzle-${journalDialect}`, profile };
    }
  }

  // 2. Supabase or Prisma PostgreSQL migrations.
  for (let i = 0; i + 1 < lowerParts.length; i++) {
    if (lowerParts[i] === 'supabase' && lowerParts[i + 1] === 'migrations') {
      return { include: true, reason: 'supabase-migrations', profile };
    }
    if (lowerParts[i] === 'prisma' && lowerParts[i + 1] === 'migrations') {
      const prismaRoot = i === 0 ? '.' : parts.slice(0, i).join('/');
      const prismaDialect = hasPostgresPrismaSchema(cache, prismaRoot) ?? hasPostgresPrismaSchema(cache, '.');
      if (prismaDialect === 'non-postgresql') {
        return { include: false, reason: 'prisma-non-pg', profile };
      }
      if (prismaDialect === 'postgresql') {
        return { include: true, reason: 'prisma-migrations', profile };
      }
    }
  }

  // 3. Explicit `.squawk.toml` in repository or ancestor workspace.
  if (profile.tomlRelDir !== null) {
    return { include: true, reason: 'squawk-toml', profile };
  }

  // 4. Migration directory inside a workspace/repository with Drizzle PostgreSQL config or PG dependencies.
  const immediateDir = dirSegments[dirSegments.length - 1] ?? '';
  const inMigrationDir =
    dirSegments.some((seg) => DEDICATED_MIGRATION_DIR_RE.test(seg)) ||
    (GENERIC_SQL_DIR_RE.test(immediateDir) &&
      !isRegularRepoFile(path.join(repoDir, fileDir, 'package.json'), cache.realRepoRoot));
  if (!inMigrationDir) {
    return { include: false, reason: 'outside-migration-dir', profile };
  }

  const ancestors = getAncestorDirs(relPath);
  for (const anc of ancestors) {
    const drizzleCfg = readDrizzleConfigAtDir(cache, anc);
    if (drizzleCfg === 'postgresql') {
      return { include: true, reason: 'drizzle-config', profile };
    }
    if (drizzleCfg === 'non-postgresql') {
      return { include: false, reason: 'drizzle-config-non-pg', profile };
    }
  }

  for (const anc of ancestors) {
    const pkgSupport = readManifestPostgresSupportAtDir(cache, anc);
    if (pkgSupport === 'postgresql') {
      return { include: true, reason: 'postgres-package-migrations', profile };
    }
    if (pkgSupport === 'non-postgresql') {
      return { include: false, reason: 'non-postgres-package', profile };
    }
  }

  return { include: false, reason: 'unclassified-sql', profile };
}
