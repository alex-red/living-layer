/**
 * When the browser suite last passed. `bun run browser` records a full pass
 * (`out/browser/last-pass.json`). The suite is manual for now: nothing else
 * runs it or warns when it is stale. Trees are hashed by content, as git does.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './worktree.js';

/** What the suite covers, hashed into each recorded pass. */
export const SUITE_PATHS = ['apps/web', 'tests/browser'] as const;

/** Where `bun run browser` keeps its report, test results and the last pass. */
export const browserOut = (root = repoRoot) =>
  process.env.BROWSER_OUT ?? join(root, 'out', 'browser');

export interface SuitePass {
  /** The commit it ran on (with changes on top when `trees` says so). */
  sha: string;
  /** The git tree hash of each of `SUITE_PATHS` as it ran. */
  trees: Record<string, string>;
  at: string;
}

/**
 * The tree hash of each suite path as it is on disk in `cwd`, unstaged and
 * new files included. It uses a throwaway index, so the checkout's own index
 * (another session's staging) is left alone.
 */
export function suiteTrees(cwd = repoRoot): Record<string, string> {
  const index = join(tmpdir(), `lab-suite-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd, env });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`);
    return r.stdout.toString().trim();
  };
  try {
    run(['read-tree', 'HEAD']);
    run(['add', '-A', '--', ...SUITE_PATHS]);
    return Object.fromEntries(SUITE_PATHS.map((p) => [p, run(['write-tree', `--prefix=${p}/`])]));
  } finally {
    rmSync(index, { force: true });
  }
}

const passFile = (out: string) => join(out, 'last-pass.json');

export function recordPass(pass: SuitePass, out = browserOut()) {
  mkdirSync(out, { recursive: true });
  writeFileSync(passFile(out), `${JSON.stringify(pass, null, 2)}\n`);
}
