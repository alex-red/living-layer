import { z } from 'zod';
import type { Archetype, ArchetypeFit } from './iso-archetypes.js';

/**
 * A detailed model of one object as a few parametric parts. Item space puts
 * the object's footprint in the unit square (x left to right, y back to
 * front) with z up in the same units, so a model is scaled by the width it
 * stands at in a scene. Every part has a bounding box (`at`, `size`); the
 * shape's own numbers are shares of that box, so the box sliders always work.
 *
 * - `lathe`: a side profile turned around the box's vertical axis (mugs,
 *   bottles, bowls, cans, pots). `wall` opens the top with walls that thick.
 * - `rbox`: a box with rounded edges (books, phones, boxes).
 * - `tube`: a round tube along a 2 to 4 point Bézier (handles, cables, arms).
 * - `extrude`: a footprint outline pushed up, with a bevel.
 * - `blob`: a lumpy ellipsoid (foliage, cloth, food).
 * - `cylinder`, `cone`, `box`, `handle` and `lid` are the first shapes; they
 *   still load and are drawn as the lathe, rbox and tube they stand for.
 */
export const ITEM_SHAPES = [
  'lathe',
  'rbox',
  'tube',
  'extrude',
  'blob',
  'cylinder',
  'box',
  'cone',
  'handle',
  'lid',
] as const;
/** How a surface takes light: it sets the shading ramp, highlight and transparency. */
export const ITEM_MATERIALS = ['matte', 'gloss', 'metal', 'glass', 'fabric', 'wood'] as const;
export type ItemMaterial = (typeof ITEM_MATERIALS)[number];
export const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/);
const coord = z.number().min(-0.5).max(1.5);
const extent = z.number().min(0.02).max(3);
/** Items are one unit wide, so a bottle or a vase stands several units tall. */
const tall = z.number().min(0.02).max(6);
const share = z.number().min(0).max(1);
/** Decal pixels: one character per pixel, an index into `colors`, or `.` for none. */
const DECAL_CHARS = '0123456789abcdef';
/**
 * Surface layers, in the part's own coordinates: `u` runs around the part
 * (0.5 faces the viewer, 0.25 is the viewer's right), `v` runs up its height.
 * `top` and decals on the `top` face use the box's x and y instead.
 */
const paintSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('band'), from: share, to: share, color: hexColorSchema }).strict(),
  z
    .object({
      kind: z.literal('stripes'),
      count: z.number().int().min(1).max(24),
      /** 0 is vertical stripes, 90 is horizontal rings. */
      angle: z.number().min(-90).max(90),
      width: z.number().min(0.05).max(0.95),
      color: hexColorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('dots'),
      count: z.number().int().min(2).max(24),
      rows: z.number().int().min(1).max(12),
      size: z.number().min(0.05).max(0.9),
      color: hexColorSchema,
    })
    .strict(),
  z.object({ kind: z.literal('top'), color: hexColorSchema }).strict(),
  z
    .object({
      kind: z.literal('decal'),
      face: z.enum(['around', 'top']),
      u0: share,
      /** May pass 1 to wrap around the back. */
      u1: z.number().min(0).max(2),
      v0: share,
      v1: share,
      /** Quarter turns of a `top` decal, so it turns with the item. */
      turns: z.number().int().min(0).max(3),
      w: z.number().int().min(1).max(64),
      h: z.number().int().min(1).max(32),
      colors: z.array(hexColorSchema).min(1).max(16),
      data: z
        .string()
        .max(64 * 32)
        .regex(/^[0-9a-f.]*$/),
    })
    .strict()
    .refine((d) => d.u1 > d.u0 && d.u1 - d.u0 <= 1 && d.v1 > d.v0, {
      message: 'A decal needs a positive area.',
    })
    .refine(
      (d) =>
        d.data.length === d.w * d.h &&
        [...d.data].every((c) => c === '.' || DECAL_CHARS.indexOf(c) < d.colors.length),
      { message: 'Decal data must have w × h pixels, each a colour index or a dot.' },
    ),
]);
export type Paint = z.infer<typeof paintSchema>;
export type Decal = Extract<Paint, { kind: 'decal' }>;
const point2 = z.object({ x: share, y: share }).strict();
const partBase = {
  id: z.string().min(1).max(24),
  at: z.object({ x: coord, y: coord, z: z.number().min(0).max(6) }).strict(),
  size: z.object({ w: extent, d: extent, h: tall }).strict(),
  color: hexColorSchema,
  /** Top radius as a share of the bottom one; only cones use it. */
  taper: z.number().min(0).max(2),
  material: z.enum(ITEM_MATERIALS).optional(),
  paint: z.array(paintSchema).max(6).optional(),
  /** Kept as it is when the model is fitted to a photo again. */
  locked: z.boolean().optional(),
};
/** Lathe: (radius, height) as shares of the box, bottom to top. */
const profileField = z
  .array(z.object({ r: share, z: share }).strict())
  .min(2)
  .max(16)
  .refine((pr) => !pr.some((q, i) => i > 0 && q.z < pr[i - 1]!.z), {
    message: 'A profile runs from bottom to top.',
  });
/** An open lathe's inner wall, and what fills it up to `level`. */
const insideField = z
  .object({ wall: hexColorSchema, liquid: hexColorSchema.nullable(), level: share })
  .strict()
  .optional();
/** Lathe: an open top with walls this thick, as a share of the radius. */
const wallField = z.number().min(0).max(0.9).optional();
/** Tube radius in item units; corner radius (rbox, extrude) as a share of the smallest side. */
const radiusField = z.number().min(0).max(0.5).optional();
/**
 * One variant per shape, each with only the fields that shape draws. The
 * legacy shapes are members too, so they load and draw as before.
 */
const itemPartUnion = z.discriminatedUnion('shape', [
  z
    .object({
      ...partBase,
      shape: z.literal('lathe'),
      profile: profileField,
      wall: wallField,
      inside: insideField,
    })
    .strict(),
  z
    .object({ ...partBase, shape: z.literal('cylinder'), wall: wallField, inside: insideField })
    .strict(),
  z.object({ ...partBase, shape: z.literal('cone') }).strict(),
  z.object({ ...partBase, shape: z.literal('box') }).strict(),
  z.object({ ...partBase, shape: z.literal('lid') }).strict(),
  z.object({ ...partBase, shape: z.literal('handle') }).strict(),
  z.object({ ...partBase, shape: z.literal('rbox'), radius: radiusField }).strict(),
  z
    .object({
      ...partBase,
      shape: z.literal('tube'),
      /** Tube: its curve, as shares of the box. */
      path: z
        .array(z.object({ x: share, y: share, z: share }).strict())
        .min(2)
        .max(4),
      radius: radiusField,
    })
    .strict(),
  z
    .object({
      ...partBase,
      shape: z.literal('extrude'),
      /** Extrude: the footprint, as shares of the box. */
      outline: z.array(point2).min(3).max(12),
      radius: radiusField,
    })
    .strict(),
  z
    .object({
      ...partBase,
      shape: z.literal('blob'),
      /** Blob: how lumpy, 0 to 1. */
      rough: share.optional(),
    })
    .strict(),
]);
export type ItemPart = z.infer<typeof itemPartUnion>;
type Variant<S extends ItemPart['shape']> = Extract<ItemPart, { shape: S }>;
/**
 * A part being edited: every shape's fields at once, since changing a part's
 * shape keeps the numbers it had. Not a valid part until `isoItemSchema` parses it.
 */
export type ItemPartDraft = Pick<
  ItemPart,
  'id' | 'shape' | 'at' | 'size' | 'color' | 'taper' | 'material' | 'paint' | 'locked'
> & {
  profile?: Variant<'lathe'>['profile'];
  wall?: Variant<'lathe'>['wall'];
  inside?: Variant<'lathe'>['inside'];
  path?: Variant<'tube'>['path'];
  radius?: Variant<'rbox'>['radius'];
  outline?: Variant<'extrude'>['outline'];
  rough?: Variant<'blob'>['rough'];
};
export interface IsoItemDraft {
  label: string;
  parts: ItemPartDraft[];
}
/**
 * A draft as the kernel can draw it while it is still being edited: each part
 * keeps the fields its shape uses, a lathe without a profile is a plain
 * cylinder, and a tube or extrusion with no curve or outline is left out.
 */
export function previewItem(draft: IsoItemDraft): IsoItem {
  const parts = draft.parts.flatMap((p): ItemPart[] => {
    const { profile, wall, inside, path, radius, outline, rough, ...base } = p;
    switch (p.shape) {
      case 'lathe':
        return [
          {
            ...base,
            shape: 'lathe',
            profile: profile ?? [
              { r: 1, z: 0 },
              { r: 1, z: 1 },
            ],
            wall,
            inside,
          },
        ];
      case 'cylinder':
        return [{ ...base, shape: 'cylinder', wall, inside }];
      case 'rbox':
        return [{ ...base, shape: 'rbox', radius }];
      case 'tube':
        return path ? [{ ...base, shape: 'tube', path, radius }] : [];
      case 'extrude':
        return outline ? [{ ...base, shape: 'extrude', outline, radius }] : [];
      case 'blob':
        return [{ ...base, shape: 'blob', rough }];
      case 'cone':
      case 'box':
      case 'lid':
      case 'handle':
        return [{ ...base, shape: p.shape }];
    }
  });
  return { label: draft.label, parts };
}
/** The optional fields each shape draws. Saved items may carry others; they are dropped on parse. */
const USED_FIELDS: Record<ItemPart['shape'], readonly string[]> = {
  lathe: ['profile', 'wall', 'inside'],
  cylinder: ['wall', 'inside'],
  cone: [],
  box: [],
  lid: [],
  handle: [],
  rbox: ['radius'],
  tube: ['path', 'radius'],
  extrude: ['outline', 'radius'],
  blob: ['rough'],
};
const SHAPE_FIELDS = ['profile', 'wall', 'path', 'radius', 'outline', 'rough', 'inside'];
function dropUnused(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const shape = (raw as { shape?: unknown }).shape;
  if (typeof shape !== 'string' || !Object.hasOwn(USED_FIELDS, shape)) return raw;
  const keep = USED_FIELDS[shape as ItemPart['shape']];
  const out: Record<string, unknown> = { ...raw };
  for (const k of SHAPE_FIELDS) if (!keep.includes(k)) delete out[k];
  return out;
}
export const itemPartSchema = z.preprocess(dropUnused, itemPartUnion);
export const isoItemSchema = z
  .object({
    label: z.string().min(1).max(60),
    parts: z.array(itemPartSchema).min(1).max(12),
  })
  .strict();
export type IsoItem = z.infer<typeof isoItemSchema>;
/** How well a fitted model matches the photo it was fitted to. */
export interface ItemFitRecord {
  archetype: Archetype;
  /** The measured numbers the parts were built from, for refitting and fusing. */
  params: ArchetypeFit;
  /** Silhouette overlap with the mask, 0 to 1. */
  iou: number;
  /** Mean OKLab colour error inside the mask, times 100. */
  deltaE: number;
  /** The camera's angle above the surface, in degrees. */
  elevation: number;
  /** Sightings fused into this model. */
  views: number;
  /** The masked crop it was fitted to, as an evidence asset. */
  crop: string | null;
  /** That crop's size in pixels: a thing under about 60 across is too small to model well. */
  cropPx?: { width: number; height: number };
  /** What Meta's models added: part masks from SAM, a class and a check from Spark. */
  assists: string[];
}
/** A saved model, with where its first draft came from. */
export interface SavedItem extends IsoItem {
  /** `placeholder`: a shape's usual proportions, from a scan, until it is drafted properly. */
  source: 'demo' | 'sampled' | 'spark' | 'placeholder';
  /** The segmentation the draft was made from. */
  segmentRunId: string | null;
  swatches: Swatch[];
  updatedAt: string;
  fit?: ItemFitRecord | null;
}
export interface Swatch {
  hex: string;
  /** Share of the mask's pixels in this colour, 0 to 1. */
  share: number;
}

/** The model's height in item units, so a scene can stand it on a surface. */
export function itemHeight(item: IsoItem): number {
  return Math.max(...item.parts.map((p) => p.at.z + p.size.h));
}
/** Turn the model a quarter turn clockwise (seen from above) about the footprint's centre. */
export function rotateItem(item: IsoItem, quarters = 1): IsoItem {
  let parts = item.parts;
  for (let i = 0; i < ((quarters % 4) + 4) % 4; i++)
    parts = parts.map((p) => {
      // In box shares a point (x, y) goes to (1 - y, x), as the box itself does.
      const turned: ItemPart = {
        ...p,
        at: { x: 1 - (p.at.y + p.size.d), y: p.at.x, z: p.at.z },
        size: { w: p.size.d, d: p.size.w, h: p.size.h },
      };
      if (turned.shape === 'tube' && p.shape === 'tube')
        turned.path = p.path.map((q) => ({ x: 1 - q.y, y: q.x, z: q.z }));
      if (turned.shape === 'extrude' && p.shape === 'extrude')
        turned.outline = p.outline.map((q) => ({ x: 1 - q.y, y: q.x }));
      if (p.paint)
        turned.paint = p.paint.map((layer) =>
          layer.kind !== 'decal'
            ? layer
            : layer.face === 'top'
              ? { ...layer, turns: (layer.turns + 1) % 4 }
              : {
                  ...layer,
                  // The surface's u runs around: a quarter turn moves it a quarter on.
                  u0: (layer.u0 + 0.25) % 1,
                  u1: ((layer.u0 + 0.25) % 1) + (layer.u1 - layer.u0),
                },
        );
      return turned;
    });
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
