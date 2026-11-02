/**
 * The pictures in docs/fixtures.md: what each step of drafting a fixture
 * from a picture makes, on the demo's own pictures (no model call, nothing
 * from a real home). For each thing: the picture with its outline, the
 * masked crop, the fitted model as the photo's camera sees it (what Spark
 * compares in a live check), and the model as the room draws it.
 *
 *   bun scripts/fixture-figures.ts       writes docs/media/fixtures/steps.png
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import {
  fitItem,
  maskBits,
  renderSprite,
  voxelize,
  type Archetype,
  type Detection,
} from '@livinglayer/domain';
import {
  demoFixtureClass,
  demoPhotoInventory,
  demoPhotoSegmentation,
  demoPng,
  demoReference,
} from '../apps/server/src/demo.js';
import { maskedCrop } from '../apps/server/src/images.js';
import { viewPng } from '../apps/server/src/item.js';

const OUT = resolve('docs/media/fixtures');
mkdirSync(OUT, { recursive: true });
const CELL = 220;
const ACCENT = { r: 255, g: 64, b: 129 };

interface Case {
  name: string;
  label: string;
  archetype: Archetype;
  png: Buffer;
  detection: Detection;
  /** The picture's elevation when known (the desk camera's), else the fitter reads it. */
  elevation: number | null;
}
const cases: Case[] = [];
for (const name of ['lamp', 'mouse'] as const) {
  const { png, detection } = await demoReference(name);
  const cls = demoFixtureClass[name];
  cases.push({ name, label: cls.label, archetype: cls.archetype, png, detection, elevation: null });
}
// A box drawn on the demo office's frame: its mug, outlined as SAM would.
const seg = await demoPhotoSegmentation();
const mugIndex = demoPhotoInventory.things.findIndex((t) => t.id === 'mug');
const mug = seg.detections.find((d) => Number(d.objectId) === mugIndex + 1)!;
cases.push({
  name: 'desk-mug',
  label: 'Mug',
  archetype: 'mug',
  png: await demoPng(),
  detection: mug,
  elevation: null,
});

const rows: Buffer[] = [];
for (const c of cases) {
  const crop = await maskedCrop(c.png, c.detection);
  const fitted = fitItem({
    rgba: crop.rgba,
    width: crop.width,
    height: crop.height,
    label: c.label,
    archetype: c.archetype,
    elevation: c.elevation,
  });
  const cells = [
    await outlined(c.png, c.detection),
    await fitCell(crop.png),
    await fitCell(await viewPng(fitted.item, fitted.elevation, crop.width)),
    await fitCell(await spriteOf(fitted.item.parts), 'nearest'),
  ];
  const row = await sharp({
    create: { width: CELL * 4, height: CELL, channels: 4, background: '#ffffff' },
  })
    .composite(cells.map((input, i) => ({ input, left: i * CELL, top: 0 })))
    .png()
    .toBuffer();
  rows.push(row);
  console.log(
    `${c.name}: ${fitted.archetype}, IoU ${fitted.score.iou.toFixed(3)}, ΔE ${fitted.score.deltaE.toFixed(1)}, ` +
      `elevation ${Math.round(fitted.elevation)}°, ${fitted.renders} renders`,
  );
}
const header = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL * 4}" height="28">` +
    ['picture + outline', 'masked crop', 'fitted, as the camera sees it', 'in the room']
      .map(
        (t, i) =>
          `<text x="${i * CELL + 10}" y="20" font-family="Helvetica" font-size="15" fill="#333">${t}</text>`,
      )
      .join('') +
    '</svg>',
);
await sharp({
  create: {
    width: CELL * 4,
    height: 28 + CELL * rows.length,
    channels: 4,
    background: '#ffffff',
  },
})
  .composite([
    { input: header, left: 0, top: 0 },
    ...rows.map((input, i) => ({ input, left: 0, top: 28 + i * CELL })),
  ])
  .png()
  .toFile(resolve(OUT, 'steps.png'));
console.log(`wrote ${OUT}`);

/** The picture around the thing, its outline drawn over it. */
async function outlined(png: Buffer, d: Detection) {
  const meta = await sharp(png).metadata();
  const frame = { width: meta.width!, height: meta.height! };
  const bits = maskBits(d, frame, 1);
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < bits.width && y < bits.height && bits.data[y * bits.width + x];
  for (let y = 0; y < bits.height; y++)
    for (let x = 0; x < bits.width; x++) {
      if (!at(x, y)) continue;
      const edge = !at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1);
      if (!edge) continue;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ] as const) {
        const px = x + dx;
        const py = y + dy;
        if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue;
        const p = (py * frame.width + px) * 4;
        data[p] = ACCENT.r;
        data[p + 1] = ACCENT.g;
        data[p + 2] = ACCENT.b;
        data[p + 3] = 255;
      }
    }
  // Some room around the box, so the outline reads against what's beside it.
  const pad = Math.round(Math.max(d.box.width, d.box.height) * 0.35);
  const left = Math.max(0, Math.floor(d.box.x - pad));
  const top = Math.max(0, Math.floor(d.box.y - pad));
  const width = Math.min(frame.width - left, Math.ceil(d.box.width + 2 * pad));
  const height = Math.min(frame.height - top, Math.ceil(d.box.height + 2 * pad));
  const cut = await sharp(data, { raw: { ...frame, channels: 4 } })
    .extract({ left, top, width, height })
    .png()
    .toBuffer();
  return fitCell(cut);
}

async function fitCell(png: Buffer, kernel: 'nearest' | 'lanczos3' = 'lanczos3') {
  return sharp(png)
    .resize({
      width: CELL - 16,
      height: CELL - 16,
      fit: 'contain',
      kernel,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .extend({ top: 8, bottom: 8, left: 8, right: 8, background: '#ffffff00' })
    .png()
    .toBuffer();
}

async function spriteOf(parts: Parameters<typeof voxelize>[0]) {
  const s = renderSprite(voxelize(parts, { resolution: 48 }), { scale: 6, pixel: 1 });
  return sharp(Buffer.from(s.rgba), { raw: { width: s.width, height: s.height, channels: 4 } })
    .png()
    .toBuffer();
}
