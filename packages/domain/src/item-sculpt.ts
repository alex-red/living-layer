import { z } from 'zod';
import type { ProductFacts } from './facts.js';
import { bezier, clampFiniteOrLow, textHash } from './math.js';
import {
  ITEM_MATERIALS,
  itemPartSchema,
  printSchema,
  type IsoItem,
  type ItemPart,
  type Paint,
} from './iso-item.js';
import { printDecal, printKey, type Ink } from './item-print.js';

/**
 * A model as Spark writes it: our own parts, with every field present (null
 * where a shape doesn't use it), so a strict JSON schema can carry it. Only
 * the current shapes; colour bands and prints (lettering, set in type on the
 * server) are the paint, as most things are a few flat colours and a logo.
 */
const SCULPT_SHAPES = ['lathe', 'rbox', 'tube', 'extrude', 'blob'] as const;
const unit = z.number().min(0).max(1);
/** Answers from before prints, and mocks of them, have none: that is null. */
const withPrints = (v: unknown) =>
  v && typeof v === 'object' && !('prints' in v) ? { ...v, prints: null } : v;
const sculptPartSchema = z.preprocess(
  withPrints,
  z
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
      wall: z.number().nullable(),
      inside: z
        .object({
          wall: z.string().regex(/^#[0-9a-f]{6}$/),
          liquid: z
            .string()
            .regex(/^#[0-9a-f]{6}$/)
            .nullable(),
          level: unit,
        })
        .strict()
        .nullable(),
      bands: z
        .array(
          z.object({ from: unit, to: unit, color: z.string().regex(/^#[0-9a-f]{6}$/) }).strict(),
        )
        .nullable(),
      prints: z.array(printSchema).max(3).nullable(),
    })
    .strict(),
);
export type SculptPart = z.infer<typeof sculptPartSchema>;
/** A model of at most `max` parts as Spark writes it. */
export const sculptSchemaOf = (max: number) =>
  z
    .object({
      parts: z.array(sculptPartSchema).max(max),
      /** What it changed, in a sentence. */
      note: z.string().max(240),
    })
    .strict();
const sculptSchema = sculptSchemaOf(12);
export type Sculpt = z.infer<typeof sculptSchema>;

/** Every print in a sculpt, to be set in type before `fromSculpt`. */
export const sculptPrints = (sculpt: Sculpt) => sculpt.parts.flatMap((p) => p.prints ?? []);
/**
 * Spark's parts as ours: numbers kept in range, nulls left out, and any part
 * that still isn't a valid one dropped. Null when nothing is left. A print
 * becomes a decal when `inks` has it set (`printKey`), else it is left off.
 */
export function fromSculpt(
  label: string,
  sculpt: Sculpt,
  inks: ReadonlyMap<string, Ink> = new Map(),
): IsoItem | null {
  const parts: ItemPart[] = [];
  const ids = new Set<string>();
  for (const s of sculpt.parts) {
    let id = s.id.trim() || 'part';
    for (let n = 2; ids.has(id); n++) id = `${s.id.slice(0, 20)}-${n}`;
    const profile = s.profile ? [...s.profile].sort((a, b) => a.z - b.z).slice(0, 16) : undefined;
    const part = {
      id,
      shape: s.shape,
      at: {
        x: clampFiniteOrLow(s.at.x, -0.5, 1.5),
        y: clampFiniteOrLow(s.at.y, -0.5, 1.5),
        z: clampFiniteOrLow(s.at.z, 0, 6),
      },
      size: {
        w: clampFiniteOrLow(s.size.w, 0.02, 3),
        d: clampFiniteOrLow(s.size.d, 0.02, 3),
        h: clampFiniteOrLow(s.size.h, 0.02, 6),
      },
      color: s.color,
      taper: 1,
      material: s.material,
      ...(profile && profile.length >= 2 ? { profile } : {}),
      ...(s.path ? { path: s.path.slice(0, 4) } : {}),
      ...(s.outline ? { outline: s.outline.slice(0, 12) } : {}),
      ...(s.radius !== null ? { radius: clampFiniteOrLow(s.radius, 0, 0.5) } : {}),
      ...(s.rough !== null ? { rough: clampFiniteOrLow(s.rough, 0, 1) } : {}),
      // An open top, and what shows inside it: only a lathe has one.
      ...(s.shape === 'lathe' && s.wall ? { wall: clampFiniteOrLow(s.wall, 0.02, 0.9) } : {}),
      ...(s.shape === 'lathe' && s.wall && s.inside ? { inside: s.inside } : {}),
    };
    const bands: Paint[] = (s.bands ?? [])
      .filter((b) => b.to > b.from)
      .slice(0, 6)
      .map((b) => ({ kind: 'band' as const, from: b.from, to: b.to, color: b.color }));
    const ok = itemPartSchema.safeParse(bands.length ? { ...part, paint: bands } : part);
    if (!ok.success) continue;
    const decals = (s.prints ?? []).flatMap((print) => {
      const ink = inks.get(printKey(print));
      const decal = ink && printDecal(ok.data, print, ink);
      return decal ? [decal] : [];
    });
    const printed = decals.length
      ? itemPartSchema.safeParse({ ...ok.data, paint: [...bands, ...decals].slice(0, 6) })
      : null;
    if (printed?.success) ok.data = printed.data;
    ids.add(id);
    parts.push(ok.data);
  }
  return parts.length ? { label, parts: seatHandles(openTops(parts)) } : null;
}

/** A turned part's radius at height z, in item units. */
function latheRadius(body: Extract<ItemPart, { shape: 'lathe' }>, z: number): number {
  const v = (z - body.at.z) / body.size.h;
  const pr = body.profile;
  const i = pr.findIndex((q) => q.z >= v);
  let r = pr[i < 0 ? pr.length - 1 : 0]!.r;
  if (i > 0) {
    const a = pr[i - 1]!;
    const b = pr[i]!;
    r = a.r + ((b.r - a.r) * (v - a.z)) / Math.max(1e-6, b.z - a.z);
  }
  return (r * Math.min(body.size.w, body.size.d)) / 2;
}
/**
 * A handle whose loop hardly clears a turned body, as when Spark moves the
 * body and leaves its handle behind, is pushed straight out from the body's
 * axis until its ends meet the body's surface.
 */
function seatHandles(parts: ItemPart[]): ItemPart[] {
  return parts.map((tube) => {
    if (tube.shape !== 'tube' || tube.path.length < 2) return tube;
    const at = (q: { x: number; y: number; z: number }) => ({
      x: tube.at.x + q.x * tube.size.w,
      y: tube.at.y + q.y * tube.size.d,
      z: tube.at.z + q.z * tube.size.h,
    });
    const control = tube.path.map((q): [number, number, number] => [q.x, q.y, q.z]);
    const curve = Array.from({ length: 9 }, (_, i) => {
      const [x, y, z] = bezier(control, i / 8);
      return at({ x, y, z });
    });
    const radius = tube.radius ?? 0;
    for (const body of parts) {
      if (body.shape !== 'lathe') continue;
      const cx = body.at.x + body.size.w / 2;
      const cy = body.at.y + body.size.d / 2;
      const off = (p: { x: number; y: number; z: number }) =>
        Math.hypot(p.x - cx, p.y - cy) - latheRadius(body, p.z);
      const inZ = (p: { z: number }) => p.z >= body.at.z && p.z <= body.at.z + body.size.h;
      // A real handle stands well off its body: by a few times its thickness at least.
      const clear = Math.max(radius * 3, latheRadius(body, curve[4]!.z) * 0.4);
      if (!curve.every(inZ) || curve.some((p) => off(p) > clear)) continue;
      // Out along the way the loop's middle leans from the axis.
      const mid = curve[4]!;
      const len = Math.hypot(mid.x - cx, mid.y - cy);
      if (len < 1e-3) continue;
      const [dx, dy] = [(mid.x - cx) / len, (mid.y - cy) / len];
      const ends = [curve[0]!, curve[8]!];
      const shift = Math.max(
        ...ends.map((e) => latheRadius(body, e.z) - ((e.x - cx) * dx + (e.y - cy) * dy)),
      );
      if (shift <= 0) continue;
      const x = clampFiniteOrLow(tube.at.x + dx * shift, -0.5, 1.5);
      const y = clampFiniteOrLow(tube.at.y + dy * shift, -0.5, 1.5);
      return { ...tube, at: { ...tube.at, x, y } };
    }
    return tube;
  });
}

/**
 * A closed lathe with a thin lathe inside it near its top is a vessel and
 * what its opening shows: its top is opened, and the disc's colour becomes
 * its inner wall, which a closed body would hide. Empty: from above the rim a
 * dark glaze and a drink look alike, and a drink is only what Spark says is
 * in it (inside.liquid).
 */
function openTops(parts: ItemPart[]): ItemPart[] {
  const gone = new Set<string>();
  const out = parts.map((body) => {
    if (body.shape !== 'lathe' || body.wall) return body;
    const top = body.at.z + body.size.h;
    const fill = parts.find(
      (p) =>
        p !== body &&
        p.shape === 'lathe' &&
        !gone.has(p.id) &&
        p.size.h <= body.size.h * 0.15 &&
        p.size.w < body.size.w &&
        p.at.x >= body.at.x - 0.01 &&
        p.at.y >= body.at.y - 0.01 &&
        p.at.x + p.size.w <= body.at.x + body.size.w + 0.01 &&
        p.at.y + p.size.d <= body.at.y + body.size.d + 0.01 &&
        p.at.z + p.size.h >= body.at.z + body.size.h * 0.6 &&
        p.at.z + p.size.h <= top + 0.01,
    );
    if (!fill) return body;
    gone.add(fill.id);
    return {
      ...body,
      wall: Math.min(0.3, Math.max(0.04, 1 - fill.size.w / body.size.w)),
      inside: { wall: fill.color, liquid: null, level: 0 },
    };
  });
  return out.filter((p) => !gone.has(p.id));
}

/**
 * Our parts as Spark writes them, for the model it starts from.
 */
export function toSculpt(item: IsoItem): SculptPart[] {
  return item.parts.map((p) => {
    const base = {
      id: p.id,
      at: p.at,
      size: p.size,
      color: p.color,
      material: p.material ?? 'matte',
      profile: p.shape === 'lathe' ? p.profile : null,
      path: p.shape === 'tube' ? p.path : null,
      outline: p.shape === 'extrude' ? p.outline : null,
      radius:
        p.shape === 'rbox' || p.shape === 'tube' || p.shape === 'extrude'
          ? (p.radius ?? null)
          : null,
      rough: p.shape === 'blob' ? (p.rough ?? null) : null,
      wall: p.shape === 'lathe' ? (p.wall ?? null) : null,
      inside: p.shape === 'lathe' ? (p.inside ?? null) : null,
      bands:
        p.paint?.flatMap((q) =>
          q.kind === 'band' ? [{ from: q.from, to: q.to, color: q.color }] : [],
        ) ?? null,
      prints: p.paint?.flatMap((q) => (q.kind === 'decal' && q.print ? [q.print] : [])) ?? null,
    };
    return { ...base, shape: p.shape };
  });
}
/** Our part format, as Spark is told it, the same on every look. */
export const SCULPT_FORMAT = [
  'Coordinates: x left to right and y back to front across the footprint, from 0 to 1; z up, in the same units. Each part has a box: at is its back-left-bottom corner, size its width, depth and height.',
  'Shapes:',
  '- lathe: a side profile turned about the box’s vertical axis, for round bodies, pots, cups and bases. profile: points r, z from bottom to top, z a share of the box’s height and r a share of its half-width, so r = 1 reaches the box’s sides: a plain cylinder filling its box is [{r: 1, z: 0}, {r: 1, z: 1}]. The box sets the size; keep r near 1 unless the shape narrows. wall opens its top, with walls that thick as a share of the radius (a mug or cup about 0.1, a bowl or pot 0.05 to 0.1); null closes it. inside, for an open lathe: wall is the colour of the inner wall, liquid the colour of a drink or what else fills it, and level how full it is, a share of its height. A dark inside is usually the inside’s own colour (a glaze, or shade), not a drink: set liquid only when the picture clearly shows something in it, else null with level 0. Model what is in a vessel as its inside, not as a separate part.',
  '- rbox: a box with rounded edges, for screens, books and panels. radius: a share of its smallest side.',
  '- tube: a round tube along a Bézier curve, for stands, cables, arms, handles and rings. path: 2 to 4 points as shares of the box; the tube starts at the first point and ends at the last, and the middle points only pull the curve toward them (it does not pass through them). radius in item units. A curve pulled toward a point gets about three quarters of the way there, so a tube’s box should be a little larger than the tube looks. A closed ring or loop is two tubes that start at the same point and end at the same point, bulging to opposite sides: a tall upright loop is [{x: 0.5, y: 0.5, z: 0}, {x: 0, y: 0.5, z: 0.15}, {x: 0, y: 0.5, z: 0.85}, {x: 0.5, y: 0.5, z: 1}] and the same with x 1 for the other half, which reaches out to about an eighth of the box from each side.',
  '- extrude: a footprint outline as shares of the box, pushed up, for flat odd shapes.',
  '- blob: a lumpy ellipsoid, for foliage and soft things. rough: 0 to 1.',
  'Set fields a shape doesn’t use to null.',
  'Give each part its main colour as lowercase #rrggbb and a material (matte, gloss, metal, glass, fabric, wood); bands paint horizontal stripes on it, from and to as shares of its height. Use few parts and get the big shapes right first.',
  'prints: lettering or a logo’s words printed on a part, which we set in type and wrap round it: text (lines broken with \\n, as the picture breaks them), style (script for joined handwriting, sans, serif, or bold), color, around (the way its middle faces in degrees seen from above: 0 the front, y = 1; 90 the right, x = 1; 180 the back; 270 the left), at (its middle’s height) and size (its block’s height, from the top line to the underline), both shares of the part’s height, and underline. A print is paint, never a part of its own: don’t model letters or a logo as boxes, and where the current model has boxes standing for printed letters or a logo, remove them and print it instead. When the picture is too small to read and the person names the words, print those. Null when nothing is printed.',
];
/** What Spark is asked: our part format, and how to build the thing from its picture. */
/**
 * What the person said about the thing before modelling it ("it's a Dyson
 * bladeless fan"), and what a lookup found of that product: Spark models by
 * both, the picture still deciding where they disagree.
 */
interface SculptContext {
  note?: string | null;
  facts?: ProductFacts | null;
  /** The picture has no colour (a night or infrared camera): colours come from the words. */
  greyscale?: boolean;
  /** The picture is a few dozen pixels across, cut from a photo of a whole room. */
  small?: boolean;
}
function contextLines({ note, facts, greyscale, small }: SculptContext = {}): string[] {
  const lines: string[] = [];
  // From across a room a computer mouse is a small blob, and its name alone once made an animal.
  if (small)
    lines.push(
      'It was cut from a photo of a room, so it is small and blurry: it is a thing found on a desk, a shelf or the floor, and its name means that thing (a mouse is a computer mouse). Model the object, not a creature or a toy, unless its name says so.',
    );
  if (greyscale)
    lines.push(
      'The first image is greyscale, from a night or infrared camera: use it for shape only, and take colours from what the person says or what is known of the product, else plain neutral ones.',
    );
  if (note) lines.push(`The person says about it: "${note}". Follow it where the picture allows.`);
  if (!facts) return lines;
  const known = [
    facts.name ? `It is the ${facts.name}.` : '',
    facts.sizeCm ? `It measures ${facts.sizeCm.w} × ${facts.sizeCm.d} × ${facts.sizeCm.h} cm.` : '',
    facts.parts?.length
      ? `Its parts: ${facts.parts.map((p) => (p.count && p.count > 1 ? `${p.count} × ${p.name}` : p.name)).join(', ')}.`
      : '',
    facts.colors?.length
      ? `Its colours: ${facts.colors.map((c) => `${c.name} ${c.hex}`).join(', ')}.`
      : '',
    facts.materials?.length ? `Its materials: ${facts.materials.join(', ')}.` : '',
  ].filter(Boolean);
  if (known.length)
    lines.push(
      `What is known of the product: ${known.join(' ')} The picture wins where they differ.`,
    );
  return lines;
}
export function sculptPrompt(
  label: string,
  size: { w: number; d: number; h: number },
  context?: SculptContext,
): string {
  return [
    `Model the ${label.toLowerCase()} in the first image as a small parametric 3D model, made of at most 12 parts. The second image is how the current model renders from the same angle; its parts are given below as JSON. Start from them: keep what is right, fix what is wrong, and add or remove parts so the render matches the first image.`,
    `It stands ${size.w.toFixed(2)} wide, ${size.d.toFixed(2)} deep and ${size.h.toFixed(2)} tall, as its footprint's longer side is 1.`,
    ...contextLines(context),
    ...SCULPT_FORMAT,
    'Say in note what you changed.',
  ].join('\n');
}
/**
 * Which sculpt prompt a run sent: a hash of its fixed lines and format, so
 * the run log tells one prompt from the next.
 */
export const SCULPT_PROMPT_VERSION = `sculpt-${textHash(
  sculptPrompt('thing', { w: 1, d: 1, h: 1 }, { note: 'note', small: true, greyscale: true }),
)}`;
/** One step of a long job, as the page shows it while the job runs. */
interface JobStep {
  id: string;
  label: string;
  state: 'waiting' | 'running' | 'done' | 'failed' | 'stopped';
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
  /** The page stopped it before it finished. */
  stopped?: boolean;
  /** What it was, for its history: "Drawing the room". */
  title?: string;
  mode?: 'demo' | 'live';
  /** The evidence runs (model calls) it made, in order. */
  runIds?: string[];
  /** How it ended, once it has. */
  outcome?: 'done' | 'failed' | 'stopped';
  /** Why it failed. */
  error?: string;
  endedAt?: string;
}
