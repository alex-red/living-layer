import { z } from 'zod';
import {
  ITEM_MATERIALS,
  type Decal,
  type IsoItem,
  type ItemMaterial,
  type ItemPart,
  type Paint,
} from './iso-item.js';

/**
 * Recipes for the objects people put on desks: each turns a few measured
 * numbers into parts. The fitter measures the numbers from the photo; Spark
 * at most names the archetype and material, never the numbers.
 */
export const ARCHETYPES = [
  'mug',
  'cup',
  'bottle',
  'can',
  'book',
  'box',
  'plant',
  'lamp',
  'device',
  'cat',
  'generic',
] as const;
export const archetypeSchema = z.enum(ARCHETYPES);
export type Archetype = z.infer<typeof archetypeSchema>;
export const CAT_POSES = ['idle', 'sleeping'] as const;
export type CatPose = (typeof CAT_POSES)[number];
/** How wide each kind of object usually is, handle included, in centimetres. */
export const ARCHETYPE_WIDTH_CM: Record<Archetype, number | null> = {
  mug: 12,
  cup: 9,
  bottle: 7.5,
  can: 6.6,
  book: 16,
  box: 20,
  plant: 15,
  lamp: 18,
  device: 15,
  cat: 26,
  generic: null,
};
/**
 * A sighting's width in tiles, held near what that kind of object really
 * measures: a camera's view of a small desk can make a mug look a hand
 * wide. The kind comes from the fitted model, or else from the label.
 */
export function believableWidth(width: number, label: string, archetype?: Archetype | null) {
  const kind =
    archetype ?? ARCHETYPES.find((a) => new RegExp(`\\b${a}s?\\b`, 'i').test(label)) ?? null;
  const cm = kind ? ARCHETYPE_WIDTH_CM[kind] : null;
  if (!cm) return width;
  const usual = cm / 30;
  return Math.max(usual * 0.75, Math.min(usual * 1.35, width));
}
export interface Band {
  /** Shares of the body's height. */
  from: number;
  to: number;
  color: string;
}
/** A body turned on a lathe, with an optional handle, cap or plant on top. */
export interface LatheFit {
  family: 'lathe';
  /** The widest radius and the height, in item units. */
  radius: number;
  height: number;
  /** Radius and height as shares, bottom to top. */
  profile: { r: number; z: number }[];
  /** Open top with walls this thick (share of the radius); 0 for closed. */
  wall: number;
  /** Top and bottom as shares of the height; reach and thickness in item units. */
  handle: { top: number; bottom: number; reach: number; thickness: number } | null;
  colors: { body: string; inside: string; liquid: string | null; handle: string };
  /** How full, as a share of the inside's height. */
  level: number;
  cap: { from: number; color: string } | null;
  foliage: { height: number; color: string } | null;
  bands: Band[];
  decal: Decal | null;
  material: ItemMaterial;
}
export interface BoxFit {
  family: 'box';
  w: number;
  d: number;
  h: number;
  /** Corner radius as a share of the smallest side. */
  radius: number;
  colors: { top: string; side: string };
  bands: Band[];
  decal: Decal | null;
  material: ItemMaterial;
}
/**
 * A flat thing seen from above: its outline pushed up and rounded over, like
 * a mouse, a remote or a switch plate. A photo from above can't show how tall
 * it is, so the height comes from its known size when there is one.
 */
export interface FlatFit {
  family: 'flat';
  /** The footprint as shares of its box, clockwise from the back left. */
  outline: { x: number; y: number }[];
  /** The box's width and depth as shares of the longer one, which is 1. */
  w: number;
  d: number;
  h: number;
  /** How rounded the top edge is, as a share of the smallest side. */
  radius: number;
  colors: { top: string; side: string };
  decal: Decal | null;
  material: ItemMaterial;
}
export interface CatFit {
  family: 'cat';
  pose: CatPose;
  colors: { body: string; accent: string };
  material: ItemMaterial;
}
export type ArchetypeFit = LatheFit | BoxFit | FlatFit | CatFit;

export const ARCHETYPE_FAMILY: Record<Archetype, ArchetypeFit['family']> = {
  mug: 'lathe',
  cup: 'lathe',
  bottle: 'lathe',
  can: 'lathe',
  plant: 'lathe',
  lamp: 'lathe',
  device: 'flat',
  cat: 'cat',
  generic: 'lathe',
  book: 'box',
  box: 'box',
};
/**
 * Shapes the fitter's archetypes draw poorly, so a live draft offers Model
 * with AI straight after placing: a device is a flat outline extruded (a
 * mouse comes out a blob), a box only a box, generic a guessed turned body,
 * and a lamp's thin stem is lost between profile samples (the fit bench's
 * known gap). Turned vessels, books and cats stay with the fitter.
 */
export const SCULPT_FIRST: readonly Archetype[] = ['device', 'box', 'generic', 'lamp'];
const WORDS: [Archetype, RegExp][] = [
  // Before lamps, so a light switch is a device.
  [
    'device',
    /\b(mouse|remote|router|switch|plug|speaker|keyboard|controller|thermostat|charger|trackpad)\b/,
  ],
  // Only as the name's last word: a cat tower, cat bed or pet bowl is something else.
  ['cat', /\b(cat|kitty|kitten|feline|pet)s?$/],
  ['lamp', /\b(lamp|light|bulb|sconce|lantern)\b/],
  ['mug', /\b(mug|tankard|stein)\b/],
  ['cup', /\b(cup|glass|tumbler|bowl|beaker)\b/],
  ['bottle', /\b(bottle|flask|thermos|jar|vase)\b/],
  ['can', /\b(can|tin|soda|candle)\b/],
  ['book', /\b(book|notebook|notepad|journal|diary|novel)\b/],
  ['box', /\b(box|phone|tablet|laptop|case|carton|block)\b/],
  ['plant', /\b(plant|succulent|cactus|flower|pot)\b/],
];
/** A guess from the object's name alone, for drafts made without Spark. */
export function archetypeOf(label: string): Archetype {
  const text = label.toLowerCase().trim();
  return WORDS.find(([, re]) => re.test(text))?.[0] ?? 'generic';
}

const lathe = (fit: Partial<LatheFit>): LatheFit => ({
  family: 'lathe',
  radius: 0.4,
  height: 0.9,
  profile: [
    { r: 1, z: 0 },
    { r: 1, z: 1 },
  ],
  wall: 0,
  handle: null,
  colors: { body: '#b3a796', inside: '#8c826f', liquid: null, handle: '#b3a796' },
  level: 0,
  cap: null,
  foliage: null,
  bands: [],
  decal: null,
  material: 'matte',
  ...fit,
});
/** Typical proportions per archetype, in the given colours, before any measuring. */
export function defaultFit(archetype: Archetype, colors: string[] = []): ArchetypeFit {
  const main = colors[0] ?? '#b3a796';
  const second = colors[1] ?? main;
  // Glazed and moulded things are the same colour inside; a second colour is what they hold.
  const all = { body: main, inside: main, liquid: null, handle: main };
  switch (archetype) {
    case 'mug':
      return lathe({
        radius: 0.36,
        height: 0.82,
        profile: [
          { r: 0.9, z: 0 },
          { r: 1, z: 0.06 },
          { r: 1, z: 1 },
        ],
        wall: 0.12,
        handle: { top: 0.8, bottom: 0.22, reach: 0.22, thickness: 0.08 },
        colors: { ...all, liquid: colors[1] ?? null },
        level: colors[1] ? 0.85 : 0,
        material: 'gloss',
      });
    case 'cup':
      return lathe({
        radius: 0.45,
        height: 0.85,
        profile: [
          { r: 0.66, z: 0 },
          { r: 0.82, z: 0.45 },
          { r: 1, z: 1 },
        ],
        wall: 0.08,
        colors: all,
        material: 'gloss',
      });
    case 'bottle':
      return lathe({
        radius: 0.3,
        height: 2.2,
        profile: [
          { r: 0.96, z: 0 },
          { r: 1, z: 0.04 },
          { r: 1, z: 0.6 },
          { r: 0.5, z: 0.8 },
          { r: 0.42, z: 1 },
        ],
        cap: { from: 0.88, color: second },
        colors: all,
        material: 'glass',
      });
    case 'can':
      return lathe({
        radius: 0.34,
        height: 1.25,
        profile: [
          { r: 0.9, z: 0 },
          { r: 1, z: 0.05 },
          { r: 1, z: 0.95 },
          { r: 0.9, z: 1 },
        ],
        colors: all,
        material: 'metal',
      });
    case 'plant':
      return lathe({
        radius: 0.36,
        height: 0.7,
        profile: [
          { r: 0.74, z: 0 },
          { r: 1, z: 0.92 },
          { r: 1.0, z: 1 },
        ],
        wall: 0.1,
        level: 0.88,
        colors: { body: main, inside: main, liquid: '#4a3a2c', handle: main },
        foliage: { height: 1, color: colors.find((c) => greenish(c)) ?? '#4d6a54' },
      });
    case 'book':
      return {
        family: 'box',
        w: 0.92,
        d: 0.72,
        h: 0.18,
        radius: 0.2,
        colors: { top: main, side: '#e6dfcc' },
        bands: [],
        decal: null,
        material: 'matte',
      };
    case 'box':
      return {
        family: 'box',
        w: 0.9,
        d: 0.8,
        h: 0.6,
        radius: 0.1,
        colors: { top: second, side: main },
        bands: [],
        decal: null,
        material: 'matte',
      };
    case 'lamp':
      // A round base, a thin stem and a shade wider at the bottom.
      return lathe({
        radius: 0.45,
        height: 1.8,
        profile: [
          { r: 0.6, z: 0 },
          { r: 0.6, z: 0.04 },
          { r: 0.1, z: 0.07 },
          { r: 0.1, z: 0.58 },
          { r: 1, z: 0.62 },
          { r: 0.6, z: 1 },
        ],
        colors: all,
      });
    case 'device':
      return {
        family: 'flat',
        outline: [
          { x: 0.1, y: 0 },
          { x: 0.9, y: 0 },
          { x: 1, y: 0.1 },
          { x: 1, y: 0.9 },
          { x: 0.9, y: 1 },
          { x: 0.1, y: 1 },
          { x: 0, y: 0.9 },
          { x: 0, y: 0.1 },
        ],
        w: 0.6,
        d: 1,
        h: 0.35,
        radius: 0.45,
        colors: { top: main, side: second },
        decal: null,
        material: 'matte',
      };
    case 'cat':
      return {
        family: 'cat',
        pose: 'idle',
        colors: { body: colors[0] ?? '#d88b4b', accent: colors[1] ?? '#f2e6d8' },
        material: 'fabric',
      };
    case 'generic':
      return lathe({ radius: 0.42, height: 1, colors: all });
  }
}
function greenish(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const r = n >> 16;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return g > r * 1.1 && g > b * 1.05;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const bandPaint = (bands: Band[]): Paint[] =>
  bands.map((b) => ({ kind: 'band', from: round(b.from), to: round(b.to), color: b.color }));

/** The parts for a fit, in item space: the body centred on the footprint. */
export function buildItem(label: string, fit: ArchetypeFit): IsoItem {
  if (fit.family === 'cat') {
    const { body, accent } = fit.colors;
    const material = fit.material;
    const ear = (id: string, x: number, y: number, z: number): ItemPart => ({
      id,
      shape: 'lathe',
      at: { x: round(x), y: round(y), z: round(z) },
      size: { w: 0.14, d: 0.14, h: 0.2 },
      color: body,
      taper: 1,
      profile: [
        { r: 1, z: 0 },
        { r: 0.15, z: 1 },
      ],
      material,
    });
    if (fit.pose === 'sleeping') {
      return {
        label,
        parts: [
          {
            id: 'body',
            shape: 'blob',
            at: { x: 0.12, y: 0.14, z: 0 },
            size: { w: 0.72, d: 0.68, h: 0.42 },
            color: body,
            taper: 1,
            rough: 0.15,
            material,
          },
          {
            id: 'head',
            shape: 'blob',
            at: { x: 0.44, y: 0.46, z: 0.04 },
            size: { w: 0.36, d: 0.36, h: 0.34 },
            color: body,
            taper: 1,
            rough: 0.1,
            material,
          },
          ear('ear-l', 0.48, 0.62, 0.3),
          ear('ear-r', 0.64, 0.48, 0.3),
          {
            id: 'tail',
            shape: 'tube',
            at: { x: 0.1, y: 0.1, z: 0.02 },
            size: { w: 0.68, d: 0.68, h: 0.18 },
            color: accent,
            taper: 0.7,
            radius: 0.06,
            path: [
              { x: 0.15, y: 0.4, z: 0.4 },
              { x: 0.1, y: 0.85, z: 0.3 },
              { x: 0.55, y: 0.9, z: 0.25 },
              { x: 0.85, y: 0.65, z: 0.2 },
            ],
            material,
          },
        ],
      };
    }
    return {
      label,
      parts: [
        {
          id: 'body',
          shape: 'blob',
          at: { x: 0.2, y: 0.18, z: 0 },
          size: { w: 0.56, d: 0.56, h: 0.74 },
          color: body,
          taper: 0.82,
          rough: 0.12,
          material,
        },
        {
          id: 'chest',
          shape: 'blob',
          at: { x: 0.38, y: 0.38, z: 0.14 },
          size: { w: 0.36, d: 0.36, h: 0.46 },
          color: accent,
          taper: 0.85,
          rough: 0.08,
          material,
        },
        {
          id: 'paw-l',
          shape: 'rbox',
          at: { x: 0.42, y: 0.6, z: 0 },
          size: { w: 0.14, d: 0.18, h: 0.14 },
          color: accent,
          taper: 1,
          radius: 0.45,
          material,
        },
        {
          id: 'paw-r',
          shape: 'rbox',
          at: { x: 0.6, y: 0.42, z: 0 },
          size: { w: 0.18, d: 0.14, h: 0.14 },
          color: accent,
          taper: 1,
          radius: 0.45,
          material,
        },
        {
          id: 'head',
          shape: 'blob',
          at: { x: 0.34, y: 0.34, z: 0.62 },
          size: { w: 0.42, d: 0.42, h: 0.4 },
          color: body,
          taper: 1,
          rough: 0.08,
          material,
        },
        ear('ear-l', 0.38, 0.56, 0.94),
        ear('ear-r', 0.56, 0.38, 0.94),
        {
          id: 'tail',
          shape: 'tube',
          at: { x: 0.08, y: 0.08, z: 0.04 },
          size: { w: 0.38, d: 0.38, h: 0.68 },
          color: body,
          taper: 0.75,
          radius: 0.055,
          path: [
            { x: 0.65, y: 0.65, z: 0.1 },
            { x: 0.2, y: 0.25, z: 0.25 },
            { x: 0.15, y: 0.2, z: 0.65 },
            { x: 0.35, y: 0.35, z: 0.92 },
          ],
          material,
        },
      ],
    };
  }
  if (fit.family === 'flat') {
    const w = clamp(fit.w, 0.05, 1);
    const d = clamp(fit.d, 0.05, 1);
    const paint: Paint[] = [{ kind: 'top', color: fit.colors.top }];
    if (fit.decal) paint.push(fit.decal);
    return {
      label,
      parts: [
        {
          id: 'body',
          shape: 'extrude',
          at: { x: round(0.5 - w / 2), y: round(0.5 - d / 2), z: 0 },
          size: { w: round(w), d: round(d), h: round(clamp(fit.h, 0.03, 6)) },
          color: fit.colors.side,
          taper: 1,
          outline: fit.outline.map((p) => ({
            x: round(clamp(p.x, 0, 1)),
            y: round(clamp(p.y, 0, 1)),
          })),
          radius: round(clamp(fit.radius, 0, 0.5)),
          material: fit.material,
          paint,
        },
      ],
    };
  }
  if (fit.family === 'box') {
    const w = clamp(fit.w, 0.05, 1);
    const d = clamp(fit.d, 0.05, 1);
    const h = clamp(fit.h, 0.03, 6);
    const paint: Paint[] = [{ kind: 'top', color: fit.colors.top }, ...bandPaint(fit.bands)];
    if (fit.decal) paint.push(fit.decal);
    return {
      label,
      parts: [
        {
          id: 'body',
          shape: 'rbox',
          at: { x: round(0.5 - w / 2), y: round(0.5 - d / 2), z: 0 },
          size: { w: round(w), d: round(d), h: round(h) },
          color: fit.colors.side,
          taper: 1,
          radius: round(clamp(fit.radius, 0, 0.5)),
          material: fit.material,
          paint: paint.slice(0, 6),
        },
      ],
    };
  }
  const R = clamp(fit.radius, 0.03, 0.5);
  const H = clamp(fit.height, 0.05, fit.foliage ? 1.5 : 6);
  const paint: Paint[] = bandPaint(fit.bands);
  if (fit.cap) paint.push({ kind: 'band', from: round(fit.cap.from), to: 1, color: fit.cap.color });
  if (fit.decal) paint.push(fit.decal);
  const body: ItemPart = {
    id: 'body',
    shape: 'lathe',
    at: { x: round(0.5 - R), y: round(0.5 - R), z: 0 },
    size: { w: round(2 * R), d: round(2 * R), h: round(H) },
    color: fit.colors.body,
    taper: 1,
    profile: fit.profile.map((p) => ({ r: round(clamp(p.r, 0, 1)), z: round(clamp(p.z, 0, 1)) })),
    material: fit.material,
  };
  if (paint.length) body.paint = paint.slice(0, 6);
  if (fit.wall > 0) {
    body.wall = round(clamp(fit.wall, 0.02, 0.9));
    body.inside = {
      wall: fit.colors.inside,
      liquid: fit.colors.liquid,
      level: round(clamp(fit.level, 0, 1)),
    };
  }
  const parts: ItemPart[] = [body];
  if (fit.handle) {
    const { top, bottom, thickness } = fit.handle;
    const reach = clamp(fit.handle.reach, 0.04, 1.3 - R);
    const radiusAt = (z: number) => {
      const pr = body.profile!;
      for (let i = 1; i < pr.length; i++)
        if (z <= pr[i]!.z) {
          const a = pr[i - 1]!;
          const b = pr[i]!;
          return (a.r + ((b.r - a.r) * (z - a.z)) / Math.max(1e-6, b.z - a.z)) * R;
        }
      return pr[pr.length - 1]!.r * R;
    };
    // The handle sticks out to the viewer's right: world (1, -1).
    const e = [Math.SQRT1_2, -Math.SQRT1_2];
    const t = clamp(thickness, 0.02, 0.3);
    // The ends stay below the rim and inside the wall, so neither shows in an open top.
    const zt = Math.min(clamp(top, 0.1, 1) * H, H - t);
    const zb = Math.max(t / 2, clamp(Math.min(bottom, top - 0.1), 0, 0.9) * H);
    const sink = fit.wall > 0 ? Math.min(t / 2, fit.wall * R * 0.5) : t / 2;
    const point = (out: number, z: number) => [0.5 + e[0]! * out, 0.5 + e[1]! * out, z];
    const control = [
      point(radiusAt(zt / H) - sink, zt),
      point(radiusAt(zt / H) + reach * 1.33, zt),
      point(radiusAt(zb / H) + reach * 1.33, zb),
      point(radiusAt(zb / H) - sink, zb),
    ];
    const r = t / 2;
    const lo = [0, 1, 2].map((k) => Math.min(...control.map((c) => c[k]!)) - r);
    const hi = [0, 1, 2].map((k) => Math.max(...control.map((c) => c[k]!)) + r);
    lo[2] = Math.max(0, lo[2]!);
    const size = [0, 1, 2].map((k) => Math.max(0.02, hi[k]! - lo[k]!));
    parts.push({
      id: 'handle',
      shape: 'tube',
      at: { x: round(lo[0]!), y: round(lo[1]!), z: round(lo[2]!) },
      size: { w: round(size[0]!), d: round(size[1]!), h: round(size[2]!) },
      color: fit.colors.handle,
      taper: 1,
      radius: round(r),
      path: control.map((c) => ({
        x: round(clamp((c[0]! - lo[0]!) / size[0]!, 0, 1)),
        y: round(clamp((c[1]! - lo[1]!) / size[1]!, 0, 1)),
        z: round(clamp((c[2]! - lo[2]!) / size[2]!, 0, 1)),
      })),
      material: fit.material,
    });
  }
  if (fit.foliage) {
    const w = clamp(R * 2.5, 0.1, 1.4);
    const fh = clamp(fit.foliage.height, 0.1, 1.5);
    parts.push({
      id: 'foliage',
      shape: 'blob',
      at: { x: round(0.5 - w / 2), y: round(0.5 - w / 2), z: round(H * 0.82) },
      size: { w: round(w), d: round(w), h: round(fh) },
      color: fit.foliage.color,
      taper: 1,
      rough: 0.7,
      material: 'matte',
    });
  }
  return { label, parts };
}

/** What Spark says about a crop: a name for its shape and surface, never numbers. */
export const itemClassSchema = z
  .object({
    archetype: archetypeSchema,
    material: z.enum(ITEM_MATERIALS),
    description: z.string().max(240),
    backside: z.string().max(240).nullable(),
  })
  .strict();
export type ItemClass = z.infer<typeof itemClassSchema>;
/** Spark's corrections after comparing the photo with the rendered model. */
export const itemCheckSchema = z
  .object({
    height: z.number(),
    radius: z.number(),
    handleReach: z.number(),
    body: z
      .string()
      .regex(/^#[0-9a-f]{6}$/)
      .nullable(),
    note: z.string().max(240),
  })
  .strict();
export type ItemCheck = z.infer<typeof itemCheckSchema>;
/**
 * Apply Spark's suggested multipliers to a fit, each clamped to ±20% (±30%
 * for the handle), so a check can nudge a model but never redraw it.
 */
export function applyCheck(fit: ArchetypeFit, check: ItemCheck): ArchetypeFit {
  const k = (v: number, lo = 0.8, hi = 1.2) => (Number.isFinite(v) ? clamp(v, lo, hi) : 1);
  if (fit.family === 'cat')
    return {
      ...fit,
      colors: check.body ? { ...fit.colors, body: check.body } : fit.colors,
    };
  if (fit.family === 'flat')
    return {
      ...fit,
      h: fit.h * k(check.height),
      colors: check.body ? { ...fit.colors, side: check.body } : fit.colors,
    };
  if (fit.family === 'box')
    return {
      ...fit,
      h: fit.h * k(check.height),
      d: clamp(fit.d * k(check.radius), 0.05, 1),
      colors: check.body ? { ...fit.colors, side: check.body } : fit.colors,
    };
  return {
    ...fit,
    height: fit.height * k(check.height),
    radius: fit.radius * k(check.radius),
    handle: fit.handle && {
      ...fit.handle,
      reach: fit.handle.reach * k(check.handleReach, 0.7, 1.3),
    },
    colors: check.body ? { ...fit.colors, body: check.body } : fit.colors,
  };
}
/** One line about a fit, for Spark's check and for evidence. */
export function describeFit(fit: ArchetypeFit): string {
  const n = (v: number) => v.toFixed(2);
  if (fit.family === 'cat')
    return `a ${fit.pose} cat in ${fit.colors.body} with ${fit.colors.accent} markings`;
  if (fit.family === 'flat')
    return `a flat shape ${n(fit.w)} wide, ${n(fit.d)} deep and ${n(fit.h)} tall with a ${fit.outline.length}-point outline, ${fit.colors.side} sides and a ${fit.colors.top} top`;
  if (fit.family === 'box')
    return `a box ${n(fit.w)} wide, ${n(fit.d)} deep and ${n(fit.h)} tall, ${fit.colors.side} sides and a ${fit.colors.top} top`;
  return [
    `a turned body ${n(fit.height)} tall with radius ${n(fit.radius)}, colour ${fit.colors.body}`,
    fit.handle ? `a handle reaching ${n(fit.handle.reach)} on the right` : 'no handle',
    fit.bands.length ? `${fit.bands.length} band(s)` : '',
    fit.decal ? 'a printed pattern' : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** A cat model in a pose (`idle` or `sleeping`). */
export function catItem(label = 'Cat', pose: CatPose = 'idle', colors: string[] = []): IsoItem {
  const base = defaultFit('cat', colors) as CatFit;
  return buildItem(label, { ...base, pose });
}

/** A monitor fixture model, with a screen that lights up when `on`. */
export function monitorItem(label = 'Monitor', on = false): IsoItem {
  return {
    label,
    parts: [
      {
        id: 'base',
        shape: 'rbox',
        at: { x: 0.28, y: 0.25, z: 0 },
        size: { w: 0.44, d: 0.5, h: 0.05 },
        color: '#23283c',
        taper: 1,
        radius: 0.15,
        material: 'metal',
      },
      {
        id: 'neck',
        shape: 'rbox',
        at: { x: 0.44, y: 0.3, z: 0.05 },
        size: { w: 0.12, d: 0.14, h: 0.25 },
        color: '#23283c',
        taper: 1,
        radius: 0.1,
        material: 'metal',
      },
      {
        id: 'frame',
        shape: 'rbox',
        at: { x: 0.05, y: 0.36, z: 0.22 },
        size: { w: 0.9, d: 0.12, h: 0.72 },
        color: '#23283c',
        taper: 1,
        radius: 0.06,
        material: 'matte',
      },
      {
        id: 'screen',
        shape: 'rbox',
        at: { x: 0.09, y: 0.43, z: 0.26 },
        size: { w: 0.82, d: 0.07, h: 0.64 },
        color: on ? '#68b5e8' : '#2c3858',
        taper: 1,
        radius: 0.04,
        material: 'gloss',
      },
    ],
  };
}
