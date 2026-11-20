import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const INCLUDED_ISSUE_TYPES = [
  'files',
  'exports',
  'types',
  'nsExports',
  'nsTypes',
  'enumMembers',
  'duplicates',
];

const EXPORT_ONLY_ISSUE_TYPES = [
  'exports',
  'types',
  'nsExports',
  'nsTypes',
  'enumMembers',
];

export const SKIP_DIRS = new Set([
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
  '.react-router',
  '.svelte-kit',
  '.vercel',
  'storybook-static',
  'fixtures',
  '__fixtures__',
]);

const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const CODE_FILE_EXTS = new Set([
  ...SOURCE_EXTS,
  '.es',
  '.es6',
  '.astro',
  '.mdx',
  '.vue',
  '.svelte',
]);
const NON_CODE_ASSET_EXT_RE =
  /\.(?:css|scss|sass|less|styl|json|jsonc|wasm|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|otf|map|sql|yaml|yml|md)$/i;
const CODE_EXT_STRIP_RE = /(?:\.d\.(?:[cm]?ts)|\.[cm]?[jt]sx?)$/i;
const BUILD_DIR_PREFIXES = [
  'dist/src/',
  'dist/esm/',
  'dist/cjs/',
  'dist/mjs/',
  'dist/lib/',
  'dist/',
  'build/src/',
  'build/esm/',
  'build/cjs/',
  'build/',
  'out/src/',
  'out/',
  'lib/',
];

// Disable plugins whose config loaders dynamically import uninstalled node_modules via jiti.
export const DISABLED_DYNAMIC_PLUGINS = {
  angular: false,
  astro: false,
  'astro-markdoc': false,
  ava: false,
  'aws-cdk': false,
  babel: false,
  biome: false,
  capacitor: false,
  commitizen: false,
  commitlint: false,
  cspell: false,
  cucumber: false,
  cypress: false,
  docusaurus: false,
  drizzle: false,
  'electron-builder': false,
  'electron-forge': false,
  'electron-vite': false,
  eleventy: false,
  eslint: false,
  expo: false,
  'expo-router': false,
  gatsby: false,
  'graphql-codegen': false,
  husky: false,
  jasmine: false,
  jest: false,
  karma: false,
  knex: false,
  ladle: false,
  lefthook: false,
  'lint-staged': false,
  linthtml: false,
  markdownlint: false,
  mdxlint: false,
  metro: false,
  'mikro-orm': false,
  mocha: false,
  'nano-staged': false,
  next: false,
  nitro: false,
  'npm-package-json-lint': false,
  nuxt: false,
  nyc: false,
  osls: false,
  oxfmt: false,
  oxlint: false,
  'panda-css': false,
  payload: false,
  playwright: false,
  'playwright-ct': false,
  pm2: false,
  postcss: false,
  prettier: false,
  prisma: false,
  'react-native': false,
  'react-router': false,
  relay: false,
  'release-it': false,
  remark: false,
  rolldown: false,
  rsbuild: false,
  rspack: false,
  rstest: false,
  'semantic-release': false,
  'serverless-framework': false,
  'simple-git-hooks': false,
  storybook: false,
  stryker: false,
  stylelint: false,
  svgr: false,
  textlint: false,
  tsdown: false,
  tsrs: false,
  tsup: false,
  tsx: false,
  typedoc: false,
  unbuild: false,
  vite: false,
  'vite-plus': false,
  vitest: false,
  vue: false,
  'webdriver-io': false,
  webpack: false,
  wrangler: false,
  wxt: false,
  xo: false,
};

const SRC_EXT_GLOB = '{ts,tsx,mts,cts,js,jsx,mjs,cjs}';

const SHARED_ENTRY_PATTERNS = [
  `{app,src}/{routes/**,routes.*,root.*,entry.client.*,entry.server.*}.{ts,tsx,js,jsx}`,
  `routes/**/*.{ts,tsx,js,jsx}`,
  `src/{pages,content,middleware,layouts,actions}/**/*.{ts,tsx,js,jsx,mjs,astro,mdx}`,
  `src/{content.config,middleware}.{ts,js,mjs}`,
  `source.config.{ts,js,mjs}`,
  `**/*.{astro,mdx}`,
  `{pages,app,server}/**/*.{ts,tsx,js,jsx}`,
  `src/app/**/{page,layout,route,loading,error,not-found,template,default,opengraph-image,icon,apple-icon,sitemap,robots}.{ts,tsx,js,jsx}`,
  `{instrumentation,middleware}.{ts,tsx,js,jsx}`,
  `worker/**/*.{ts,tsx,js,jsx}`,
  `workers/**/*.{ts,tsx,js,jsx}`,
  `public/**/*.{js,mjs,cjs}`,
  `**/snippets/**/*.{js,jsx,ts,tsx}`,
  `{scripts,bin}/**/*.${SRC_EXT_GLOB}`,
  `{test,tests,__tests__,test-kit,fixtures,e2e}/**/*.${SRC_EXT_GLOB}`,
  `**/*.{test,spec,test-d,spec-d,e2e,preprod,cluster,image,load,stories,setup}.${SRC_EXT_GLOB}`,
  `**/setupTests.${SRC_EXT_GLOB}`,
  `**/__mocks__/**/*.${SRC_EXT_GLOB}`,
  `.storybook/**/*.${SRC_EXT_GLOB}`,
  `*{,.*}.config.${SRC_EXT_GLOB}`,
  `.config/**/*.${SRC_EXT_GLOB}`,
];

const PRIVATE_ENTRY_PATTERNS = [
  `src/{index,main,bin,*-index}.${SRC_EXT_GLOB}`,
  `{index,main,bin,server}.${SRC_EXT_GLOB}`,
];

const DEFAULT_PROJECT_PATTERNS = [
  '**/*.{js,es,es6,jsx,mjs,cjs,ts,tsx,mts,cts}',
  '!**/*.d.{ts,mts,cts}',
];

const DEFAULT_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.output/**',
  '**/.astro/**',
  '**/.turbo/**',
  '**/.wrangler/**',
  '**/.react-router/**',
  '**/.svelte-kit/**',
  '**/.vercel/**',
  '**/storybook-static/**',
  '**/.{claude,agents,cursor,codex}/**',
];

export function stripJsonc(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out = [];
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let pendingCommaIdx = -1;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        out.push(ch);
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      } else if (ch === '\n' || ch === '\r') {
        out.push(ch);
      }
      continue;
    }
    if (inString) {
      out.push(ch);
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"') {
      pendingCommaIdx = -1;
      inString = true;
      out.push(ch);
      continue;
    }
    if (ch === ',') {
      pendingCommaIdx = out.length;
      out.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (pendingCommaIdx >= 0) {
        out[pendingCommaIdx] = '';
        pendingCommaIdx = -1;
      }
      out.push(ch);
      continue;
    }
    if (!/\s/.test(ch)) {
      pendingCommaIdx = -1;
    }
    out.push(ch);
  }

  return out.join('');
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}

function isRegularFile(filePath) {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isRealDirectory(dirPath) {
  try {
    const st = lstatSync(dirPath);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function isSafeRelativeGlob(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return false;
  const raw = pattern.startsWith('!') ? pattern.slice(1) : pattern;
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return false;
  const segments = raw.split('/');
  return !segments.includes('..');
}

function hasAnyCodeFile(dirPath) {
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue;
    if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (CODE_FILE_EXTS.has(ext)) return true;
    } else if (ent.isDirectory() && !SKIP_DIRS.has(ent.name)) {
      if (hasAnyCodeFile(path.join(dirPath, ent.name))) return true;
    }
  }
  return false;
}

function readJsonFileSafe(filePath) {
  if (!isRegularFile(filePath)) return null;
  try {
    return parseJsonc(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function isPublicLibrary(pkg) {
  return Boolean(
    pkg &&
      typeof pkg === 'object' &&
      pkg.private !== true &&
      Boolean(pkg.exports || pkg.main || pkg.module || pkg.bin),
  );
}

export function discoverWorkspaces(repoRoot) {
  const discovered = [];

  function walk(absDir, relDir) {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const manifestPath = path.join(absDir, 'package.json');
    if (relDir !== '.' && isRegularFile(manifestPath)) {
      const pkg = readJsonFileSafe(manifestPath);
      if (pkg && typeof pkg === 'object' && hasAnyCodeFile(absDir)) {
        discovered.push({
          key: relDir,
          dir: absDir,
          manifestPath,
          pkg,
        });
      }
    }

    for (const ent of entries) {
      if (ent.isSymbolicLink() || !ent.isDirectory()) continue;
      if (SKIP_DIRS.has(ent.name)) continue;
      const childRel = relDir === '.' ? ent.name : `${relDir}/${ent.name}`;
      walk(path.join(absDir, ent.name), childRel);
    }
  }

  const rootManifestPath = path.join(repoRoot, 'package.json');
  const rootPkg = readJsonFileSafe(rootManifestPath);
  walk(repoRoot, '.');

  if (rootPkg || discovered.length === 0) {
    discovered.unshift({
      key: '.',
      dir: repoRoot,
      manifestPath: isRegularFile(rootManifestPath) ? rootManifestPath : null,
      pkg: rootPkg ?? { private: true },
    });
  }

  return discovered;
}

function collectStringTargets(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringTargets(item, out);
  } else if (value && typeof value === 'object') {
    for (const val of Object.values(value)) collectStringTargets(val, out);
  }
  return out;
}

function normalizeManifestTarget(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('http')) return null;
  const rel = trimmed.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
  if (!rel || rel.startsWith('node_modules/') || rel.split('/').includes('..')) return null;
  if (NON_CODE_ASSET_EXT_RE.test(rel)) return null;
  return rel;
}

function stripBuildPrefix(rel) {
  for (const prefix of BUILD_DIR_PREFIXES) {
    if (rel.startsWith(prefix)) {
      return { inner: rel.slice(prefix.length), stripped: true };
    }
  }
  return { inner: rel, stripped: false };
}

export function mapBuiltTargetToSource(wsDir, rawTarget, { forPaths = false } = {}) {
  const rel = normalizeManifestTarget(rawTarget);
  if (!rel) return [];

  const { inner, stripped } = stripBuildPrefix(rel);

  if (rel.includes('*')) {
    if (!stripped) {
      return [forPaths ? `./${rel}` : rel];
    }
    const noExt = forPaths
      ? inner.replace(/\*(?:\.d\.(?:[cm]?ts)|\.[cm]?[jt]sx?)$/i, '*')
      : inner.replace(CODE_EXT_STRIP_RE, `.${SRC_EXT_GLOB}`);
    const results = [];
    if (isRealDirectory(path.join(wsDir, 'src'))) {
      results.push(forPaths ? `./src/${noExt}` : `src/${noExt}`);
    } else {
      results.push(forPaths ? `./${noExt}` : noExt);
    }
    return results;
  }

  const found = [];
  const addIfNew = (candidateRel) => {
    const posixRel = toPosix(candidateRel).replace(/^(?:\.\/)+/, '');
    const formatted = forPaths ? `./${posixRel}` : posixRel;
    if (!found.includes(formatted)) found.push(formatted);
  };

  if (
    !stripped &&
    CODE_EXT_STRIP_RE.test(rel) &&
    !/\.d\.[cm]?ts$/i.test(rel) &&
    isRegularFile(path.join(wsDir, rel))
  ) {
    addIfNew(rel);
  }

  const stem = inner.replace(CODE_EXT_STRIP_RE, '').replace(/\/+$/, '');
  if (!stem) return found;

  const candidateStems = stripped
    ? [`src/${stem}`, `src/${stem}/index`, stem, `${stem}/index`]
    : [stem, `${stem}/index`, `src/${stem}`, `src/${stem}/index`];

  for (const candStem of candidateStems) {
    for (const ext of SOURCE_EXTS) {
      const candRel = `${candStem}${ext}`;
      if (isRegularFile(path.join(wsDir, candRel))) {
        addIfNew(candRel);
      }
    }
    // For paths resolution, returning the first matching source file per target avoids ambiguity.
    if (forPaths && found.length > 0) break;
  }

  return found;
}

export function resolvePackageEntrySources(wsDir, pkg) {
  if (!pkg || typeof pkg !== 'object') return [];
  const rawTargets = [
    ...collectStringTargets(pkg.exports),
    ...collectStringTargets(pkg.main),
    ...collectStringTargets(pkg.module),
    ...collectStringTargets(pkg.bin),
  ];
  const entries = [];
  for (const raw of rawTargets) {
    for (const mapped of mapBuiltTargetToSource(wsDir, raw, { forPaths: false })) {
      if (!entries.includes(mapped)) entries.push(mapped);
    }
  }
  return entries;
}

function addUniquePathTargets(map, key, targets) {
  if (!key || targets.length === 0) return;
  const existing = Object.hasOwn(map, key) ? map[key] : [];
  for (const t of targets) {
    if (!existing.includes(t)) existing.push(t);
  }
  if (existing.length > 0) map[key] = existing;
}

function mapRawTargetsToAbsPosix(wsDir, rawTargets) {
  const mapped = [];
  for (const raw of rawTargets) {
    for (const m of mapBuiltTargetToSource(wsDir, raw, { forPaths: true })) {
      const abs = toPosix(path.resolve(wsDir, m));
      if (!mapped.includes(abs)) mapped.push(abs);
    }
  }
  return mapped;
}

function isRelativeWithinBase(baseDir, targetPath) {
  const rel = path.relative(baseDir, targetPath);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function isRealPathInsideRepo(candidatePath, realRepoRoot) {
  let cursor = path.resolve(candidatePath);
  while (true) {
    if (existsSync(cursor)) {
      try {
        const realCursor = realpathSync(cursor);
        return isRelativeWithinBase(realRepoRoot, realCursor);
      } catch {
        return false;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function buildRepoWorkspaceAbsolutePaths(workspaces) {
  const absPaths = Object.create(null);

  for (const ws of workspaces) {
    const pkg = ws.pkg;
    if (!pkg || typeof pkg.name !== 'string' || !pkg.name.trim()) continue;
    const pkgName = pkg.name.trim();

    const exp = pkg.exports;
    const isSubpathExportsMap =
      exp &&
      typeof exp === 'object' &&
      !Array.isArray(exp) &&
      Object.keys(exp).some((k) => k === '.' || k.startsWith('./'));

    // 1. Root package entry (`import ... from "pkg"`)
    const rootRawTargets = [];
    if (isSubpathExportsMap) {
      if (Object.hasOwn(exp, '.')) collectStringTargets(exp['.'], rootRawTargets);
    } else if (exp) {
      collectStringTargets(exp, rootRawTargets);
    }
    collectStringTargets(pkg.module, rootRawTargets);
    collectStringTargets(pkg.main, rootRawTargets);

    const rootMapped = mapRawTargetsToAbsPosix(ws.dir, rootRawTargets);
    if (rootMapped.length === 0 && !isSubpathExportsMap) {
      for (const fallbackStem of ['src/index', 'index']) {
        for (const ext of SOURCE_EXTS) {
          const cand = path.join(ws.dir, `${fallbackStem}${ext}`);
          if (isRegularFile(cand)) {
            rootMapped.push(toPosix(cand));
            break;
          }
        }
        if (rootMapped.length > 0) break;
      }
    }
    addUniquePathTargets(absPaths, pkgName, rootMapped);

    // 2. Subpath exports (`import ... from "pkg/subpath"`)
    if (isSubpathExportsMap) {
      for (const [subKey, subVal] of Object.entries(exp)) {
        if (subKey === '.' || !subKey.startsWith('./')) continue;
        const suffix = subKey.slice(2);
        if (!suffix) continue;
        const aliasKey = `${pkgName}/${suffix}`;
        const subMapped = mapRawTargetsToAbsPosix(ws.dir, collectStringTargets(subVal));
        addUniquePathTargets(absPaths, aliasKey, subMapped);
      }
    } else if (!exp && isRealDirectory(path.join(ws.dir, 'src'))) {
      addUniquePathTargets(absPaths, `${pkgName}/*`, [toPosix(path.join(ws.dir, 'src/*'))]);
    }
  }

  return absPaths;
}

function readLocalTsconfigPaths(wsDir, repoRoot) {
  const refVisited = new Set();
  const collected = Object.create(null);
  let realRepoRoot;
  try {
    realRepoRoot = realpathSync(repoRoot);
  } catch {
    return collected;
  }

  function resolveInsideRepo(tsconfigPath) {
    const resolved = path.resolve(tsconfigPath);
    if (!isRelativeWithinBase(repoRoot, resolved)) return null;
    if (!isRegularFile(resolved)) return null;
    try {
      const realResolved = realpathSync(resolved);
      if (!isRelativeWithinBase(realRepoRoot, realResolved)) return null;
      return realResolved;
    } catch {
      return null;
    }
  }

  function loadChain(tsconfigPath, chainSet) {
    const realResolved = resolveInsideRepo(tsconfigPath);
    if (!realResolved || chainSet.has(realResolved)) {
      return { effectiveBaseDir: null, pathsMap: Object.create(null) };
    }
    const nextChain = new Set(chainSet);
    nextChain.add(realResolved);

    const parsed = readJsonFileSafe(realResolved);
    if (!parsed || typeof parsed !== 'object') {
      return { effectiveBaseDir: null, pathsMap: Object.create(null) };
    }
    const cfgDir = path.dirname(realResolved);
    let effectiveBaseDir = null;
    const pathsMap = Object.create(null);

    if (parsed.extends) {
      const extList = Array.isArray(parsed.extends) ? parsed.extends : [parsed.extends];
      for (const ext of extList) {
        if (typeof ext === 'string' && (ext.startsWith('./') || ext.startsWith('../'))) {
          const extTarget = ext.endsWith('.json')
            ? path.resolve(cfgDir, ext)
            : isRegularFile(path.resolve(cfgDir, `${ext}.json`))
              ? path.resolve(cfgDir, `${ext}.json`)
              : path.resolve(cfgDir, ext, 'tsconfig.json');
          const parent = loadChain(extTarget, nextChain);
          if (parent.effectiveBaseDir) effectiveBaseDir = parent.effectiveBaseDir;
          Object.assign(pathsMap, parent.pathsMap);
        }
      }
    }

    if (Array.isArray(parsed.references)) {
      for (const ref of parsed.references) {
        if (ref && typeof ref.path === 'string') {
          const refAbs = path.resolve(cfgDir, ref.path);
          const refCfg = refAbs.endsWith('.json') ? refAbs : path.join(refAbs, 'tsconfig.json');
          const realRef = resolveInsideRepo(refCfg);
          if (realRef && !refVisited.has(realRef)) {
            refVisited.add(realRef);
            const refLoaded = loadChain(realRef, new Set());
            for (const [k, v] of Object.entries(refLoaded.pathsMap)) {
              if (!Object.hasOwn(pathsMap, k)) pathsMap[k] = v;
            }
          }
        }
      }
    }

    const co = parsed.compilerOptions;
    if (co && typeof co === 'object') {
      if (typeof co.baseUrl === 'string') {
        effectiveBaseDir = path.resolve(cfgDir, co.baseUrl);
      }
      if (co.paths && typeof co.paths === 'object') {
        const baseDir = effectiveBaseDir ?? cfgDir;
        for (const [alias, targets] of Object.entries(co.paths)) {
          if (!Array.isArray(targets)) continue;
          const absTargets = targets
            .filter((t) => typeof t === 'string')
            .map((t) => path.resolve(baseDir, t))
            .filter(
              (abs) =>
                isRelativeWithinBase(realRepoRoot, abs) && isRealPathInsideRepo(abs, realRepoRoot),
            )
            .map((abs) => toPosix(abs));
          if (absTargets.length > 0) {
            pathsMap[alias] = absTargets;
          }
        }
      }
    }

    return { effectiveBaseDir, pathsMap };
  }

  const rootLoaded = loadChain(path.join(wsDir, 'tsconfig.json'), new Set());
  Object.assign(collected, rootLoaded.pathsMap);
  return collected;
}

function resolveSubpathImports(wsDir, pkg) {
  const pathsMap = Object.create(null);
  const extraEntries = [];
  if (!pkg || typeof pkg.imports !== 'object' || !pkg.imports || Array.isArray(pkg.imports)) {
    return { pathsMap, extraEntries };
  }
  for (const [impKey, impVal] of Object.entries(pkg.imports)) {
    if (!impKey.startsWith('#')) continue;
    const rawTargets = collectStringTargets(impVal);
    const mappedPaths = mapRawTargetsToAbsPosix(wsDir, rawTargets);
    for (const raw of rawTargets) {
      for (const entryRel of mapBuiltTargetToSource(wsDir, raw, { forPaths: false })) {
        if (!entryRel.includes('*') && !extraEntries.includes(entryRel)) {
          extraEntries.push(entryRel);
        }
      }
    }
    addUniquePathTargets(pathsMap, impKey, mappedPaths);
  }
  return { pathsMap, extraEntries };
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'typeof',
  'void',
  'delete',
  'throw',
  'case',
  'in',
  'of',
  'instanceof',
  'new',
  'await',
  'yield',
]);

const CONTROL_HEADER_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

export function tokenizeModuleSource(source) {
  const tokens = [];
  const templateBraceStack = [];
  const parenControlStack = [];
  let i = 0;

  const canStartRegex = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === 'punct') {
      if (prev.value === ')') return Boolean(prev.closesControlHeader);
      return prev.value !== ']';
    }
    if (prev.type === 'ident') return REGEX_PREFIX_KEYWORDS.has(prev.value);
    return false;
  };

  const readTemplateChunk = () => {
    let val = '';
    let hasSubstitution = false;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        val += source[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '`') {
        i++;
        if (!hasSubstitution) {
          tokens.push({ type: 'string', value: val });
        } else {
          tokens.push({ type: 'punct', value: '`' });
        }
        return;
      }
      if (ch === '$' && source[i + 1] === '{') {
        hasSubstitution = true;
        tokens.push({ type: 'punct', value: '${' });
        templateBraceStack.push({ braces: 0, parenDepth: parenControlStack.length });
        i += 2;
        return;
      }
      val += ch;
      i++;
    }
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (i === 0 && ch === '#' && next === '!') {
      i += 2;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '/' && canStartRegex()) {
      i++;
      let inClass = false;
      while (i < source.length) {
        const rc = source[i];
        if (rc === '\\') {
          i += 2;
          continue;
        }
        if (rc === '[') inClass = true;
        else if (rc === ']' && inClass) inClass = false;
        else if ((rc === '/' && !inClass) || rc === '\n' || rc === '\r') {
          if (rc === '/') {
            i++;
            while (i < source.length && /[A-Za-z]/.test(source[i])) i++;
          }
          break;
        }
        i++;
      }
      tokens.push({ type: 'regex', value: '/' });
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let val = '';
      while (i < source.length) {
        const sc = source[i];
        if (sc === '\\') {
          val += source[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (sc === quote || sc === '\n' || sc === '\r') {
          if (sc === quote) i++;
          break;
        }
        val += sc;
        i++;
      }
      tokens.push({ type: 'string', value: val });
      continue;
    }
    if (ch === '`') {
      i++;
      readTemplateChunk();
      continue;
    }
    if (ch === '(') {
      const prevTok = tokens[tokens.length - 1];
      const prevPrevTok = tokens[tokens.length - 2];
      const isDirectControl =
        prevTok?.type === 'ident' &&
        CONTROL_HEADER_KEYWORDS.has(prevTok.value) &&
        prevPrevTok?.value !== '.';
      const isForAwaitControl =
        prevTok?.type === 'ident' &&
        prevTok.value === 'await' &&
        prevPrevTok?.type === 'ident' &&
        prevPrevTok.value === 'for' &&
        tokens[tokens.length - 3]?.value !== '.';
      parenControlStack.push(isDirectControl || isForAwaitControl);
      tokens.push({ type: 'punct', value: '(' });
      i++;
      continue;
    }
    if (ch === ')') {
      const closesControlHeader = parenControlStack.pop() === true;
      tokens.push({ type: 'punct', value: ')', closesControlHeader });
      i++;
      continue;
    }
    if (ch === '{' && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1].braces++;
      tokens.push({ type: 'punct', value: '{' });
      i++;
      continue;
    }
    if (ch === '}' && templateBraceStack.length > 0) {
      const top = templateBraceStack[templateBraceStack.length - 1];
      if (top.braces === 0) {
        templateBraceStack.pop();
        parenControlStack.length = top.parenDepth;
        tokens.push({ type: 'punct', value: '}' });
        i++;
        readTemplateChunk();
        continue;
      }
      top.braces--;
      tokens.push({ type: 'punct', value: '}' });
      i++;
      continue;
    }
    if (ch === '#' && /[A-Za-z_$]/.test(next ?? '')) {
      let end = i + 2;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end++;
      tokens.push({ type: 'priv', value: source.slice(i, end) });
      i = end;
      continue;
    }
    if (ch === '@' && /[A-Za-z_-]/.test(next ?? '')) {
      let end = i + 1;
      while (end < source.length && /[A-Za-z0-9_-]/.test(source[end])) end++;
      tokens.push({ type: 'at', value: source.slice(i, end) });
      i = end;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < source.length && /[0-9A-Za-z_.]/.test(source[end])) end++;
      tokens.push({ type: 'num', value: source.slice(i, end) });
      i = end;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end++;
      tokens.push({ type: 'ident', value: source.slice(i, end) });
      i = end;
      continue;
    }
    tokens.push({ type: 'punct', value: ch });
    i++;
  }

  return tokens;
}

function isPropertyKeyToken(tok, propName) {
  return (tok?.type === 'ident' || tok?.type === 'string') && tok.value === propName;
}

export function extractDrizzleSchemas(wsDir) {
  let entries;
  try {
    entries = readdirSync(wsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const schemas = [];
  const drizzleConfigRe = /^drizzle(?:\.[^/]+)?\.config\.(?:[cm]?[jt]sx?|json)$/i;

  for (const ent of entries) {
    if (!ent.isFile() || ent.isSymbolicLink() || !drizzleConfigRe.test(ent.name)) continue;
    let src;
    try {
      src = readFileSync(path.join(wsDir, ent.name), 'utf8');
    } catch {
      continue;
    }
    const tokens = tokenizeModuleSource(src);
    const rawValues = [];

    for (let i = 0; i < tokens.length; i++) {
      if (
        !isPropertyKeyToken(tokens[i], 'schema') ||
        tokens[i - 1]?.value === '.' ||
        tokens[i + 1]?.type !== 'punct' ||
        tokens[i + 1]?.value !== ':'
      ) {
        continue;
      }
      const valTok = tokens[i + 2];
      if (valTok?.type === 'string') {
        rawValues.push(valTok.value);
      } else if (valTok?.type === 'punct' && valTok.value === '[') {
        for (let j = i + 3; j < tokens.length; j++) {
          if (tokens[j].type === 'punct' && tokens[j].value === ']') break;
          if (tokens[j].type === 'string') rawValues.push(tokens[j].value);
        }
      }
    }

    for (const raw of rawValues) {
      const rel = normalizeManifestTarget(raw);
      if (!rel) continue;
      const abs = path.join(wsDir, rel);
      let entryPattern = rel;
      if (!rel.includes('*') && isRealDirectory(abs)) {
        entryPattern = `${rel.replace(/\/+$/, '')}/**/*.${SRC_EXT_GLOB}`;
      }
      if (!schemas.includes(entryPattern)) schemas.push(entryPattern);
    }
  }

  return schemas;
}

function extractReactRouterAppDir(wsDir) {
  const candidates = [
    'react-router.config.ts',
    'react-router.config.mts',
    'react-router.config.js',
    'react-router.config.mjs',
  ];
  for (const name of candidates) {
    const cfgPath = path.join(wsDir, name);
    if (!isRegularFile(cfgPath)) continue;
    try {
      const tokens = tokenizeModuleSource(readFileSync(cfgPath, 'utf8'));
      for (let i = 0; i < tokens.length; i++) {
        if (
          isPropertyKeyToken(tokens[i], 'appDirectory') &&
          tokens[i + 1]?.type === 'punct' &&
          tokens[i + 1]?.value === ':' &&
          tokens[i + 2]?.type === 'string'
        ) {
          const rel = tokens[i + 2].value.trim().replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
          if (rel && isSafeRelativeGlob(rel)) return rel;
        }
      }
    } catch {
      // Ignore unreadable config.
    }
  }
  return null;
}

function extractOxlintJsPlugins(wsDir) {
  const plugins = [];
  for (const name of ['.oxlintrc.json', '.oxlintrc.jsonc']) {
    const parsed = readJsonFileSafe(path.join(wsDir, name));
    if (!parsed || typeof parsed !== 'object') continue;
    const rawLists = [parsed.jsPlugins];
    if (Array.isArray(parsed.overrides)) {
      for (const ov of parsed.overrides) {
        if (ov && typeof ov === 'object') rawLists.push(ov.jsPlugins);
      }
    }
    for (const list of rawLists) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const target =
          typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw.specifier : null;
        const rel = normalizeManifestTarget(target);
        if (rel && isRegularFile(path.join(wsDir, rel)) && !plugins.includes(rel)) {
          plugins.push(rel);
        }
      }
    }
  }
  return plugins;
}

function toRelativePosix(fromDir, absTarget) {
  const rel = toPosix(path.relative(fromDir, absTarget));
  if (!rel) return '.';
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function globBodyToRegExpSource(globPattern, atStart = true) {
  let re = '';
  let i = 0;
  while (i < globPattern.length) {
    if (atStart && i === 0 && globPattern.startsWith('**/')) {
      re += '(?:.+/)?';
      i += 3;
      continue;
    }
    if (globPattern.startsWith('/**/', i)) {
      re += '(?:/.*)?/';
      i += 4;
      continue;
    }
    if (globPattern.slice(i) === '/**') {
      re += '(?:/.*)?';
      i += 3;
      continue;
    }
    const ch = globPattern[i];
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      const parts = [];
      let segStart = j;
      while (j < globPattern.length && depth > 0) {
        if (globPattern[j] === '{') depth++;
        else if (globPattern[j] === '}') {
          depth--;
          if (depth === 0) {
            parts.push(globPattern.slice(segStart, j));
            break;
          }
        } else if (globPattern[j] === ',' && depth === 1) {
          parts.push(globPattern.slice(segStart, j));
          segStart = j + 1;
        }
        j++;
      }
      if (depth === 0 && parts.length >= 2) {
        re += `(?:${parts.map((p) => globBodyToRegExpSource(p, false)).join('|')})`;
        i = j + 1;
        continue;
      }
    }
    if (ch === '*') {
      if (globPattern[i + 1] === '*') {
        while (globPattern[i + 1] === '*') i++;
        re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
    i++;
  }
  return re;
}

export function globToRegExp(globPattern) {
  return new RegExp(`^${globBodyToRegExpSource(globPattern, true)}$`);
}

function normalizeWorkspaceKey(rawKey) {
  const cleaned = rawKey.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return cleaned || '.';
}

function mergeUniqueStrings(target, extra) {
  if (!Array.isArray(extra)) return target;
  for (const item of extra) {
    if (isSafeRelativeGlob(item) && !target.includes(item)) {
      target.push(item);
    }
  }
  return target;
}

function mergeIgnoreIssuesMap(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;
  for (const [glob, types] of Object.entries(source)) {
    if (!isSafeRelativeGlob(glob) || !Array.isArray(types)) continue;
    const validTypes = types.filter((t) => typeof t === 'string' && INCLUDED_ISSUE_TYPES.includes(t));
    if (validTypes.length === 0) continue;
    const cur = Object.hasOwn(target, glob) ? target[glob] : [];
    for (const t of validTypes) {
      if (!cur.includes(t)) cur.push(t);
    }
    target[glob] = cur;
  }
}

function mergeStaticRepoKnipConfig(repoRoot, config, workspacesByKey) {
  const localPath = ['knip.json', 'knip.jsonc']
    .map((n) => path.join(repoRoot, n))
    .find((p) => isRegularFile(p));
  let local = localPath ? readJsonFileSafe(localPath) : null;
  if (!local) {
    const rootPkg = readJsonFileSafe(path.join(repoRoot, 'package.json'));
    if (rootPkg && typeof rootPkg.knip === 'object' && rootPkg.knip && !Array.isArray(rootPkg.knip)) {
      local = rootPkg.knip;
    }
  }
  if (!local || typeof local !== 'object' || Array.isArray(local)) return;

  mergeUniqueStrings(config.ignore, local.ignore);
  mergeIgnoreIssuesMap(config.ignoreIssues, local.ignoreIssues);

  const rootWs = config.workspaces['.'];
  if (rootWs) {
    mergeUniqueStrings(rootWs.entry, local.entry);
    mergeUniqueStrings(rootWs.project, local.project);
  }

  if (local.workspaces && typeof local.workspaces === 'object' && !Array.isArray(local.workspaces)) {
    const discoveredKeys = Object.keys(config.workspaces);
    for (const [rawPattern, wsOverride] of Object.entries(local.workspaces)) {
      if (!wsOverride || typeof wsOverride !== 'object' || Array.isArray(wsOverride)) continue;
      const normPattern = normalizeWorkspaceKey(rawPattern);
      if (normPattern !== '.' && !isSafeRelativeGlob(normPattern)) continue;

      let matchedKeys;
      if (normPattern.includes('*') || normPattern.includes('?') || normPattern.includes('{')) {
        const matcher = globToRegExp(normPattern);
        matchedKeys = discoveredKeys.filter((k) => k !== '.' && matcher.test(k));
      } else if (Object.hasOwn(config.workspaces, normPattern)) {
        matchedKeys = [normPattern];
      } else if (isRealDirectory(path.join(repoRoot, normPattern))) {
        const wsAbsDir = path.join(repoRoot, normPattern);
        const rebasedPaths = Object.create(null);
        for (const [alias, relTargets] of Object.entries(workspacesByKey.get('.')?.paths ?? {})) {
          rebasedPaths[alias] = relTargets.map((t) =>
            toRelativePosix(wsAbsDir, path.resolve(repoRoot, t)),
          );
        }
        config.workspaces[normPattern] = {
          includeEntryExports: true,
          entry: [...PRIVATE_ENTRY_PATTERNS, ...SHARED_ENTRY_PATTERNS],
          project: [...DEFAULT_PROJECT_PATTERNS],
          ignore: [],
          paths: rebasedPaths,
        };
        matchedKeys = [normPattern];
      } else {
        matchedKeys = [];
      }

      for (const wsKey of matchedKeys) {
        const targetWs = Object.hasOwn(config.workspaces, wsKey) ? config.workspaces[wsKey] : null;
        if (!targetWs) continue;
        mergeUniqueStrings(targetWs.entry, wsOverride.entry);
        mergeUniqueStrings(targetWs.project, wsOverride.project);
        mergeUniqueStrings(targetWs.ignore, wsOverride.ignore);
        if (typeof wsOverride.includeEntryExports === 'boolean') {
          targetWs.includeEntryExports = wsOverride.includeEntryExports;
        }
        if (Array.isArray(wsOverride.ignoreMembers)) {
          const validMembers = wsOverride.ignoreMembers.filter((m) => typeof m === 'string');
          if (validMembers.length > 0) {
            targetWs.ignoreMembers = [...(targetWs.ignoreMembers ?? []), ...validMembers];
          }
        }
        if (wsOverride.ignoreIssues && typeof wsOverride.ignoreIssues === 'object') {
          const rebased = Object.create(null);
          for (const [pat, types] of Object.entries(wsOverride.ignoreIssues)) {
            if (!isSafeRelativeGlob(pat)) continue;
            const fullPat = wsKey === '.' ? pat : `${wsKey}/${pat.replace(/^(?:\.\/)+/, '')}`;
            rebased[fullPat] = types;
          }
          mergeIgnoreIssuesMap(config.ignoreIssues, rebased);
        }
      }
    }
  }
}

function buildDefaultIgnoreIssues() {
  const map = Object.create(null);
  const groups = [
    [
      ['**/*{,.*}.config.*', '**/renovate-config.*', '**/.storybook/**', '**/*.stories.*'],
      [...EXPORT_ONLY_ISSUE_TYPES, 'duplicates'],
    ],
    [
      [
        '**/*.setup.*',
        '**/setupTests.*',
        '**/scripts/**',
        '**/bin/**',
        '**/public/**',
        '**/snippets/**',
        '**/worker/**',
        '**/workers/**',
        '**/routes/**',
        '**/routes.{ts,tsx,js,jsx}',
        '**/{root,entry.client,entry.server,middleware,instrumentation}.{ts,tsx,js,jsx,mjs}',
        '**/pages/**',
        '**/app/**/{page,layout,route,loading,error,not-found,template,default,opengraph-image,icon,apple-icon,sitemap,robots}.{ts,tsx,js,jsx}',
      ],
      EXPORT_ONLY_ISSUE_TYPES,
    ],
    [
      [
        '**/*.{astro,mdx}',
        '**/gen/**',
        '**/generated/**',
        '**/__generated__/**',
        '**/*.gen.*',
        '**/*.generated.*',
        '**/.react-router/**',
      ],
      INCLUDED_ISSUE_TYPES,
    ],
  ];
  for (const [patterns, issueTypes] of groups) {
    for (const pat of patterns) {
      map[pat] = [...issueTypes];
    }
  }
  return map;
}

export function buildKnipConfig(repoRoot) {
  const workspaces = discoverWorkspaces(repoRoot);
  const repoAbsPaths = buildRepoWorkspaceAbsolutePaths(workspaces);
  const ignoreIssues = buildDefaultIgnoreIssues();

  const knipWorkspaces = Object.create(null);
  const workspacesMeta = new Map();

  for (const ws of workspaces) {
    const publicLib = isPublicLibrary(ws.pkg);
    const mappedEntries = resolvePackageEntrySources(ws.dir, ws.pkg);
    const drizzleEntries = extractDrizzleSchemas(ws.dir);
    const oxlintPlugins = extractOxlintJsPlugins(ws.dir);
    const customAppDir = extractReactRouterAppDir(ws.dir);
    const { pathsMap: subpathImportAbsPaths, extraEntries: subpathImportEntries } =
      resolveSubpathImports(ws.dir, ws.pkg);
    const localTsPaths = readLocalTsconfigPaths(ws.dir, repoRoot);

    const entry = [];
    const addEntry = (pat) => {
      if (pat && !entry.includes(pat)) entry.push(pat);
    };

    for (const m of mappedEntries) addEntry(m);
    for (const m of subpathImportEntries) addEntry(m);
    for (const m of oxlintPlugins) addEntry(m);

    if (publicLib) {
      if (mappedEntries.length === 0) {
        addEntry(`src/{index,main,bin}.${SRC_EXT_GLOB}`);
      }
      addEntry(`examples/**/*.${SRC_EXT_GLOB}`);
    } else {
      for (const pat of PRIVATE_ENTRY_PATTERNS) addEntry(pat);
    }

    if (customAppDir) {
      addEntry(`${customAppDir}/**/*.{ts,tsx,js,jsx}`);
      const ignoreRoutePat =
        ws.key === '.' ? `${customAppDir}/**` : `${ws.key}/${customAppDir}/**`;
      ignoreIssues[ignoreRoutePat] = [...EXPORT_ONLY_ISSUE_TYPES];
    }

    for (const pat of SHARED_ENTRY_PATTERNS) addEntry(pat);
    for (const pat of drizzleEntries) addEntry(pat);

    // Build workspace-relative `paths` combining cross-workspace packages, `#imports`, and tsconfig paths.
    const combinedAbs = Object.create(null);
    for (const [k, v] of Object.entries(repoAbsPaths)) addUniquePathTargets(combinedAbs, k, v);
    for (const [k, v] of Object.entries(subpathImportAbsPaths)) addUniquePathTargets(combinedAbs, k, v);
    for (const [k, v] of Object.entries(localTsPaths)) addUniquePathTargets(combinedAbs, k, v);

    // Omit bare Object.prototype keys because knip@6.46.1 ProjectPrincipal.addPaths checks `key in {}`.
    const wsPaths = Object.create(null);
    for (const [alias, absList] of Object.entries(combinedAbs)) {
      if (alias === '__proto__' || alias in Object.prototype) continue;
      wsPaths[alias] = absList.map((absTarget) => toRelativePosix(ws.dir, absTarget));
    }

    const wsConfig = {
      includeEntryExports: !publicLib,
      entry,
      project: [...DEFAULT_PROJECT_PATTERNS],
      ignore: [],
      paths: wsPaths,
    };

    knipWorkspaces[ws.key] = wsConfig;
    workspacesMeta.set(ws.key, wsConfig);
  }

  const config = {
    ignoreExportsUsedInFile: true,
    include: [...INCLUDED_ISSUE_TYPES],
    exclude: [],
    rules: {},
    preprocessor: [],
    preprocessorOptions: {},
    asyncCompilers: {},
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    ignoreIssues,
    ...DISABLED_DYNAMIC_PLUGINS,
    workspaces: knipWorkspaces,
  };

  mergeStaticRepoKnipConfig(repoRoot, config, workspacesMeta);
  return config;
}

export function writeKnipConfigModule(configObj, knipInstallDir, outFilePath) {
  const astroCompilerPath = path.join(
    knipInstallDir,
    'node_modules/knip/dist/plugins/astro/compiler.js',
  );
  const mdxCompilerPath = path.join(
    knipInstallDir,
    'node_modules/knip/dist/plugins/astro/compiler-mdx.js',
  );
  const hasAstroCompilers = isRegularFile(astroCompilerPath) && isRegularFile(mdxCompilerPath);

  const lines = [];
  if (hasAstroCompilers) {
    lines.push(`import astroCompiler from ${JSON.stringify(pathToFileURL(astroCompilerPath).href)};`);
    lines.push(`import mdxCompiler from ${JSON.stringify(pathToFileURL(mdxCompilerPath).href)};`);
  }
  lines.push(`const config = ${JSON.stringify(configObj, null, 2)};`);
  lines.push(
    hasAstroCompilers
      ? `config.compilers = { astro: astroCompiler, mdx: mdxCompiler };`
      : `config.compilers = {};`,
  );
  lines.push(`export default config;`);
  writeFileSync(outFilePath, `${lines.join('\n')}\n`, 'utf8');
}
