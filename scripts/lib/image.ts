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

/**
 * Pictures in a grid, each row's under a label: `[[before, after], [beforeIso, afterIso]]`
 * with `labels` over the columns. Each cell is scaled to its column's first picture's width.
 */
export async function pictureGrid(rows: Buffer[][], labels: string[] = []): Promise<Buffer> {
  const gap = 10;
  const head = labels.length ? 40 : 0;
  const widths = await Promise.all(
    (rows[0] ?? []).map(async (png) => (await sharp(png).metadata()).width ?? 1),
  );
  const cells = await Promise.all(
    rows.map((row) =>
      Promise.all(
        row.map(async (png, i) => {
          const fit = await sharp(png).resize({ width: widths[i] }).png().toBuffer();
          return { png: fit, height: (await sharp(fit).metadata()).height ?? 1 };
        }),
      ),
    ),
  );
  const heights = cells.map((row) => Math.max(...row.map((c) => c.height)));
  const width = widths.reduce((a, w) => a + w, 0) + gap * (widths.length - 1);
  const height = head + heights.reduce((a, h) => a + h, 0) + gap * (heights.length - 1);
  const left = (i: number) => widths.slice(0, i).reduce((a, w) => a + w + gap, 0);
  const label = labels.length
    ? Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${head}">${labels
          .map(
            (l, i) =>
              `<text x="${left(i) + 12}" y="27" fill="#fff" font-size="22" font-family="sans-serif">${l.replace(/[<>&]/g, '')}</text>`,
          )
          .join('')}</svg>`,
      )
    : null;
  return sharp({ create: { width, height, channels: 4, background: '#14161c' } })
    .composite([
      ...(label ? [{ input: label, left: 0, top: 0 }] : []),
      ...cells.flatMap((row, r) =>
        row.map((c, i) => ({
          input: c.png,
          left: left(i),
          top: head + heights.slice(0, r).reduce((a, h) => a + h + gap, 0),
        })),
      ),
    ])
    .png()
    .toBuffer();
}
