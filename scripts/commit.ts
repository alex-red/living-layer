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
 * When another session is editing the same file, `--patch` commits only
 * some hunks of it: HEAD with the patch on top is verified and committed
 * through a temporary index, leaving the working tree and the real index as
 * they are (`lib/patch-commit.ts`). `--hunks` writes such a patch to review.
 *
 *   bun run commit -m "fix: summary" [-m "body"] -- <path>…
 *   bun run commit --skip-verify -m "docs: …" -- docs/plans/x.md   for a change verify can't judge
 *   bun run commit --hunks docs/x.md --match "my words" [--match …]   writes out/docs/x.md.patch
 *   bun run commit -m "docs: …" --patch out/docs/x.md.patch [-- <path>…]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { browserOut } from './lib/browser.js';
import {
  checkPatchCommit,
  commitListFile,
  commitPatch,
  hunksMatching,
  patchPaths,
} from './lib/patch-commit.js';
import { git, repoRoot as root, snapshotPatch, withWorktree } from './lib/worktree.js';
/** Conventional Commits summaries stay under about 60 characters; past this, refuse. */
const SUMMARY_MAX = 72;

function fail(message: string): never {
  console.error(`commit: ${message}`);
  process.exit(1);
}

const messages: string[] = [];
const paths: string[] = [];
const matches: string[] = [];
let skipVerify = false;
let patchFile: string | undefined;
let hunksOf: string | undefined;
const argv = process.argv.slice(2);
for (let i = 0, rest = false; i < argv.length; i++) {
  const a = argv[i]!;
  if (rest) paths.push(a);
  else if (a === '--') rest = true;
  else if (a === '-m' || a === '--message') messages.push(argv[++i] ?? fail('-m needs a message'));
  else if (a === '--skip-verify') skipVerify = true;
  else if (a === '--patch') patchFile = argv[++i] ?? fail('--patch needs a file');
  else if (a === '--hunks') hunksOf = argv[++i] ?? fail('--hunks needs a file');
  else if (a === '--match') matches.push(argv[++i] ?? fail('--match needs some text'));
  else if (a.startsWith('-')) fail(`unknown option ${a}`);
  else paths.push(a);
}

if (hunksOf !== undefined) {
  if (!matches.length) fail('say which hunks: --match <text>');
  const file = relative(root, join(root, hunksOf));
  if (!git(['ls-files', '--error-unmatch', '--', file]).ok)
    fail(`${file} isn't in the repository: commit it whole, after --`);
  // One line of context keeps a neighbour's change a few lines away in a hunk of its own.
  const diff = git(['diff', '--binary', '-U1', 'HEAD', '--', file]).out;
  let found: ReturnType<typeof hunksMatching>;
  try {
    found = hunksMatching(diff, matches);
  } catch (e) {
    fail(`${file}: ${(e as Error).message}`);
  }
  if (!found.kept) fail(`none of ${file}'s ${found.total} hunk(s) changes a line with that text`);
  const out = join(root, 'out', `${file}.patch`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, found.patch);
  console.log(
    `commit: ${found.kept} of ${found.total} hunk(s) of ${file} in ${relative(root, out)}`,
  );
  console.log(`look at it, then: bun run commit -m "…" --patch ${relative(root, out)}`);
  process.exit(0);
}

const summary = messages[0]?.trim();
if (!summary) fail('give a message: -m "fix: what changed"');
if (summary.length > SUMMARY_MAX)
  fail(
    `the summary is ${summary.length} characters; keep it under about 60 and put the rest in a body (-m again)`,
  );
if (summary.length > 60)
  console.warn(`commit: the summary is ${summary.length} characters; about 60 is the aim`);
if (!paths.length && !patchFile) fail('name the files to commit, after --');
const patch = patchFile === undefined ? undefined : readPatch(patchFile);
const head = git(['rev-parse', 'HEAD']).out.trim();
if (patch !== undefined) {
  const both = paths.filter((p) => patchPaths(patch, root).includes(p));
  if (both.length) fail(`${both.join(', ')} is in the patch and named too: pick one`);
}
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
  !paths.length
    ? []
    : git(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--', ...paths])
        .out.split('\0')
        .filter(Boolean)
        .map((l) => l.slice(3)),
);
const unchanged = paths.filter((p) => !changed.has(p));
if (unchanged.length) fail(`nothing to commit in ${unchanged.join(', ')}`);

const snapshot = patch === undefined ? { ref: 'HEAD', paths } : { ref: head, paths, patch };
if (patch !== undefined)
  try {
    checkPatchCommit({ head, patch, paths });
  } catch (e) {
    fail((e as Error).message);
  }
const before = snapshotPatch(snapshot);
if (skipVerify) console.log('commit: verify skipped (--skip-verify)');
else {
  const status = await withWorktree(snapshot, (dir) => {
    const r = spawnSync('bun', ['scripts/verify.ts'], {
      cwd: dir,
      stdio: 'inherit',
      env: {
        ...process.env,
        ROOMS_DIR: process.env.ROOMS_DIR ?? join(root, '.data', 'rooms'),
        BROWSER_OUT: browserOut(root),
      },
    });
    return r.status ?? 1;
  });
  if (status !== 0) fail('verify failed; nothing was committed');
  // What was verified is what gets committed: refuse if the files moved meanwhile.
  if (snapshotPatch(snapshot) !== before)
    fail('the named files changed while verify ran; nothing was committed, run it again');
}

if (patch !== undefined) {
  try {
    commitPatch({ head, patch, paths, messages });
  } catch (e) {
    fail((e as Error).message);
  }
  console.log(git(['log', '--oneline', '-1']).out.trim());
  process.exit(0);
}

writeFileSync(commitListFile(), `${paths.join('\n')}\n`);
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
  rmSync(commitListFile(), { force: true });
}
console.log(git(['log', '--oneline', '-1']).out.trim());

function readPatch(file: string): string {
  if (!existsSync(file)) fail(`no patch at ${file}`);
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) fail(`${file} is empty`);
  try {
    patchPaths(text, root);
  } catch (e) {
    fail(`${file}: ${(e as Error).message}`);
  }
  return text;
}
