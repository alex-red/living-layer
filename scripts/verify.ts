/**
 * Everything worth knowing about a change, in one go and about a minute,
 * with no build and no server: formatting, types, the tests, the benches,
 * and the colour audit of every template. Prints one summary. Fails only on
 * formatting, types or tests; the benches and the audit report, as agreed.
 *
 *   bun run verify
 *   bun run verify --against main     also the room bench at main, and what moved
 *   bun run verify --at staged        HEAD and what is staged, in a clean worktree
 *   bun run verify --at <ref>         a commit (a merge, say) in a clean worktree
 *
 * Run it before committing, and on any merge of another branch. Other
 * sessions may be editing this checkout: `--at` judges exactly the snapshot,
 * whatever else is on disk (`lib/worktree.ts`).
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { flag, parseArgs } from './lib/args.js';
import { snapshotOf, withWorktree } from './lib/worktree.js';

const root = resolve(import.meta.dir, '..');
const args = parseArgs();
const against = flag(args, 'against');
const at = flag(args, 'at');
if (at) {
  // The same verify, run inside the snapshot; captured rooms stay in this checkout's data folder.
  const rest = process.argv.slice(2).filter((a, i, all) => a !== '--at' && all[i - 1] !== '--at');
  const status = await withWorktree(snapshotOf(at), (dir) => {
    const r = spawnSync(
      'bun',
      ['scripts/verify.ts', ...rest.filter((a) => !a.startsWith('--at='))],
      {
        cwd: dir,
        stdio: 'inherit',
        env: { ...process.env, ROOMS_DIR: process.env.ROOMS_DIR ?? join(root, '.data', 'rooms') },
      },
    );
    return r.status ?? 1;
  });
  process.exit(status);
}
interface Step {
  name: string;
  cmd: string[];
  /** Fails the run when it fails; the rest only report. */
  gate: boolean;
  /** One line of what it found, from its output and exit code. */
  read: (out: string, ok: boolean) => string;
  /** Whether what it found needs a look, for report-only steps. */
  look?: (out: string) => boolean;
}
const count = (out: string, pattern: RegExp) => (out.match(pattern) ?? []).length;
const steps: Step[] = [
  {
    name: 'format',
    cmd: ['bun', 'run', 'format:check'],
    gate: true,
    read: (_, ok) => (ok ? 'clean' : 'needs `bun run format`'),
  },
  {
    name: 'types',
    cmd: ['bun', 'run', 'typecheck'],
    gate: true,
    read: (out, ok) => (ok ? 'clean' : `${count(out, /error TS/g)} errors`),
  },
  {
    name: 'tests',
    cmd: ['bun', 'test'],
    gate: true,
    read: (out) =>
      `${/(\d+) pass/.exec(out)?.[1] ?? '?'} pass, ${/(\d+) fail/.exec(out)?.[1] ?? '?'} fail`,
  },
  {
    name: 'room bench',
    cmd: ['bun', 'scripts/room-bench.ts'],
    gate: false,
    read: (out) =>
      `${count(out, /← below target$/gm)} misses, ${count(out, /\(known gap\)/g)} known gaps`,
    look: (out) => /← below target$/m.test(out),
  },
  {
    name: 'fit bench',
    cmd: ['bun', 'scripts/fit-bench.ts'],
    gate: false,
    read: (out) =>
      `${count(out, /← below target$/gm)} misses, ${count(out, /\(known gap\)/g)} known gaps`,
    look: (out) => /← below target$/m.test(out),
  },
  {
    name: 'rooms bench',
    cmd: ['bun', 'scripts/rooms-bench.ts'],
    gate: false,
    read: (out) =>
      /No captured rooms/.test(out)
        ? 'none captured'
        : `${count(out, /← below target$/gm)} rooms moved`,
    look: (out) => /← below target$/m.test(out),
  },
  {
    name: 'brush bench',
    cmd: ['bun', 'scripts/brush-bench.ts'],
    gate: false,
    read: (out) =>
      /has marked points/.test(out)
        ? 'no marked rooms'
        : `${count(out, /← below target$/gm)} misses, ${count(out, /\(known gap\)/g)} known gaps`,
    look: (out) => /← below target$/m.test(out),
  },
  {
    name: 'colour audit',
    cmd: ['bun', 'scripts/prop-sheet.ts', '--turns', '0', '--audit'],
    gate: false,
    read: (out) => `${count(out, /← specks: look/g)} templates with specks`,
    look: (out) => /← specks: look/.test(out),
  },
  ...(against
    ? [
        {
          name: `room vs ${against}`,
          cmd: ['bun', 'scripts/bench-at.ts', against, 'room'],
          gate: false,
          read: (out: string) =>
            `${count(out, /REGRESSION/g)} regressions, ${count(out, /← fixed/g)} fixed`,
          look: (out: string) => /REGRESSION/.test(out),
        },
      ]
    : []),
];

let failed = 0;
const lines: string[] = [];
for (const step of steps) {
  process.stdout.write(`${step.name}… `);
  const start = performance.now();
  const r = spawnSync(step.cmd[0]!, step.cmd.slice(1), { cwd: root, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const ok = r.status === 0;
  const s = ((performance.now() - start) / 1000).toFixed(1);
  const look = step.gate ? !ok : (step.look?.(out) ?? false);
  if (step.gate && !ok) failed++;
  console.log(`${s}s`);
  lines.push(
    `${(look ? (step.gate ? '✗' : '!') : '✓').padEnd(2)} ${step.name.padEnd(16)} ${step.read(out, ok).padEnd(34)} ${s}s`,
  );
  if (look) lines.push(`   └ run \`${step.cmd.join(' ')}\` to see it`);
}
console.log(`\n${lines.join('\n')}`);
console.log('\n✗ fails the run · ! reported, not failing (benches and audit) · ✓ fine');
process.exit(failed ? 1 : 0);
