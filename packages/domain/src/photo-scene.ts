import { z } from 'zod';
import type { Detection, Segmentation } from './index.js';
import {
  applyHomography,
  homography,
  quadIsConvex,
  type IsoBox,
  type IsoProp,
  type IsoScene,
  type IsoTone,
  type Point,
  type Quad,
  type SurfacePin,
} from './iso.js';
import {
  PROP_TEMPLATES,
  TEMPLATE_IDS,
  freshGroupId,
  groupBounds,
  moveGroup,
  placeTemplate,
  removeGroup,
  rotateGroup,
  settleGroup,
  type TemplateId,
} from './iso-templates.js';
import { ARCHETYPES, type Archetype } from './iso-archetypes.js';
import type { SavedItem } from './iso-item.js';

/**
 * A scene from one photo. Spark lists what it sees with a rough box for each
 * thing, SAM outlines every box in one call, and this module measures the
 * rest: the main surface's corners from its mask, the camera from those
 * corners, where each thing stands from where its mask meets the floor or the
 * surface, and how well the drawn scene matches the masks. Spark never
 * returns a size, a tile or a turn.
 */

export const PHOTO_SURFACES = ['desk', 'table', 'cabinet', 'shelf'] as const;
type SurfaceTemplate = (typeof PHOTO_SURFACES)[number];
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
const count = (b: Uint8Array) => b.reduce((s, v) => s + v, 0);
function iou(a: Uint8Array, b: Uint8Array): number {
  let and = 0;
  let or = 0;
  for (let i = 0; i < a.length; i++) {
    and += a[i]! & b[i]!;
    or += a[i]! | b[i]!;
  }
  return or ? and / or : 0;
}

// --- The main surface's corners ------------------------------------------------

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
const area = (ring: Point[]) =>
  Math.abs(
    ring.reduce((s, p, i) => {
      const n = ring[(i + 1) % ring.length]!;
      return s + p.x * n.y - n.x * p.y;
    }, 0),
  ) / 2;
/** Fewer hull points, keeping the shape: drop the point whose triangle is smallest. */
function thin(hull: Point[], keep: number): Point[] {
  const h = [...hull];
  while (h.length > keep) {
    let best = 0;
    let least = Infinity;
    for (let i = 0; i < h.length; i++) {
      const a = Math.abs(cross(h[(i - 1 + h.length) % h.length]!, h[i]!, h[(i + 1) % h.length]!));
      if (a < least) {
        least = a;
        best = i;
      }
    }
    h.splice(best, 1);
  }
  return h;
}
/** Clockwise on screen, starting at the back left: the order a pin's corners take. */
export function orderCorners(q: Point[]): Quad {
  const cx = q.reduce((s, p) => s + p.x, 0) / q.length;
  const cy = q.reduce((s, p) => s + p.y, 0) / q.length;
  const ring = [...q].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  const back = [...ring].sort((a, b) => a.y - b.y).slice(0, 2);
  const start = ring.indexOf(back[0]!.x <= back[1]!.x ? back[0]! : back[1]!);
  return [0, 1, 2, 3].map((k) => ring[(start + k) % 4]!) as Quad;
}
/** Erode, then dilate, along rows only: wipes out what is narrower than 2r + 1 across. */
function openRows(bits: Bits, r: number): Bits {
  const { width, height } = bits;
  const pass = (src: Uint8Array, dilate: boolean) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let v = dilate ? 0 : 1;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          const s = xx >= 0 && xx < width ? src[y * width + xx]! : dilate ? 0 : 1;
          if (dilate ? s : !s) {
            v = dilate ? 1 : 0;
            break;
          }
        }
        out[y * width + x] = v;
      }
    return out;
  };
  return { width, height, data: pass(pass(bits.data, false), true) };
}
/** The mask with every hole filled: what no path of empty pixels joins to the frame's edge. */
function fillHoles(bits: Bits): Bits {
  const { width, height, data } = bits;
  const outside = new Uint8Array(data.length);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!data[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (i >= width) push(i - width);
    if (i < data.length - width) push(i + width);
  }
  return { width, height, data: outside.map((o) => (o ? 0 : 1)) };
}
/**
 * The top without what hangs below its front edge: drawers, a cabinet, legs.
 * Holes are filled first: SAM leaves them where clutter it wasn't asked about
 * sits. In each column the top is the first run of mask from above; the front edge
 * is the line most of those runs end on. A run of columns reaching well below
 * it is cut back to it when the part below is about as wide at the bottom as
 * at the line, as a drawer unit is, rather than narrowing to a point. A desk
 * seen at an angle shows a second edge, its near side, which only rises above
 * the line, so nothing of it is cut.
 */
function cutHanging(mask: Bits): { top: Bits; hanging: Bits } {
  const solid = fillHoles(mask);
  const { width, height, data } = solid;
  const at = (x: number, y: number) => data[y * width + x]!;
  const cols: { x: number; bottom: number }[] = [];
  const gap = Math.max(2, Math.round(height * 0.04));
  for (let x = 0; x < width; x++) {
    let y = 0;
    while (y < height && !at(x, y)) y++;
    if (y === height) continue;
    // Short gaps are bridged: a thing on the desk's back edge leaves a sliver above the top.
    let bottom = y;
    for (; y < height; y++)
      if (at(x, y)) bottom = y;
      else if (y - bottom > gap) break;
    cols.push({ x, bottom });
  }
  if (cols.length < 8) return { top: solid, hanging: newBits(width, height) };
  // The front edge: of lines through two columns' bottoms, the one most
  // columns end on, refitted to those. A column running into the frame's
  // bottom says nothing about the edge: the photo cuts it off there.
  const tol = Math.max(1.5, height * 0.02);
  const open = cols.filter((k) => k.bottom < height - 1);
  const step = Math.max(1, Math.floor(open.length / 40));
  const sample = open.filter((_, i) => i % step === 0);
  let best: typeof cols = [];
  for (let i = 0; i < sample.length; i++)
    for (let j = i + 1; j < sample.length; j++) {
      const p = sample[i]!;
      const q = sample[j]!;
      const slope = (q.bottom - p.bottom) / (q.x - p.x);
      const on = open.filter((k) => Math.abs(k.bottom - (p.bottom + slope * (k.x - p.x))) <= tol);
      if (on.length > best.length) best = on;
    }
  if (best.length < cols.length * 0.3) return { top: solid, hanging: newBits(width, height) };
  const n = best.length;
  const sx = best.reduce((s, p) => s + p.x, 0);
  const sy = best.reduce((s, p) => s + p.bottom, 0);
  const sxx = best.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = best.reduce((s, p) => s + p.x * p.bottom, 0);
  const det = n * sxx - sx * sx;
  const m = det ? (n * sxy - sx * sy) / det : 0;
  const c = (sy - m * sx) / n;
  const line = (x: number) => m * x + c;
  const deep = Math.max(2, height * 0.05);
  const out = { width, height, data: data.slice() };
  const hanging = newBits(width, height);
  // Contiguous runs of columns that reach well below the line.
  const low = cols.filter((p) => p.bottom > line(p.x) + deep).map((p) => p.x);
  const blocks: [number, number][] = [];
  for (const x of low) {
    const last = blocks.at(-1);
    if (last && x - last[1] <= 2) last[1] = x;
    else blocks.push([x, x]);
  }
  const below = (x: number) => Math.max(0, Math.ceil(line(x) + tol));
  for (const [a, b] of blocks) {
    // How wide the part below the line is near its bottom, by the extent of
    // each row: SAM's masks of drawer fronts are full of holes.
    let top = height;
    let bottom = 0;
    for (let x = a; x <= b; x++)
      for (let y = below(x); y < height; y++)
        if (at(x, y)) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
    if (bottom - top < deep * 2) continue;
    let wide = 0;
    for (let y = Math.round(top + 0.6 * (bottom - top)); y <= top + 0.9 * (bottom - top); y++) {
      let l = -1;
      let r = -1;
      for (let x = a; x <= b; x++)
        if (y >= below(x) && at(x, y)) {
          if (l < 0) l = x;
          r = x;
        }
      if (l >= 0) wide = Math.max(wide, r - l + 1);
    }
    if (wide < 0.6 * (b - a + 1)) continue;
    for (let x = a; x <= b; x++)
      for (let y = Math.max(0, Math.ceil(line(x) + tol)); y < height; y++) {
        hanging.data[y * width + x] = out.data[y * width + x]!;
        out.data[y * width + x] = 0;
      }
  }
  return { top: out, hanging };
}
/**
 * Just the top of a surface's mask. SAM outlines the whole desk, legs and
 * all, and leaves holes where things stand on it. The holes are filled with
 * the masks of what stands there (a mug), whatever hangs below the front edge
 * as a block is cut off (a drawer unit), then an opening along the rows, about
 * 7% of the surface's width, wipes out anything narrower than that: the legs.
 * Only along the rows, so a top seen nearly edge-on, a thin strip, stays.
 */
export function surfaceTop(bits: Bits, others: Bits[]): Bits {
  return surfaceParts(bits, others).top;
}
/** The top of a surface's mask, and what was cut off below it as a block (a drawer unit). */
export function surfaceParts(bits: Bits, others: Bits[]): { top: Bits; hanging: Bits } {
  const { width, height, data } = bits;
  const solid = newBits(width, height);
  let widest = 0;
  for (let y = 0; y < height; y++) {
    let l = -1;
    let r = -1;
    for (let x = 0; x < width; x++)
      if (data[y * width + x]) {
        if (l < 0) l = x;
        r = x;
      }
    if (l < 0) continue;
    widest = Math.max(widest, r - l + 1);
    for (let x = l; x <= r; x++) {
      const i = y * width + x;
      if (data[i] || others.some((o) => o.data[i])) solid.data[i] = 1;
    }
  }
  const { top, hanging } = cutHanging(solid);
  const r = Math.max(1, Math.ceil(widest * 0.035));
  const opened = openRows(top, r);
  // An opening that wipes everything out means the mask was all thin parts; keep it as it was.
  return { top: opened.data.some(Boolean) ? opened : top, hanging };
}
/**
 * A surface's mask for matching its template against, and what may differ
 * from the drawing without counting either way: what other things cover, and
 * what hangs below the top as a block, which the template doesn't draw.
 */
function matchTarget(mask: Bits, hanging: Bits, union: Uint8Array) {
  const target = { width: mask.width, height: mask.height, data: mask.data.slice() };
  const ignore = union.slice();
  for (let i = 0; i < target.data.length; i++)
    if (hanging.data[i]) {
      target.data[i] = 0;
      ignore[i] = 1;
    }
  return { target, ignore };
}
/**
 * Four corners for a surface's mask, in frame pixels: the biggest quad inside
 * the mask's hull, then each corner nudged while the overlap with the hull
 * grows. `iou` says how quad-shaped the outline was; under about 0.85 the
 * mask is not a clean surface and a person should pin it by hand.
 */
export function fitSurfaceQuad(
  bits: Bits,
  frame: Segmentation['frame'],
): { corners: Quad; iou: number } | null {
  const { width, height, data } = bits;
  const edge: Point[] = [];
  for (let y = 0; y < height; y++) {
    let l = -1;
    let r = -1;
    for (let x = 0; x < width; x++)
      if (data[y * width + x]) {
        if (l < 0) l = x;
        r = x;
      }
    if (l >= 0) edge.push({ x: l, y }, { x: r + 1, y }, { x: l, y: y + 1 }, { x: r + 1, y: y + 1 });
  }
  if (edge.length < 8) return null;
  const hull = thin(convexHull(edge), 40);
  if (hull.length < 4) return null;
  const filled = newBits(width, height);
  fillRings(filled, [hull]);
  let best: Point[] | null = null;
  let most = 0;
  const n = hull.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const q = [hull[a]!, hull[b]!, hull[c]!, hull[d]!];
          const s = area(q);
          if (s > most) {
            most = s;
            best = q;
          }
        }
  if (!best) return null;
  const trial = newBits(width, height);
  const score = (q: Point[]) => {
    trial.data.fill(0);
    fillRings(trial, [q]);
    return iou(trial.data, filled.data);
  };
  let quad = best.map((p) => ({ ...p }));
  let current = score(quad);
  const clampP = (p: Point) => ({
    x: Math.max(0, Math.min(width, p.x)),
    y: Math.max(0, Math.min(height, p.y)),
  });
  for (let step = Math.max(width, height) * 0.04; step >= 0.5; step /= 2) {
    let moved = true;
    for (let pass = 0; moved && pass < 4; pass++) {
      moved = false;
      for (let k = 0; k < 4; k++)
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
        ] as const) {
          const next = quad.map((p, i) =>
            i === k ? clampP({ x: p.x + dx * step, y: p.y + dy * step }) : p,
          );
          const s = score(next);
          if (s > current + 1e-6) {
            quad = next;
            current = s;
            moved = true;
          }
        }
    }
  }
  const sx = frame.width / width;
  const sy = frame.height / height;
  const corners = orderCorners(quad.map((p) => ({ x: p.x * sx, y: p.y * sy })));
  return quadIsConvex(corners, 1) ? { corners, iou: current } : null;
}

/**
 * A surface pinned from its own mask alone, for a close photo of a desk that
 * is already in a scene: the top's four corners in frame pixels, refined so
 * the template drawn from them matches the outline. `iou` is how quad-shaped
 * the top was; under about 0.85 the corners need a person's check.
 */
export function pinFromMask(
  d: Detection,
  frame: Segmentation['frame'],
  template: TemplateId = 'desk',
): { corners: Quad; iou: number } | null {
  const scale = Math.min(1, WORK_WIDTH / frame.width);
  const mask = maskBits(d, frame, scale);
  const parts = surfaceParts(mask, []);
  const fitted = fitSurfaceQuad(parts.top, frame);
  if (!fitted) return null;
  const { target, ignore } = matchTarget(mask, parts.hanging, new Uint8Array(mask.data.length));
  const corners = refinePin(
    turnToFit(fitted.corners, frame, template),
    template,
    frame,
    target,
    ignore,
    scale,
  );
  return { corners: quadIsConvex(corners, 1) ? corners : fitted.corners, iou: fitted.iou };
}

// --- The camera ----------------------------------------------------------------

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
  camera: PhotoCamera | null;
  /** The thing whose top was pinned. */
  surfaceThing: string | null;
  /** How quad-shaped the surface's mask was, when the corners were fitted. */
  quadIou: number | null;
  things: PlacedThing[];
  /** Mask-area weighted mean of every thing's match. */
  score: number | null;
  /** Scene coordinates of the pinned surface's back-left corner. */
  origin: { x: number; y: number; z: number } | null;
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
  /** Corners a person set; otherwise they are fitted to the surface's mask. */
  corners?: Quad | null;
  edits?: Record<string, PhotoEdit>;
  /** Nudge positions and turns until the drawing matches the masks. */
  refine?: boolean;
}
const isTemplate = (as: string): as is TemplateId => as in PROP_TEMPLATES;
const isSurfaceTemplate = (as: string): as is SurfaceTemplate =>
  (PHOTO_SURFACES as readonly string[]).includes(as);
/** Height of a template's top surface, the highest one if it has several. */
function topOf(id: TemplateId, size?: { w: number; d: number }): number {
  const built = placeTemplate(id, 'probe', 0, 0, 0, size ? { size } : {});
  return Math.max(0, ...built.surfaces.map((s) => s.z));
}
/** Mask pixels at the working scale, at most this many across. */
const WORK_WIDTH = 200;
/** How far from the pinned surface a thing may stand before it is left out, in tiles. */
const REACH = 10;
const OFF = 24;
const BIG = 64;

function shiftScene(scene: IsoScene, dx: number, dy: number): IsoScene {
  return {
    ...scene,
    props: scene.props.map((p) => ({ ...p, at: { ...p.at, x: p.at.x + dx, y: p.at.y + dy } })),
    surfaces: scene.surfaces.map((s) => ({
      ...s,
      rect: { ...s.rect, x: s.rect.x + dx, y: s.rect.y + dy },
    })),
  };
}
function addBuilt(scene: IsoScene, built: ReturnType<typeof placeTemplate>): IsoScene {
  return {
    ...scene,
    props: [...scene.props, ...built.props],
    surfaces: [...scene.surfaces, ...built.surfaces],
  };
}

/**
 * Lay a photo's things out as a scene. With a pinned surface, every position
 * comes from the camera: tabletop things from where their mask's foot meets
 * the plane of what they stand on, furniture from where it meets the floor.
 * Without one, things are spread over the grid by where they are in the frame,
 * and the scene says so by having no pin.
 */
export function layoutPhoto(input: LayoutInput): PhotoLayout {
  const { inventory, segmentation } = input;
  const frame = segmentation.frame;
  const edits = input.edits ?? {};
  const byId = new Map(segmentation.detections.map((d) => [d.objectId, d]));
  const things: PlacedThing[] = inventory.things.map((t) => {
    const as = (edits[t.id]?.as ?? t.as) as PhotoAs;
    const detectionId = input.detections[t.id] ?? null;
    const found = detectionId !== null && byId.has(detectionId);
    return {
      ...t,
      as,
      detectionId: found ? detectionId : null,
      status: edits[t.id]?.removed ? 'removed' : found ? 'placed' : 'not-found',
    };
  });
  const live = things.filter((t) => t.status === 'placed');
  const detection = (t: PlacedThing) => byId.get(t.detectionId!)!;
  const maskArea = (t: PlacedThing) => {
    const d = detection(t);
    return (d.mask.foregroundPixels * d.box.width * d.box.height) / (d.mask.width * d.mask.height);
  };
  const scale = Math.min(1, WORK_WIDTH / frame.width);
  const masks = new Map(live.map((t) => [t.id, maskBits(detection(t), frame, scale)]));

  // 1. The main surface and its corners.
  const surfaceThing =
    live
      .filter((t) => t.role === 'surface' && isSurfaceTemplate(t.as))
      .sort((a, b) => maskArea(b) - maskArea(a))[0] ?? null;
  let corners = input.corners ?? null;
  let quadIou: number | null = null;
  let hanging: Bits | null = null;
  if (surfaceThing && !corners) {
    // Only what stands on the surface may hide part of its top; a chair in front hides legs.
    const others = live
      .filter((t) => t !== surfaceThing && (t.on === surfaceThing.id || t.role === 'object'))
      .map((t) => masks.get(t.id)!);
    const parts = surfaceParts(masks.get(surfaceThing.id)!, others);
    hanging = parts.hanging;
    const fitted = fitSurfaceQuad(parts.top, frame);
    quadIou = fitted?.iou ?? null;
    if (fitted && fitted.iou >= 0.85) corners = fitted.corners;
  }
  const template = surfaceThing && isTemplate(surfaceThing.as) ? surfaceThing.as : null;
  // Fitted corners are read the way round that suits the template, then refined; a
  // person's keep their order, so a draft re-laid out after a review edit reads the same.
  let reading: Reading | null =
    corners && template
      ? turnToFit(corners, frame, template, input.corners ? [0] : undefined)
      : null;
  if (reading && template && !input.corners) {
    const union = new Uint8Array(masks.get(surfaceThing!.id)!.data.length);
    for (const [id, m] of masks)
      if (id !== surfaceThing!.id) for (let i = 0; i < union.length; i++) union[i]! |= m.data[i]!;
    const mask = masks.get(surfaceThing!.id)!;
    const { target, ignore } = matchTarget(
      mask,
      hanging ?? newBits(mask.width, mask.height),
      union,
    );
    corners = refinePin(reading, template, frame, target, ignore, scale);
    reading = { ...reading, corners };
  }
  const camera = reading
    ? cameraFromPin(reading.corners, frame, reading.width, reading.depthRange)
    : null;

  let scene: IsoScene = {
    kind: 'custom',
    label: 'From photo',
    grid: { w: BIG, d: BIG },
    props: [],
    surfaces: [],
  };
  const placeAt = (
    t: PlacedThing,
    x: number,
    y: number,
    z: number,
    size?: { w: number; d: number },
  ) => {
    const id = t.as as TemplateId;
    const g = freshGroupId(scene, id);
    scene = addBuilt(
      scene,
      placeTemplate(id, g, x, y, z, { label: capital(t.label), ...(size ? { size } : {}) }),
    );
    t.group = g;
    return g;
  };
  const objectBox = (foot: Point, width: number, d: Detection, z: number): IsoBox => {
    const w = clamp(width, 0.25, 1.5);
    const h = clamp(w * (d.box.height / d.box.width) * 0.8, 0.25, 2);
    return { at: { x: foot.x - w / 2, y: foot.y - w / 2, z }, size: { w, d: w, h } };
  };
  const asObject = (t: PlacedThing) => t.role === 'object' || !isTemplate(t.as);
  let origin: PhotoLayout['origin'] = null;

  if (camera && surfaceThing && template) {
    // 2. The pinned surface stands at (OFF, OFF), its top `top` tiles up.
    const size = camera.surface;
    const top = topOf(template, size);
    origin = { x: OFF, y: OFF, z: top };
    placeAt(surfaceThing, OFF, OFF, 0, size);
    const toUnit = homography(corners!, UNIT);
    /** The top of what Spark says a thing stands on, once that is placed. */
    const standsOn = (t: PlacedThing) => {
      const parent = things.find((p) => p.id === t.on && p.group);
      return parent
        ? scene.surfaces
            .filter((s) => s.id.startsWith(`${parent.group}:`))
            .sort((a, b) => b.z - a.z)[0]
        : undefined;
    };
    const planeOf = (t: PlacedThing, footPx: Point): number => {
      const surface = standsOn(t);
      if (surface) return surface.z - top;
      // Furniture stands on the floor. Anything smaller stands on the pinned
      // surface when its foot lands on it, whatever Spark said.
      if (!asObject(t) && !(isTemplate(t.as) && PROP_TEMPLATES[t.as].onTop)) return -top;
      const uv = toUnit && applyHomography(toUnit, footPx);
      return uv && uv.x >= -0.02 && uv.x <= 1.02 && uv.y >= -0.02 && uv.y <= 1.02 ? 0 : -top;
    };
    const order = [...live]
      .filter((t) => t !== surfaceThing)
      .sort((a, b) => Number(a.on !== 'floor') - Number(b.on !== 'floor'));
    for (const t of order) {
      const d = detection(t);
      const footPx = { x: d.box.x + d.box.width / 2, y: d.box.y + d.box.height };
      const Z = planeOf(t, footPx);
      const foot = unprojectPoint(camera, footPx, Z);
      const left = unprojectPoint(camera, { x: d.box.x, y: footPx.y }, Z);
      const right = unprojectPoint(camera, { x: d.box.x + d.box.width, y: footPx.y }, Z);
      // A thing on a placed surface is kept on it below, however far off its foot measures.
      const held = asObject(t) && Boolean(standsOn(t));
      const far =
        !foot || Math.abs(foot.X - size.w / 2) > REACH || Math.abs(foot.Y - size.d / 2) > REACH;
      if (far && !held) {
        t.status = 'unplaced';
        continue;
      }
      // No foot at all (above the horizon) leaves a held thing in the middle of its surface.
      let at = foot ? { x: OFF + foot.X, y: OFF + foot.Y } : null;
      if (asObject(t)) {
        const width = left && right ? Math.hypot(right.X - left.X, right.Y - left.Y) : 0.5;
        t.status = 'object';
        // A thing on a desk or a shelf stays on it. Its foot is often hidden
        // (a monitor's stand behind the clutter), which measures it too far back.
        const on = standsOn(t);
        if (on) {
          const w = objectBox({ x: 0, y: 0 }, width, d, 0).size.w;
          const inside = (v: number | undefined, from: number, span: number) =>
            v === undefined || span <= w
              ? from + span / 2
              : clamp(v, from + w / 2, from + span - w / 2);
          at = { x: inside(at?.x, on.rect.x, on.rect.w), y: inside(at?.y, on.rect.y, on.rect.d) };
        }
        t.foot = objectBox(at!, width, d, Z + top);
        continue;
      }
      const tpl = PROP_TEMPLATES[t.as as TemplateId];
      // Only held objects get here without a foot.
      if (t.as === 'wall' || !at) continue;
      // A floor thing's foot is its front edge; a tabletop thing's is its middle.
      const y = tpl.onTop ? at.y - tpl.size.d / 2 : at.y - tpl.size.d;
      const g = placeAt(t, at.x - tpl.size.w / 2, y, tpl.onTop ? Z + top : 0);
      if (tpl.onTop) scene = settleGroup(scene, g);
    }
  } else {
    // No pin: spread things over a 10 × 8 room by where they are in the frame.
    const W = 10;
    const D = 8;
    origin = null;
    const order = [...live].sort(
      (a, b) =>
        Number(isTemplate(a.as) && PROP_TEMPLATES[a.as].onTop) -
        Number(isTemplate(b.as) && PROP_TEMPLATES[b.as].onTop),
    );
    for (const t of order) {
      const d = detection(t);
      const fx = ((d.box.x + d.box.width / 2) / frame.width) * W;
      const fy = ((d.box.y + d.box.height) / frame.height) * D;
      if (asObject(t)) {
        t.status = 'object';
        const z = Math.max(
          0,
          ...scene.surfaces
            .filter(
              (s) =>
                OFF + fx >= s.rect.x &&
                OFF + fx <= s.rect.x + s.rect.w &&
                OFF + fy - 0.3 >= s.rect.y &&
                OFF + fy - 0.3 <= s.rect.y + s.rect.d,
            )
            .map((s) => s.z),
        );
        t.foot = objectBox(
          { x: OFF + fx, y: OFF + fy - 0.3 },
          (d.box.width / frame.width) * W * 0.6,
          d,
          z,
        );
        continue;
      }
      if (t.as === 'wall') continue;
      const tpl = PROP_TEMPLATES[t.as as TemplateId];
      const g = placeAt(t, OFF + fx - tpl.size.w / 2, OFF + fy - tpl.size.d, 0);
      if (tpl.onTop) scene = settleGroup(scene, g);
    }
  }

  // 3. A wall goes behind everything else, as wide as the room.
  const wall = live.find((t) => t.as === 'wall' && t.status === 'placed');
  if (wall && scene.props.length) {
    const xs = scene.props.map((p) => [p.at.x, p.at.x + p.size.w]).flat();
    const y0 = Math.min(...scene.props.map((p) => p.at.y));
    placeAt(wall, Math.min(...xs), y0 - 0.45, 0, {
      w: Math.max(...xs) - Math.min(...xs),
      d: 0.2,
    });
  }

  // 4. Move it all into a grid that just fits, half a tile from the edges.
  const boxes: IsoBox[] = [
    ...scene.props,
    ...things.filter((t) => t.status === 'object').map((t) => t.foot!),
  ];
  if (boxes.length) {
    const minX = Math.min(...boxes.map((b) => b.at.x));
    const minY = Math.min(...boxes.map((b) => b.at.y));
    const dx = 0.5 - minX;
    const dy = 0.5 - minY;
    scene = shiftScene(scene, dx, dy);
    for (const t of things)
      if (t.foot)
        t.foot = { ...t.foot, at: { ...t.foot.at, x: t.foot.at.x + dx, y: t.foot.at.y + dy } };
    if (origin) origin = { x: origin.x + dx, y: origin.y + dy, z: origin.z };
    const maxX = Math.max(...boxes.map((b) => b.at.x + b.size.w)) + dx;
    const maxY = Math.max(...boxes.map((b) => b.at.y + b.size.d)) + dy;
    scene.grid = {
      w: Math.max(4, Math.min(16, Math.ceil(maxX + 0.5))),
      d: Math.max(4, Math.min(16, Math.ceil(maxY + 0.5))),
    };
    // Whatever still sticks out of a 16-tile room is left out, not squashed in.
    for (const t of things) {
      const b = t.group ? groupBounds(scene, t.group) : t.foot;
      if (!b) continue;
      if (b.at.x + b.size.w > scene.grid.w + 0.5 || b.at.y + b.size.d > scene.grid.d + 3) {
        if (t.group) scene = removeGroup(scene, t.group);
        t.group = undefined;
        t.foot = undefined;
        t.status = 'unplaced';
      }
    }
  } else scene.grid = { w: 8, d: 6 };

  const pin: SurfacePin | null =
    corners && surfaceThing?.group && camera
      ? { scene: 'custom', surfaceId: `${surfaceThing.group}:top`, corners, frame }
      : null;
  const layout: PhotoLayout = {
    scene,
    pin,
    camera,
    surfaceThing: surfaceThing?.id ?? null,
    quadIou,
    things,
    score: null,
    origin,
  };
  if (camera && origin) scoreLayout(layout, masks, scale, input.refine ?? false);
  return layout;
}
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// --- Scoring against the masks ------------------------------------------------

/** Corners of a prop (a prism's eight, a cylinder's rims as 12-gons) in scene coordinates. */
function propCorners(b: IsoBox, shape: IsoProp['shape']): [number, number, number][] {
  const { x, y, z } = b.at;
  const { w, d, h } = b.size;
  if (shape === 'cylinder') {
    const out: [number, number, number][] = [];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const px = x + w / 2 + (Math.cos(a) * w) / 2;
      const py = y + d / 2 + (Math.sin(a) * d) / 2;
      out.push([px, py, z], [px, py, z + h]);
    }
    return out;
  }
  const out: [number, number, number][] = [];
  for (const cx of [x, x + w])
    for (const cy of [y, y + d]) for (const cz of [z, z + h]) out.push([cx, cy, cz]);
  return out;
}
/** The outline of boxes as the photo's camera sees them, filled into `bits`. */
function silhouette(
  camera: PhotoCamera,
  origin: { x: number; y: number; z: number },
  boxes: { box: IsoBox; shape: IsoProp['shape'] }[],
  bits: Bits,
  scale: number,
) {
  bits.data.fill(0);
  for (const { box, shape } of boxes) {
    const pts = propCorners(box, shape)
      .map(([x, y, z]) => projectPoint(camera, x - origin.x, y - origin.y, z - origin.z))
      .filter((p): p is Point => Boolean(p))
      .map((p) => ({ x: p.x * scale, y: p.y * scale }));
    if (pts.length >= 3) fillRings(bits, [convexHull(pts)]);
  }
}
/** Overlap of a drawing with a mask, not counting pixels where another mask may hide it. */
function visibleIou(sil: Uint8Array, mask: Uint8Array, union: Uint8Array): number {
  let and = 0;
  let or = 0;
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i]!;
    if (!m && union[i]) continue;
    and += m & sil[i]!;
    or += m | sil[i]!;
  }
  return or ? and / or : 0;
}
/** Whether a corner sits on the frame's edge: where the photo cuts a surface off. */
function clippedQuad(corners: Quad, frame: Segmentation['frame']): boolean {
  const edge = 0.01 * Math.max(frame.width, frame.height);
  return corners.some(
    (p) => p.x <= edge || p.y <= edge || p.x >= frame.width - edge || p.y >= frame.height - edge,
  );
}
/** Fitted corners read one way round, and how long their back edge is in tiles. */
interface Reading {
  corners: Quad;
  width: number;
  depthRange: [number, number];
}
/**
 * Fitted corners, read the way round that suits the template. They come
 * ordered with the two highest in the frame as the back edge, which is wrong
 * for a desk running away from the camera: its short far end is highest, and
 * that end is the template's depth, not its width. Of the readings whose back
 * edge is farther from the camera than the front, the one whose surface comes
 * out nearest the template's proportions wins. When the frame cuts the
 * surface off, what shows of it may be shorter than the template, not longer.
 * Corners a person set keep their order (`turns` is just 0); only which of the
 * template's sides their back edge is gets chosen.
 */
function turnToFit(
  corners: Quad,
  frame: Segmentation['frame'],
  template: TemplateId,
  turns: readonly number[] = [0, 1, 3],
): Reading {
  const { w, d } = PROP_TEMPLATES[template].size;
  const clipped = clippedQuad(corners, frame);
  const usual: Reading = { corners, width: w, depthRange: [1, d * 2] };
  let best = usual;
  let least = Infinity;
  for (const k of turns)
    for (const [width, other] of [
      [w, d],
      [d, w],
    ] as const) {
      const turned = [0, 1, 2, 3].map((i) => corners[(i + k) % 4]!) as Quad;
      const c = cameraFromPin(turned, frame, width, [0.05, 100]);
      if (!c) continue;
      const at = (X: number, Y: number) =>
        norm([
          X * c.r1[0] + Y * c.r2[0] + c.t[0],
          X * c.r1[1] + Y * c.r2[1] + c.t[1],
          X * c.r1[2] + Y * c.r2[2] + c.t[2],
        ]);
      if (at(width / 2, 0) <= at(width / 2, c.surface.d)) continue;
      const ratio = Math.log(c.surface.d / other);
      // Any other reading is a bigger claim than the usual one, so it has to fit clearly better.
      const off = (clipped ? Math.max(0, ratio) : Math.abs(ratio)) + (k || width !== w ? 0.2 : 0);
      if (off < least) {
        least = off;
        best = { corners: turned, width, depthRange: [1, other * 2] };
      }
    }
  return best;
}
/**
 * Corners nudged until the whole surface template, top, front and legs,
 * drawn from the camera those corners imply, matches the surface's mask. A
 * quad fitted to the mask alone sits on the front face's bottom edge, not
 * the top's.
 */
function refinePin(
  { corners, width, depthRange }: Reading,
  template: TemplateId,
  frame: Segmentation['frame'],
  mask: Bits,
  union: Uint8Array,
  scale: number,
): Quad {
  const sil = newBits(mask.width, mask.height);
  const match = (q: Quad) => {
    if (!quadIsConvex(q, 1)) return 0;
    const cam = cameraFromPin(q, frame, width, depthRange);
    if (!cam) return 0;
    const top = topOf(template, cam.surface);
    const built = placeTemplate(template, 'pin', 0, 0, 0, { size: cam.surface });
    silhouette(
      cam,
      { x: 0, y: 0, z: top },
      built.props.map((p) => ({ box: p as IsoBox, shape: p.shape })),
      sil,
      scale,
    );
    return visibleIou(sil.data, mask.data, union);
  };
  let best = corners.map((p) => ({ ...p })) as Quad;
  let score = match(best);
  let evaluations = 0;
  for (let step = Math.max(frame.width, frame.height) * 0.02; step * scale >= 0.5; step /= 2)
    for (let moved = true; moved && evaluations < 400;) {
      moved = false;
      for (let k = 0; k < 4; k++)
        for (const [dx, dy] of [
          [0, step],
          [0, -step],
          [step, 0],
          [-step, 0],
        ] as const) {
          const q = best.map((p, i) => (i === k ? { x: p.x + dx, y: p.y + dy } : p)) as Quad;
          evaluations++;
          const s = match(q);
          if (s > score + 1e-5) {
            best = q;
            score = s;
            moved = true;
          }
        }
    }
  return best.map((p) => ({
    x: clamp(p.x, 0, frame.width),
    y: clamp(p.y, 0, frame.height),
  })) as Quad;
}
/**
 * Score every thing's drawing against its mask, and when asked, nudge each
 * placed template (not the pinned surface) by turns and half, quarter and
 * eighth tiles while its match improves. Pixels another mask covers don't
 * count against a thing, since that other thing may stand in front of it.
 */
function scoreLayout(
  layout: PhotoLayout,
  masks: Map<string, Bits>,
  scale: number,
  refine: boolean,
) {
  const any = masks.values().next().value as Bits | undefined;
  if (!any) return;
  const { width, height } = any;
  const union = new Uint8Array(width * height);
  for (const m of masks.values()) for (let i = 0; i < union.length; i++) union[i]! |= m.data[i]!;
  const sil = newBits(width, height);
  const matchOf = (id: string, boxes: { box: IsoBox; shape: IsoProp['shape'] }[]) => {
    silhouette(layout.camera!, layout.origin!, boxes, sil, scale);
    return visibleIou(sil.data, masks.get(id)!.data, union);
  };
  const groupBoxes = (scene: IsoScene, g: string) =>
    scene.props.filter((p) => p.group === g).map((p) => ({ box: p as IsoBox, shape: p.shape }));
  let weighted = 0;
  let total = 0;
  for (const t of layout.things) {
    if (!masks.has(t.id) || (t.status !== 'placed' && t.status !== 'object')) continue;
    if (t.status === 'object' && t.foot)
      t.iou = matchOf(t.id, [{ box: t.foot, shape: 'cylinder' }]);
    else if (t.group) {
      const g = t.group;
      let best = matchOf(t.id, groupBoxes(layout.scene, g));
      if (refine && t.id !== layout.surfaceThing) {
        const onTop = PROP_TEMPLATES[t.as as TemplateId]?.onTop;
        const settle = (s: IsoScene) => (onTop ? settleGroup(s, g) : s);
        let scene = layout.scene;
        let trial = scene;
        for (let k = 1; k < 4; k++) {
          trial = settle(rotateGroup(trial, g));
          const s = matchOf(t.id, groupBoxes(trial, g));
          if (s > best + 1e-4) {
            best = s;
            scene = trial;
          }
        }
        let evaluations = 3;
        for (const step of [0.5, 0.25, 0.125])
          for (let moved = true; moved && evaluations < 40;) {
            moved = false;
            for (const [dx, dy] of [
              [step, 0],
              [-step, 0],
              [0, step],
              [0, -step],
            ] as const) {
              if (evaluations >= 40) break;
              const next = settle(moveGroup(scene, g, dx, dy));
              evaluations++;
              const s = matchOf(t.id, groupBoxes(next, g));
              if (s > best + 1e-4) {
                best = s;
                scene = next;
                moved = true;
              }
            }
          }
        layout.scene = scene;
      }
      t.iou = best;
    }
    const a = count(masks.get(t.id)!.data);
    weighted += (t.iou ?? 0) * a;
    total += a;
  }
  layout.score = total ? weighted / total : null;
}

// --- A flat drawing for Spark to compare --------------------------------------

const FLAT: Record<IsoTone, [number, number, number]> = {
  floor: [190, 186, 176],
  wall: [214, 210, 200],
  wood: [150, 112, 76],
  steel: [120, 126, 134],
  fabric: [88, 104, 140],
  paper: [236, 232, 220],
  book: [60, 110, 90],
  glass: [160, 200, 210],
  appliance: [60, 62, 70],
  plant: [70, 140, 80],
  ceramic: [220, 214, 196],
};
/**
 * The layout drawn from the photo's camera in flat colours, far things first,
 * as RGBA at `width` pixels across: what Spark sees beside the photo.
 */
export function flatView(
  layout: PhotoLayout,
  width: number,
): { width: number; height: number; rgba: Uint8Array } | null {
  const { camera, origin } = layout;
  if (!camera || !origin) return null;
  const frame = layout.pin?.frame ?? { width: camera.cx * 2, height: camera.cy * 2 };
  const scale = width / frame.width;
  const out = { width, height: Math.round(frame.height * scale), rgba: new Uint8Array(0) };
  out.rgba = new Uint8Array(out.width * out.height * 4).fill(255);
  const bits = newBits(out.width, out.height);
  // Distance along the camera's axis, from the footprint's centre.
  const depth = (b: IsoBox) =>
    (b.at.x + b.size.w / 2 - origin.x) * camera.r1[2] +
    (b.at.y + b.size.d / 2 - origin.y) * camera.r2[2] +
    (b.at.z - origin.z) * camera.up[2] +
    camera.t[2];
  const items: { box: IsoBox; shape: IsoProp['shape']; rgb: [number, number, number] }[] = [
    ...layout.scene.props.map((p) => ({ box: p as IsoBox, shape: p.shape, rgb: FLAT[p.tone] })),
    ...layout.things
      .filter((t) => t.status === 'object' && t.foot)
      .map((t) => ({
        box: t.foot!,
        shape: 'cylinder' as const,
        rgb: [230, 120, 60] as [number, number, number],
      })),
  ].sort((a, b) => depth(b.box) - depth(a.box));
  for (const it of items) {
    silhouette(camera, origin, [it], bits, scale);
    for (let i = 0; i < bits.data.length; i++)
      if (bits.data[i]) out.rgba.set([...it.rgb, 255], i * 4);
  }
  return out;
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

// --- Synthetic photos, for tests and the benchmark ----------------------------

export interface SyntheticPhotoOptions {
  /** Degrees above the desk's centre. */
  elevation: number;
  /** Radians the camera is turned about the desk. */
  yaw: number;
  /** Focal length in pixels. */
  f: number;
  frame?: Segmentation['frame'];
  surface?: { as: SurfaceTemplate; w: number; d: number };
  /** Floor templates, back-left corner in tiles from the surface's back-left corner. */
  furniture?: { id: string; as: TemplateId; x: number; y: number }[];
  /** Round objects standing on the surface: centre, radius and height in tiles. */
  objects?: { id: string; as: PhotoAs; x: number; y: number; r: number; h: number }[];
}
/** A pinhole camera from `SyntheticPhotoOptions`, aimed at the surface's centre. */
function syntheticCamera(o: SyntheticPhotoOptions, frame: Segmentation['frame'], centre: Vec3) {
  const el = (o.elevation * Math.PI) / 180;
  const dist = 9;
  const C: Vec3 = [
    centre[0] + dist * Math.cos(el) * Math.sin(o.yaw),
    centre[1] + dist * Math.cos(el) * Math.cos(o.yaw),
    centre[2] + dist * Math.sin(el),
  ];
  const fwd = sub(centre, C);
  const z = scaleV(fwd, 1 / norm(fwd));
  const right: Vec3 = [Math.cos(o.yaw), -Math.sin(o.yaw), 0];
  const down = crossV(right, z);
  return {
    depth: (p: Vec3) => dot(sub(p, C), z),
    project: (p: Vec3): Point => {
      const q = sub(p, C);
      return {
        x: (o.f * dot(q, right)) / dot(q, z) + frame.width / 2,
        y: (o.f * dot(q, down)) / dot(q, z) + frame.height / 2,
      };
    },
  };
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
/**
 * A photo of a surface with furniture and objects, outlined the way SAM
 * would: every mask only where nothing nearer hides it. World X runs along
 * the surface's back edge, Y toward the front, Z up from its top. `truth`
 * holds where everything really is, to measure a layout against.
 */
export function syntheticPhoto(o: SyntheticPhotoOptions) {
  const frame = o.frame ?? { width: 1280, height: 720 };
  const surface = o.surface ?? { as: 'desk', w: 4, d: 2.5 };
  const top = topOf(surface.as, surface);
  const cam = syntheticCamera(o, frame, [surface.w / 2, surface.d / 2, -0.6]);
  type Shape = {
    id: string;
    label: string;
    as: PhotoAs;
    role: PhotoThing['role'];
    on: string;
    solids: Point[][];
    depth: number;
  };
  const toWorld = (p: IsoProp): [Vec3, Vec3] => [
    [p.at.x, p.at.y, p.at.z - top],
    [p.at.x + p.size.w, p.at.y + p.size.d, p.at.z - top + p.size.h],
  ];
  const hullOf = ([a, b]: [Vec3, Vec3], round: boolean): Point[] => {
    const pts: Point[] = [];
    if (round) {
      for (let k = 0; k < 24; k++) {
        const t = (k / 24) * Math.PI * 2;
        const x = (a[0] + b[0]) / 2 + (Math.cos(t) * (b[0] - a[0])) / 2;
        const y = (a[1] + b[1]) / 2 + (Math.sin(t) * (b[1] - a[1])) / 2;
        pts.push(cam.project([x, y, a[2]]), cam.project([x, y, b[2]]));
      }
    } else
      for (const x of [a[0], b[0]])
        for (const y of [a[1], b[1]])
          for (const z of [a[2], b[2]]) pts.push(cam.project([x, y, z]));
    return convexHull(pts);
  };
  const centreDepth = ([a, b]: [Vec3, Vec3]) =>
    cam.depth([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  const shapes: Shape[] = [];
  const truth: Record<string, { x: number; y: number }> = {};
  const desk = placeTemplate(surface.as, 'surface', 0, 0, 0, {
    size: { w: surface.w, d: surface.d },
  });
  shapes.push({
    id: 'surface',
    label: PROP_TEMPLATES[surface.as].label.toLowerCase(),
    as: surface.as,
    role: 'surface',
    on: 'floor',
    solids: desk.props.map((p) => hullOf(toWorld(p), p.shape === 'cylinder')),
    depth: Math.max(...desk.props.map((p) => centreDepth(toWorld(p)))),
  });
  for (const f of o.furniture ?? []) {
    const built = placeTemplate(f.as, f.id, f.x, f.y, 0);
    truth[f.id] = { x: f.x, y: f.y };
    shapes.push({
      id: f.id,
      label: PROP_TEMPLATES[f.as].label.toLowerCase(),
      as: f.as,
      role: 'furniture',
      on: 'floor',
      solids: built.props.map((p) => hullOf(toWorld(p), p.shape === 'cylinder')),
      depth: Math.min(...built.props.map((p) => centreDepth(toWorld(p)))),
    });
  }
  for (const b of o.objects ?? []) {
    truth[b.id] = { x: b.x, y: b.y };
    const box: [Vec3, Vec3] = [
      [b.x - b.r, b.y - b.r, 0],
      [b.x + b.r, b.y + b.r, b.h],
    ];
    shapes.push({
      id: b.id,
      label: b.as,
      as: b.as,
      role: 'object',
      on: 'surface',
      solids: [hullOf(box, true)],
      depth: centreDepth(box),
    });
  }
  // Nearest first: each mask keeps only pixels nothing nearer has claimed.
  const claimed = new Uint8Array(frame.width * frame.height);
  const detections: Detection[] = [];
  const things: PhotoThing[] = [];
  const ids: Record<string, string> = {};
  for (const s of [...shapes].sort((a, b) => a.depth - b.depth)) {
    const bits = newBits(frame.width, frame.height);
    for (const solid of s.solids) {
      const one = newBits(frame.width, frame.height);
      fillRings(one, [solid]);
      for (let i = 0; i < one.data.length; i++) if (one.data[i]) bits.data[i] = 1;
    }
    for (let i = 0; i < bits.data.length; i++) {
      if (claimed[i]) bits.data[i] = 0;
      else if (bits.data[i]) claimed[i] = 1;
    }
    const d = detectionFromBits(String(detections.length + 1), bits);
    if (!d) continue;
    detections.push(d);
    ids[s.id] = d.objectId;
    things.push({
      id: s.id,
      label: s.label,
      as: s.as,
      role: s.role,
      on: s.on,
      box: {
        x1: Math.round((d.box.x / frame.width) * 1000),
        y1: Math.round((d.box.y / frame.height) * 1000),
        x2: Math.round(((d.box.x + d.box.width) / frame.width) * 1000),
        y2: Math.round(((d.box.y + d.box.height) / frame.height) * 1000),
      },
    });
  }
  // Spark lists things biggest first, the surface among them.
  const order = shapes.map((s) => s.id);
  things.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const corners = [
    cam.project([0, 0, 0]),
    cam.project([surface.w, 0, 0]),
    cam.project([surface.w, surface.d, 0]),
    cam.project([0, surface.d, 0]),
  ] as Quad;
  return {
    inventory: { kind: 'desk', things, summary: 'A synthetic photo.' } as PhotoInventory,
    segmentation: { concept: 'photo scene', frame, detections } as Segmentation,
    detections: ids,
    truth: { corners, at: truth, surface },
  };
}
