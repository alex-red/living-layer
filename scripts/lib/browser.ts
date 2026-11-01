/**
 * When the browser suite last passed, and whether what it covers has changed
 * since ([plan](../../docs/plans/agent-tooling.md#b-the-browser-suite-as-a-normal-check-blocks-2-3-9)).
 * `bun run browser` records a full pass; plain `verify` warns when
 * `apps/web` or `tests/browser` differ from what passed. Trees are compared
 * by content, as git hashes them, so a commit of the same files still counts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './worktree.js';

/** What the suite covers, for "has it changed since it passed". */
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

export function lastPass(out = browserOut()): SuitePass | null {
  try {
    return JSON.parse(readFileSync(passFile(out), 'utf8')) as SuitePass;
  } catch {
    return null;
  }
}

export function recordPass(pass: SuitePass, out = browserOut()) {
  mkdirSync(out, { recursive: true });
  writeFileSync(passFile(out), `${JSON.stringify(pass, null, 2)}\n`);
}

/**
 * Which suite paths differ from the last pass, for `cwd` as it is now; null
 * when they match. A missing record counts as all of them changed.
 */
export function changedSinceSuitePassed(
  cwd = repoRoot,
  out = browserOut(),
): { pass: SuitePass | null; changed: string[] } | null {
  const pass = lastPass(out);
  const now = suiteTrees(cwd);
  const changed = SUITE_PATHS.filter((p) => pass?.trees[p] !== now[p]);
  return changed.length ? { pass, changed } : null;
}

/** "abc1234, 3 h ago": a pass, briefly. */
export function describePass(pass: SuitePass, now = Date.now()) {
  const mins = Math.round((now - Date.parse(pass.at)) / 60_000);
  const ago =
    mins < 60
      ? `${mins} min ago`
      : mins < 48 * 60
        ? `${Math.round(mins / 60)} h ago`
        : `${Math.round(mins / 1440)} d ago`;
  return `${pass.sha}, ${ago}`;
}
