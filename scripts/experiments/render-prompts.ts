/**
 * Experiment: a second SAM pass prompted from the room's own draft.
 *
 * The first pass gives SAM only Spark's loose box per thing. After it, the
 * draft is a 3D room seen through a calibrated camera, so each thing's
 * drawing says which pixels should be it and which are its neighbours, the
 * wall or the floor. This sends SAM the same boxes again with points taken
 * from that drawing:
 *
 *   positive  on the thing's own drawing, well inside it: its feet (the
 *             lowest part in each third of its width, where placement reads
 *             the mask) and its middle. Only for things the catalogue draws,
 *             or small ones: a big thing drawn as a box (a fan) has a box's
 *             shape, not its own.
 *   negative  in its box, where the drawing shows something else close to
 *             it: between a desk's legs, what stands on it, the wall behind.
 *
 * It compares the two passes' masks (IoU, pieces, how much of the box each
 * fills, and how well each agrees with the drawing) and lays the room out
 * again through the new masks. One SAM call per draft ($0.0025), cached under
 * the data folder (ignored: pictures of a home).
 *
 *   bun scripts/experiments/render-prompts.ts <run> [<run>…] --dry   points only, no call
 *   bun scripts/experiments/render-prompts.ts <run> [<run>…]         call SAM, compare
 *   … --variant neg | pos                                             negative or positive points only
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { buildObjectPrompt } from '@meta-sam/parser';
import { META_PRICES, type PhotoDraft, type Segmentation } from '@livinglayer/domain';
import { flag, has, parseArgs } from '../lib/args.js';
import { dataDir, openEvidence } from '../lib/evidence.js';
import { layoutOverlay } from '../lib/overlay.js';
import { compare, placements } from '../lib/placements.js';
import { layOutInput, layoutInput } from '../lib/rooms.js';
import { area, bitsOf, capped, dataUrl, iou, pieces, type Bits } from './lib.js';
import { pointsFor } from './render-points.js';

const args = parseArgs();
const dry = has(args, 'dry');
/** Which points: `both` (the default), `neg` (negative only) or `pos` (positive only). */
const variant = flag(args, 'variant') ?? 'both';
const options = {
  positives: variant !== 'neg',
  negatives: variant !== 'pos',
};
const live = capped(Number(flag(args, 'max-usd') ?? 0.05));
const evidence = openEvidence();
const out = resolve(import.meta.dir, '../../out');
mkdirSync(out, { recursive: true });

const refs = args.positional.length ? args.positional : ['latest'];
for (const ref of refs) {
  const run = evidence.run<PhotoDraft>(ref, 'photo');
  const draft = run.output;
  const short = run.id.slice(0, 8);
  const source = evidence.asset(`${run.id}/source.png`);
  if (!source) {
    console.log(`${short}: no frame stored (a demo run), skipped.`);
    continue;
  }
  const { width: w, height: h } = draft.calibration.camera.frame;
  const { first, result, shifts } = pointsFor(draft, options);

  // The points over the frame: green positive, red negative, each thing's drawing outlined.
  const { data } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const { drawn } of result.values())
    if (drawn)
      for (let i = 0; i < drawn.data.length; i++) {
        const x = i % w;
        const edge =
          drawn.data[i] &&
          ((x > 0 && !drawn.data[i - 1]) ||
            (x < w - 1 && !drawn.data[i + 1]) ||
            !drawn.data[i - w] ||
            !drawn.data[i + w]);
        if (edge) [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]] = [255, 255, 255];
      }
  for (const { points } of result.values())
    for (const p of points)
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const x = p.x + dx;
          const y = p.y + dy;
          if (x < 0 || y < 0 || x >= w || y >= h || Math.hypot(dx, dy) > 3.5) continue;
          const i = (y * w + x) * 3;
          [data[i], data[i + 1], data[i + 2]] =
            p.label === 'negative' ? [255, 40, 40] : [40, 255, 90];
        }
  const pointsFile = resolve(out, `points-${short}.png`);
  await sharp(data, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(pointsFile);
  const counts = [...result.entries()].map(
    ([id, r]) =>
      `${id} +${r.points.filter((p) => p.label !== 'negative').length}/-${r.points.filter((p) => p.label === 'negative').length}`,
  );
  console.log(
    `${short}: ${counts.join(', ')}\n  drawings slid by (px): ${shifts.join(', ')}\n  points over the frame: ${pointsFile}`,
  );
  if (dry) continue;

  // The second pass: the same boxes, with the points.
  const cache = join(
    dataDir(),
    'experiments',
    'render-prompts',
    variant === 'both' ? `${short}.sam.json` : `${short}.${variant}.sam.json`,
  );
  mkdirSync(join(dataDir(), 'experiments', 'render-prompts'), { recursive: true });
  let second: Segmentation;
  if (existsSync(cache)) second = JSON.parse(readFileSync(cache, 'utf8')) as Segmentation;
  else {
    const prompt = buildObjectPrompt({
      size: { width: w, height: h },
      objects: [...result.entries()].map(([id, r]) => ({
        id: Number(draft.detections[id]),
        prompts: [{ box: r.box, ...(r.points.length ? { points: r.points } : {}) }],
      })),
    });
    live.spend(META_PRICES.samPerImage);
    const answer = await live.meta.segment(dataUrl(source), prompt, w, h, {
      concept: 'photo scene',
      maxMasks: 16,
    });
    second = answer.output;
    writeFileSync(cache, JSON.stringify(second));
  }

  // Thing by thing: the two passes, and how each agrees with the drawing.
  console.log(`  ${'thing'.padEnd(10)} 1st→2nd IoU   pieces   fills box   agrees with drawing`);
  for (const [id, r] of result) {
    const detection = draft.detections[id];
    const a = bitsOf(draft.segmentation, detection);
    const b = bitsOf(second, detection);
    const boxArea = (r.box.right - r.box.left) * (r.box.bottom - r.box.top);
    const fill = (m: Bits | null) => (m ? `${Math.round((100 * area(m)) / boxArea)}%` : '-');
    const agree = (m: Bits | null) => (m && r.drawn ? iou(m, r.drawn).toFixed(2) : ' -  ');
    console.log(
      `  ${id.padEnd(10)} ${a && b ? iou(a, b).toFixed(2) : ' -  '}          ${String(a ? pieces(a) : '-').padStart(2)}→${String(b ? pieces(b) : '-').padEnd(3)}  ${fill(a).padStart(4)}→${fill(b).padEnd(5)}  ${agree(a)}→${agree(b)}`,
    );
  }
  const now = layOutInput({ ...layoutInput(draft), segmentation: second });
  const moved = compare(placements(first.layout), placements(now.layout))
    .filter((c) => c.moved > 0.15 || c.status || c.only)
    .map(
      (c) =>
        `${c.id} ${c.status ? `${c.status.from}→${c.status.to}` : c.only ? `only ${c.only}` : c.moved.toFixed(2)}`,
    );
  console.log(
    `  layout: wall ${now.refined ? `${now.refined.wall} ${now.refined.degrees}°` : 'not turned'} (1st pass ${first.refined ? `${first.refined.wall} ${first.refined.degrees}°` : 'not turned'}); moved over 0.15 tiles: ${moved.join(', ') || 'nothing'}`,
  );
  writeFileSync(
    resolve(out, `points-${short}-layout.png`),
    await layoutOverlay(now.layout, now.calibration.camera, source),
  );
}
if (!dry) console.log(`\nSpent $${live.spent.toFixed(4)} (cached drafts cost nothing).`);
evidence.close();
