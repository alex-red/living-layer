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
 * - `cylinder`, `cone`, `box`, `handle` and `lid` were the first shapes; saved
 *   items that still have them are turned into the lathe, rbox and tube they
 *   stand for when they load (`upgradeItem`).
 */
export const ITEM_SHAPES = ['lathe', 'rbox', 'tube', 'extrude', 'blob'] as const;
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
/** How a print's letters are set: joined handwriting, plain, with serifs, or heavy. */
const PRINT_STYLES = ['script', 'sans', 'serif', 'bold'] as const;
/**
 * Lettering or a logo's words printed on a part, as Spark reads them off a
 * picture: set in type on the server and drawn as a decal, which keeps it so
 * the words survive another look. `around` is the way its middle faces, in
 * degrees seen from above: 0 the front (y = 1), 90 the right (x = 1), 180
 * the back. `at` is its middle's height and `size` its block's height, both
 * shares of the part's height. Lines break at `\n`.
 */
export const printSchema = z
  .object({
    text: z.string().min(1).max(48),
    style: z.enum(PRINT_STYLES),
    color: hexColorSchema,
    around: z.number().min(-360).max(360),
    at: share,
    size: z.number().min(0.05).max(1),
    underline: z.boolean(),
  })
  .strict();
export type Print = z.infer<typeof printSchema>;
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
      /** Up to 128 × 64: a print's letters need it, a fitted unwrap uses at most 64 × 32. */
      w: z.number().int().min(1).max(128),
      h: z.number().int().min(1).max(64),
      colors: z.array(hexColorSchema).min(1).max(16),
      data: z
        .string()
        .max(128 * 64)
        .regex(/^[0-9a-f.]*$/),
      /** The words it was set from, when it is a print. */
      print: printSchema.optional(),
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
  /** Top radius as a share of the bottom one; no shape draws it now, but saved items carry it. */
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
/** Corner radius (rbox, extrude), as a share of the smallest side. */
const radiusField = z.number().min(0).max(0.5).optional();
/** A tube's radius is in item units, and a legacy handle was up to 3 thick. */
const tubeRadiusField = z.number().min(0).max(1.5).optional();
/**
 * One variant per shape, each with only the fields that shape draws.
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
      /** Radius in item units. */
      radius: tubeRadiusField,
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
      case 'rbox':
        return [{ ...base, shape: 'rbox', radius }];
      case 'tube':
        return path ? [{ ...base, shape: 'tube', path, radius }] : [];
      case 'extrude':
        return outline ? [{ ...base, shape: 'extrude', outline, radius }] : [];
      case 'blob':
        return [{ ...base, shape: 'blob', rough }];
    }
  });
  return { label: draft.label, parts };
}
/** The optional fields each shape draws. Saved items may carry others; they are dropped on parse. */
const USED_FIELDS: Record<ItemPart['shape'], readonly string[]> = {
  lathe: ['profile', 'wall', 'inside'],
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
/**
 * The first shapes, which a saved item may still have: a part of one of these
 * is drawn as the modern shape it stands for. Only the first three are
 * pixel-exact. A handle becomes a tube whose box is recomputed from its loop
 * (which reaches 1.33 times the handle's box), so a band painted on it reads
 * the same height but a stripe or decal around it moves. A lid becomes two
 * lathes, the cap and a knob, so every later part moves up one place, and a
 * paint layer covers the cap only.
 */
const LEGACY_SHAPES = new Set(['cylinder', 'cone', 'box', 'lid', 'handle']);
interface LegacyPart {
  id: string;
  shape: 'cylinder' | 'cone' | 'box' | 'lid' | 'handle';
  at: { x: number; y: number; z: number };
  size: { w: number; d: number; h: number };
  taper: number;
}
const STRAIGHT = [
  { r: 1, z: 0 },
  { r: 1, z: 1 },
];
const isNumbers = (o: unknown, keys: string[]): boolean =>
  typeof o === 'object' &&
  o !== null &&
  keys.every((k) => Number.isFinite((o as Record<string, unknown>)[k]));
function isLegacy(p: unknown): p is LegacyPart {
  if (typeof p !== 'object' || p === null) return false;
  const q = p as Record<string, unknown>;
  return (
    typeof q.id === 'string' &&
    LEGACY_SHAPES.has(q.shape as string) &&
    isNumbers(q.at, ['x', 'y', 'z']) &&
    isNumbers(q.size, ['w', 'd', 'h']) &&
    Number.isFinite(q.taper)
  );
}
/** A handle: a half loop in the upright plane, bulging away from the item's centre along its longer side. */
function handleAsTube(p: LegacyPart): unknown {
  const { at, size } = p;
  const alongX = size.w >= size.d;
  const outward = (alongX ? at.x + size.w / 2 : at.y + size.d / 2) >= 0.5;
  const reach = (alongX ? size.w : size.d) * 1.33 * (outward ? 1 : -1);
  const thick = (alongX ? size.d : size.w) / 2;
  const inner = alongX ? (outward ? at.x : at.x + size.w) : outward ? at.y : at.y + size.d;
  const lo = Math.min(inner, inner + reach);
  const span = Math.min(3, Math.abs(reach));
  const top = (size.h - thick) / size.h;
  const bottom = thick / size.h;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const along = (a: number) => clamp01((a - lo) / span);
  const pt = (a: number, z: number) =>
    alongX ? { x: along(a), y: 0.5, z: clamp01(z) } : { x: 0.5, y: along(a), z: clamp01(z) };
  const start = Math.max(-0.5, Math.min(1.5, lo));
  const box = alongX
    ? { at: { ...at, x: start }, size: { ...size, w: span } }
    : { at: { ...at, y: start }, size: { ...size, d: span } };
  return {
    ...p,
    ...box,
    shape: 'tube',
    path: [pt(inner, top), pt(inner + reach, top), pt(inner + reach, bottom), pt(inner, bottom)],
    radius: Math.max(0.01, thick),
  };
}
function legacyParts(p: unknown): unknown[] {
  if (!isLegacy(p)) return [p];
  const { at, size } = p;
  switch (p.shape) {
    case 'cylinder':
      return [{ ...p, shape: 'lathe', profile: STRAIGHT }];
    case 'cone': {
      const k = Math.max(1, p.taper);
      return [
        {
          ...p,
          shape: 'lathe',
          profile: [
            { r: 1 / k, z: 0 },
            { r: Math.max(0.001, p.taper / k), z: 1 },
          ],
        },
      ];
    }
    case 'box':
      return [{ ...p, shape: 'rbox', radius: 0.08 }];
    case 'handle':
      return [handleAsTube(p)];
    case 'lid': {
      const { paint: _paint, ...plain } = p as LegacyPart & { paint?: unknown };
      return [
        { ...p, shape: 'lathe', profile: STRAIGHT },
        {
          ...plain,
          id: `${p.id.slice(0, 19)}-knob`,
          shape: 'lathe',
          at: { x: at.x + size.w * 0.4, y: at.y + size.d * 0.4, z: at.z + size.h },
          size: {
            w: Math.max(0.02, size.w * 0.2),
            d: Math.max(0.02, size.d * 0.2),
            h: Math.max(size.h, 0.04),
          },
          profile: [
            { r: 1, z: 0 },
            { r: 0.8, z: 1 },
          ],
        },
      ];
    }
  }
}
/**
 * The item with any first-shape part turned into a modern one, the same object
 * when it has none. For saved items, which carry whatever shapes they were made with.
 */
export function upgradeItem<T extends { parts: readonly unknown[] }>(item: T): T {
  if (!item.parts.some(isLegacy)) return item;
  return { ...item, parts: item.parts.flatMap(legacyParts) };
}
/**
 * The most parts a model holds. Spark sculpts to `SCULPT_PARTS` and goes past
 * it only for a model that already has more; a person, a variant (a cat on
 * its tree) or a promoted prop may use them all.
 */
export const MAX_ITEM_PARTS = 24;
export const isoItemSchema = z.preprocess(
  (raw) =>
    typeof raw === 'object' && raw !== null && Array.isArray((raw as { parts?: unknown }).parts)
      ? upgradeItem(raw as { parts: unknown[] })
      : raw,
  z
    .object({
      label: z.string().min(1).max(60),
      parts: z.array(itemPartSchema).min(1).max(MAX_ITEM_PARTS),
    })
    .strict(),
);
export type IsoItem = z.infer<typeof isoItemSchema>;
/** The model inside a stored one: a `SavedItem` also carries its source, fit and swatches. */
export const storedItem = ({ label, parts }: { label: string; parts: unknown[] }): IsoItem =>
  isoItemSchema.parse({ label, parts });
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
                  // The front goes to the left.
                  ...(layer.print
                    ? { print: { ...layer.print, around: (layer.print.around + 270) % 360 } }
                    : {}),
                },
        );
      return turned;
    });
  return { ...item, parts };
}
/**
 * A plain empty mug: a glazed body a little narrower at its foot, its inside
 * a shade darker, and a thick D handle standing out to the viewer's right
 * (toward the back right, which the isometric view shows as right). The base
 * of every mug draft; nothing is in it unless a fit or the person says so.
 * Its proportions are a diner mug's: 9.8 cm tall, 8.5 cm across.
 */
export function mugItem(body = '#f3e3dc', inside = '#cbb3ae', label = 'Mug'): IsoItem {
  return {
    label,
    parts: [
      {
        id: 'body',
        shape: 'lathe',
        profile: [
          { r: 0.94, z: 0 },
          { r: 0.99, z: 0.04 },
          { r: 1, z: 0.96 },
          { r: 0.98, z: 1 },
        ],
        at: { x: 0, y: 0.236, z: 0 },
        size: { w: 0.74, d: 0.74, h: 0.86 },
        color: body,
        taper: 1,
        material: 'gloss',
        wall: 0.1,
        inside: { wall: inside, liquid: null, level: 0 },
      },
      {
        // A loop in the vertical plane through the body's axis and its back-right
        // side: both ends just outside the body's wall, so neither shows inside.
        id: 'handle',
        shape: 'tube',
        path: [
          { x: 0, y: 1, z: 1 },
          { x: 1, y: 0, z: 1 },
          { x: 1, y: 0, z: 0 },
          { x: 0, y: 1, z: 0 },
        ],
        radius: 0.085,
        at: { x: 0.656, y: 0, z: 0.13 },
        size: { w: 0.3, d: 0.3, h: 0.62 },
        color: body,
        taper: 1,
        material: 'gloss',
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
