/** Picture helpers for the scripts: crops by shares, and a reference beside a render. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';

export type Share = [number, number, number, number];
/** `x0,y0,x1,y1` as shares of a picture, each 0 to 1. */
export function parseShare(text: string): Share {
  const v = text.split(',').map(Number);
  if (v.length !== 4 || v.some((n) => !(n >= 0 && n <= 1)) || v[2]! <= v[0]! || v[3]! <= v[1]!)
    throw new Error(`"${text}": expected x0,y0,x1,y1 between 0 and 1, with x1 > x0 and y1 > y0`);
  return v as Share;
}
/** The part of a PNG inside `share`, never past its edges. */
export async function cropShare(png: Buffer, [x0, y0, x1, y1]: Share): Promise<Buffer> {
  const { width = 1, height = 1 } = await sharp(png).metadata();
  const left = Math.floor(x0 * width);
  const top = Math.floor(y0 * height);
  return sharp(png)
    .extract({
      left,
      top,
      width: Math.max(1, Math.min(width - left, Math.ceil((x1 - x0) * width))),
      height: Math.max(1, Math.min(height - top, Math.ceil((y1 - y0) * height))),
    })
    .png()
    .toBuffer();
}
const referenceDir = resolve(import.meta.dir, '..', '..', 'design', 'reference');
/** A reference's picture: a name in design/reference/ (its JSON names the picture), or a path. */
export function referencePicture(nameOrPath: string): string {
  const json = join(referenceDir, `${nameOrPath}.json`);
  if (existsSync(json)) {
    const { image } = JSON.parse(readFileSync(json, 'utf8')) as { image: string };
    return join(dirname(json), image);
  }
  if (existsSync(nameOrPath)) return nameOrPath;
  throw new Error(`No reference "${nameOrPath}" in design/reference/, and no such file`);
}
/** A render with the reference beside it, scaled to the same height. */
export async function besideReference(png: Buffer, reference: string): Promise<Buffer> {
  const { width = 1, height = 1 } = await sharp(png).metadata();
  const ref = await sharp(referencePicture(reference)).resize({ height }).png().toBuffer();
  const refWidth = (await sharp(ref).metadata()).width ?? 1;
  return sharp({
    create: { width: width + refWidth + 12, height, channels: 4, background: '#0d0f16' },
  })
    .composite([
      { input: png, left: 0, top: 0 },
      { input: ref, left: width + 12, top: 0 },
    ])
    .png()
    .toBuffer();
}
