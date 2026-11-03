/**
 * `bun test`, split into a few processes so the files run side by side. Each
 * file goes to the shard with the least time so far, longest first, by the
 * time it took last run (a file never timed counts as the median). Prints
 * what bun prints, summed over the shards: `N pass`, `M fail`; a shard that
 * fails prints its whole output, the others stay quiet.
 *
 *   bun run test:fast                 four shards
 *   bun run test:fast --shards 6      another number (or SHARDS=6)
 *   bun run test:fast --record        also keep this run's times in scripts/test-times.json
 *   bun run test:fast -- -t "mug"     everything after `--` goes to bun test
 *
 * Times: each run writes the files' times to out/test-times.json, which is
 * read before the checked-in scripts/test-times.json; without either the
 * files are dealt out by size.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { flag, has, parseArgs } from './lib/args.js';

const root = resolve(import.meta.dir, '..');
const outDir = join(root, 'out');
const recorded = join(root, 'scripts', 'test-times.json');
const local = join(outDir, 'test-times.json');

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const args = parseArgs(dash < 0 ? argv : argv.slice(0, dash));
const passThrough = dash < 0 ? [] : argv.slice(dash + 1);
const shardCount = Math.max(
  1,
  Number(flag(args, 'shards') ?? process.env.SHARDS ?? Math.min(4, cpus().length)),
);

/** Every test file bun would run: `tests/**.test.ts` except the browser suite's. */
function testFiles(dir = join(root, 'tests')): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'browser' && name !== 'node_modules') found.push(...testFiles(path));
    } else if (/\.(test|spec)\.[tj]sx?$/.test(name)) found.push(relative(root, path));
  }
  return found;
}
const readTimes = (file: string): Record<string, number> =>
  existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>) : {};

const files = testFiles();
const times = { ...readTimes(recorded), ...readTimes(local) };
const known = files.map((f) => times[f]).filter((t): t is number => t !== undefined);
const median = known.length ? known.sort((a, b) => a - b)[known.length >> 1]! : 0;
// Without a time, the size of the file stands in for it.
const cost = (f: string) =>
  times[f] ?? (known.length ? median : statSync(join(root, f)).size / 20_000);

const shards = Array.from({ length: Math.min(shardCount, files.length) }, () => ({
  files: [] as string[],
  load: 0,
}));
for (const f of [...files].sort((a, b) => cost(b) - cost(a))) {
  const lightest = shards.reduce((a, b) => (b.load < a.load ? b : a));
  lightest.files.push(f);
  lightest.load += cost(f);
}

mkdirSync(outDir, { recursive: true });
const start = performance.now();
const results = await Promise.all(
  shards.map(async (shard, i) => {
    const junit = join(outDir, `test-junit-${i}.xml`);
    const proc = Bun.spawn(
      [
        'bun',
        'test',
        ...shard.files,
        '--reporter=junit',
        `--reporter-outfile=${junit}`,
        ...passThrough,
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { shard, junit, code, out: `${out}${err}` };
  }),
);

// What bun prints at the end of a run, summed. Under the junit reporter its
// own summary goes to stderr in the same words.
const sum = (pattern: RegExp) =>
  results.reduce((n, r) => n + Number(pattern.exec(r.out)?.[1] ?? 0), 0);
const pass = sum(/^\s*(\d+) pass/m);
const fail = sum(/^\s*(\d+) fail/m);

// Times for next time, from each file's own suite in the junit files.
const fresh: Record<string, number> = {};
for (const r of results) {
  if (!existsSync(r.junit)) continue;
  for (const m of readFileSync(r.junit, 'utf8').matchAll(
    /<testsuite name="[^"]*" file="([^"]+)"[^>]* time="([\d.]+)"/g,
  ))
    if (files.includes(m[1]!)) fresh[m[1]!] ??= Number(m[2]);
}
// Keep a file's old time when it didn't run (a `-t` filter, a crash).
const merged = Object.fromEntries(
  Object.entries({ ...times, ...fresh })
    .filter(([f]) => files.includes(f))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([f, t]) => [f, Math.round(t * 1000) / 1000]),
);
if (passThrough.length === 0 && Object.keys(fresh).length) {
  writeFileSync(local, `${JSON.stringify(merged, null, 2)}\n`);
  if (has(args, 'record')) writeFileSync(recorded, `${JSON.stringify(merged, null, 2)}\n`);
}

const crashed = results.filter((r) => r.code !== 0 && !/^\s*\d+ fail/m.test(r.out));
for (const r of results)
  if (r.code !== 0) {
    console.log(`\n── shard with ${r.shard.files.length} files failed ──`);
    console.log(r.out);
  }
const seconds = ((performance.now() - start) / 1000).toFixed(1);
console.log(
  `\n ${pass} pass\n ${fail} fail\nRan ${shards.length} shards over ${files.length} files [${seconds}s; ` +
    `${results.map((r) => r.shard.load.toFixed(0)).join(' / ')} s planned]`,
);
process.exit(fail || crashed.length || results.some((r) => r.code !== 0) ? 1 : 0);
