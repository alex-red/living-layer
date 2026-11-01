/**
 * The browser suite on a clean snapshot: a worktree of the commit with its
 * own install and build, so another session's half-done edit can't leak in,
 * on free ports with empty data ([plan](../docs/plans/agent-tooling.md#b-the-browser-suite-as-a-normal-check-blocks-2-3-9)).
 * Prints one summary, and under each failure what its trace shows
 * (`lib/trace.ts`, the same as `bun run trace`). A full pass is recorded for
 * plain `verify`'s "changed since the suite passed" warning.
 *
 *   bun run browser                    HEAD
 *   bun run browser --at staged        HEAD and what is staged
 *   bun run browser --at main -g brush the tests whose title matches
 *   bun run browser --here             this checkout as it is, no worktree (what `verify --browser` runs)
 *
 * Results stay in `out/browser/` (the report and each failure's trace) after
 * the worktree is gone.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import { browserOut, recordPass, suiteTrees } from './lib/browser.js';
import { traceSummary } from './lib/trace.js';
import { describeSnapshot, git, repoRoot, snapshotOf, withWorktree } from './lib/worktree.js';

const argv = process.argv.slice(2);
const value = (...names: string[]) => {
  const i = argv.findIndex((a) => names.includes(a));
  return i < 0 ? undefined : argv[i + 1];
};
const at = value('--at') ?? 'HEAD';
const grep = value('-g', '--grep');
const here = argv.includes('--here');
const out = browserOut();

/** A port nothing is listening on now. */
const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.unref();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

interface Result {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  duration: number;
  error?: { message?: string };
  attachments?: { name: string; path?: string }[];
}
interface Spec {
  title: string;
  file: string;
  line: number;
  tests: { status: 'expected' | 'unexpected' | 'flaky' | 'skipped'; results: Result[] }[];
}
interface Suite {
  specs?: Spec[];
  suites?: Suite[];
}
const specsOf = (s: Suite): Spec[] => [...(s.specs ?? []), ...(s.suites ?? []).flatMap(specsOf)];

/** Build the web app and run Playwright in `dir`; the exit code. */
async function run(dir: string, sha: string): Promise<number> {
  const trees = suiteTrees(dir);
  process.stdout.write('build… ');
  let start = performance.now();
  const built = spawnSync('bun', ['run', '--filter', '@livinglayer/web', 'build'], {
    cwd: dir,
    encoding: 'utf8',
  });
  console.log(`${((performance.now() - start) / 1000).toFixed(1)}s`);
  if (built.status !== 0) {
    console.log(`${built.stdout}${built.stderr}`.trim().split('\n').slice(-30).join('\n'));
    console.log('\n✗ build failed: the suite did not run');
    return 1;
  }
  // The last run's results go; the record of the last pass stays.
  const results = join(out, 'test-results');
  const report = join(out, 'report.json');
  for (const p of [results, report]) rmSync(p, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const [port, cameraPort] = [await freePort(), await freePort()];
  start = performance.now();
  const pw = spawnSync(
    join(dir, 'node_modules', '.bin', 'playwright'),
    ['test', '--reporter=list,json', `--output=${results}`, ...(grep ? ['-g', grep] : [])],
    {
      cwd: dir,
      stdio: 'inherit',
      env: {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_NAME: report,
        BROWSER_PORT: String(port),
        BROWSER_CAMERA_PORT: String(cameraPort),
        FORCE_COLOR: '0',
      },
    },
  );
  const secs = ((performance.now() - start) / 1000).toFixed(1);
  if (!existsSync(report)) {
    console.log(`\n✗ Playwright wrote no report (exit ${pw.status}): see its output above`);
    return 1;
  }
  const specs = specsOf(JSON.parse(readFileSync(report, 'utf8')) as Suite);
  const tests = specs.flatMap((spec) => spec.tests.map((t) => ({ spec, t })));
  const n = (s: string) => tests.filter(({ t }) => t.status === s).length;
  const failed = tests.filter(({ t }) => t.status === 'unexpected');
  const lines = [
    '',
    `${failed.length ? '✗' : '✓'} browser  ${n('expected')}/${tests.length - n('skipped')} passed` +
      `${n('flaky') ? `, ${n('flaky')} flaky` : ''}${n('skipped') ? `, ${n('skipped')} skipped` : ''}` +
      ` on ${here ? 'this checkout' : describeSnapshot(snapshotOf(at))} (${sha}) in ${secs}s`,
  ];
  for (const { spec, t } of failed) {
    const last = t.results.at(-1)!;
    lines.push('', `✗ ${spec.title}  (${spec.file}:${spec.line})`);
    // The worktree is gone by the time anyone reads this, so the trace is read now, from out/.
    const trace = last.attachments?.find((a) => a.name === 'trace')?.path;
    const folder = trace ? join(trace, '..') : undefined;
    lines.push(
      ...(folder
        ? traceSummary(folder, { root: dir })
        : [`  ${(last.error?.message ?? 'no error message').split('\n')[0]}`]
      ).map((l) => `  ${l}`),
    );
    if (folder) lines.push(`  └ bun run trace ${relative(repoRoot, folder)}`);
  }
  if (!failed.length && !grep && pw.status === 0)
    recordPass({ sha, trees, at: new Date().toISOString() });
  console.log(lines.join('\n'));
  return failed.length || pw.status ? 1 : 0;
}

const status = here
  ? await run(repoRoot, `${git(['rev-parse', '--short', 'HEAD']).out.trim()}+disk`)
  : await withWorktree(snapshotOf(at), run);
process.exit(status);
