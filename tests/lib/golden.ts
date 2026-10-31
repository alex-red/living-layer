/**
 * Golden pictures: a sprite is compared with a PNG kept in `tests/golden`,
 * and the test fails when more than 1% of its pixels moved by more than a
 * little. Set UPDATE_GOLDEN=1 to accept a new look; a missing PNG is
 * written on the first run. The PNGs double as a review sheet.
 */
import { expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

export const GOLDEN_DIR = join(import.meta.dir, '..', 'golden');
export interface Rgba {
  width: number;
  height: number;
  rgba: Uint8ClampedArray | Uint8Array;
}
/** Compare `picture` with `tests/golden/<name>.png`. */
export async function expectGolden(name: string, picture: Rgba) {
  const file = join(GOLDEN_DIR, `${name}.png`);
  const { width, height, rgba } = picture;
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
      .png()
      .toFile(file);
  }
  const golden = await sharp(readFileSync(file)).raw().toBuffer({ resolveWithObject: true });
  expect([golden.info.width, golden.info.height]).toEqual([width, height]);
  let off = 0;
  for (let i = 0; i < rgba.length; i += 4)
    if ([0, 1, 2, 3].some((k) => Math.abs(golden.data[i + k]! - rgba[i + k]!) > 8)) off++;
  expect(off / (width * height)).toBeLessThan(0.01);
}
