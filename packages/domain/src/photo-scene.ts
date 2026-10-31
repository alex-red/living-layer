import { z } from 'zod';
import type { Detection, RoomCalibration, Segmentation } from './index.js';
import {
  applyHomography,
  homography,
  type IsoBox,
  type IsoScene,
  type Point,
  type Quad,
  type SurfacePin,
} from './iso.js';
import {
  PROP_TEMPLATES,
  TEMPLATE_IDS,
  freshGroupId,
  moveGroup,
  placeTemplate,
  settleGroup,
  type TemplateId,
} from './iso-templates.js';
import { ARCHETYPES, type Archetype } from './iso-archetypes.js';
import type { SavedItem } from './iso-item.js';

/**
 * What a scan of the room's camera frame shares: Spark lists what it sees
 * with a rough box for each thing and SAM outlines every box in one call;
 * `layoutRoom` (room-scan.ts) places them through the calibrated camera.
 * Spark never returns a size, a tile or a turn. Also here: masks as bits,
 * and the camera behind a pin, which fixtures and pictures on a pinned
 * surface go through.
 */

export const PHOTO_SURFACES = ['desk', 'table', 'cabinet', 'shelf'] as const;
/** What a thing in the photo may be drawn as: a template, or an item model's archetype. */
export const PHOTO_AS = [...new Set<string>([...TEMPLATE_IDS, ...ARCHETYPES])] as [
  string,
  ...string[],
];
export type PhotoAs = TemplateId | Archetype;
export const MAX_PHOTO_THINGS = 16;

const photoBoxSchema = z
  .object({
    x1: z.number().int().min(0).max(1000),
    y1: z.number().int().min(0).max(1000),
    x2: z.number().int().min(0).max(1000),
    y2: z.number().int().min(0).max(1000),
  })
  .strict();
const photoThingSchema = z
  .object({
    id: z.string().min(1).max(24),
    label: z.string().trim().min(1).max(40),
    as: z.enum(PHOTO_AS),
    role: z.enum(['furniture', 'surface', 'object']),
    on: z.string().min(1).max(24),
    box: photoBoxSchema,
  })
  .strict();
/** Spark's answer about a photo: what is there and roughly where, never how big. */
export const photoInventorySchema = z
  .object({
    kind: z.enum(['desk', 'office', 'fridge', 'room']),
    things: z.array(photoThingSchema).min(1).max(MAX_PHOTO_THINGS),
    summary: z.string().max(200),
  })
  .strict();
export type PhotoInventory = z.infer<typeof photoInventorySchema>;
/**
 * Spark's estimate of the room around a corner camera, for setting it up in
 * one go: each wall named by the side of the far corner it runs to in the
 * photo, so the right one is the room's back wall and the left one its left
 * wall, as the iso view draws them. Estimates, which calibration checks.
 */
export const roomEstimateSchema = z
  .object({
    rightWallCm: z.number().int().min(60).max(480),
    leftWallCm: z.number().int().min(60).max(480),
    cameraHeightCm: z.number().int().min(100).max(400),
  })
  .strict();
export type RoomEstimate = z.infer<typeof roomEstimateSchema>;
/** The inventory with the room's estimate: one Spark call for setting a room up. */
export const setupInventorySchema = photoInventorySchema
  .extend({ room: roomEstimateSchema })
  .strict();
export type SetupInventory = z.infer<typeof setupInventorySchema>;
export type PhotoThing = z.infer<typeof photoThingSchema>;
/** Spark's second look: the photo beside the drawn scene, naming what's missing or extra. */
export const photoCheckSchema = z
  .object({
    missing: z.array(photoThingSchema).max(4),
    extra: z.array(z.string().min(1).max(24)).max(MAX_PHOTO_THINGS),
    note: z.string().max(200),
  })
  .strict();
export type PhotoCheck = z.infer<typeof photoCheckSchema>;

/** Ids made safe and unique, `on` pointing at a real id or the floor, boxes the right way up. */
export function cleanInventory(inventory: PhotoInventory): PhotoInventory {
  const seen = new Map<string, string>();
  const things = inventory.things.map((t, i) => {
    let id = t.id.toLowerCase().replace(/[^a-z0-9-]/g, '-') || `thing-${i + 1}`;
    while ([...seen.values()].includes(id)) id = `${id}-${i + 1}`;
    seen.set(t.id, id);
    const [x1, x2] = t.box.x1 <= t.box.x2 ? [t.box.x1, t.box.x2] : [t.box.x2, t.box.x1];
    const [y1, y2] = t.box.y1 <= t.box.y2 ? [t.box.y1, t.box.y2] : [t.box.y2, t.box.y1];
    return { ...t, id, box: { x1, y1, x2, y2 } };
  });
  for (const t of things) {
    const on = seen.get(t.on);
    t.on = on && on !== t.id ? on : 'floor';
  }
  return { ...inventory, things };
}
/** A thing's rough box in frame pixels, or null when it is too small to prompt SAM with. */
export function promptBox(
  t: Pick<PhotoThing, 'box'>,
  frame: Segmentation['frame'],
): { left: number; top: number; right: number; bottom: number } | null {
  const sx = frame.width / 1000;
  const sy = frame.height / 1000;
  const left = Math.max(0, Math.min(frame.width - 1, Math.floor(t.box.x1 * sx)));
  const top = Math.max(0, Math.min(frame.height - 1, Math.floor(t.box.y1 * sy)));
  const right = Math.max(left + 1, Math.min(frame.width, Math.ceil(t.box.x2 * sx)));
  const bottom = Math.max(top + 1, Math.min(frame.height, Math.ceil(t.box.y2 * sy)));
  return right - left >= 2 && bottom - top >= 2 ? { left, top, right, bottom } : null;
}
/** The prompt catalogue for Spark: templates to draw furniture with, archetypes for objects. */
export function photoCatalog(): string {
  const templates = TEMPLATE_IDS.map((id) => {
    const t = PROP_TEMPLATES[id];
    return `${id} (${t.label.toLowerCase()}${t.onTop ? ', stands on a surface' : ''})`;
  }).join(', ');
  return [
    `Templates: ${templates}.`,
    `Object models: ${ARCHETYPES.join(', ')}.`,
    `Surfaces people put things on: ${PHOTO_SURFACES.join(', ')}.`,
  ].join('\n');
}

// --- Masks as bits -----------------------------------------------------------

export interface Bits {
  width: number;
  height: number;
  data: Uint8Array;
}
export const newBits = (width: number, height: number): Bits => ({
  width,
  height,
  data: new Uint8Array(width * height),
});
/** Fill polygons into `bits` by the even-odd rule, sampling each pixel's centre. */
export function fillRings(bits: Bits, rings: Point[][]) {
  const { width, height, data } = bits;
  const edges: [number, number, number, number][] = [];
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      if (a.y !== b.y) edges.push([a.x, a.y, b.x, b.y]);
    }
  if (!edges.length) return;
  const y0 = Math.max(0, Math.floor(Math.min(...edges.map((e) => Math.min(e[1], e[3])))));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...edges.map((e) => Math.max(e[1], e[3])))));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (const [ax, ay, bx, by] of edges)
      if (ay <= cy !== by <= cy) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[k + 1]! - 0.5));
      for (let x = from; x <= to; x++) data[y * width + x] = 1;
    }
  }
}
/** The rings of an SVG path made of M, L, H, V and Z, absolute or relative. */
export function pathRings(d: string): Point[][] {
  const tokens = d.match(/[MLHVZmlhvz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const rings: Point[][] = [];
  let ring: Point[] = [];
  let cmd = 'M';
  let x = 0;
  let y = 0;
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/[A-Za-z]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        if (ring.length > 2) rings.push(ring);
        ring = [];
      }
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M':
        if (ring.length > 2) rings.push(ring);
        x = (rel ? x : 0) + num();
        y = (rel ? y : 0) + num();
        ring = [{ x, y }];
        cmd = rel ? 'l' : 'L';
        break;
      case 'L':
        x = (rel ? x : 0) + num();
        y = (rel ? y : 0) + num();
        ring.push({ x, y });
        break;
      case 'H':
        x = (rel ? x : 0) + num();
        ring.push({ x, y });
        break;
      case 'V':
        y = (rel ? y : 0) + num();
        ring.push({ x, y });
        break;
      default:
        i++;
    }
  }
  if (ring.length > 2) rings.push(ring);
  return rings;
}
/** A detection's mask drawn into a frame-sized grid, scaled by `scale`. */
export function maskBits(d: Detection, frame: Segmentation['frame'], scale: number): Bits {
  const bits = newBits(
    Math.max(1, Math.round(frame.width * scale)),
    Math.max(1, Math.round(frame.height * scale)),
  );
  const sx = (d.box.width / d.mask.width) * scale;
  const sy = (d.box.height / d.mask.height) * scale;
  fillRings(
    bits,
    pathRings(d.mask.svgPath).map((r) =>
      r.map((p) => ({ x: d.box.x * scale + p.x * sx, y: d.box.y * scale + p.y * sy })),
    ),
  );
  return bits;
}

// --- Outlines -------------------------------------------------------------------

const cross = (o: Point, a: Point, b: Point) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
/** Convex hull, clockwise on screen (y down). */
export function convexHull(points: Point[]): Point[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const lower: Point[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Point[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].reverse();
}

type Vec3 = [number, number, number];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(...a);
const scaleV = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossV = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/**
 * A pinhole camera over a pinned surface, in surface units: X along the
 * surface's back edge, Y from back to front, `up` out of the surface toward
 * the camera, all in camera coordinates, with the surface's back-left corner
 * at `t`. `surface` is the size the corners imply, in tiles.
 */
export interface PhotoCamera {
  f: number;
  cx: number;
  cy: number;
  r1: Vec3;
  r2: Vec3;
  up: Vec3;
  t: Vec3;
  surface: { w: number; d: number };
  /** Degrees above the surface, looking at its centre. */
  elevation: number;
  /** True when the corners were too square-on to measure the focal length from. */
  focalGuessed: boolean;
}
const UNIT: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
/**
 * The camera behind a pin. The focal length comes from the right angle at
 * the surface's corners when the perspective is strong enough to show it and
 * no corner is cut off by the frame, else a typical phone or webcam lens. The surface's depth follows from its
 * width and the corners, so a desk keeps its true proportions.
 */
export function cameraFromPin(
  corners: Quad,
  frame: Segmentation['frame'],
  width: number,
  depthRange: [number, number] = [0.5, 8],
): PhotoCamera | null {
  const h = homography(UNIT, corners);
  if (!h) return null;
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  const col = (j: number): Vec3 => [h[j]! - cx * h[6 + j]!, h[3 + j]! - cy * h[6 + j]!, h[6 + j]!];
  const a1 = col(0);
  const a2 = col(1);
  const a3 = col(2);
  const maxDim = Math.max(frame.width, frame.height);
  const f2 = -(a1[0] * a2[0] + a1[1] * a2[1]) / (a1[2] * a2[2]);
  const measured = Number.isFinite(f2) && f2 > 0 ? Math.sqrt(f2) : NaN;
  // A corner on the frame's edge is where the photo cuts the surface off, not
  // a right angle, so it says nothing about the lens.
  const focalGuessed =
    clippedQuad(corners, frame) || !(measured >= 0.45 * maxDim && measured <= 3 * maxDim);
  const f = focalGuessed ? 0.8 * maxDim : measured;
  let b1: Vec3 = [a1[0] / f, a1[1] / f, a1[2]];
  let b2: Vec3 = [a2[0] / f, a2[1] / f, a2[2]];
  let b3: Vec3 = [a3[0] / f, a3[1] / f, a3[2]];
  if (b3[2] < 0) [b1, b2, b3] = [scaleV(b1, -1), scaleV(b2, -1), scaleV(b3, -1)];
  const n1 = norm(b1);
  const n2 = norm(b2);
  if (n1 < 1e-12 || n2 < 1e-12) return null;
  const depth = Math.max(depthRange[0], Math.min(depthRange[1], (width * n2) / n1));
  const lambda = n1 / width;
  const r1 = scaleV(b1, 1 / n1);
  const r2raw = sub(b2, scaleV(r1, dot(b2, r1)));
  const r2 = scaleV(r2raw, 1 / norm(r2raw));
  const t = scaleV(b3, 1 / lambda);
  let up = crossV(r1, r2);
  if (dot(up, scaleV(t, -1)) < 0) up = scaleV(up, -1);
  const centre: Vec3 = [
    t[0] + (r1[0] * width) / 2 + (r2[0] * depth) / 2,
    t[1] + (r1[1] * width) / 2 + (r2[1] * depth) / 2,
    t[2] + (r1[2] * width) / 2 + (r2[2] * depth) / 2,
  ];
  const elevation =
    (Math.asin(Math.min(1, Math.abs(dot(up, centre)) / norm(centre))) * 180) / Math.PI;
  return { f, cx, cy, r1, r2, up, t, surface: { w: width, d: depth }, elevation, focalGuessed };
}
/**
 * The pin's camera in the pinned surface's own tiles, `w` across and `d`
 * deep: its far edge is where the pin's far corners are, however deep the
 * photo makes it look. `r2` is stretched to do that, so it is no longer of
 * unit length; heights stay in tiles across.
 */
export function pinCamera(
  corners: Quad,
  frame: Segmentation['frame'],
  w: number,
  d: number,
): PhotoCamera | null {
  const camera = cameraFromPin(corners, frame, w, [1e-3, 1e6]);
  if (!camera || !(d > 0)) return null;
  return { ...camera, r2: scaleV(camera.r2, camera.surface.d / d), surface: { w, d } };
}
/** Where a point X, Y on the surface, Z above it, appears in the frame. */
export function projectPoint(c: PhotoCamera, X: number, Y: number, Z: number): Point | null {
  const p: Vec3 = [
    X * c.r1[0] + Y * c.r2[0] + Z * c.up[0] + c.t[0],
    X * c.r1[1] + Y * c.r2[1] + Z * c.up[1] + c.t[1],
    X * c.r1[2] + Y * c.r2[2] + Z * c.up[2] + c.t[2],
  ];
  if (p[2] <= 1e-6) return null;
  return { x: (c.f * p[0]) / p[2] + c.cx, y: (c.f * p[1]) / p[2] + c.cy };
}
/** The point on the plane Z (above the surface, negative below it) that a pixel shows. */
export function unprojectPoint(
  c: PhotoCamera,
  p: Point,
  Z: number,
): { X: number; Y: number } | null {
  const d: Vec3 = [(p.x - c.cx) / c.f, (p.y - c.cy) / c.f, 1];
  const rhs: Vec3 = [c.t[0] + Z * c.up[0], c.t[1] + Z * c.up[1], c.t[2] + Z * c.up[2]];
  // s·d − X·r1 − Y·r2 = t + Z·up, by Cramer's rule.
  const m: Vec3[] = [d, scaleV(c.r1, -1), scaleV(c.r2, -1)];
  const det3 = (a: Vec3, b: Vec3, e: Vec3) => dot(a, crossV(b, e));
  const det = det3(m[0]!, m[1]!, m[2]!);
  if (Math.abs(det) < 1e-12) return null;
  const s = det3(rhs, m[1]!, m[2]!) / det;
  if (s <= 0) return null;
  return { X: det3(m[0]!, rhs, m[2]!) / det, Y: det3(m[0]!, m[1]!, rhs) / det };
}

// --- Layout --------------------------------------------------------------------

/** A thing of the photo, where it ended up and how well its drawing matches its mask. */
export interface PlacedThing extends PhotoThing {
  /** The SAM detection that outlines it, by object id. */
  detectionId: string | null;
  /**
   * `placed`: drawn as a template. `object`: an item model, standing at `box`.
   * `not-found`: SAM had no mask for it. `unplaced`: it fell outside the room.
   * `removed`: a person took it out.
   */
  status: 'placed' | 'object' | 'not-found' | 'unplaced' | 'removed';
  group?: string;
  foot?: IsoBox;
  /** Overlap of its drawing with its mask, where other masks might hide it ignored. */
  iou?: number | null;
}
export interface PhotoLayout {
  scene: IsoScene;
  pin: SurfacePin | null;
  /** The thing whose top was pinned. */
  surfaceThing: string | null;
  things: PlacedThing[];
  /** Mask-area weighted mean of every thing's match. */
  score: number | null;
}
export interface PhotoEdit {
  as?: PhotoAs;
  removed?: boolean;
}
export interface LayoutInput {
  inventory: PhotoInventory;
  segmentation: Segmentation;
  /** Thing id to SAM object id. */
  detections: Record<string, string>;
  edits?: Record<string, PhotoEdit>;
}
const isTemplate = (as: string): as is TemplateId => as in PROP_TEMPLATES;
function addBuilt(scene: IsoScene, built: ReturnType<typeof placeTemplate>): IsoScene {
  return {
    ...scene,
    props: [...scene.props, ...built.props],
    surfaces: [...scene.surfaces, ...built.surfaces],
  };
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Whether a corner sits on the frame's edge: where the photo cuts a surface off. */
function clippedQuad(corners: Quad, frame: Segmentation['frame']): boolean {
  const edge = 0.01 * Math.max(frame.width, frame.height);
  return corners.some(
    (p) => p.x <= edge || p.y <= edge || p.x >= frame.width - edge || p.y >= frame.height - edge,
  );
}
/** Where a frame point lands on the pinned surface, in the surface's unit square. */
export function onPinnedSurface(pin: SurfacePin, p: Point): Point | null {
  const h = homography(pin.corners, UNIT);
  return h ? applyHomography(h, p) : null;
}

/** What a photo draft keeps: enough to lay the scene out again and to save it. */
export interface PhotoDraft {
  inventory: PhotoInventory;
  /** The box-prompted segmentation, saved as its own run so sightings can point at it. */
  segmentRunId: string;
  segmentation: Segmentation;
  /** Thing id to SAM object id. */
  detections: Record<string, string>;
  layout: PhotoLayout;
  /** Fitted models for the objects, by thing id. */
  items: Record<string, SavedItem>;
  check: (PhotoCheck & { kept: boolean; added: string[] }) | null;
  /** Each model call and what it changed, in order. */
  assists: string[];
  /** The room camera the layout was drawn through, so a review lays it out the same way. */
  calibration: RoomCalibration;
  /** When the draft set the room up too: Spark's estimate and how the camera was fitted to it. */
  setup?: {
    room: RoomEstimate;
    /** The room's inner floor as calibrated, in centimetres: the estimate, maybe turned. */
    floorCm: { w: number; d: number };
    fit: { error: number; heightCm: number; hfovDeg: number };
  };
}

/**
 * The scene to save: the layout's, plus a template for each object that
 * won't be tracked but has one (a book, a bottle), standing where its mask
 * stood. Tracked objects are drawn from their sightings instead.
 */
export function sceneForSave(layout: PhotoLayout, tracked: string[]): IsoScene {
  let scene = layout.scene;
  for (const t of layout.things) {
    if (t.status !== 'object' || !t.foot || tracked.includes(t.id) || !isTemplate(t.as)) continue;
    const tpl = PROP_TEMPLATES[t.as];
    const cx = t.foot.at.x + t.foot.size.w / 2;
    const cy = t.foot.at.y + t.foot.size.d / 2;
    const g = freshGroupId(scene, t.as);
    scene = addBuilt(
      scene,
      placeTemplate(t.as, g, cx - tpl.size.w / 2, cy - tpl.size.d / 2, t.foot.at.z, {
        label: capital(t.label),
      }),
    );
    scene = settleGroup(moveGroup(scene, g, 0, 0), g);
  }
  return scene;
}
/** Bits as a detection, one rectangle per run of pixels, in the box's own pixels. */
export function detectionFromBits(objectId: string, bits: Bits): Detection | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < bits.height; y++)
    for (let x = 0; x < bits.width; x++)
      if (bits.data[y * bits.width + x]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  if (x1 < 0) return null;
  const runs: string[] = [];
  let pixels = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (!bits.data[y * bits.width + x]) continue;
      const start = x;
      while (x <= x1 && bits.data[y * bits.width + x]) x++;
      pixels += x - start;
      const [a, b, top, bottom] = [start - x0, x - x0, y - y0, y - y0 + 1];
      runs.push(`M${a} ${top}L${b} ${top}L${b} ${bottom}L${a} ${bottom}Z`);
    }
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;
  return {
    objectId,
    confidence: 0.9,
    box: { x: x0, y: y0, width, height },
    mask: { width, height, foregroundPixels: pixels, svgPath: runs.join('') },
  };
}
