import { z } from 'zod';
import { ITEM_MATERIALS, itemPartSchema, type IsoItem, type ItemPart } from './iso-item.js';

/**
 * A model as Spark writes it: our own parts, with every field present (null
 * where a shape doesn't use it), so a strict JSON schema can carry it. Only
 * the current shapes; colour bands are the one paint, as most things are a
 * few flat colours.
 */
const SCULPT_SHAPES = ['lathe', 'rbox', 'tube', 'extrude', 'blob'] as const;
const unit = z.number().min(0).max(1);
export const sculptPartSchema = z
  .object({
    id: z.string().min(1).max(24),
    shape: z.enum(SCULPT_SHAPES),
    at: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict(),
    size: z.object({ w: z.number(), d: z.number(), h: z.number() }).strict(),
    color: z.string().regex(/^#[0-9a-f]{6}$/),
    material: z.enum(ITEM_MATERIALS),
    profile: z.array(z.object({ r: unit, z: unit }).strict()).nullable(),
    path: z.array(z.object({ x: unit, y: unit, z: unit }).strict()).nullable(),
    outline: z.array(z.object({ x: unit, y: unit }).strict()).nullable(),
    radius: z.number().nullable(),
    rough: z.number().nullable(),
    bands: z
      .array(z.object({ from: unit, to: unit, color: z.string().regex(/^#[0-9a-f]{6}$/) }).strict())
      .nullable(),
  })
  .strict();
export type SculptPart = z.infer<typeof sculptPartSchema>;
export const sculptSchema = z
  .object({
    parts: z.array(sculptPartSchema).max(12),
    /** What it changed, in a sentence. */
    note: z.string().max(240),
  })
  .strict();
export type Sculpt = z.infer<typeof sculptSchema>;

const clamp = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

/**
 * Spark's parts as ours: numbers kept in range, nulls left out, and any part
 * that still isn't a valid one dropped. Null when nothing is left.
 */
export function fromSculpt(label: string, sculpt: Sculpt): IsoItem | null {
  const parts: ItemPart[] = [];
  const ids = new Set<string>();
  for (const s of sculpt.parts) {
    let id = s.id.trim() || 'part';
    for (let n = 2; ids.has(id); n++) id = `${s.id.slice(0, 20)}-${n}`;
    const profile = s.profile ? [...s.profile].sort((a, b) => a.z - b.z).slice(0, 16) : undefined;
    const part = {
      id,
      shape: s.shape,
      at: { x: clamp(s.at.x, -0.5, 1.5), y: clamp(s.at.y, -0.5, 1.5), z: clamp(s.at.z, 0, 6) },
      size: {
        w: clamp(s.size.w, 0.02, 3),
        d: clamp(s.size.d, 0.02, 3),
        h: clamp(s.size.h, 0.02, 6),
      },
      color: s.color,
      taper: 1,
      material: s.material,
      ...(profile && profile.length >= 2 ? { profile } : {}),
      ...(s.path ? { path: s.path.slice(0, 4) } : {}),
      ...(s.outline ? { outline: s.outline.slice(0, 12) } : {}),
      ...(s.radius !== null ? { radius: clamp(s.radius, 0, 0.5) } : {}),
      ...(s.rough !== null ? { rough: clamp(s.rough, 0, 1) } : {}),
      ...(s.bands?.length
        ? {
            paint: s.bands
              .filter((b) => b.to > b.from)
              .slice(0, 6)
              .map((b) => ({ kind: 'band' as const, from: b.from, to: b.to, color: b.color })),
          }
        : {}),
    };
    const ok = itemPartSchema.safeParse(part);
    if (!ok.success) continue;
    ids.add(id);
    parts.push(ok.data);
  }
  return parts.length ? { label, parts } : null;
}

/**
 * Our parts as Spark writes them, for the model it starts from. The first
 * shapes are written as the ones they are drawn as: a cylinder or cone as a
 * lathe, a box or lid as a rounded box, and a handle as a C-shaped tube.
 */
export function toSculpt(item: IsoItem): SculptPart[] {
  return item.parts.map((p) => {
    const base = {
      id: p.id,
      at: p.at,
      size: p.size,
      color: p.color,
      material: p.material ?? 'matte',
      profile: p.profile ?? null,
      path: p.path ?? null,
      outline: p.outline ?? null,
      radius: p.radius ?? null,
      rough: p.rough ?? null,
      bands:
        p.paint?.flatMap((q) =>
          q.kind === 'band' ? [{ from: q.from, to: q.to, color: q.color }] : [],
        ) ?? null,
    };
    switch (p.shape) {
      case 'cylinder':
        return {
          ...base,
          shape: 'lathe',
          profile: [
            { r: 1, z: 0 },
            { r: 1, z: 1 },
          ],
        };
      case 'cone': {
        const k = Math.max(1, p.taper);
        return {
          ...base,
          shape: 'lathe',
          profile: [
            { r: 1 / k, z: 0 },
            { r: Math.min(1, p.taper / k), z: 1 },
          ],
        };
      }
      case 'box':
        return { ...base, shape: 'rbox', radius: 0.08 };
      case 'lid':
        return { ...base, shape: 'rbox', radius: 0.1 };
      case 'handle': {
        const alongX = p.size.w >= p.size.d;
        const out = (alongX ? p.at.x + p.size.w / 2 : p.at.y + p.size.d / 2) >= 0.5;
        const [near, far] = out ? [0, 1] : [1, 0];
        const pt = (a: number, z: number) => (alongX ? { x: a, y: 0.5, z } : { x: 0.5, y: a, z });
        return {
          ...base,
          shape: 'tube',
          path: [pt(near, 0.85), pt(far, 0.85), pt(far, 0.15), pt(near, 0.15)],
          radius: Math.min(0.5, (alongX ? p.size.d : p.size.w) / 2),
        };
      }
      default:
        return { ...base, shape: p.shape };
    }
  });
}
/** Our part format, as Spark is told it, the same on every look. */
const FORMAT = [
  'Coordinates: x left to right and y back to front across the footprint, from 0 to 1; z up, in the same units. Each part has a box: at is its back-left-bottom corner, size its width, depth and height.',
  'Shapes:',
  '- lathe: a side profile turned about the box’s vertical axis, for round bodies, pots, cups and bases. profile: points r, z from bottom to top, z a share of the box’s height and r a share of its half-width, so r = 1 reaches the box’s sides: a plain cylinder filling its box is [{r: 1, z: 0}, {r: 1, z: 1}]. The box sets the size; keep r near 1 unless the shape narrows.',
  '- rbox: a box with rounded edges, for screens, books and panels. radius: a share of its smallest side.',
  '- tube: a round tube along a Bézier curve, for stands, cables, arms, handles and rings. path: 2 to 4 points as shares of the box; the tube starts at the first point and ends at the last, and the middle points only pull the curve toward them (it does not pass through them). radius in item units. A curve pulled toward a point gets about three quarters of the way there, so a tube’s box should be a little larger than the tube looks. A closed ring or loop is two tubes that start at the same point and end at the same point, bulging to opposite sides: a tall upright loop is [{x: 0.5, y: 0.5, z: 0}, {x: 0, y: 0.5, z: 0.15}, {x: 0, y: 0.5, z: 0.85}, {x: 0.5, y: 0.5, z: 1}] and the same with x 1 for the other half, which reaches out to about an eighth of the box from each side.',
  '- extrude: a footprint outline as shares of the box, pushed up, for flat odd shapes.',
  '- blob: a lumpy ellipsoid, for foliage and soft things. rough: 0 to 1.',
  'Set fields a shape doesn’t use to null.',
  'Give each part its main colour as lowercase #rrggbb and a material (matte, gloss, metal, glass, fabric, wood); bands paint horizontal stripes on it, from and to as shares of its height. Use few parts and get the big shapes right first.',
];
/** What Spark is asked: our part format, and how to build the thing from its picture. */
export function sculptPrompt(label: string, size: { w: number; d: number; h: number }): string {
  return [
    `Model the ${label.toLowerCase()} in the first image as a small parametric 3D model, made of at most 12 parts. The second image is how the current model renders from the same angle; its parts are given below as JSON. Start from them: keep what is right, fix what is wrong, and add or remove parts so the render matches the first image.`,
    `It stands ${size.w.toFixed(2)} wide, ${size.d.toFixed(2)} deep and ${size.h.toFixed(2)} tall, as its footprint's longer side is 1.`,
    ...FORMAT,
    'Say in note what you changed.',
  ].join('\n');
}
/** What Spark is asked on its second look: its own model rendered beside the picture. */
export function sculptCheckPrompt(label: string): string {
  return [
    `The first image is the ${label.toLowerCase()}; the second is your model of it rendered from the same angle, with its parts below as JSON. Correct the parts so the render matches the first image better: proportions, widths, positions, colours and any missing or unclosed piece.`,
    ...FORMAT,
    'Say in note what you changed.',
  ].join('\n');
}

/** One step of a long job, as the page shows it while the job runs. */
export interface JobStep {
  id: string;
  label: string;
  state: 'waiting' | 'running' | 'done' | 'failed';
  detail?: string;
  /** A small picture of what the step made, as a data URL. */
  image?: string;
  startedAt?: string;
  endedAt?: string;
}
export interface Job {
  id: string;
  steps: JobStep[];
  createdAt: string;
  done: boolean;
}
