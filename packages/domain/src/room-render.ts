import { KEY_LIGHT, type Vec3 } from './math.js';
import type { IsoBox, IsoScene, IsoTone } from './iso.js';
import { hexLab, labRgb, rampLab, type Lab } from './color.js';
import type { Decal } from './iso-item.js';
import { propSolids } from './iso-furniture.js';
import { PROP_TONES } from './iso-prop-sprite.js';
import { toCamera, type RoomCamera } from './room-camera.js';

/**
 * The room as its camera sees it: every solid of every prop (`propSolids`,
 * the same parts the photo fitter sees) drawn in perspective with a depth
 * buffer, lit like the iso view, and labelled per pixel. The demo's camera is
 * this picture, and its synthetic SAM masks are read from the labels, so a
 * demo mask is exactly what the frame shows.
 */
export interface RoomSolid {
  /** What the pixel belongs to: a prop's group, an object's id, or `floor`. */
  id: string;
  box: IsoBox;
  shape: 'prism' | 'cylinder';
  color: Lab;
  /** Lit evenly, as the iso view draws the floor and walls. */
  flat?: boolean;
  /** A print on its top, painted as the item kernel paints a top decal. */
  decal?: Decal;
}
export interface RoomPicture {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** Per pixel, an index into `names`, or -1 where nothing is. */
  ids: Int16Array;
  names: string[];
  /** Per pixel, the distance along the camera's view to what is drawn there; Infinity where nothing is. */
  depth: Float32Array;
}

const LIGHT = KEY_LIGHT;
const BACKGROUND: Lab = hexLab('#0d0f16');
const NEAR = 0.05;

/** A prop scene's solids, by group, in the room's tones. */
export function sceneSolids(scene: IsoScene): RoomSolid[] {
  return scene.props.flatMap((p) =>
    propSolids(p).map((s) => ({
      id: p.group,
      box: s.box,
      shape: s.shape === 'cylinder' ? ('cylinder' as const) : ('prism' as const),
      color: hexLab(s.color ?? PROP_TONES[s.tone as IsoTone]),
      flat: s.tone === 'wall',
      ...(s.decal ? { decal: s.decal } : {}),
    })),
  );
}
/**
 * Things a layout draws as their own models rather than templates, as boxes
 * of their own colour where they stand: without them a picture of the room
 * lacks its laptop and mugs, and whoever compares it with the photo finds
 * them missing.
 */
export function thingSolids(
  things: { id: string; foot?: IsoBox | null; color: string }[],
): RoomSolid[] {
  return things.flatMap((t) =>
    t.foot ? [{ id: t.id, box: t.foot, shape: 'prism' as const, color: hexLab(t.color) }] : [],
  );
}
/** The floor under a grid, as a solid with only a top. */
export const floorSolid = (grid: IsoScene['grid']): RoomSolid => ({
  id: 'floor',
  box: { at: { x: 0, y: 0, z: 0 }, size: { w: grid.w, d: grid.d, h: 0 } },
  shape: 'prism',
  color: hexLab(PROP_TONES.floor),
  flat: true,
});

/** A face as a polygon of room points and its outward normal. */
interface Face {
  points: Vec3[];
  normal: Vec3;
}
function facesOf({ box: { at, size }, shape }: RoomSolid): Face[] {
  const [x0, y0, z0] = [at.x, at.y, at.z];
  const [x1, y1, z1] = [at.x + size.w, at.y + size.d, at.z + size.h];
  if (shape === 'cylinder') {
    const n = 20;
    const [cx, cy, rx, ry] = [(x0 + x1) / 2, (y0 + y1) / 2, size.w / 2, size.d / 2];
    const ring = (z: number) =>
      Array.from({ length: n }, (_, k): Vec3 => {
        const t = (k / n) * Math.PI * 2;
        return [cx + Math.cos(t) * rx, cy + Math.sin(t) * ry, z];
      });
    const bottom = ring(z0);
    const top = ring(z1);
    const sides = bottom.map((b, k): Face => {
      const t = ((k + 0.5) / n) * Math.PI * 2;
      const j = (k + 1) % n;
      return {
        points: [b, bottom[j]!, top[j]!, top[k]!],
        normal: [Math.cos(t), Math.sin(t), 0],
      };
    });
    return [
      ...sides,
      { points: top, normal: [0, 0, 1] },
      { points: [...bottom].reverse(), normal: [0, 0, -1] },
    ];
  }
  const faces: Face[] = [
    {
      points: [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      normal: [0, 0, 1],
    },
  ];
  if (size.h <= 0) return faces;
  return [
    ...faces,
    {
      points: [
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y0, z0],
      ],
      normal: [0, 0, -1],
    },
    {
      points: [
        [x0, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
      ],
      normal: [0, 1, 0],
    },
    {
      points: [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ],
      normal: [0, -1, 0],
    },
    {
      points: [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
      normal: [1, 0, 0],
    },
    {
      points: [
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
      ],
      normal: [-1, 0, 0],
    },
  ];
}

/** A face's colour: tops as the iso view lights them, the rest by how much they face the light. */
function shade(color: Lab, normal: Vec3, flat: boolean): Lab {
  if (flat) return color;
  if (normal[2] > 0.5) return rampLab(color, 3);
  const d = normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2];
  return rampLab(color, d > 0.5 ? 2 : d > 0.2 ? 1 : 0);
}

/** A small, fixed grain, so the frame has texture to track like a camera's. */
const grain = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) & 255) / 255 - 0.5) * 0.012;
};

let borrowed: { depth: Float32Array; ids: Int16Array } | undefined;
const EMPTY = new Float64Array(0);
let lens: { width: number; height: number; falloff: Float64Array } | undefined;
/** The lens's darkening at each pixel, kept for the last frame size. */
function lensFalloff(width: number, height: number): Float64Array {
  if (lens?.width === width && lens.height === height) return lens.falloff;
  const falloff = new Float64Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const r = Math.hypot((x - width / 2) / width, (y - height / 2) / height);
      falloff[y * width + x] = 1 - 0.18 * r * r;
    }
  lens = { width, height, falloff };
  return falloff;
}

/** A rectangle of the frame's pixels: from `x0`, `y0` up to, not including, `x1`, `y1`. */
export interface PixelWindow {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/**
 * The pixels the solids can cover, grown by `margin` and kept in the frame:
 * the box of their corners as the camera sees them. Null when a corner is at
 * or behind the camera's near plane, where the box doesn't bound them.
 */
export function solidsWindow(
  camera: RoomCamera,
  solids: RoomSolid[],
  margin = 2,
): PixelWindow | null {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { box } of solids)
    for (const x of [box.at.x, box.at.x + box.size.w])
      for (const y of [box.at.y, box.at.y + box.size.d])
        for (const z of [box.at.z, box.at.z + box.size.h]) {
          const [cx, cy, cz] = toCamera(camera, { x, y, z });
          if (cz < NEAR) return null;
          const px = (camera.f * cx) / cz + camera.cx;
          const py = (camera.f * cy) / cz + camera.cy;
          [x0, y0, x1, y1] = [
            Math.min(x0, px),
            Math.min(y0, py),
            Math.max(x1, px),
            Math.max(y1, py),
          ];
        }
  return clampWindow(camera, {
    x0: Math.floor(x0) - margin,
    y0: Math.floor(y0) - margin,
    x1: Math.ceil(x1) + margin + 1,
    y1: Math.ceil(y1) + margin + 1,
  });
}
/** A window kept inside the camera's frame; empty ones stay empty. */
function clampWindow({ frame }: RoomCamera, w: PixelWindow): PixelWindow {
  const x0 = Math.max(0, Math.min(frame.width, w.x0));
  const y0 = Math.max(0, Math.min(frame.height, w.y0));
  return {
    x0,
    y0,
    x1: Math.max(x0, Math.min(frame.width, w.x1)),
    y1: Math.max(y0, Math.min(frame.height, w.y1)),
  };
}

/**
 * Draw the solids through the camera. With `labels`, only which solid covers
 * each pixel is worked out, for matching drawings against masks quickly; with
 * `scratch` too, its `ids` are only good until the next scratch picture, for a
 * caller that reads them at once and keeps nothing. With `window`, only those
 * pixels are drawn, each exactly as in the whole picture; the rest are empty
 * (no solid, black): a check of one small thing needn't draw the whole room.
 */
export function renderRoom(
  camera: RoomCamera,
  solids: RoomSolid[],
  {
    labels = false,
    scratch = false,
    window,
  }: { labels?: boolean; scratch?: boolean; window?: PixelWindow } = {},
): RoomPicture {
  const { width, height } = camera.frame;
  const {
    x0: wx0,
    y0: wy0,
    x1: wx1,
    y1: wy1,
  } = clampWindow(camera, window ?? { x0: 0, y0: 0, x1: width, y1: height });
  // A scratch picture borrows buffers the next scratch picture overwrites.
  let depth: Float32Array;
  let ids: Int16Array;
  if (scratch && labels) {
    if (borrowed?.depth.length !== width * height)
      borrowed = { depth: new Float32Array(width * height), ids: new Int16Array(width * height) };
    depth = borrowed.depth.fill(Infinity);
    ids = borrowed.ids.fill(-1);
  } else {
    depth = new Float32Array(width * height).fill(Infinity);
    ids = new Int16Array(width * height).fill(-1);
  }
  const color = new Float32Array(labels ? 0 : width * height * 3);
  const names: string[] = [];
  const index = new Map<string, number>();
  for (const solid of solids) {
    let id = index.get(solid.id);
    if (id === undefined) {
      id = names.push(solid.id) - 1;
      index.set(solid.id, id);
    }
    for (const face of facesOf(solid)) {
      const cam = face.points.map((p) => toCamera(camera, { x: p[0], y: p[1], z: p[2] }));
      // A face turned away from the camera is hidden by the solid's other faces.
      const p0 = face.points[0]!;
      const toFace = [0, 1, 2].map((k) => p0[k]! - camera.position[k]!);
      if (
        face.normal[0] * toFace[0]! + face.normal[1] * toFace[1]! + face.normal[2] * toFace[2]! >=
        0
      )
        continue;
      const poly = clipNear(cam);
      if (poly.length < 3) continue;
      const lab = shade(solid.color, face.normal, !!solid.flat);
      const print = !labels && face.normal[2] > 0.5 ? topPrint(camera, solid) : null;
      const px = poly.map(([x, y, z]) => ({
        x: (camera.f * x) / z + camera.cx,
        y: (camera.f * y) / z + camera.cy,
        w: 1 / z,
      }));
      for (let t = 1; t + 1 < px.length; t++)
        fillTriangle(px[0]!, px[t]!, px[t + 1]!, width, wx0, wy0, wx1, wy1, (i, w) => {
          const z = 1 / w;
          // On a tie the later solid wins: a mug drawn after the desk stands on its top.
          if (z > depth[i]! + 1e-4) return;
          depth[i] = z;
          ids[i] = id!;
          if (!labels)
            color.set((print && print(i % width, (i - (i % width)) / width)) ?? lab, i * 3);
        });
    }
  }
  const rgba = new Uint8ClampedArray(labels ? 0 : width * height * 4);
  const falloff = labels ? EMPTY : lensFalloff(width, height);
  if (!labels)
    for (let y = wy0; y < wy1; y++)
      for (let x = wx0; x < wx1; x++) {
        const i = y * width + x;
        const bg = ids[i]! < 0;
        // A lens darkens toward the corners a little.
        const L = (bg ? BACKGROUND[0] : color[i * 3]!) * falloff[i]! + grain(x, y);
        const [cr, cg, cb] = labRgb([
          L,
          bg ? BACKGROUND[1] : color[i * 3 + 1]!,
          bg ? BACKGROUND[2] : color[i * 3 + 2]!,
        ]);
        const o = i * 4;
        rgba[o] = cr;
        rgba[o + 1] = cg;
        rgba[o + 2] = cb;
        rgba[o + 3] = 255;
      }
  return { width, height, rgba, ids, names, depth };
}

/**
 * A solid's top decal as the camera sees it: the colour at a frame pixel, or
 * null where the decal leaves the top its own colour. The pixel's ray meets
 * the top's plane, and the decal is read there as `paintAt` reads a top decal.
 */
function topPrint(
  camera: RoomCamera,
  { box: { at, size }, decal, flat }: RoomSolid,
): ((x: number, y: number) => Lab | null) | null {
  if (!decal || decal.face !== 'top' || size.w <= 0 || size.d <= 0) return null;
  const labs = decal.colors.map((c) => shade(hexLab(c), [0, 0, 1], !!flat));
  const top = at.z + size.h;
  const { right, down, forward, position, f, cx, cy } = camera;
  // Height from the camera to the top, along the ray's own z.
  const rise = top - position[2];
  return (x, y) => {
    const u = (x + 0.5 - cx) / f;
    const v = (y + 0.5 - cy) / f;
    const dz = right[2]! * u + down[2]! * v + forward[2]!;
    if (Math.abs(dz) < 1e-9) return null;
    const k = rise / dz;
    let s = (position[0] + k * (right[0]! * u + down[0]! * v + forward[0]!) - at.x) / size.w;
    let t = (position[1] + k * (right[1]! * u + down[1]! * v + forward[1]!) - at.y) / size.d;
    // Undo the quarter turns: (x, y) went to (1 - y, x) each time.
    for (let q = 0; q < decal.turns; q++) {
      const was = s;
      s = t;
      t = 1 - was;
    }
    if (s < decal.u0 || s > decal.u1 || t < decal.v0 || t > decal.v1) return null;
    const col = Math.min(
      decal.w - 1,
      Math.floor(((s - decal.u0) / (decal.u1 - decal.u0)) * decal.w),
    );
    const row = Math.min(
      decal.h - 1,
      Math.floor(((t - decal.v0) / (decal.v1 - decal.v0)) * decal.h),
    );
    const ch = decal.data.charCodeAt(row * decal.w + col);
    // '.' leaves the top as it is; '0'–'9' and 'a'–'f' index the colours.
    if (ch === 46) return null;
    return labs[ch <= 57 ? ch - 48 : ch - 87] ?? null;
  };
}

/** The part of a polygon in front of the camera's near plane, in camera coordinates. */
function clipNear(poly: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const ina = a[2] >= NEAR;
    const inb = b[2] >= NEAR;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (NEAR - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
    }
  }
  return out;
}

type Vertex = { x: number; y: number; w: number };
/**
 * Every pixel centre inside the triangle and the window (`wx0`, `wy0` up to,
 * not including, `wx1`, `wy1`), with 1/depth interpolated across it.
 */
function fillTriangle(
  a: Vertex,
  b: Vertex,
  c: Vertex,
  width: number,
  wx0: number,
  wy0: number,
  wx1: number,
  wy1: number,
  plot: (i: number, w: number) => void,
) {
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area) < 1e-9) return;
  const x0 = Math.max(wx0, Math.floor(Math.min(a.x, b.x, c.x)));
  const x1 = Math.min(wx1 - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const y0 = Math.max(wy0, Math.floor(Math.min(a.y, b.y, c.y)));
  const y1 = Math.min(wy1 - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const wa = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
      const wb = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
      const wc = 1 - wa - wb;
      if (wa < 0 || wb < 0 || wc < 0) continue;
      plot(y * width + x, wa * a.w + wb * b.w + wc * c.w);
    }
}

/** One thing's pixels in a room picture, as a mask the size of the frame. */
export function roomMask(picture: RoomPicture, id: string) {
  const k = picture.names.indexOf(id);
  const data = new Uint8Array(picture.width * picture.height);
  if (k >= 0) for (let i = 0; i < data.length; i++) if (picture.ids[i] === k) data[i] = 1;
  return { width: picture.width, height: picture.height, data };
}
