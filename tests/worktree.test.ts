import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, withWorktree } from '../scripts/lib/worktree.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A repo with one commit of `a.txt` and `gone.txt`, then edits on disk and in the index. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'lab-worktree-test-'));
  dirs.push(dir);
  const g = (...args: string[]) => expect(git(args, dir).ok).toBe(true);
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, 'gone.txt'), 'bye\n');
  g('add', '.');
  g('commit', '-q', '-m', 'first');
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  writeFileSync(join(dir, 'new.txt'), 'fresh\n');
  rmSync(join(dir, 'gone.txt'));
  // Someone else's work: staged, but not named below.
  writeFileSync(join(dir, 'theirs.txt'), 'not mine\n');
  g('add', 'theirs.txt');
  return dir;
}
const read = (dir: string, f: string) =>
  existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null;
const opts = (cwd: string) => ({ cwd, install: false, log: false });

describe('snapshots in a throwaway worktree', () => {
  it('puts the named paths on the commit as they are on disk, new and deleted ones too', async () => {
    const dir = repo();
    const seen = await withWorktree(
      { ref: 'HEAD', paths: ['a.txt', 'new.txt', 'gone.txt'] },
      (tree) => ['a.txt', 'new.txt', 'gone.txt', 'theirs.txt'].map((f) => read(tree, f)),
      opts(dir),
    );
    expect(seen).toEqual(['two\n', 'fresh\n', null, null]);
  });

  it('puts only what is staged on the commit', async () => {
    const dir = repo();
    const seen = await withWorktree(
      { ref: 'HEAD', staged: true },
      (tree) => ['a.txt', 'theirs.txt'].map((f) => read(tree, f)),
      opts(dir),
    );
    expect(seen).toEqual(['one\n', 'not mine\n']);
  });

  it('removes the worktree afterwards, even when the work fails', async () => {
    const dir = repo();
    let tree = '';
    await expect(
      withWorktree(
        { ref: 'HEAD' },
        (t) => {
          tree = t;
          throw new Error('broke');
        },
        opts(dir),
      ),
    ).rejects.toThrow('broke');
    expect(existsSync(tree)).toBe(false);
    expect(git(['worktree', 'list'], dir).out.trim().split('\n')).toHaveLength(1);
  });
});
