/**
 * Run a bench at another commit and compare this tree against it: the
 * baseline for "did my change move anything". The commit is checked out in
 * a temporary worktree with its own `bun install` (`lib/worktree.ts`), so
 * nothing in this checkout is touched.
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
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { repoRoot as root, withWorktree } from './lib/worktree.js';

const [ref = 'HEAD', bench = 'room', ...rest] = process.argv.slice(2);
if (!['fit', 'room', 'rooms'].includes(bench))
  throw new Error(`Bench is "room", "rooms" or "fit", not "${bench}"`);
// Captured rooms are local, in this checkout's data folder: the other commit reads them here.
process.env.ROOMS_DIR ??= join(resolve(root, process.env.DATA_DIR ?? '.data'), 'rooms');
const script = `scripts/${bench}-bench.ts`;
const run = (args: string[], cwd: string) =>
  spawnSync('bun', args, { cwd, stdio: 'inherit' }).status ?? 1;

await withWorktree({ ref }, (tree, short) => {
  console.log(`${bench} bench at ${ref} (${short})`);
  if (!existsSync(join(tree, script))) throw new Error(`${script} doesn't exist at ${short}`);
  const baseline = join(root, 'out', `${bench}-${short}.json`);
  const json = existsSync(join(tree, 'scripts/lib/bench.ts'));
  run([script, ...(json ? ['--json', baseline] : [])], tree);
  if (!json) {
    console.log(`\n${short} predates the shared reporter, so there's no baseline to compare with.`);
    console.log('This tree, to read side by side:\n');
    process.exitCode = run([script, ...rest], root);
  } else {
    console.log(`\nThis tree against ${short}:\n`);
    process.exitCode = run([script, '--compare', baseline, ...rest], root);
  }
});
