/**
 * Commit exactly the files named, checked first, in one step
 * ([plan](../docs/plans/agent-tooling.md#a-clean-snapshots-blocks-1-2)).
 * This checkout is shared by several sessions: something staged and left
 * waiting can land in another session's commit, and `verify` on disk judges
 * their half-done edits too. So this runs `verify` on HEAD with only the
 * named paths as they are now, in a clean worktree, then stages and commits
 * just those paths (`git commit --only`), leaving anything else staged alone.
 * The pre-commit hook (`.githooks/pre-commit`) refuses commits made any
 * other way, unless `COMMIT_ANY=1`.
 *
 *   bun run commit -m "fix: summary" [-m "body"] -- <path>…
 *   bun run commit --skip-verify -m "docs: …" -- docs/plans/x.md   for a change verify can't judge
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, repoRoot as root, snapshotPatch, withWorktree } from './lib/worktree.js';

/** Where the hook finds the paths this commit names. */
const listFile = () =>
  // Relative in the main checkout, absolute in a linked worktree.
  resolve(root, git(['rev-parse', '--git-path', 'livinglayer-commit-paths']).out.trim());
/** Conventional Commits summaries stay under about 60 characters; past this, refuse. */
const SUMMARY_MAX = 72;

function fail(message: string): never {
  console.error(`commit: ${message}`);
  process.exit(1);
}

const messages: string[] = [];
const paths: string[] = [];
let skipVerify = false;
const argv = process.argv.slice(2);
for (let i = 0, rest = false; i < argv.length; i++) {
  const a = argv[i]!;
  if (rest) paths.push(a);
  else if (a === '--') rest = true;
  else if (a === '-m' || a === '--message') messages.push(argv[++i] ?? fail('-m needs a message'));
  else if (a === '--skip-verify') skipVerify = true;
  else if (a.startsWith('-')) fail(`unknown option ${a}`);
  else paths.push(a);
}

const summary = messages[0]?.trim();
if (!summary) fail('give a message: -m "fix: what changed"');
if (summary.length > SUMMARY_MAX)
  fail(
    `the summary is ${summary.length} characters; keep it under about 60 and put the rest in a body (-m again)`,
  );
if (summary.length > 60)
  console.warn(`commit: the summary is ${summary.length} characters; about 60 is the aim`);
if (!paths.length) fail('name the files to commit, after --');
const tracked = new Set(
  git(['ls-files', '-z', '--', ...paths])
    .out.split('\0')
    .filter(Boolean),
);
for (const p of paths) {
  if (p === '.' || p === '-A' || p === '*') fail(`name files, not "${p}"`);
  const there = existsSync(join(root, p));
  if (there && statSync(join(root, p)).isDirectory()) fail(`${p} is a folder: name its files`);
  if (!there && !tracked.has(p)) fail(`${p} is neither on disk nor in the repository`);
}
const changed = new Set(
  git(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--', ...paths])
    .out.split('\0')
    .filter(Boolean)
    .map((l) => l.slice(3)),
);
const unchanged = paths.filter((p) => !changed.has(p));
if (unchanged.length) fail(`nothing to commit in ${unchanged.join(', ')}`);

const snapshot = { ref: 'HEAD', paths };
const before = snapshotPatch(snapshot);
if (skipVerify) console.log('commit: verify skipped (--skip-verify)');
else {
  const status = await withWorktree(snapshot, (dir) => {
    const r = spawnSync('bun', ['scripts/verify.ts'], {
      cwd: dir,
      stdio: 'inherit',
      env: { ...process.env, ROOMS_DIR: process.env.ROOMS_DIR ?? join(root, '.data', 'rooms') },
    });
    return r.status ?? 1;
  });
  if (status !== 0) fail('verify failed; nothing was committed');
  // What was verified is what gets committed: refuse if the files moved meanwhile.
  if (snapshotPatch(snapshot) !== before)
    fail('the named files changed while verify ran; nothing was committed, run it again');
}

writeFileSync(listFile(), `${paths.join('\n')}\n`);
try {
  const added = git(['add', '-A', '--', ...paths]);
  if (!added.ok) fail(`git add failed: ${added.err.trim()}`);
  const r = spawnSync(
    'git',
    ['commit', '--only', ...messages.flatMap((m) => ['-m', m]), '--', ...paths],
    { cwd: root, stdio: 'inherit' },
  );
  if (r.status !== 0) fail('git commit failed');
} finally {
  rmSync(listFile(), { force: true });
}
console.log(git(['log', '--oneline', '-1']).out.trim());
