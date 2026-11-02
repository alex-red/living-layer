import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkPatchCommit,
  commitPatch,
  hunksMatching,
  patchPaths,
} from '../scripts/lib/patch-commit.js';
import { git, withWorktree } from '../scripts/lib/worktree.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
const text = (edit: (l: string[]) => void) => {
  const l = [...lines];
  edit(l);
  return `${l.join('\n')}\n`;
};
/**
 * A repo with one commit of `doc.md`, then on disk our edit (line 15) and
 * another session's (line 3) in it, and their `theirs.txt` staged. Its hooks
 * are this repository's own.
 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'lab-patch-test-'));
  dirs.push(dir);
  const g = (...args: string[]) => expect(git(args, dir).ok).toBe(true);
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'core.hooksPath', resolve(import.meta.dir, '..', '.githooks'));
  writeFileSync(
    join(dir, 'doc.md'),
    text(() => {}),
  );
  g('add', '.');
  expect(git(['commit', '-q', '-m', 'first'], dir, undefined, { COMMIT_ANY: '1' }).ok).toBe(true);
  writeFileSync(
    join(dir, 'doc.md'),
    text((l) => {
      l[2] = 'their line';
      l[14] = 'our line';
    }),
  );
  writeFileSync(join(dir, 'theirs.txt'), 'not mine\n');
  g('add', 'theirs.txt');
  const head = git(['rev-parse', 'HEAD'], dir).out.trim();
  const diff = git(['diff', '-U1', 'HEAD', '--', 'doc.md'], dir).out;
  return { dir, head, ...hunksMatching(diff, ['our line']) };
}
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');
const show = (dir: string, spec: string) => git(['show', spec], dir).out;

describe('committing some hunks of a file', () => {
  it('picks the hunks whose changed lines match', () => {
    const { patch, kept, total, dir } = repo();
    expect([kept, total]).toEqual([1, 2]);
    expect(patch).toContain('+our line');
    expect(patch).not.toContain('their line');
    expect(patchPaths(patch, dir)).toEqual(['doc.md']);
  });

  it('verifies HEAD with just the patch on it', async () => {
    const { dir, head, patch } = repo();
    const seen = await withWorktree({ ref: head, paths: [], patch }, (t) => read(t, 'doc.md'), {
      cwd: dir,
      install: false,
      log: false,
    });
    expect(seen).toBe(text((l) => (l[14] = 'our line')));
  });

  it('commits only our hunk, past the hook, and leaves everyone else as they were', () => {
    const { dir, head, patch } = repo();
    const commit = commitPatch({ head, patch, paths: [], messages: ['docs: ours'] }, dir);
    expect(git(['rev-parse', 'HEAD'], dir).out.trim()).toBe(commit);
    expect(show(dir, 'HEAD:doc.md')).toBe(text((l) => (l[14] = 'our line')));
    expect(git(['diff', '--name-only', 'HEAD~1', 'HEAD'], dir).out).toBe('doc.md\n');
    // Their hunk is still on disk, unstaged; their staged file is still staged.
    expect(read(dir, 'doc.md')).toContain('their line');
    expect(git(['diff', '--cached', '--name-only'], dir).out).toBe('theirs.txt\n');
    const left = git(['diff', '--', 'doc.md'], dir).out;
    expect(left).toContain('+their line');
    expect(left).not.toContain('our line');
  });

  it('puts our hunk on a version of the file someone else staged', () => {
    const { dir, head, patch } = repo();
    writeFileSync(
      join(dir, 'doc.md'),
      text((l) => (l[2] = 'their line')),
    );
    expect(git(['add', 'doc.md'], dir).ok).toBe(true);
    writeFileSync(
      join(dir, 'doc.md'),
      text((l) => {
        l[2] = 'their line';
        l[14] = 'our line';
      }),
    );
    commitPatch({ head, patch, paths: [], messages: ['docs: ours'] }, dir);
    const staged = git(['diff', '--cached', '--', 'doc.md'], dir).out;
    expect(staged).toContain('+their line');
    expect(staged).not.toContain('our line');
  });

  it("refuses a patch that doesn't apply to HEAD", () => {
    const { dir, head } = repo();
    const stale = hunksMatching(
      git(['diff', '-U1', 'HEAD', '--', 'doc.md'], dir).out.replace(/line 16/g, 'line sixteen'),
      ['our line'],
    ).patch;
    expect(() => checkPatchCommit({ head, patch: stale, paths: [] }, dir)).toThrow(
      "doesn't apply to HEAD",
    );
  });

  it('refuses when HEAD moved meanwhile, and commits nothing', () => {
    const { dir, head, patch } = repo();
    writeFileSync(join(dir, 'other.txt'), 'x\n');
    git(['add', 'other.txt'], dir);
    git(['commit', '-q', '-m', 'meanwhile'], dir, undefined, { COMMIT_ANY: '1' });
    const moved = git(['rev-parse', 'HEAD'], dir).out.trim();
    expect(() => commitPatch({ head, patch, paths: [], messages: ['docs: ours'] }, dir)).toThrow(
      'HEAD moved',
    );
    expect(git(['rev-parse', 'HEAD'], dir).out.trim()).toBe(moved);
  });
});
