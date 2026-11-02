/**
 * Committing some hunks of a file that other sessions are editing too
 * (`bun run commit --patch`). The commit is built in a temporary index from
 * HEAD, the patch and any named paths as they are on disk, so the working
 * tree and the real index keep everyone else's changes; HEAD only moves if
 * it is still the commit the patch was made against.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git, repoRoot } from './worktree.js';

/** Where the pre-commit hook finds the paths a commit names. */
export const commitListFile = (cwd = repoRoot) =>
  // Relative in the main checkout, absolute in a linked worktree.
  resolve(cwd, git(['rev-parse', '--git-path', 'livinglayer-commit-paths'], cwd).out.trim());

/** The paths a patch touches, both sides of a rename. */
export function patchPaths(patch: string, cwd = repoRoot): string[] {
  const r = git(['apply', '--numstat', '-z', '-'], cwd, patch);
  if (!r.ok) throw new Error(`the patch can't be read: ${r.err.trim()}`);
  // "added\tdeleted\tpath\0", or "added\tdeleted\t\0from\0to\0" for a rename.
  const fields = r.out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (!f) continue;
    const path = f.split('\t')[2];
    if (path) paths.push(path);
    else paths.push(fields[++i]!, fields[++i]!);
  }
  return [...new Set(paths)];
}

/**
 * The hunks of one file's diff with a changed line containing any of
 * `texts`, as a patch of their own; context lines don't count, since they
 * may be someone else's.
 */
export function hunksMatching(diff: string, texts: string[]) {
  if (/^Binary files /m.test(diff) || /^GIT binary patch$/m.test(diff))
    throw new Error('the file is binary: name it after -- instead');
  const lines = diff.split(/(?<=\n)/);
  const first = lines.findIndex((l) => l.startsWith('@@'));
  if (first < 0) return { patch: '', kept: 0, total: 0 };
  const hunks: string[][] = [];
  for (const l of lines.slice(first)) {
    if (l.startsWith('@@')) hunks.push([]);
    hunks.at(-1)!.push(l);
  }
  const ours = hunks.filter((h) =>
    h.some((l) => /^[-+]/.test(l) && texts.some((t) => l.slice(1).includes(t))),
  );
  return {
    patch: ours.length ? [...lines.slice(0, first), ...ours.flat()].join('') : '',
    kept: ours.length,
    total: hunks.length,
  };
}

export interface PatchCommit {
  /** The commit the patch was made against: HEAD when the commit started. */
  head: string;
  patch: string;
  /** Paths committed whole, as they are on disk. */
  paths: string[];
  messages: string[];
}

/** Run `fn` against a temporary index holding `head` with the patch and paths on it. */
function inIndex<T>(
  { head, patch, paths }: Omit<PatchCommit, 'messages'>,
  cwd: string,
  fn: (run: typeof git, tree: string) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), 'lab-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  const run: typeof git = (args, at = cwd, input) => git(args, at, input, env);
  try {
    const read = run(['read-tree', head]);
    if (!read.ok) throw new Error(`git read-tree failed: ${read.err.trim()}`);
    if (patch) {
      const applied = run(
        ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'],
        cwd,
        patch,
      );
      if (!applied.ok)
        throw new Error(
          `the patch doesn't apply to HEAD (${head.slice(0, 7)}): ${applied.err.trim()}\n` +
            'rebuild it against HEAD (bun run commit --hunks <file> --match <text>)',
        );
    }
    if (paths.length) {
      const added = run(['add', '-A', '--', ...paths]);
      if (!added.ok) throw new Error(`git add failed: ${added.err.trim()}`);
    }
    const tree = run(['write-tree']);
    if (!tree.ok) throw new Error(`git write-tree failed: ${tree.err.trim()}`);
    return fn(run, tree.out.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Refuse a patch that doesn't apply to its HEAD, or that changes nothing. */
export function checkPatchCommit(c: Omit<PatchCommit, 'messages'>, cwd = repoRoot) {
  inIndex(c, cwd, (_, tree) => {
    if (tree === git(['rev-parse', `${c.head}^{tree}`], cwd).out.trim())
      throw new Error('the patch and paths change nothing on HEAD');
  });
}

/**
 * Commit HEAD with the patch and paths on it, refusing if HEAD has moved
 * from `head`. The pre-commit hook runs against the temporary index, as it
 * would for a `git commit`. Afterwards the real index takes the committed
 * versions of these paths, where nobody had staged something else, so it
 * doesn't undo the commit; the working tree isn't touched. Returns the new commit.
 */
export function commitPatch(c: PatchCommit, cwd = repoRoot): string {
  const moved = () =>
    new Error(
      `HEAD moved from ${c.head.slice(0, 7)} meanwhile; nothing was committed, rebuild the patch`,
    );
  if (git(['rev-parse', 'HEAD'], cwd).out.trim() !== c.head) throw moved();
  const touched = [...new Set([...patchPaths(c.patch, cwd), ...c.paths])];
  const commit = inIndex(c, cwd, (run, tree) => {
    const list = commitListFile(cwd);
    writeFileSync(list, `${touched.join('\n')}\n`);
    try {
      const hook = run(['hook', 'run', '--ignore-missing', 'pre-commit']);
      if (!hook.ok) throw new Error(`the pre-commit hook refused it:\n${hook.err.trim()}`);
    } finally {
      rmSync(list, { force: true });
    }
    const made = run(['commit-tree', tree, '-p', c.head, ...c.messages.flatMap((m) => ['-m', m])]);
    if (!made.ok) throw new Error(`git commit-tree failed: ${made.err.trim()}`);
    return made.out.trim();
  });
  // Checked again as it moves, in case another commit landed since.
  const updated = git(
    ['update-ref', '-m', `commit (patch): ${c.messages[0] ?? ''}`, 'HEAD', commit, c.head],
    cwd,
  );
  if (!updated.ok) throw moved();
  syncIndex(c, touched, commit, cwd);
  return commit;
}

/** The blob a path has, in the real index or in a commit ('' for none). */
const blob = (args: string[], p: string, cwd: string) =>
  git([...args, '--format=%(objectname)', '--', p], cwd).out.trim();

function syncIndex(c: PatchCommit, touched: string[], commit: string, cwd: string) {
  for (const p of touched) {
    const staged = blob(['ls-files'], p, cwd);
    const before = blob(['ls-tree', c.head], p, cwd);
    if (staged === before || c.paths.includes(p)) {
      git(['reset', '-q', commit, '--', p], cwd);
      continue;
    }
    // Someone staged their own version: put our hunks on it, or say it now undoes them.
    const applied = git(
      ['apply', '--cached', '--binary', '--whitespace=nowarn', `--include=${p}`, '-'],
      cwd,
      c.patch,
    );
    if (!applied.ok)
      console.warn(
        `commit: ${p} has other staged changes that don't take this patch; ` +
          `the index now undoes it there (git diff --cached -- ${p})`,
      );
  }
}
