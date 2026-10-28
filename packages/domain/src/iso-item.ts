import { z } from 'zod';
import type { IsoBox } from './iso.js';

/**
 * A detailed model of one object as a few parametric parts. Item space puts
 * the object's footprint in the unit square (x left to right, y back to
 * front) with z up in the same units, so a model is scaled by the width it
 * stands at in a scene. Parts are easier to check and edit than voxels.
 */
export const ITEM_SHAPES = ['cylinder', 'box', 'cone', 'handle', 'lid'] as const;
export const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/);
const coord = z.number().min(-0.5).max(1.5);
const extent = z.number().min(0.02).max(3);
export const itemPartSchema = z
  .object({
    id: z.string().min(1).max(24),
    shape: z.enum(ITEM_SHAPES),
    at: z.object({ x: coord, y: coord, z: z.number().min(0).max(3) }).strict(),
    size: z.object({ w: extent, d: extent, h: extent }).strict(),
    color: hexColorSchema,
    /** Top radius as a share of the bottom one; only cones use it. */
    taper: z.number().min(0).max(2),
  })
  .strict();
export type ItemPart = z.infer<typeof itemPartSchema>;
export const isoItemSchema = z
  .object({
    label: z.string().min(1).max(60),
    parts: z.array(itemPartSchema).min(1).max(12),
  })
  .strict();
export type IsoItem = z.infer<typeof isoItemSchema>;
/** A saved model, with where its first draft came from. */
export interface SavedItem extends IsoItem {
  source: 'fixture' | 'sampled' | 'spark';
  /** The segmentation the draft was made from. */
  segmentRunId: string | null;
  swatches: Swatch[];
  updatedAt: string;
}
export interface Swatch {
  hex: string;
  /** Share of the mask's pixels in this colour, 0 to 1. */
  share: number;
}

export const partBox = (p: ItemPart): IsoBox => ({ at: p.at, size: p.size });
/** The model's height in item units, so a scene can stand it on a surface. */
export function itemHeight(item: IsoItem): number {
  return Math.max(...item.parts.map((p) => p.at.z + p.size.h));
}
/** Turn the model a quarter turn clockwise (seen from above) about the footprint's centre. */
export function rotateItem(item: IsoItem, quarters = 1): IsoItem {
  let parts = item.parts;
  for (let i = 0; i < ((quarters % 4) + 4) % 4; i++)
    parts = parts.map((p) => ({
      ...p,
      at: { x: 1 - (p.at.y + p.size.d), y: p.at.x, z: p.at.z },
      size: { w: p.size.d, d: p.size.w, h: p.size.h },
    }));
  return { ...item, parts };
}

/** A plain mug: body, coffee, handle on the right. The base of every mug draft. */
export function mugItem(body = '#ece5d0', inside = '#73604c', label = 'Mug'): IsoItem {
  return {
    label,
    parts: [
      {
        id: 'body',
        shape: 'cylinder',
        at: { x: 0, y: 0, z: 0 },
        size: { w: 0.78, d: 0.78, h: 0.9 },
        color: body,
        taper: 1,
      },
      {
        id: 'coffee',
        shape: 'cylinder',
        at: { x: 0.07, y: 0.07, z: 0.9 },
        size: { w: 0.64, d: 0.64, h: 0.02 },
        color: inside,
        taper: 1,
      },
      {
        id: 'handle',
        shape: 'handle',
        at: { x: 0.74, y: 0.31, z: 0.18 },
        size: { w: 0.26, d: 0.16, h: 0.52 },
        color: body,
        taper: 1,
      },
    ],
  };
}
/**
 * A draft that needs no model call: a mug when the concept is one, otherwise
 * a single body with the photo's height-to-width ratio, in the sampled colours.
 */
export function sampledItem(
  label: string,
  ratio: number,
  swatches: Swatch[],
  mug: boolean,
): IsoItem {
  const main = swatches[0]?.hex ?? '#b3a796';
  const second = swatches[1]?.hex ?? main;
  if (mug) {
    const item = mugItem(main, second, label);
    // The photo's ratio includes the handle, so the body is a little taller than that.
    const h = Math.min(2.5, Math.max(0.3, ratio * 1.1));
    return {
      ...item,
      parts: item.parts.map((p) =>
        p.id === 'body'
          ? { ...p, size: { ...p.size, h } }
          : p.id === 'coffee'
            ? { ...p, at: { ...p.at, z: h } }
            : { ...p, size: { ...p.size, h: h * 0.58 }, at: { ...p.at, z: h * 0.2 } },
      ),
    };
  }
  return {
    label,
    parts: [
      {
        id: 'body',
        shape: 'cylinder',
        at: { x: 0, y: 0, z: 0 },
        size: { w: 1, d: 1, h: Math.min(3, Math.max(0.1, ratio)) },
        color: main,
        taper: 1,
      },
    ],
  };
}

/**
 * Rounded RGB buckets by pixel count: the few colours that cover most of a
 * mask. Pixels are RGBA; only those with alpha at or above half count.
 */
export function swatchesOf(rgba: Uint8Array | Buffer, limit = 4): Swatch[] {
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  let total = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) continue;
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.n++;
    buckets.set(key, bucket);
    total++;
  }
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((c) => ({
      hex: `#${hex(c.r / c.n)}${hex(c.g / c.n)}${hex(c.b / c.n)}`,
      share: c.n / total,
    }));
}
/** Give repeated part ids a suffix, so the editor can address every part. */
export function uniqueParts(item: IsoItem): IsoItem {
  const seen = new Map<string, number>();
  return {
    ...item,
    parts: item.parts.map((p) => {
      const n = seen.get(p.id) ?? 0;
      seen.set(p.id, n + 1);
      return n ? { ...p, id: `${p.id.slice(0, 20)}-${n + 1}` } : p;
    }),
  };
}
