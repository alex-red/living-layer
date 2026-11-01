import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const env = {
  ...process.env,
  PATH: `${resolve(root, 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
};

const t0 = performance.now();
const r = spawnSync('tsrs', ['--noEmit', '--fast'], { cwd: root, env });

if (r.status !== 0) {
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) console.error(r.error);
  process.exit(r.status ?? 1);
}

const s = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`types clean (${s}s)`);
