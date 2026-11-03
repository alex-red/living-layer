import { clamp } from './math.js';
import { z } from 'zod';
import type { Detection, Segmentation } from './api.js';
import type { ZoneRect } from './memory.js';
import { ISO_TONES, PROP_FORMS, type PropForm } from './iso-furniture.js';
import { fixtureRecipeSchema, type FixtureRecipe } from './recipe.js';
import { TEMPLATE_IDS, type TemplateId } from './iso-templates.js';

/**
 * Isometric scenes: a typed spec of simple props on a tile grid, drawn by the
 * web as SVG. World x runs down-right on screen, y down-left, z up; one unit
 * is one tile. Nothing here is generated: presets are written by hand and a
 * homography from four clicked corners ties a real photo to one surface.
 */
export const ISO_TILE = { width: 64, height: 32 } as const;
/** Screen pixels per unit of height, close to a tile edge's on-screen length. */
export const ISO_RISE = 36;

export const isoSceneKindSchema = z.enum(['office', 'desk', 'fridge']);
export type IsoSceneKind = z.infer<typeof isoSceneKindSchema>;
export type IsoTone =
  | 'floor'
  | 'wall'
  | 'wood'
  | 'steel'
  | 'fabric'
  | 'paper'
  | 'book'
  | 'glass'
  | 'appliance'
  | 'plant'
  | 'ceramic'
  | 'screen'
  | 'soil';
export interface IsoVec {
  x: number;
  y: number;
  z: number;
}
export interface IsoSize {
  w: number;
  d: number;
  h: number;
}
export interface IsoProp {
  id: string;
  label: string;
  shape: 'prism' | 'cylinder';
  /** The corner nearest the origin; a cylinder fills the footprint `w × d`. */
  at: IsoVec;
  size: IsoSize;
  tone: IsoTone;
  /** The placed template this prop belongs to; a group moves and turns as one. */
  group: string;
  template?: TemplateId;
  /** `lamp` glows warm when a lamp action on its light is confirmed. */
  role?: 'lamp';
  /** The light a lamp stands for; without one, the scene's main light. */
  lightId?: string;
  /** Spark may say whether it can see this prop; required props are always drawn. */
  optional?: boolean;
  /** Faces painted from the photo the scene was drafted from: evidence assets, or data URLs. */
  texture?: { top?: string; front?: string; side?: string };
  /** The model drawn in the box (see iso-furniture); without one, a plain box. */
  form?: PropForm;
  /** A model as data instead of a form (see recipe.ts); drawn in place of `form`. */
  recipe?: FixtureRecipe;
  /** Quarter turns clockwise from the model's own facing. */
  turns?: number;
  /** Its draw layer, shared by its group: higher is drawn over lower where they meet. */
  layer?: number;
}
/** A flat, horizontal place objects can rest on, in tile space. */
export interface IsoSurface {
  id: string;
  label: string;
  propId: string;
  rect: { x: number; y: number; w: number; d: number };
  z: number;
}
export interface IsoScene {
  /** `custom`: built by a person or drafted by Spark, kept in desk memory. */
  kind: IsoSceneKind | 'custom';
  label: string;
  grid: { w: number; d: number };
  props: IsoProp[];
  surfaces: IsoSurface[];
}

export interface IsoScreen {
  sx: number;
  sy: number;
}
export function toIso({ x, y, z }: IsoVec): IsoScreen {
  return {
    sx: ((x - y) * ISO_TILE.width) / 2,
    sy: ((x + y) * ISO_TILE.height) / 2 - z * ISO_RISE,
  };
}
/** The world point at height `z` that lands on a screen point. */
export function fromIso({ sx, sy }: IsoScreen, z = 0): IsoVec {
  const a = sx / (ISO_TILE.width / 2);
  const b = (sy + z * ISO_RISE) / (ISO_TILE.height / 2);
  return { x: (a + b) / 2, y: (b - a) / 2, z };
}

export interface IsoBox {
  at: IsoVec;
  size: IsoSize;
  /** Its draw layer, like a z-index: a higher one is drawn over a lower one wherever they meet. */
  layer?: number;
}
/** How far a person can bring a thing forward or send it back. */
export const MAX_LAYER = 9;
export const layerSchema = z.number().int().min(-MAX_LAYER).max(MAX_LAYER);
/**
 * Draw order: layer by layer from the lowest, and within a layer back to
 * front, for boxes that don't intersect. Two boxes can only cover each other
 * when their `x - y` spans overlap on screen; then the one fully behind on
 * some axis, and in front on none, goes first. A layer is the way out when
 * boxes do intersect, or a thin thing hides in a bigger one's box.
 */
export function depthOrder<T extends IsoBox>(boxes: T[]): T[] {
  const layers = [...new Set(boxes.map((b) => b.layer ?? 0))].sort((a, b) => a - b);
  return layers.flatMap((l) => backToFront(boxes.filter((b) => (b.layer ?? 0) === l)));
}
/** A group's draw layer in a scene: its main prop's, 0 when it has none. */
export function groupLayer(scene: Pick<IsoScene, 'props'>, g: string): number {
  return (
    (scene.props.find((p) => p.group === g && p.id === g) ?? scene.props.find((p) => p.group === g))
      ?.layer ?? 0
  );
}
/** The scene with a group moved to another draw layer (within ±MAX_LAYER), every prop of it at once. */
export function withGroupLayer<S extends Pick<IsoScene, 'props'>>(
  scene: S,
  g: string,
  layer: number,
): S {
  const l = Math.max(-MAX_LAYER, Math.min(MAX_LAYER, Math.round(layer)));
  return {
    ...scene,
    props: scene.props.map((p) => {
      if (p.group !== g) return p;
      const { layer: _, ...rest } = p;
      return l ? { ...rest, layer: l } : rest;
    }),
  };
}
/**
 * How far a box's base may sink into the box under it and still stand on it,
 * in tiles (about a centimetre): a recipe desk's top part can end a millimetre
 * below its box, and a keyboard on that top was drawn under the desk.
 */
const RESTS_ON = 0.03;
function backToFront<T extends IsoBox>(boxes: T[]): T[] {
  const span = (b: IsoBox): [number, number] => [
    b.at.x - b.at.y - b.size.d,
    b.at.x + b.size.w - b.at.y,
  ];
  const behind = (a: IsoBox, b: IsoBox) =>
    a.at.x + a.size.w <= b.at.x + 1e-9 ||
    a.at.y + a.size.d <= b.at.y + 1e-9 ||
    a.at.z + a.size.h <= b.at.z + RESTS_ON;
  const before = boxes.map(() => [] as number[]);
  boxes.forEach((a, i) =>
    boxes.forEach((b, j) => {
      if (i === j) return;
      const [a0, a1] = span(a);
      const [b0, b1] = span(b);
      if (a1 <= b0 + 1e-9 || b1 <= a0 + 1e-9) return;
      // Behind on one axis but in front on another means neither can cover
      // the other (one is lower and nearer), so either order is right.
      if (behind(a, b) && !behind(b, a)) before[j]!.push(i);
    }),
  );
  const state = boxes.map(() => 0);
  const order: T[] = [];
  const visit = (i: number) => {
    if (state[i]) return; // 1 = visiting: a cycle, broken by input order
    state[i] = 1;
    before[i]!.forEach(visit);
    state[i] = 2;
    order.push(boxes[i]!);
  };
  boxes.forEach((_, i) => visit(i));
  return order;
}

// Frame pixels, clockwise from the surface's back-left corner.
export const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export type Point = z.infer<typeof pointSchema>;
export type Quad = [Point, Point, Point, Point];
type Homography = [number, number, number, number, number, number, number, number, number];

/** Solve `A·x = b` in place by Gaussian elimination; null when singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[pivot]![c]!)) pivot = r;
    if (Math.abs(a[pivot]![c]!) < 1e-12) return null;
    [a[c], a[pivot]] = [a[pivot]!, a[c]!];
    [b[c], b[pivot]] = [b[pivot]!, b[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = a[r]![c]! / a[c]![c]!;
      for (let k = c; k < n; k++) a[r]![k]! -= f * a[c]![k]!;
      b[r]! -= f * b[c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let k = r + 1; k < n; k++) s -= a[r]![k]! * x[k]!;
    x[r] = s / a[r]![r]!;
  }
  return x;
}
/** The projective map taking four source points onto four target points. */
export function homography(from: Quad, to: Quad): Homography | null {
  const a: number[][] = [];
  const b: number[] = [];
  from.forEach(({ x, y }, i) => {
    const { x: u, y: v } = to[i]!;
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  });
  const h = solve(a, b);
  return h ? ([...h, 1] as Homography) : null;
}
export function applyHomography(h: Homography, { x, y }: Point): Point {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}
export function invertHomography(h: Homography): Homography | null {
  const [a, b, c, d, e, f, g, i, j] = h;
  const A = e * j - f * i;
  const B = -(d * j - f * g);
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const m = [
    A,
    -(b * j - c * i),
    b * f - c * e,
    B,
    a * j - c * g,
    -(a * f - c * d),
    C,
    -(a * i - b * g),
    a * e - b * d,
  ].map((v) => v / det);
  return m.map((v) => v / m[8]!) as Homography;
}
/** True for a simple convex quad of reasonable size, so the map can't fold over itself. */
export function quadIsConvex(q: Quad, minArea = 1): boolean {
  let sign = 0;
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i]!;
    const n = q[(i + 1) % 4]!;
    const m = q[(i + 2) % 4]!;
    const cross = (n.x - p.x) * (m.y - n.y) - (n.y - p.y) * (m.x - n.x);
    if (Math.abs(cross) < 1e-9) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
    area += p.x * n.y - n.x * p.y;
  }
  return Math.abs(area) / 2 >= minArea;
}

const lightIdSchema = z.string().regex(/^light\.[a-z0-9_]+$/);
const vec = z
  .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
  .strict();
/** A face texture: `runId/tex-N.png` in the evidence store. */
export const textureRef = z.string().regex(/^[a-z0-9-]{1,64}\/tex-\d{1,4}\.png$/);
const isoPropSchema = z
  .object({
    id: z.string().min(1).max(48),
    label: z.string().min(1).max(60),
    shape: z.enum(['prism', 'cylinder']),
    at: vec,
    size: z
      .object({
        w: z.number().min(0.01).max(16),
        d: z.number().min(0.01).max(16),
        h: z.number().min(0.01).max(8),
      })
      .strict(),
    tone: z.enum(ISO_TONES),
    group: z.string().min(1).max(32),
    template: z.enum(TEMPLATE_IDS).optional(),
    role: z.literal('lamp').optional(),
    lightId: lightIdSchema.optional(),
    optional: z.boolean().optional(),
    /** Faces painted from the photo the scene was drafted from, as evidence assets. */
    texture: z
      .object({ top: textureRef, front: textureRef, side: textureRef })
      .partial()
      .strict()
      .optional(),
    form: z.enum(PROP_FORMS).optional(),
    recipe: fixtureRecipeSchema.optional(),
    turns: z.number().int().min(0).max(3).optional(),
    /** Its draw layer, shared by its group: higher is drawn over lower where they meet. */
    layer: layerSchema.optional(),
  })
  .strict() satisfies z.ZodType<IsoProp>;
/**
 * A scene a person built: every prop inside the grid, ids unique, and every
 * surface resting on a prop of the scene.
 */
export const isoSceneSchema = z
  .object({
    kind: z.literal('custom'),
    label: z.string().min(1).max(60),
    grid: z
      .object({ w: z.number().int().min(2).max(16), d: z.number().int().min(2).max(16) })
      .strict(),
    props: z.array(isoPropSchema).min(1).max(120),
    surfaces: z
      .array(
        z
          .object({
            id: z.string().min(1).max(48),
            label: z.string().min(1).max(60),
            propId: z.string().min(1).max(48),
            rect: z
              .object({
                x: z.number(),
                y: z.number(),
                w: z.number().positive(),
                d: z.number().positive(),
              })
              .strict(),
            z: z.number().min(0).max(16),
          })
          .strict(),
      )
      .max(24),
  })
  .strict()
  .refine(
    (s) =>
      s.props.every(
        (p) =>
          p.at.x >= -0.5 &&
          p.at.y >= -0.5 &&
          p.at.z >= 0 &&
          p.at.x + p.size.w <= s.grid.w + 0.5 &&
          p.at.y + p.size.d <= s.grid.d + 3,
      ),
    { message: 'Every prop must stand inside the grid.' },
  )
  .refine((s) => new Set(s.props.map((p) => p.id)).size === s.props.length, {
    message: 'Prop ids must be unique.',
  })
  .refine(
    (s) =>
      new Set(s.surfaces.map((x) => x.id)).size === s.surfaces.length &&
      s.surfaces.every((x) => s.props.some((p) => p.id === x.propId)),
    { message: 'Each surface needs a unique id and a prop to rest on.' },
  ) satisfies z.ZodType<IsoScene>;

export const surfacePinSchema = z
  .object({
    scene: z.enum(['office', 'desk', 'fridge', 'custom']),
    surfaceId: z.string().min(1).max(40),
    corners: z.tuple([pointSchema, pointSchema, pointSchema, pointSchema]),
    frame: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict(),
  })
  .strict()
  .refine(
    (p) =>
      p.corners.every((c) => c.x >= 0 && c.y >= 0 && c.x <= p.frame.width && c.y <= p.frame.height),
    { message: 'Corners must lie within the frame.' },
  )
  .refine((p) => quadIsConvex(p.corners, (p.frame.width * p.frame.height) / 400), {
    message: 'Corners must form a convex shape, clockwise from the back left.',
  });
/** Four clicked corners that tie a camera frame to one surface of a scene. */
export type SurfacePin = z.infer<typeof surfacePinSchema>;

const UNIT_SQUARE: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
/**
 * The map from frame pixels to the surface's unit square (u left to right,
 * v back to front), when the pin applies to frames of this size. Like a
 * carried zone, it assumes the camera hasn't moved since the corners were set.
 */
export function surfaceMap(
  pin: SurfacePin,
  frame: Segmentation['frame'],
): { toSurface: Homography; toFrame: Homography } | null {
  if (pin.frame.width !== frame.width || pin.frame.height !== frame.height) return null;
  const toSurface = homography(pin.corners, UNIT_SQUARE);
  const toFrame = toSurface && invertHomography(toSurface);
  return toSurface && toFrame ? { toSurface, toFrame } : null;
}
export function surfaceWorld(surface: IsoSurface, { x: u, y: v }: Point): IsoVec {
  return {
    x: surface.rect.x + u * surface.rect.w,
    y: surface.rect.y + v * surface.rect.d,
    z: surface.z,
  };
}
export function worldSurface(surface: IsoSurface, p: Pick<IsoVec, 'x' | 'y'>): Point {
  return { x: (p.x - surface.rect.x) / surface.rect.w, y: (p.y - surface.rect.y) / surface.rect.d };
}

/**
 * Where a detection stands on a surface: the middle of its base, with a
 * footprint sized from the box's bottom edge. The bottom-centre of the box is
 * the base's front edge, nearest the camera, so the middle is half the
 * base's width further from the camera, the way up the frame goes on the
 * surface. `onSurface` is false when that middle falls off the surface.
 */
export function projectBox(
  box: Detection['box'],
  surface: IsoSurface,
  toSurface: Homography,
): { foot: Point; box: IsoBox; onSurface: boolean } {
  const bottom = { x: box.x + box.width / 2, y: box.y + box.height };
  const front = applyHomography(toSurface, bottom);
  const left = applyHomography(toSurface, { x: box.x, y: box.y + box.height });
  const right = applyHomography(toSurface, { x: box.x + box.width, y: box.y + box.height });
  // Surface units to tiles, so the step back is measured in the room, not the unit square.
  const { w: sw, d: sd } = surface.rect;
  const width = clamp(Math.hypot((right.x - left.x) * sw, (right.y - left.y) * sd), 0.25, 1.5);
  const up = applyHomography(toSurface, { x: bottom.x, y: bottom.y - box.height / 4 });
  const ux = (up.x - front.x) * sw;
  const uy = (up.y - front.y) * sd;
  const along = Math.hypot(ux, uy);
  const foot = along
    ? {
        x: front.x + ((ux / along) * (width / 2)) / sw,
        y: front.y + ((uy / along) * (width / 2)) / sd,
      }
    : front;
  const height = clamp(width * (box.height / box.width) * 0.8, 0.25, 2);
  const onSurface = foot.x >= -0.05 && foot.x <= 1.05 && foot.y >= -0.05 && foot.y <= 1.05;
  const centre = surfaceWorld(surface, { x: clamp(foot.x, 0, 1), y: clamp(foot.y, 0, 1) });
  return {
    foot,
    onSurface,
    box: {
      at: { x: centre.x - width / 2, y: centre.y - width / 2, z: surface.z },
      size: { w: width, d: width, h: height },
    },
  };
}
/** A normalized zone's corners on the surface's unit square. */
export function zoneOnSurface(
  zone: ZoneRect,
  frame: Segmentation['frame'],
  toSurface: Homography,
): Quad {
  const { x, y, width, height } = zone;
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ].map((p) => applyHomography(toSurface, { x: p.x * frame.width, y: p.y * frame.height })) as Quad;
}
/**
 * The frame zone for a rectangle drawn on the surface: the bounding box of
 * its corners in the frame, clamped to it. Placement still runs on the frame,
 * so the rule stays the same whichever view the zone was drawn in.
 */
export function zoneFromSurface(
  a: Point,
  b: Point,
  frame: Segmentation['frame'],
  toFrame: Homography,
): ZoneRect | null {
  const u0 = clamp(Math.min(a.x, b.x), 0, 1);
  const u1 = clamp(Math.max(a.x, b.x), 0, 1);
  const v0 = clamp(Math.min(a.y, b.y), 0, 1);
  const v1 = clamp(Math.max(a.y, b.y), 0, 1);
  const corners = [
    { x: u0, y: v0 },
    { x: u1, y: v0 },
    { x: u1, y: v1 },
    { x: u0, y: v1 },
  ].map((p) => applyHomography(toFrame, p));
  const xs = corners.map((p) => clamp(p.x / frame.width, 0, 1));
  const ys = corners.map((p) => clamp(p.y / frame.height, 0, 1));
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  return width >= 0.01 && height >= 0.01 ? { x, y, width, height } : null;
}

export * from './iso-presets.js';
export * from './iso-templates.js';
export * from './iso-furniture.js';
