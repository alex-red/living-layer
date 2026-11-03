/**
 * Lists exported names in apps/server/src, apps/web/src and packages/domain/src that no other
 * file in apps/, packages/, scripts/ or tests/ imports. Report only: it always exits 0.
 *
 *   bun run dead-exports
 *
 * A name is used when another file imports it from its module, or from `@livinglayer/domain`
 * (or the domain's folder) when the domain's index re-exports that module. A namespace import
 * or a dynamic import uses every export of its module. Use inside a file doesn't count.
 * The TypeScript 7 beta has no JS API here, so this reads the import statements with a regex.
 *
 * Intentional public API goes in IGNORE as `path#name` (path from the repo root).
 */
import { dirname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

const IGNORE: string[] = [];

const SOURCES = ['apps/server/src', 'apps/web/src', 'packages/domain/src'];
const IMPORTERS = ['apps', 'packages', 'scripts', 'tests'];
const PACKAGE = '@livinglayer/domain';
const DOMAIN_INDEX = 'packages/domain/src/index';

const key = (file: string) => file.replace(/\.tsx?$/, '');
const rel = (file: string) => relative(root, file);

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const ext of ['ts', 'tsx']) {
    const glob = new Bun.Glob(`**/*.${ext}`);
    for (const p of glob.scanSync({ cwd: resolve(root, dir), onlyFiles: true })) {
      if (p.includes('node_modules') || p.includes('dist/') || p.endsWith('.d.ts')) continue;
      out.push(resolve(root, dir, p));
    }
  }
  return out;
}

const t0 = performance.now();
const sourceFiles = [...new Set(SOURCES.flatMap(filesUnder))].sort();
const importerFiles = [...new Set([...sourceFiles, ...IMPORTERS.flatMap(filesUnder)])].sort();
const known = new Set(importerFiles.map(key));
const domainIndexKey = resolve(root, DOMAIN_INDEX);

// Definitions: `export const|function|class|type|…` and `export { a, b as c }` (no `from`).
const DECLARED =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+enum|const|let|var|function\*?|class|interface|type|enum)\s+([\w$]+)/gm;
const LIST = /^export\s+(?:type\s+)?\{([^}]*)\}(\s*from\s*['"][^'"]+['"])?/gm;
const DEFAULT = /^export\s+default\b/m;

// Uses: `import … from '…'`, `export { … } from '…'`, `export * as ns from '…'`, `import('…')`.
const IMPORT = /\bimport\s+([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
const EXPORT_FROM =
  /\bexport\s+(?:type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const defs = new Map<string, Set<string>>();
for (const file of sourceFiles) {
  const names = new Set<string>();
  const text = await Bun.file(file).text();
  for (const m of text.matchAll(DECLARED)) names.add(m[1]!);
  for (const m of text.matchAll(LIST)) {
    if (m[2]) continue; // a re-export, not a definition
    for (const part of m[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '');
      if (name)
        names.add(
          name
            .split(/\s+as\s+/)
            .pop()!
            .trim(),
        );
    }
  }
  if (DEFAULT.test(text)) names.add('default');
  defs.set(key(file), names);
}

// The domain index's reach, followed through the modules it re-exports: `export * from` a
// module (all its names), or named re-exports of it.
const reachAll = new Set<string>();
const reachNames = new Set<string>();
const indexFile = resolve(root, DOMAIN_INDEX + '.ts');
const queue = [indexFile];
const seen = new Set<string>([domainIndexKey]);
for (let file = queue.shift(); file; file = queue.shift()) {
  for (const m of (await Bun.file(file).text()).matchAll(EXPORT_FROM)) {
    const target = resolveSpec(file, m[2]!);
    if (!target || target === domainIndexKey) continue;
    if (m[1] === '*') reachAll.add(target);
    else if (!m[1]!.startsWith('*')) for (const n of names(m[1]!)) reachNames.add(`${target}#${n}`);
    if (!seen.has(target)) {
      seen.add(target);
      queue.push(`${target}.ts`);
    }
  }
}

function resolveSpec(fromFile: string, spec: string): string | null {
  if (spec === PACKAGE) return domainIndexKey;
  if (!spec.startsWith('.')) return null;
  const base = key(resolve(dirname(fromFile), spec)).replace(/\.(m?js|jsx)$/, '');
  for (const candidate of [base, `${base}/index`]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

// `{ a, b as c, type D }` → original names a, b, D; a default name → 'default'.
function names(clause: string): string[] {
  const c = clause.replace(/^type\s+/, '').trim();
  const out: string[] = [];
  const braces = /\{([\s\S]*)\}/.exec(c);
  const dflt = c
    .replace(/\{[\s\S]*\}/, '')
    .replace(/,/g, '')
    .trim();
  if (dflt && !dflt.startsWith('*')) out.push('default');
  for (const part of braces?.[1]?.split(',') ?? []) {
    const name = part
      .trim()
      .replace(/^type\s+/, '')
      .split(/\s+as\s+/)[0]!
      .trim();
    if (name) out.push(name);
  }
  return out;
}

const used = new Set<string>(); // `module#name`
const usedAll = new Set<string>(); // modules imported whole (namespace or dynamic)

function mark(fromFile: string, spec: string, clause: string) {
  const target = resolveSpec(fromFile, spec);
  if (!target) return;
  const star = /^\*/.test(clause.trim().replace(/^type\s+/, ''));
  if (star) {
    // `import * as ns` or `export * as ns` uses all; a bare `export * from` only re-exports.
    if (!/\bas\b/.test(clause)) return;
    if (target === domainIndexKey) reachAll.forEach((m) => usedAll.add(m));
    else usedAll.add(target);
    return;
  }
  for (const n of names(clause)) {
    if (target !== domainIndexKey) {
      used.add(`${target}#${n}`);
      continue;
    }
    // From the package: every reachable module that defines the name.
    for (const [m, set] of defs) {
      if (!set.has(n)) continue;
      if (reachAll.has(m) || reachNames.has(`${m}#${n}`)) used.add(`${m}#${n}`);
    }
  }
}

for (const file of importerFiles) {
  const text = await Bun.file(file).text();
  for (const m of text.matchAll(IMPORT)) mark(file, m[2]!, m[1]!);
  for (const m of text.matchAll(EXPORT_FROM)) mark(file, m[2]!, m[1]!);
  for (const m of text.matchAll(DYNAMIC)) {
    const target = resolveSpec(file, m[1]!);
    if (target === domainIndexKey) reachAll.forEach((r) => usedAll.add(r));
    else if (target) usedAll.add(target);
  }
}

const unused = new Map<string, string[]>(); // repo path → names
for (const file of sourceFiles) {
  const k = key(file);
  const list = [...(defs.get(k) ?? [])]
    .filter((n) => !used.has(`${k}#${n}`) && !usedAll.has(k))
    .filter((n) => !IGNORE.includes(`${rel(file)}#${n}`))
    .sort();
  if (list.length) unused.set(rel(file), list);
}

const lines: string[] = [];
const perRoot = new Map<string, number>(SOURCES.map((s) => [s, 0]));
for (const [file, list] of unused) {
  lines.push(file);
  for (const n of list) lines.push(`  ${n}`);
  const source = SOURCES.find((s) => file.startsWith(s + '/'))!;
  perRoot.set(source, perRoot.get(source)! + list.length);
  lines.push('');
}
const total = [...perRoot.values()].reduce((a, b) => a + b, 0);
const seconds = ((performance.now() - t0) / 1000).toFixed(2);
console.log(lines.join('\n'));
console.log(SOURCES.map((s) => `${s} ${perRoot.get(s)}`).join(' · '));
console.log(`${total} unused exports in ${unused.size} files, ${seconds}s`);
