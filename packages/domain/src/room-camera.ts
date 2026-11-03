import { cross, dot, sub, unit, type Vec3 } from './math.js';
import { z } from 'zod';
import { pointSchema, type IsoVec, type Point } from './iso.js';
import { cm } from './iso-furniture.js';
import type { CameraCrop } from './camera.js';

/**
 * The room's one camera: a pinhole camera mounted high in the room's front
 * corner, looking across at the back-left corner, the way the iso view looks.
 * Everything is in room tiles (30 cm): x along the back wall, y along the left
 * wall, z up from the floor, with the back-left floor corner at the origin.
 */
export interface RoomCamera {
  /** Focal length and principal point, in frame pixels. */
  f: number;
  cx: number;
  cy: number;
  frame: { width: number; height: number };
  /** The camera's axes in room coordinates: image right, image down, and forward. */
  right: Vec3;
  down: Vec3;
  forward: Vec3;
  /** Where the camera is, in tiles. */
  position: Vec3;
  /** The room's floor, in tiles. */
  room: { w: number; d: number };
}
const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const roomCameraSchema = z
  .object({
    f: z.number().positive(),
    cx: z.number().finite(),
    cy: z.number().finite(),
    frame: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict(),
    right: vec3,
    down: vec3,
    forward: vec3,
    position: vec3,
    room: z.object({ w: z.number().min(2).max(16), d: z.number().min(2).max(16) }).strict(),
  })
  .strict() satisfies z.ZodType<RoomCamera>;

/** A point in the camera's own axes: x right, y down, z forward. */
export function toCamera(c: RoomCamera, { x, y, z }: IsoVec): Vec3 {
  const p = sub([x, y, z], c.position);
  return [dot(p, c.right), dot(p, c.down), dot(p, c.forward)];
}
/** Where a point of the room appears in the frame, or null behind the camera. */
export function projectRoom(c: RoomCamera, p: IsoVec): Point | null {
  const [x, y, z] = toCamera(c, p);
  if (z <= 1e-6) return null;
  return { x: (c.f * x) / z + c.cx, y: (c.f * y) / z + c.cy };
}
/** How far in front of the camera a point is, along its view. */
export const roomDepth = (c: RoomCamera, p: IsoVec) => toCamera(c, p)[2];
/** The ray a pixel sees, in room coordinates: from the camera, not of unit length. */
export function pixelRay(c: RoomCamera, { x, y }: Point): Vec3 {
  const u = (x - c.cx) / c.f;
  const v = (y - c.cy) / c.f;
  return [0, 1, 2].map((k) => c.right[k]! * u + c.down[k]! * v + c.forward[k]!) as Vec3;
}
/** The point at height `z` that a pixel shows, or null when that plane is behind the camera. */
export function unprojectRoom(c: RoomCamera, p: Point, z = 0): IsoVec | null {
  const d = pixelRay(c, p);
  if (Math.abs(d[2]) < 1e-9) return null;
  const s = (z - c.position[2]) / d[2];
  if (s <= 0) return null;
  return { x: c.position[0] + s * d[0], y: c.position[1] + s * d[1], z };
}

/** Degrees the camera looks down on a point from, for fitting a model to what it sees there. */
export function elevationAt(c: RoomCamera, p: IsoVec): number {
  const d = sub([p.x, p.y, p.z], c.position);
  return (Math.atan2(-d[2], Math.hypot(d[0], d[1])) * 180) / Math.PI;
}

/** A camera at `position` looking at `target`, kept level: image right stays horizontal. */
export function lookAt(
  position: Vec3,
  target: Vec3,
  f: number,
  frame: RoomCamera['frame'],
  room: RoomCamera['room'],
  roll = 0,
): RoomCamera {
  const forward = unit(sub(target, position));
  // The room is drawn with x to the right of y, as the iso view shows it.
  let right = unit(cross([0, 0, 1], forward));
  let down = unit(cross(right, forward));
  if (roll) {
    const [c, s] = [Math.cos(roll), Math.sin(roll)];
    [right, down] = [
      unit([0, 1, 2].map((k) => right[k]! * c + down[k]! * s) as Vec3),
      unit([0, 1, 2].map((k) => down[k]! * c - right[k]! * s) as Vec3),
    ];
  }
  return {
    f,
    cx: frame.width / 2,
    cy: frame.height / 2,
    frame,
    right,
    down,
    forward,
    position,
    room,
  };
}

/** Typical corner cameras: a wide lens, mounted 2.4 m up, 10 cm in from each wall. */
export const CORNER_DEFAULTS = { heightCm: 240, insetCm: 10, hfovDeg: 90 } as const;
const focalOf = (width: number, hfovDeg: number) => width / 2 / Math.tan((hfovDeg * Math.PI) / 360);

/**
 * The camera a person would mount for a room of `room` tiles: high in the
 * front corner, aimed so the back-left corner sits a little above the frame's
 * middle and both walls run out to its sides.
 */
export function cornerCamera(
  room: RoomCamera['room'],
  {
    frame = { width: 960, height: 720 },
    heightCm = CORNER_DEFAULTS.heightCm,
    insetCm = CORNER_DEFAULTS.insetCm,
    hfovDeg = CORNER_DEFAULTS.hfovDeg,
  }: {
    frame?: RoomCamera['frame'];
    heightCm?: number;
    insetCm?: number;
    hfovDeg?: number;
  } = {},
): RoomCamera {
  const inset = cm(insetCm);
  return lookAt(
    [room.w - inset, room.d - inset, cm(heightCm)],
    [room.w * 0.4, room.d * 0.4, 0],
    focalOf(frame.width, hfovDeg),
    frame,
    room,
  );
}

/**
 * What calibration sees of the room: where the back-left floor corner is in
 * the frame, points along the floor lines of the back wall (to its right in
 * the frame) and the left wall (to its left), and, when the frame shows them,
 * the far ends of those walls: the back-right and front-left floor corners.
 * The fourth corner is the camera's own. The corners are what pin the lens
 * down; the lines alone leave it trading off against the camera's tilt.
 */
export interface RoomMarks {
  corner: Point;
  back: Point[];
  left: Point[];
  backEnd?: Point | null;
  leftEnd?: Point | null;
  /**
   * Lines a person drew straight up from the floor to something of known
   * height (a desk's top, a door's frame): where it stands, the point that
   * high above it, and how high that is. The floor marks pin the room's
   * shape, not its size; a known height pins its size and the camera's.
   */
  heights?: HeightMark[];
  /**
   * Lines a person drew along things that stand straight up (a shelf's post,
   * a door's edge), no length needed: the floor marks barely say which way is
   * up, so these pin the camera's tilt.
   */
  verticals?: VerticalMark[];
}
export interface VerticalMark {
  a: Point;
  b: Point;
}
export const verticalMarkSchema = z.object({ a: pointSchema, b: pointSchema }).strict();
export interface HeightMark {
  foot: Point;
  top: Point;
  cm: number;
}
export const heightMarkSchema = z
  .object({ foot: pointSchema, top: pointSchema, cm: z.number().min(5).max(400) })
  .strict();
export const roomMarksSchema = z
  .object({
    corner: pointSchema,
    back: z.array(pointSchema).max(64),
    left: z.array(pointSchema).max(64),
    backEnd: pointSchema.nullable().optional(),
    leftEnd: pointSchema.nullable().optional(),
    heights: z.array(heightMarkSchema).max(8).optional(),
    verticals: z.array(verticalMarkSchema).max(8).optional(),
  })
  .strict();

/** How far a point is from the line a and b make, in pixels. */
function offLine(a: Point, b: Point, p: Point) {
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  if (l < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / l;
}

/**
 * How far, squared in pixels, a camera draws a height mark's top from where
 * the person put it: the point its foot marks on the floor, raised its height.
 */
function heightMiss(c: RoomCamera, m: HeightMark) {
  const foot = unprojectRoom(c, m.foot, 0);
  const top = foot && projectRoom(c, { x: foot.x, y: foot.y, z: cm(m.cm) });
  return top ? (top.x - m.top.x) ** 2 + (top.y - m.top.y) ** 2 : 1e8;
}

/**
 * Which way straight up runs in the frame at a pixel, as a unit vector
 * pointing up the picture: every upright runs toward the point straight up
 * (or down) vanishes to, so its direction there is the camera's tilt.
 */
export function uprightAt(c: RoomCamera, p: Point): Point {
  const w = c.forward[2];
  // Where straight up vanishes, in homogeneous pixels (w near 0: a level camera, uprights parallel).
  const vx = c.f * c.right[2] + c.cx * w;
  const vy = c.f * c.down[2] + c.cy * w;
  const [ux, uy] = [vx - p.x * w, vy - p.y * w];
  const u = Math.hypot(ux, uy) || 1;
  const s = uy > 0 ? -1 : 1;
  return { x: (s * ux) / u, y: (s * uy) / u };
}
/**
 * How far, squared in pixels, a vertical mark's ends are from the upright the
 * camera draws through its middle, whatever the thing's height.
 */
function verticalMiss(c: RoomCamera, m: VerticalMark) {
  const u = uprightAt(c, { x: (m.a.x + m.b.x) / 2, y: (m.a.y + m.b.y) / 2 });
  // The far end's distance from the drawn upright through the middle, at half the line's length.
  return (((m.b.x - m.a.x) * u.y - (m.b.y - m.a.y) * u.x) / 2) ** 2;
}

/** Nelder–Mead on a few numbers. */
function minimise(f: (x: number[]) => number, start: number[], steps: number[], iterations = 600) {
  const n = start.length;
  let simplex = [start, ...steps.map((s, i) => start.map((v, j) => (j === i ? v + s : v)))].map(
    (x) => ({ x, v: f(x) }),
  );
  for (let it = 0; it < iterations; it++) {
    simplex.sort((a, b) => a.v - b.v);
    const best = simplex[0]!;
    const worst = simplex[n]!;
    if (Math.abs(worst.v - best.v) < 1e-10) break;
    const centre = start.map((_, j) => simplex.slice(0, n).reduce((s, p) => s + p.x[j]!, 0) / n);
    const along = (t: number) => centre.map((c, j) => c + t * (worst.x[j]! - c));
    const r = { x: along(-1), v: 0 };
    r.v = f(r.x);
    if (r.v < best.v) {
      const e = { x: along(-2), v: 0 };
      e.v = f(e.x);
      simplex[n] = e.v < r.v ? e : r;
    } else if (r.v < simplex[n - 1]!.v) simplex[n] = r;
    else {
      const k = { x: along(0.5), v: 0 };
      k.v = f(k.x);
      if (k.v < worst.v) simplex[n] = k;
      else
        simplex = simplex.map((p, i) =>
          i === 0 ? p : { x: p.x.map((v, j) => best.x[j]! + (v - best.x[j]!) / 2), v: f(p.x) },
        );
    }
  }
  simplex.sort((a, b) => a.v - b.v);
  return simplex[0]!;
}

/** How a calibration turned out. */
export interface RoomFit {
  camera: RoomCamera;
  /** Root mean square distance of the marks from where the camera draws them, in pixels. */
  error: number;
  /** The camera's height above the floor, in centimetres. */
  heightCm: number;
  hfovDeg: number;
}

/**
 * The camera behind the marks, for a room of `room` tiles with the camera in
 * its front corner. The corner and the two floor lines leave the lens, the
 * camera's height and its aim one number short, so a typical lens and a level
 * camera are weak priors; a known height (`heightCm`) pins it down further.
 */
export function cameraFromMarks(
  marks: RoomMarks,
  frame: RoomCamera['frame'],
  room: RoomCamera['room'],
  {
    heightCm,
    insetCm = CORNER_DEFAULTS.insetCm,
    origin = { x: 0, y: 0 },
    crop,
    heightSpreadCm,
  }: {
    heightCm?: number;
    insetCm?: number;
    /** Where the room's inner floor corner is in the scene, inside its walls. */
    origin?: { x: number; y: number };
    /** The camera's zoomed view, when the frame is that part of the camera's whole frame. */
    crop?: CameraCrop | null;
    /** How sure `heightCm` is: a measured height is held to a few centimetres, an estimate looser. */
    heightSpreadCm?: number;
  } = {},
): RoomFit {
  if (crop) {
    // Fit the whole lens, whose principal point is its frame's centre, then
    // keep the crop of it: the same focal length, its principal point moved.
    const full = { width: frame.width / crop.w, height: frame.height / crop.h };
    const dx = crop.x * full.width;
    const dy = crop.y * full.height;
    const shift = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
    const fit = cameraFromMarks(
      {
        corner: shift(marks.corner),
        back: marks.back.map(shift),
        left: marks.left.map(shift),
        ...(marks.backEnd !== undefined ? { backEnd: marks.backEnd && shift(marks.backEnd) } : {}),
        ...(marks.leftEnd !== undefined ? { leftEnd: marks.leftEnd && shift(marks.leftEnd) } : {}),
        ...(marks.heights
          ? {
              heights: marks.heights.map((m) => ({ ...m, foot: shift(m.foot), top: shift(m.top) })),
            }
          : {}),
        ...(marks.verticals
          ? { verticals: marks.verticals.map((m) => ({ a: shift(m.a), b: shift(m.b) })) }
          : {}),
      },
      full,
      room,
      {
        ...(heightCm ? { heightCm } : {}),
        ...(heightSpreadCm ? { heightSpreadCm } : {}),
        insetCm,
        origin,
      },
    );
    const camera = { ...fit.camera, cx: fit.camera.cx - dx, cy: fit.camera.cy - dy, frame };
    return { ...fit, camera, hfovDeg: (2 * Math.atan(frame.width / 2 / camera.f) * 180) / Math.PI };
  }
  const inset = cm(insetCm);
  const build = ([fov, yaw, pitch, roll, h]: number[]) => {
    const position: Vec3 = [room.w - inset, room.d - inset, h!];
    // Aim by yaw about the corner direction and pitch down from level.
    const base = Math.atan2(-(room.d - inset), -(room.w - inset));
    const a = base + yaw!;
    const target: Vec3 = [
      position[0] + Math.cos(a) * Math.cos(pitch!),
      position[1] + Math.sin(a) * Math.cos(pitch!),
      position[2] - Math.sin(pitch!),
    ];
    return lookAt(position, target, focalOf(frame.width, fov!), frame, room, roll);
  };
  const diag = Math.hypot(frame.width, frame.height);
  const cost = (x: number[]) => {
    const [fov, , , roll, h] = x;
    if (!(fov! > 40 && fov! < 160 && h! > 0.5 && h! < 16)) return 1e12;
    const c = build(x);
    const o = projectRoom(c, { x: 0, y: 0, z: 0 });
    const bx = projectRoom(c, { x: room.w, y: 0, z: 0 });
    const ly = projectRoom(c, { x: 0, y: room.d, z: 0 });
    // Far along each wall, in case its far end is behind the camera.
    const bAlong = projectRoom(c, { x: Math.min(room.w, 1), y: 0, z: 0 });
    const lAlong = projectRoom(c, { x: 0, y: Math.min(room.d, 1), z: 0 });
    if (!o || !bAlong || !lAlong) return 1e12;
    let e = (o.x - marks.corner.x) ** 2 + (o.y - marks.corner.y) ** 2;
    for (const p of marks.back) e += offLine(o, bx ?? bAlong, p) ** 2;
    for (const p of marks.left) e += offLine(o, ly ?? lAlong, p) ** 2;
    // A wall's far corner counts like several points on the line.
    const ends = [
      [marks.backEnd, bx],
      [marks.leftEnd, ly],
    ] as const;
    let n = 1 + marks.back.length + marks.left.length;
    for (const [seen, drawn] of ends) {
      if (!seen) continue;
      e += 4 * (drawn ? (drawn.x - seen.x) ** 2 + (drawn.y - seen.y) ** 2 : 1e8);
      n += 4;
    }
    // A known height counts like a wall's far corner.
    for (const m of marks.heights ?? []) {
      e += 4 * heightMiss(c, m);
      n += 4;
    }
    // So does an upright, at both its ends.
    for (const m of marks.verticals ?? []) {
      e += 4 * 2 * verticalMiss(c, m);
      n += 4;
    }
    e /= n;
    // Priors, in pixels² so they weigh like a mark a few pixels off.
    const px = diag / 200;
    e += ((fov! - CORNER_DEFAULTS.hfovDeg) / 40) ** 2 * px * px;
    // A level camera is a guess the uprights, when marked, replace: they show its roll.
    e += (roll! / (marks.verticals?.length ? 0.5 : 0.05)) ** 2 * px * px;
    const want = cm(heightCm ?? CORNER_DEFAULTS.heightCm);
    e += ((h! - want) / (heightCm ? cm(heightSpreadCm ?? 1.5) : 5)) ** 2 * px * px;
    return e;
  };
  // Start a few ways and keep the best.
  let best = { x: [CORNER_DEFAULTS.hfovDeg, 0, 0.5, 0, 8], v: Infinity };
  for (const fov of [70, 100, 130])
    for (const pitch of [0.35, 0.6, 0.9]) {
      const run = minimise(
        cost,
        [fov, 0, pitch, 0, cm(heightCm ?? CORNER_DEFAULTS.heightCm)],
        [10, 0.1, 0.1, 0.02, 1],
      );
      if (run.v < best.v) best = run;
    }
  const again = minimise(cost, best.x, [3, 0.03, 0.03, 0.01, 0.3]);
  if (again.v < best.v) best = again;
  const inner = build(best.x);
  const o = projectRoom(inner, { x: 0, y: 0, z: 0 });
  const bAlong = projectRoom(inner, { x: room.w, y: 0, z: 0 }) ?? marks.corner;
  const lAlong = projectRoom(inner, { x: 0, y: room.d, z: 0 }) ?? marks.corner;
  const gap = (a: Point | null, b: Point) => (a ? (a.x - b.x) ** 2 + (a.y - b.y) ** 2 : 1e6);
  const sq = [
    gap(o, marks.corner),
    ...marks.back.map((p) => offLine(o ?? marks.corner, bAlong, p) ** 2),
    ...marks.left.map((p) => offLine(o ?? marks.corner, lAlong, p) ** 2),
    ...(marks.backEnd ? [gap(projectRoom(inner, { x: room.w, y: 0, z: 0 }), marks.backEnd)] : []),
    ...(marks.leftEnd ? [gap(projectRoom(inner, { x: 0, y: room.d, z: 0 }), marks.leftEnd)] : []),
    ...(marks.heights ?? []).map((m) => heightMiss(inner, m)),
    ...(marks.verticals ?? []).map((m) => verticalMiss(inner, m)),
  ];
  // In the scene's own coordinates, walls and all.
  const camera: RoomCamera = {
    ...inner,
    position: [inner.position[0] + origin.x, inner.position[1] + origin.y, inner.position[2]],
    room: { w: room.w + origin.x, d: room.d + origin.y },
  };
  return {
    camera,
    error: Math.sqrt(sq.reduce((s, v) => s + v, 0) / sq.length),
    heightCm: (camera.position[2] * 30) | 0,
    hfovDeg: best.x[0]!,
  };
}

/** How far off, in pixels, marks may be from a camera's floor lines for the fit to be kept. */
export const fitLimit = (frame: RoomCamera['frame']) => Math.hypot(frame.width, frame.height) / 60;

/**
 * The length of one wall that best fits the marks, the other wall kept as
 * given. Marks pin the room's shape, not its size: a camera higher up sees a
 * bigger room the same way. So one wall has to be known, and this finds the
 * other, to a third of a tile (10 cm), between 2 and 20 tiles.
 */
export function roomSizeFor(
  marks: RoomMarks,
  frame: RoomCamera['frame'],
  room: RoomCamera['room'],
  solve: 'w' | 'd',
  options: Parameters<typeof cameraFromMarks>[3] = {},
): { room: RoomCamera['room']; error: number } {
  const at = (v: number) => {
    const size = solve === 'w' ? { w: v, d: room.d } : { w: room.w, d: v };
    return { room: size, error: cameraFromMarks(marks, frame, size, options).error };
  };
  let best = at(2);
  for (let v = 3; v <= 20; v += 1) {
    const here = at(v);
    if (here.error < best.error) best = here;
  }
  const coarse = best.room[solve];
  for (const step of [-2, -1, 1, 2]) {
    const v = coarse + step / 3;
    if (v < 2 || v > 20) continue;
    const here = at(v);
    if (here.error < best.error) best = here;
  }
  return best;
}

/**
 * The room's size that best fits the marks when they include known heights:
 * both walls scaled together, keeping the shape the floor marks give, from
 * 0.6 to 1.6 times as given, to a centimetre or so. Without heights every
 * scale fits the floor alike, so the size is kept.
 */
export function roomScaleFor(
  marks: RoomMarks,
  frame: RoomCamera['frame'],
  room: RoomCamera['room'],
  options: Parameters<typeof cameraFromMarks>[3] = {},
): { room: RoomCamera['room']; error: number; scale: number } {
  const at = (scale: number) => ({
    scale,
    room: { w: room.w * scale, d: room.d * scale },
    error: cameraFromMarks(marks, frame, { w: room.w * scale, d: room.d * scale }, options).error,
  });
  if (!marks.heights?.length) return at(1);
  let best = at(1);
  for (let k = 0.6; k <= 1.6 + 1e-9; k += 0.05) {
    const here = at(k);
    if (here.error < best.error) best = here;
  }
  for (const step of [0.02, 0.005])
    for (const d of [-2, -1, 1, 2]) {
      const here = at(best.scale + d * step);
      if (here.scale > 0 && here.error < best.error) best = here;
    }
  return best;
}

/**
 * The room's size that best fits marks with vertical lines: each wall's
 * length found in turn, twice over. The floor marks alone fit a room of the
 * wrong size by tilting the camera; uprights say which way is up, so only
 * the right size fits both.
 */
export function roomShapeFor(
  marks: RoomMarks,
  frame: RoomCamera['frame'],
  room: RoomCamera['room'],
  options: Parameters<typeof cameraFromMarks>[3] = {},
): { room: RoomCamera['room']; error: number } {
  let best = { room, error: cameraFromMarks(marks, frame, room, options).error };
  if (!marks.verticals?.length) return best;
  for (let round = 0; round < 2; round++)
    for (const solve of ['w', 'd'] as const) {
      const here = roomSizeFor(marks, frame, best.room, solve, options);
      if (here.error < best.error) best = here;
    }
  return best;
}

/**
 * The camera a zoomed view of `c` is: the part of its frame `crop` keeps, at
 * the same focal length, its principal point moved off the new frame's centre.
 */
export function cropCamera(c: RoomCamera, crop: CameraCrop): RoomCamera {
  const frame = {
    width: Math.round(c.frame.width * crop.w),
    height: Math.round(c.frame.height * crop.h),
  };
  return {
    ...c,
    frame,
    cx: c.cx - crop.x * c.frame.width,
    cy: c.cy - crop.y * c.frame.height,
  };
}

/** The room's marks as a camera would see them: the corner and points along both walls. */
export function marksOf(c: RoomCamera, count = 6): RoomMarks {
  const inFrame = (p: Point | null): p is Point =>
    !!p && p.x >= 0 && p.y >= 0 && p.x <= c.frame.width && p.y <= c.frame.height;
  const along = (to: (t: number) => IsoVec) =>
    Array.from({ length: count }, (_, i) => projectRoom(c, to((i + 1) / count))).filter(inFrame);
  const end = (p: IsoVec) => {
    const q = projectRoom(c, p);
    return inFrame(q) ? q : null;
  };
  return {
    corner: projectRoom(c, { x: 0, y: 0, z: 0 })!,
    back: along((t) => ({ x: t * c.room.w, y: 0, z: 0 })),
    left: along((t) => ({ x: 0, y: t * c.room.d, z: 0 })),
    backEnd: end({ x: c.room.w, y: 0, z: 0 }),
    leftEnd: end({ x: 0, y: c.room.d, z: 0 }),
  };
}

/**
 * Marks read off a floor mask: the floor's outline from above is two lines
 * meeting at the far corner. Furniture against a wall hides part of the floor
 * but not its convex hull, so the hull's top edge is used. Points on the
 * frame's border are where the frame cuts the floor off, and are left out.
 */
export function marksFromFloor(
  bits: { width: number; height: number; data: Uint8Array },
  hullOf: (points: Point[]) => Point[],
): RoomMarks | null {
  const { width, height, data } = bits;
  const pts: Point[] = [];
  // The top and bottom floor pixel of each column is all the hull needs.
  for (let x = 0; x < width; x++) {
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < height; y++)
      if (data[y * width + x]) {
        if (top < 0) top = y;
        bottom = y;
      }
    if (top >= 0) pts.push({ x, y: top }, { x, y: bottom });
  }
  if (pts.length < 6) return null;
  const hull = hullOf(pts);
  const k = hull.reduce((b, p, i) => (p.y < hull[b]!.y ? i : b), 0);
  const corner = hull[k]!;
  const edge = 2;
  const onBorder = (p: Point) =>
    p.x <= edge || p.y <= edge || p.x >= width - 1 - edge || p.y >= height - 1 - edge;
  // Walk the hull's top from the corner, each way, while it runs outward on
  // one straight line: a bend is another wall's floor line, or the frame.
  const walk = (step: 1 | -1, outward: (p: Point) => boolean) => {
    const out: Point[] & { bend?: boolean } = [];
    let heading: number | null = null;
    let prev = corner;
    for (let i = 1; i < hull.length; i++) {
      const p = hull[(k + step * i + hull.length) % hull.length]!;
      if (!outward(p)) break;
      // Each hull edge's own direction, once the line's is known from a long enough stretch.
      const a = Math.atan2(p.y - prev.y, p.x - prev.x);
      const long = Math.hypot(p.x - prev.x, p.y - prev.y) > 6;
      const far = Math.hypot(p.x - corner.x, p.y - corner.y) > width * 0.03;
      if (heading !== null && long && Math.abs(a - heading) > 0.12) {
        // The line bent inside the frame: its last point is the wall's far corner.
        out.bend = true;
        break;
      }
      out.push(p);
      prev = p;
      if (onBorder(p)) break;
      if (far) heading ??= Math.atan2(p.y - corner.y, p.x - corner.x);
    }
    return out;
  };
  const right = walk(1, (p) => p.x > corner.x);
  const rightOther = walk(-1, (p) => p.x > corner.x);
  const left = walk(-1, (p) => p.x < corner.x);
  const leftOther = walk(1, (p) => p.x < corner.x);
  const back = right.length >= rightOther.length ? right : rightOther;
  const leftWall = left.length >= leftOther.length ? left : leftOther;
  // A hull edge running to the border still says where the line goes: sample along it.
  const sample = (from: Point, line: Point[]) => {
    const end = line.at(-1);
    if (!end) return [];
    return Array.from({ length: 6 }, (_, i) => ({
      x: from.x + ((end.x - from.x) * (i + 1)) / 6,
      y: from.y + ((end.y - from.y) * (i + 1)) / 6,
    }));
  };
  const b = sample(corner, back);
  const l = sample(corner, leftWall);
  if (!b.length || !l.length) return null;
  return {
    corner,
    back: b,
    left: l,
    backEnd: back.bend ? back.at(-1)! : null,
    leftEnd: leftWall.bend ? leftWall.at(-1)! : null,
  };
}

/**
 * Whether the camera moved since calibration: the frame's edges, shrunk to
 * a thumbnail, against the calibration frame's. People and things moving
 * change some edges but leave the room's lined up; a camera knocked aside
 * lines them up better at another offset, or not at all.
 */
export const CAMERA_CHECK = {
  /** Thumbnail width, in pixels. */
  width: 80,
  /** Thumbnail height at most, in pixels: it is stored in one byte. */
  maxHeight: 255,
  /** How far, in thumbnail pixels, another offset is tried. */
  reach: 3,
  /** Under this correlation at no offset the view has changed too much to trust. */
  minScore: 0.35,
  /** Another offset must line up this much better to count as a move. */
  minGain: 0.08,
};
/** The longest `cameraEdges` string: base64 of the size bytes and the tallest thumbnail. */
export const CAMERA_EDGES_MAX =
  Math.ceil((2 + CAMERA_CHECK.width * CAMERA_CHECK.maxHeight) / 3) * 4;
/** The edge thumbnail a frame is compared by, as base64 of one byte per pixel. */
export function cameraEdges(frame: { width: number; height: number; data: Uint8Array }): string {
  const w = CAMERA_CHECK.width;
  const h = Math.min(
    CAMERA_CHECK.maxHeight,
    Math.max(8, Math.round((frame.height / frame.width) * w)),
  );
  const small = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * frame.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * frame.width) / w));
      const y0 = Math.floor((y * frame.height) / h);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * frame.height) / h));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) sum += frame.data[yy * frame.width + xx]!;
      small[y * w + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  const edges = new Uint8Array(2 + w * h);
  edges[0] = w;
  edges[1] = h;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const gx = small[y * w + x + 1]! - small[y * w + x - 1]!;
      const gy = small[(y + 1) * w + x]! - small[(y - 1) * w + x]!;
      edges[2 + y * w + x] = Math.min(255, Math.round(Math.hypot(gx, gy) * 2));
    }
  let s = '';
  for (const b of edges) s += String.fromCharCode(b);
  return btoa(s);
}
const unpack = (edges: string) => {
  const raw = atob(edges);
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  return { width: bytes[0]!, height: bytes[1]!, data: bytes.subarray(2) };
};
/** How a frame lines up with the calibration frame, and whether that means the camera moved. */
export function cameraMoved(reference: string, frame: string) {
  const a = unpack(reference);
  const b = unpack(frame);
  if (a.width !== b.width || a.height !== b.height) return { moved: true, score: 0, shift: null };
  const { width: w, height: h } = a;
  const r = CAMERA_CHECK.reach;
  const score = (dx: number, dy: number) => {
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let y = r; y < h - r; y++)
      for (let x = r; x < w - r; x++) {
        const p = a.data[y * w + x]!;
        const q = b.data[(y + dy) * w + x + dx]!;
        ab += p * q;
        aa += p * p;
        bb += q * q;
      }
    return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
  };
  const still = score(0, 0);
  let best = { dx: 0, dy: 0, score: still };
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const s = score(dx, dy);
      if (s > best.score) best = { dx, dy, score: s };
    }
  const shifted = (best.dx || best.dy) && best.score - still >= CAMERA_CHECK.minGain;
  return {
    moved: still < CAMERA_CHECK.minScore || Boolean(shifted),
    score: still,
    shift: shifted ? { dx: best.dx, dy: best.dy } : null,
  };
}

/**
 * Marks from where the floor meets the walls: a floor pixel with wall just
 * above it is on a wall's floor line. Furniture against a wall hides parts of
 * those lines, but not all, so each line is fitted to the points that remain
 * (most points within two pixels wins), the back wall's running down to the
 * right and the left wall's down to the left; the corner is where they meet.
 * The walls' far ends are left to the person: furniture usually hides them.
 */
export function marksFromWalls(
  floor: { width: number; height: number; data: Uint8Array },
  wall: { width: number; height: number; data: Uint8Array },
  /** Each wall's own mask, to find a corner the furniture hides from the floor. */
  walls: { data: Uint8Array }[] = [],
): RoomMarks | null {
  const { width, height } = floor;
  // A skirting board runs between the floor's mask and the wall's: allow its height.
  const gap = Math.max(3, Math.round(height * 0.016));
  const points: Point[] = [];
  for (let x = 1; x < width - 1; x++)
    for (let y = gap; y < height - 1; y++) {
      if (!floor.data[y * width + x] || floor.data[(y - 1) * width + x]) continue;
      for (let k = 1; k <= gap; k++)
        if (wall.data[(y - k) * width + x]) {
          points.push({ x, y });
          break;
        }
    }
  if (points.length < 8) return null;
  // Deterministic: every pair of points a stride apart, scored by inliers.
  const fit = (pts: Point[], slope: (s: number) => boolean) => {
    let best: { a: Point; b: Point; inliers: Point[] } | null = null;
    const stride = Math.max(1, Math.floor(pts.length / 60));
    for (let i = 0; i < pts.length; i += stride)
      for (let j = i + stride; j < pts.length; j += stride) {
        const a = pts[i]!;
        const b = pts[j]!;
        if (Math.abs(b.x - a.x) < 8 || !slope((b.y - a.y) / (b.x - a.x))) continue;
        const inliers = pts.filter((p) => offLine(a, b, p) < 2);
        if (!best || inliers.length > best.inliers.length) best = { a, b, inliers };
      }
    if (!best || best.inliers.length < 5) return null;
    // Least squares through the inliers, as y = m x + c.
    const n = best.inliers.length;
    const mx = best.inliers.reduce((s, p) => s + p.x, 0) / n;
    const my = best.inliers.reduce((s, p) => s + p.y, 0) / n;
    const sxx = best.inliers.reduce((s, p) => s + (p.x - mx) ** 2, 0);
    const sxy = best.inliers.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
    const m = sxy / sxx;
    return { m, c: my - m * mx, inliers: best.inliers };
  };
  type Line = NonNullable<ReturnType<typeof fit>>;
  const back = fit(points, (s) => s > 0.05);
  const left = fit(
    points.filter((p) => !back?.inliers.includes(p)),
    (s) => s < -0.05,
  );
  const along = (l: Line, corner: Point, right: boolean) => {
    const xs = l.inliers.map((p) => p.x);
    const far = right ? Math.max(...xs) : Math.min(...xs);
    return Array.from({ length: 6 }, (_, i) => {
      const px = corner.x + ((far - corner.x) * (i + 1)) / 6;
      return { x: px, y: l.m * px + l.c };
    });
  };
  if (back && left && Math.abs(back.m - left.m) > 1e-6) {
    const x = (left.c - back.c) / (back.m - left.m);
    const corner = { x, y: back.m * x + back.c };
    return {
      corner,
      back: along(back, corner, true),
      left: along(left, corner, false),
      backEnd: null,
      leftEnd: null,
    };
  }
  // One wall's floor line, the other hidden behind furniture: the corner is
  // where that wall itself ends, along its line, as its own mask shows it.
  const one = back ?? left;
  if (!one || !walls.length) return null;
  const right = one === back;
  const lift = gap + 4;
  const above = (w: { data: Uint8Array }) =>
    one.inliers.filter((p) => p.y - lift > 0 && w.data[(p.y - lift) * width + p.x]).length;
  const own = walls.reduce((a, b) => (above(b) > above(a) ? b : a));
  if (!above(own)) return null;
  const xs = one.inliers.map((p) => p.x).sort((a, b) => a - b);
  let end: number | null = null;
  // From the middle of the line towards the hidden corner, while that wall still stands above it.
  for (let x = xs[xs.length >> 1]!; x >= 0 && x < width; x += right ? -1 : 1) {
    const y = Math.round(one.m * x + one.c) - lift;
    if (y <= 0 || y >= height || !own.data[y * width + x]) break;
    end = x;
  }
  if (end === null) return null;
  const corner = { x: end, y: one.m * end + one.c };
  return right
    ? { corner, back: along(one, corner, true), left: [], backEnd: null, leftEnd: null }
    : { corner, back: [], left: along(one, corner, false), backEnd: null, leftEnd: null };
}
