/**
 * Golden pictures: a sprite is compared with a PNG kept in `tests/golden`,
 * and the test fails when more than 1% of its pixels moved by more than a
 * little. A failure writes `out/golden-diff/<name>.png`: the golden, the new
 * picture and the pixels that moved (magenta), side by side, to judge before
 * accepting it. Set UPDATE_GOLDEN=1 to accept a new look; a missing PNG is
 * written on the first run. The PNGs double as a review sheet.
 */
import { expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

export const GOLDEN_DIR = join(import.meta.dir, '..', 'golden');
const DIFF_DIR = join(import.meta.dir, '..', '..', 'out', 'golden-diff');
/** How far a channel may move before a pixel counts as changed. */
const TOLERANCE = 8;
export interface Rgba {
  width: number;
  height: number;
  rgba: Uint8ClampedArray | Uint8Array;
}
const raw = (p: Rgba) =>
  sharp(Buffer.from(p.rgba), { raw: { width: p.width, height: p.height, channels: 4 } });

/** Golden | new | changed pixels, at 3× so single pixels show. */
async function writeDiff(name: string, golden: Rgba, picture: Rgba) {
  const width = Math.max(golden.width, picture.width);
  const height = Math.max(golden.height, picture.height);
  const moved = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (p: Rgba, k: number) =>
        x < p.width && y < p.height ? p.rgba[(y * p.width + x) * 4 + k]! : 0;
      const changed = [0, 1, 2, 3].some(
        (k) => Math.abs(at(golden, k) - at(picture, k)) > TOLERANCE,
      );
      moved.set(
        changed
          ? [230, 140, 196, 255]
          : [at(picture, 0) / 4, at(picture, 1) / 4, at(picture, 2) / 4, at(picture, 3)],
        (y * width + x) * 4,
      );
    }
  const panes = await Promise.all(
    [golden, picture, { width, height, rgba: moved }].map(async (p) =>
      raw(p)
        .resize(p.width * 3, p.height * 3, { kernel: 'nearest' })
        .png()
        .toBuffer(),
    ),
  );
  const file = join(DIFF_DIR, `${name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  await sharp({
    create: { width: width * 9 + 24, height: height * 3, channels: 4, background: '#0d0f16' },
  })
    .composite(panes.map((input, i) => ({ input, left: i * (width * 3 + 12), top: 0 })))
    .png()
    .toFile(file);
  console.log(`golden ${name} changed: golden | new | moved → ${file}`);
}

/** Compare `picture` with `tests/golden/<name>.png`. */
export async function expectGolden(name: string, picture: Rgba) {
  const file = join(GOLDEN_DIR, `${name}.png`);
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    await raw(picture).png().toFile(file);
  }
  const { data, info } = await sharp(readFileSync(file))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const golden: Rgba = { width: info.width, height: info.height, rgba: data };
  const same = golden.width === picture.width && golden.height === picture.height;
  let off = 0;
  if (same)
    for (let i = 0; i < picture.rgba.length; i += 4)
      if (
        [0, 1, 2, 3].some((k) => Math.abs(golden.rgba[i + k]! - picture.rgba[i + k]!) > TOLERANCE)
      )
        off++;
  const share = same ? off / (picture.width * picture.height) : 1;
  if (share >= 0.01) await writeDiff(name, golden, picture);
  expect([golden.width, golden.height]).toEqual([picture.width, picture.height]);
  expect(share).toBeLessThan(0.01);
}
