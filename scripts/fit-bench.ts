/**
 * How closely fitted models match their photos. Runs the fitter on a fixed
 * set of crops and prints silhouette overlap (IoU) and colour error (OKLab
 * ΔE) per case, so a change to the fitter or kernel shows whether accuracy
 * moved. Exits non-zero when a synthetic or demo turned body misses
 * IoU ≥ 0.9 or ΔE ≤ 8. Real crops are reported against the same targets but
 * don't fail the run: the only ones so far are a mug that isn't rotationally
 * symmetric, a known gap for a model made of turned bodies.
 *
 * Cases:
 * - synthetic: known models drawn from known camera angles, lit from one side;
 * - the demo: the illustrated desk's mug, cut out by its SAM mask;
 * - real crops: any `testdata/items/<name>.png` (a masked RGBA crop) with a
 *   `<name>.json` of `{ "label", "archetype", "elevation"? }` beside it.
 *
 *   bun scripts/fit-bench.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  ARCHETYPE_FAMILY,
  buildItem,
  defaultFit,
  fitItem,
  syntheticCrop,
  type Archetype,
  type FitInput,
  type LatheFit,
} from '@livinglayer/domain';
import { maskedCrop } from '../apps/server/src/images.js';
import { demoSegmentation } from '../apps/server/src/demo.js';

const root = resolve(import.meta.dir, '..');
interface Case {
  name: string;
  input: FitInput;
  source: 'synthetic' | 'demo' | 'real';
}
const cases: Case[] = [];
const synthetic = (
  name: string,
  archetype: Archetype,
  colours: string[],
  elevation: number,
  change: (fit: ReturnType<typeof defaultFit>) => void = () => {},
) => {
  const fit = defaultFit(archetype, colours);
  change(fit);
  const crop = syntheticCrop(buildItem(name, fit), { elevation, ppu: 150 });
  cases.push({ name, source: 'synthetic', input: { ...crop, label: name, archetype } });
};
synthetic('cream mug 30°', 'mug', ['#ece5d0', '#5a3d2b'], 30);
synthetic('blue banded mug 45°', 'mug', ['#2f5d8c', '#3b2416'], 45, (f) => {
  (f as LatheFit).bands = [{ from: 0.55, to: 0.72, color: '#f2efe6' }];
});
synthetic('tall mug 20°', 'mug', ['#c94f3d'], 20, (f) => {
  (f as LatheFit).height = 1.2;
});
synthetic('tapered cup 35°', 'cup', ['#8a90a8'], 35);
synthetic('bottle 25°', 'bottle', ['#7fa08a', '#2f3b33'], 25);
synthetic('striped can 30°', 'can', ['#e8e2d0'], 30, (f) => {
  (f as LatheFit).material = 'matte';
  (f as LatheFit).bands = [
    { from: 0.2, to: 0.35, color: '#b0302a' },
    { from: 0.65, to: 0.8, color: '#b0302a' },
  ];
});
synthetic('plant pot 30°', 'plant', ['#c06a45', '#4d6a54'], 30);
synthetic('book 40°', 'book', ['#3c554a'], 40);
synthetic('box 30°', 'box', ['#8a90a8', '#b3a796'], 30);

const segmentation = await demoSegmentation('mug');
const desk = await sharp(readFileSync(join(root, 'apps/web/public/desk.svg')))
  .png()
  .toBuffer();
const mug = segmentation.output.detections[0]!;
const crop = await maskedCrop(desk, mug);
cases.push({
  name: 'illustrated desk mug',
  source: 'demo',
  input: {
    rgba: crop.rgba,
    width: crop.width,
    height: crop.height,
    label: 'mug',
    archetype: 'mug',
  },
});

const dir = join(root, 'testdata/items');
if (existsSync(dir))
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
    const meta = join(dir, file.replace(/\.png$/, '.json'));
    if (!existsSync(meta)) continue;
    const { label, archetype, elevation } = JSON.parse(readFileSync(meta, 'utf8')) as {
      label: string;
      archetype: Archetype;
      elevation?: number;
    };
    const { data, info } = await sharp(join(dir, file))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    cases.push({
      name: file.replace(/\.png$/, ''),
      source: 'real',
      input: {
        rgba: new Uint8Array(data),
        width: info.width,
        height: info.height,
        label,
        archetype,
        elevation: elevation ?? null,
      },
    });
  }

let misses = 0;
console.log('case                        source     archetype  IoU    ΔE     camera  ms');
for (const c of cases) {
  const start = performance.now();
  const out = fitItem(c.input);
  const ms = Math.round(performance.now() - start);
  const lathe = ARCHETYPE_FAMILY[c.input.archetype ?? 'generic'] === 'lathe';
  const below = lathe && (out.score.iou < 0.9 || out.score.deltaE > 8);
  const miss = below && c.source !== 'real';
  if (miss) misses++;
  console.log(
    [
      c.name.padEnd(27),
      c.source.padEnd(10),
      out.archetype.padEnd(10),
      out.score.iou.toFixed(3).padEnd(6),
      out.score.deltaE.toFixed(2).padEnd(6),
      `${Math.round(out.elevation)}°`.padEnd(7),
      String(ms),
      miss ? '  ← below target' : below ? '  ← below target (known gap)' : '',
    ].join(' '),
  );
}
if (!cases.some((c) => c.source === 'real'))
  console.log(
    '\nNo real crops in testdata/items yet: add <name>.png and <name>.json to measure them.',
  );
process.exit(misses ? 1 : 0);
