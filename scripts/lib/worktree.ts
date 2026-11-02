/**
 * A commit, or a commit with changes on top, checked out in a throwaway
 * worktree: somewhere to judge a change that other sessions editing this
 * checkout can't reach ([plan](../../docs/plans/agent-tooling.md#a-clean-snapshots-blocks-1-2)).
 * The worktree gets its own `bun install` by default, because one that
 * borrows this checkout's node_modules resolves @livinglayer/domain back to
 * this tree and quietly runs the new code. It is always removed afterwards.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dir, '..', '..');

/**
 * What to check out: a commit as it is, or with this checkout's staged
 * changes, or some paths as they are now, after a patch of hunks if given.
 */
export type Snapshot =
  | { ref: string }
  | { ref: string; staged: true }
  | { ref: string; paths: string[]; patch?: string };

/** `--at <ref>`, `--at staged` (HEAD and the index): a snapshot from a flag's value. */
export const snapshotOf = (at: string): Snapshot =>
  at === 'staged' ? { ref: 'HEAD', staged: true } : { ref: at };

export const describeSnapshot = (s: Snapshot) =>
  'staged' in s
    ? `${s.ref} and what is staged`
    : 'paths' in s
      ? `${s.ref} ${s.patch ? 'with a patch and' : 'and'} ${s.paths.length} path(s) as they are now`
      : s.ref;

export function git(args: string[], cwd = repoRoot, input?: string, env?: Record<string, string>) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    maxBuffer: 256 << 20,
    env: env && { ...process.env, ...env },
  });
  return { ok: r.status === 0, code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * The changes a snapshot puts on top of its commit, as a binary patch: the
 * index against the commit, or the patch given and the named paths as they
 * are on disk, new files included. Empty when there is nothing on top.
 */
export function snapshotPatch(s: Snapshot, cwd = repoRoot): string {
  if ('staged' in s) return git(['diff', '--binary', '--cached', s.ref], cwd).out;
  if (!('paths' in s)) return '';
  // No paths would mean the whole tree to `git diff`.
  if (!s.paths.length) return s.patch ?? '';
  const tracked = new Set(
    git(['ls-files', '-z', '--', ...s.paths], cwd)
      .out.split('\0')
      .filter(Boolean),
  );
  // Tracked paths (changed or deleted) diff against the commit; new files against nothing.
  let patch = (s.patch ?? '') + git(['diff', '--binary', s.ref, '--', ...s.paths], cwd).out;
  for (const p of s.paths)
    if (!tracked.has(p) && existsSync(join(cwd, p)))
      // --no-index exits 1 when the files differ, which they always do here.
      patch += git(['diff', '--binary', '--no-index', '--', '/dev/null', p], cwd).out;
  return patch;
}

export interface WorktreeOptions {
  /** Install dependencies in it (default true): needed for anything that imports the workspace's packages. */
  install?: boolean;
  /** Say what it is doing on stderr (default true). */
  log?: boolean;
  cwd?: string;
}

/** Run `fn` in a fresh worktree of the snapshot, removed afterwards whatever happens. */
export async function withWorktree<T>(
  s: Snapshot,
  fn: (dir: string, sha: string) => Promise<T> | T,
  { install = true, log = true, cwd = repoRoot }: WorktreeOptions = {},
): Promise<T> {
  const sha = git(['rev-parse', '--short', s.ref], cwd);
  if (!sha.ok) throw new Error(`No commit "${s.ref}"`);
  const short = sha.out.trim();
  // The patch is read before the worktree exists, so it is this checkout's as of now.
  const patch = snapshotPatch(s, cwd);
  const dir = mkdtempSync(join(tmpdir(), `lab-${short}-`));
  const say = (m: string) => log && process.stderr.write(`${m}\n`);
  try {
    say(`worktree: ${describeSnapshot(s)} (${short}) in ${dir}`);
    const added = git(['worktree', 'add', '--detach', dir, short], cwd);
    if (!added.ok) throw new Error(`git worktree add failed: ${added.err.trim()}`);
    if (patch) {
      const applied = git(['apply', '--binary', '--whitespace=nowarn', '-'], dir, patch);
      if (!applied.ok)
        throw new Error(`The changes didn't apply on ${short}: ${applied.err.trim()}`);
    }
    if (install) {
      say('worktree: bun install');
      const r = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`bun install failed:\n${r.stderr}`);
    }
    return await fn(dir, short);
  } finally {
    git(['worktree', 'remove', '--force', dir], cwd);
    rmSync(dir, { recursive: true, force: true });
    git(['worktree', 'prune'], cwd);
  }
}
