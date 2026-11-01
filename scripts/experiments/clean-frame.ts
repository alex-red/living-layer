/**
 * Experiment: does cleaning a room camera's frame with Muse Image before SAM
 * outlines it give better masks, and so a better room draft?
 *
 * One stored draft's frame goes through each clean-up prompt; SAM outlines
 * the cleaned frame with the same boxes Spark gave the original (Spark's
 * listing is held fixed, so only the picture changes). A control arm sends
 * the untouched frame to SAM again: SAM's own run-to-run spread is the floor
 * any change has to beat. For each arm it reports:
 *
 *   - alignment: how far the cleaned frame's edges sit from the original's,
 *     over the whole frame and per tile (the calibrated camera assumes every
 *     pixel stays put; a shift or warp breaks placement whatever the masks),
 *   - masks: each thing's IoU with the original mask, its pieces, and how
 *     much of its prompt box it fills,
 *   - layout: the draft laid out again through the masks (walls refined as
 *     the setup does), what moved, and the overlay to look at.
 *
 * Billed: one image edit ($0.01) and one SAM call ($0.0025) per prompt, one
 * SAM call for the control. Responses are cached under the data folder
 * (ignored: they are pictures of a home), so a rerun costs nothing.
 *
 *   bun scripts/experiments/clean-frame.ts <run>              the pilot: all prompts + control
 *   bun scripts/experiments/clean-frame.ts <run> --only tidy  one prompt
 *   bun scripts/experiments/clean-frame.ts <run> --max-usd 0.05
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { META_PRICES, promptBox, type PhotoDraft, type Segmentation } from '@livinglayer/domain';
import { flag, parseArgs } from '../lib/args.js';
import { dataDir, openEvidence } from '../lib/evidence.js';
import { layoutOverlay } from '../lib/overlay.js';
import { compare, placements } from '../lib/placements.js';
import { layOutInput, layoutInput } from '../lib/rooms.js';
import { area, bitsOf, capped, dataUrl, iou, pieces, type Bits } from './lib.js';

/** What each arm asks Muse Image for. Every one insists nothing moves. */
const KEEP =
  'Keep the exact framing, perspective, size and position of everything: every object, edge and corner must stay on the same pixels. Do not add, remove, move or restyle anything. Output the same scene as a photograph.';
const PROMPTS: Record<string, string> = {
  tidy: `This is a frame from a fixed home security camera. Clean it up as a photo editor would: remove sensor noise and compression artefacts, correct the white balance and exposure, and sharpen edges. ${KEEP}`,
  light: `This is a frame from a fixed home security camera. Even out its lighting: lift dark shadows under and behind furniture, tame the glare from the window, correct the white balance, and remove noise, so every object's outline is clear against what is behind it. ${KEEP}`,
};

const args = parseArgs();
const ref = args.positional[0] ?? 'latest';
const only = flag(args, 'only');
const maxUsd = Number(flag(args, 'max-usd') ?? 0.1);
const evidence = openEvidence();
const run = evidence.run<PhotoDraft>(ref, 'photo');
const draft = run.output;
const short = run.id.slice(0, 8);
const source = evidence.asset(`${run.id}/source.png`);
if (!source) throw new Error(`Draft ${short} has no frame stored (a demo run?).`);
const frame = draft.calibration.camera.frame;
const cache = join(dataDir(), 'experiments', 'clean-frame', short);
const out = resolve(import.meta.dir, '../../out');
mkdirSync(cache, { recursive: true });
mkdirSync(out, { recursive: true });

const live = capped(maxUsd);

/** Muse Image's clean-up of the frame, at the frame's size; cached. */
async function cleaned(arm: string): Promise<Buffer> {
  const file = join(cache, `${arm}.png`);
  if (existsSync(file)) return readFileSync(file);
  live.spend(META_PRICES.imagePerImage);
  const result = await live.meta.illustrate(
    [dataUrl(source!)],
    PROMPTS[arm]!,
    `${frame.width}x${frame.height}`,
  );
  const meta = await sharp(result.output).metadata();
  console.log(`  ${arm}: Muse Image returned ${meta.width} × ${meta.height}`);
  const png = await sharp(result.output)
    .resize(frame.width, frame.height, { fit: 'fill' })
    .png()
    .toBuffer();
  writeFileSync(file, png);
  return png;
}

/** SAM's masks for the draft's own prompt boxes, on this picture; cached. */
async function outlined(arm: string, png: Buffer): Promise<Segmentation> {
  const file = join(cache, `${arm}.sam.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Segmentation;
  const prompts = draft.inventory.things
    .map((t) => ({ thing: t.id, box: promptBox(t, frame) }))
    .filter((p): p is typeof p & { box: NonNullable<typeof p.box> } => !!p.box)
    .map((p) => ({ id: Number(draft.detections[p.thing] ?? NaN), box: p.box }))
    .filter((p) => Number.isFinite(p.id));
  live.spend(META_PRICES.samPerImage);
  const result = await live.meta.segmentBoxes(dataUrl(png), prompts, frame.width, frame.height);
  writeFileSync(file, JSON.stringify(result.output));
  return result.output;
}

// --- Alignment: edges of the cleaned frame against the original's ---------------------

async function edges(png: Buffer) {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const e = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = data[i + 1]! - data[i - 1]!;
      const gy = data[i + w]! - data[i - w]!;
      e[i] = Math.hypot(gx, gy);
    }
  return { e, w, h };
}
/** The shift (within `reach` px) that lines b's edges up best with a's over a region, and how well. */
function bestShift(
  a: Awaited<ReturnType<typeof edges>>,
  b: Awaited<ReturnType<typeof edges>>,
  region: { x0: number; y0: number; x1: number; y1: number },
  reach = 10,
) {
  const score = (dx: number, dy: number) => {
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let y = region.y0; y < region.y1; y += 2)
      for (let x = region.x0; x < region.x1; x += 2) {
        const xb = x + dx;
        const yb = y + dy;
        if (xb < 0 || yb < 0 || xb >= b.w || yb >= b.h) continue;
        const va = a.e[y * a.w + x]!;
        const vb = b.e[yb * b.w + xb]!;
        ab += va * vb;
        aa += va * va;
        bb += vb * vb;
      }
    return ab / Math.sqrt(aa * bb || 1);
  };
  let best = { dx: 0, dy: 0, score: score(0, 0) };
  const still = best.score;
  for (let dy = -reach; dy <= reach; dy++)
    for (let dx = -reach; dx <= reach; dx++) {
      const s = score(dx, dy);
      if (s > best.score) best = { dx, dy, score: s };
    }
  return { ...best, still };
}

// --- Masks ------------------------------------------------------------------------------

// --- Run --------------------------------------------------------------------------------

const arms = ['control', ...Object.keys(PROMPTS)].filter(
  (a) => !only || a === only || a === 'control',
);
console.log(
  `Draft ${short}: ${draft.inventory.things.length} things, ${frame.width} × ${frame.height}; arms ${arms.join(', ')}; cap $${maxUsd}`,
);
const original = draft.segmentation;
const base = layOutInput(layoutInput(draft));
const before = placements(base.layout);
const sourceEdges = await edges(source);
const rows: string[] = [];
for (const arm of arms) {
  const png = arm === 'control' ? source : await cleaned(arm);
  const seg = await outlined(arm, png);
  writeFileSync(resolve(out, `clean-${short}-${arm}.png`), png);

  // Alignment, whole frame and a 4 × 3 grid of tiles: a warp shows as tiles shifting apart.
  const theirs = await edges(png);
  const whole = bestShift(sourceEdges, theirs, {
    x0: 12,
    y0: 12,
    x1: frame.width - 12,
    y1: frame.height - 12,
  });
  const tiles: string[] = [];
  let worstTile = 0;
  for (let ty = 0; ty < 3; ty++)
    for (let tx = 0; tx < 4; tx++) {
      const region = {
        x0: Math.round((tx * frame.width) / 4),
        y0: Math.round((ty * frame.height) / 3),
        x1: Math.round(((tx + 1) * frame.width) / 4),
        y1: Math.round(((ty + 1) * frame.height) / 3),
      };
      const s = bestShift(sourceEdges, theirs, region, 8);
      worstTile = Math.max(worstTile, Math.hypot(s.dx, s.dy));
      tiles.push(`${s.dx},${s.dy}`);
    }

  // Masks, thing by thing, against the original's.
  const things = draft.inventory.things.filter((t) => draft.detections[t.id]);
  const lines = things.map((t) => {
    const id = draft.detections[t.id];
    const a = bitsOf(original, id);
    const b = bitsOf(seg, id);
    const box = promptBox(t, frame)!;
    const boxArea = (box.right - box.left) * (box.bottom - box.top);
    const describe = (m: Bits | null) =>
      m ? `${pieces(m)} pc, fills ${((100 * area(m)) / boxArea).toFixed(0)}%` : 'none';
    return {
      id: t.id,
      iou: a && b ? iou(a, b) : 0,
      text: `    ${t.id.padEnd(10)} IoU ${a && b ? iou(a, b).toFixed(2) : ' -  '}  original ${describe(a)}  ·  this ${describe(b)}`,
    };
  });
  const meanIou = lines.reduce((s, l) => s + l.iou, 0) / Math.max(1, lines.length);

  // The draft laid out again through these masks.
  const input = { ...layoutInput(draft), segmentation: seg };
  const now = layOutInput(input);
  const changes = compare(before, placements(now.layout));
  const moved = changes
    .filter((c) => c.moved > 0.15 || c.status || c.only)
    .map(
      (c) =>
        `${c.id} ${c.status ? `${c.status.from}→${c.status.to}` : c.only ? `only ${c.only}` : c.moved.toFixed(2)}`,
    );
  writeFileSync(
    resolve(out, `clean-${short}-${arm}-layout.png`),
    await layoutOverlay(now.layout, now.calibration.camera, png),
  );

  rows.push(
    [
      `${arm}:`,
      `  alignment: best shift ${whole.dx},${whole.dy} px (edges ${whole.still.toFixed(2)} as they are, ${whole.score.toFixed(2)} shifted); tiles ${tiles.join(' ')}; worst tile ${worstTile.toFixed(1)} px`,
      `  masks: mean IoU with the original's ${meanIou.toFixed(2)}`,
      ...lines.map((l) => l.text),
      `  layout: wall ${now.refined ? `${now.refined.wall} ${now.refined.degrees}°` : 'not turned'} (original ${base.refined ? `${base.refined.wall} ${base.refined.degrees}°` : 'not turned'}); moved over 0.15 tiles: ${moved.join(', ') || 'nothing'}`,
    ].join('\n'),
  );
}
console.log(`\n${rows.join('\n\n')}\n`);
console.log(
  `Spent $${live.spent.toFixed(4)} this run (cached arms cost nothing). Pictures: out/clean-${short}-*.png`,
);
evidence.close();
