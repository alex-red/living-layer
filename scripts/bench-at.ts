/**
 * Run a bench at another commit and compare this tree against it: the
 * baseline for "did my change move anything". The commit is checked out in
 * a temporary worktree with its own `bun install`, because a worktree that
 * borrows this checkout's node_modules resolves @livinglayer/domain back to
 * this tree and quietly measures the new code twice. Nothing in this
 * checkout is touched; the worktree is removed afterwards.
 *
 *   bun run bench:at HEAD                  room bench at HEAD, then this tree against it
 *   bun run bench:at main fit              the fit bench
 *   bun run bench:at HEAD rooms            the captured real rooms (local, see draft.ts)
 *   bun run bench:at HEAD~3 room --set desk.topCm=4,5
 *                                          extra flags go to this tree's run
 *
 * Commits from before the shared bench reporter can't write JSON: their own
 * table is printed instead, to read side by side.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const [ref = 'HEAD', bench = 'room', ...rest] = process.argv.slice(2);
if (!['fit', 'room', 'rooms'].includes(bench))
  throw new Error(`Bench is "room", "rooms" or "fit", not "${bench}"`);
// Captured rooms are local, in this checkout's data folder: the other commit reads them here.
process.env.ROOMS_DIR ??= join(resolve(root, process.env.DATA_DIR ?? '.data'), 'rooms');
const script = `scripts/${bench}-bench.ts`;
const run = (cmd: string, args: string[], cwd: string, quiet = false) => {
  const r = spawnSync(cmd, args, { cwd, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (r.status !== 0 && quiet) process.stderr.write(r.stderr ?? '');
  return r.status ?? 1;
};

const sha = spawnSync('git', ['rev-parse', '--short', ref], { cwd: root, encoding: 'utf8' });
if (sha.status !== 0) throw new Error(`No commit "${ref}"`);
const short = sha.stdout.trim();
const baseline = join(root, 'out', `${bench}-${short}.json`);
const tree = mkdtempSync(join(tmpdir(), `bench-${short}-`));
try {
  console.log(`${bench} bench at ${ref} (${short}) in ${tree}`);
  if (run('git', ['worktree', 'add', '--detach', tree, short], root, true))
    throw new Error('git worktree add failed');
  if (run('bun', ['install', '--frozen-lockfile'], tree, true))
    throw new Error('bun install failed');
  if (!existsSync(join(tree, script))) throw new Error(`${script} doesn't exist at ${short}`);
  const json = existsSync(join(tree, 'scripts/lib/bench.ts'));
  run('bun', [script, ...(json ? ['--json', baseline] : [])], tree);
  if (!json) {
    console.log(`\n${short} predates the shared reporter, so there's no baseline to compare with.`);
    console.log('This tree, to read side by side:\n');
    process.exitCode = run('bun', [script, ...rest], root);
  } else {
    console.log(`\nThis tree against ${short}:\n`);
    process.exitCode = run('bun', [script, '--compare', baseline, ...rest], root);
  }
} finally {
  run('git', ['worktree', 'remove', '--force', tree], root, true);
  rmSync(tree, { recursive: true, force: true });
}
