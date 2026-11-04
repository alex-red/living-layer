/**
 * The web demo's seed, for a static build (GitHub Pages): a fresh demo as the
 * lab server answers it, offline, from an empty data folder of its own.
 *
 *   bun run static-demo        writes apps/web/public/static-demo/seed.json
 *   VITE_STATIC_DEMO=1 VITE_BASE=/living-layer/ bun run --filter @livinglayer/web build
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig } from '../apps/server/src/config.js';
import { captureSeed } from './lib/static-demo-seed.js';

const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-static-demo-'));
const app = await buildApp(parseConfig({ DATA_DIR: dataDir }), { serveWeb: false, vision: null });
try {
  const seed = await captureSeed(app);
  const out = resolve(import.meta.dir, '../apps/web/public/static-demo');
  mkdirSync(out, { recursive: true });
  const json = JSON.stringify(seed);
  writeFileSync(join(out, 'seed.json'), json);
  console.log(
    `Saved the demo's seed: ${Object.keys(seed.get).length} answers, ${(json.length / 1024).toFixed(0)} KB, in ${out}/seed.json`,
  );
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
