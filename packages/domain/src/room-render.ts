import type { IsoBox, IsoScene, IsoTone } from './iso.js';
import { hexLab, labRgb, rampLab, type Lab } from './color.js';
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
}
export interface RoomPicture {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** Per pixel, an index into `names`, or -1 where nothing is. */
  ids: Int16Array;
  names: string[];
}

type Vec3 = [number, number, number];
const LIGHT: Vec3 = (() => {
  const l: Vec3 = [0.15, 0.75, 1];
  const n = Math.hypot(...l);
  return [l[0] / n, l[1] / n, l[2] / n];
})();
const BACKGROUND: Lab = hexLab('#0d0f16');
const NEAR = 0.05;

/** A prop scene's solids, by group, in the room's tones. */
export function sceneSolids(scene: IsoScene): RoomSolid[] {
  return scene.props.flatMap((p) =>
    propSolids(p).map((s) => ({
      id: p.group,
      box: s.box,
      shape: s.shape === 'cylinder' ? ('cylinder' as const) : ('prism' as const),
      color: hexLab(PROP_TONES[s.tone as IsoTone]),
      flat: s.tone === 'wall',
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

/**
 * Draw the solids through the camera. With `labels`, only which solid covers
 * each pixel is worked out, for matching drawings against masks quickly.
 */
export function renderRoom(
  camera: RoomCamera,
  solids: RoomSolid[],
  { labels = false }: { labels?: boolean } = {},
): RoomPicture {
  const { width, height } = camera.frame;
  const depth = new Float32Array(width * height).fill(Infinity);
  const ids = new Int16Array(width * height).fill(-1);
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
      const px = poly.map(([x, y, z]) => ({
        x: (camera.f * x) / z + camera.cx,
        y: (camera.f * y) / z + camera.cy,
        w: 1 / z,
      }));
      for (let t = 1; t + 1 < px.length; t++)
        fillTriangle(px[0]!, px[t]!, px[t + 1]!, width, height, (i, w) => {
          const z = 1 / w;
          // On a tie the later solid wins: a mug drawn after the desk stands on its top.
          if (z > depth[i]! + 1e-4) return;
          depth[i] = z;
          ids[i] = id!;
          if (!labels) color.set(lab, i * 3);
        });
    }
  }
  const rgba = new Uint8ClampedArray(labels ? 0 : width * height * 4);
  if (!labels)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const lab: Lab =
          ids[i]! < 0 ? BACKGROUND : [color[i * 3]!, color[i * 3 + 1]!, color[i * 3 + 2]!];
        // A lens darkens toward the corners a little.
        const r = Math.hypot((x - width / 2) / width, (y - height / 2) / height);
        const L = lab[0] * (1 - 0.18 * r * r) + grain(x, y);
        const [cr, cg, cb] = labRgb([L, lab[1], lab[2]]);
        rgba.set([cr, cg, cb, 255], i * 4);
      }
  return { width, height, rgba, ids, names };
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
/** Every pixel centre inside the triangle, with 1/depth interpolated across it. */
function fillTriangle(
  a: Vertex,
  b: Vertex,
  c: Vertex,
  width: number,
  height: number,
  plot: (i: number, w: number) => void,
) {
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area) < 1e-9) return;
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
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
