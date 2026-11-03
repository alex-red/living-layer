import type { Decal, ItemPart, Print } from './iso-item.js';
import { hexRgb, rgbHex } from './color.js';

/**
 * A print set in type: how much of each pixel its ink covers, 0 to 1, row 0
 * at the top. The server sets it (`apps/server/src/print-ink.ts`) much finer
 * than a decal, which samples it down.
 */
export interface Ink {
  width: number;
  height: number;
  coverage: Float32Array;
}
/** What one setting of a print depends on: two prints alike share their ink. */
export const printKey = (p: Pick<Print, 'text' | 'style' | 'underline'>) =>
  `${p.style}|${p.underline ? 1 : 0}|${p.text}`;

const DECAL_W = 128;
const DECAL_H = 64;
/** Over this share of a pixel is ink; over the lower one a blend of ink and the part. */
const FULL = 0.5;
const HALF = 0.22;

/** How far round the part is at a height, in item units. */
function girth(part: ItemPart, v: number): number {
  if (part.shape === 'rbox' || part.shape === 'extrude') return 2 * (part.size.w + part.size.d);
  let r = 1;
  if (part.shape === 'lathe') {
    const pr = part.profile;
    const i = pr.findIndex((q) => q.z >= v);
    if (i <= 0) r = pr[i < 0 ? pr.length - 1 : 0]!.r;
    else {
      const a = pr[i - 1]!;
      const b = pr[i]!;
      r = a.r + ((b.r - a.r) * (v - a.z)) / Math.max(1e-6, b.z - a.z);
    }
  }
  return Math.PI * r * Math.min(part.size.w, part.size.d);
}

/**
 * A print's ink as a decal on its part: as tall as the print says, as wide
 * as its letters need round the part, facing where it faces. Two colours: the
 * ink, and a blend for its edges, so thin strokes don't break up.
 */
export function printDecal(part: ItemPart, print: Print, ink: Ink): Decal | null {
  if (!ink.width || !ink.height) return null;
  let vSpan = print.size;
  let uSpan = (vSpan * part.size.h * (ink.width / ink.height)) / girth(part, print.at);
  // Never more than most of the way round.
  if (uSpan > 0.8) {
    vSpan *= 0.8 / uSpan;
    uSpan = 0.8;
  }
  const v0 = Math.max(0, Math.min(1 - vSpan, print.at - vSpan / 2));
  // u is 0.5 facing the viewer (between the front and the right), and grows to the left.
  let u0 = 0.625 - print.around / 360 - uSpan / 2;
  u0 -= Math.floor(u0);
  const k = Math.min(DECAL_W / ink.width, DECAL_H / ink.height);
  const w = Math.max(1, Math.round(ink.width * k));
  const h = Math.max(1, Math.round(ink.height * k));
  const a = hexRgb(print.color);
  const b = hexRgb(part.color);
  const mid = rgbHex([0, 1, 2].map((i) => Math.round((a[i]! + b[i]!) / 2)) as typeof a);
  let data = '';
  for (let row = 0; row < h; row++)
    for (let col = 0; col < w; col++) {
      // The share of this decal pixel's ink, averaged over the ink pixels under it.
      // u grows to the viewer's left, so the decal's first column is the ink's last.
      const x0 = Math.floor(((w - 1 - col) * ink.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((w - col) * ink.width) / w));
      const y0 = Math.floor((row * ink.height) / h);
      const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * ink.height) / h));
      let sum = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) sum += ink.coverage[y * ink.width + x]!;
      const c = sum / ((x1 - x0) * (y1 - y0));
      data += c >= FULL ? '0' : c >= HALF ? '1' : '.';
    }
  return {
    kind: 'decal',
    face: 'around',
    u0,
    u1: u0 + uSpan,
    v0,
    v1: v0 + vSpan,
    turns: 0,
    w,
    h,
    colors: [print.color, mid],
    data,
    print,
  };
}
