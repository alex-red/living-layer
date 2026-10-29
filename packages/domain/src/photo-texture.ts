import type { IsoProp, IsoScene, SurfacePin } from './iso.js';
import { cameraFromPin } from './photo-scene.js';

/** An RGBA image, row by row. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}
/** The three faces the iso view draws of a prism: its top, its +y face and its +x face. */
export type PropFace = 'top' | 'front' | 'side';
export const PROP_FACES: readonly PropFace[] = ['top', 'front', 'side'];

type Vec3 = [number, number, number];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Texels per tile, and the most along any side. */
const DENSITY = 32;
const MAX_SIDE = 256;
/** Width of the depth buffer, in pixels. */
const DEPTH_WIDTH = 320;
/** Under this share of a face seen, the face keeps its plain colour. */
const MIN_SEEN = 0.35;

/**
 * A face as an origin and two edges in scene coordinates: texel (i, j) of a
 * texture `cols` × `rows` is the point origin + u·(i + ½)/cols + v·(j + ½)/rows.
 * The orientation matches how the iso view lays a texture on the face.
 */
export function faceFrame(prop: Pick<IsoProp, 'at' | 'size'>, face: PropFace) {
  const { x, y, z } = prop.at;
  const { w, d, h } = prop.size;
  switch (face) {
    case 'top':
      return { origin: [x, y, z + h] as Vec3, u: [w, 0, 0] as Vec3, v: [0, d, 0] as Vec3 };
    case 'front':
      return { origin: [x, y + d, z + h] as Vec3, u: [w, 0, 0] as Vec3, v: [0, 0, -h] as Vec3 };
    case 'side':
      return { origin: [x + w, y, z + h] as Vec3, u: [0, d, 0] as Vec3, v: [0, 0, -h] as Vec3 };
  }
}
const NORMAL: Record<PropFace, Vec3> = { top: [0, 0, 1], front: [0, 1, 0], side: [1, 0, 0] };

/**
 * The camera of a saved scene's pin, in the scene's own coordinates: the
 * pinned surface's back-left corner is where the pin's corners put it, and
 * the surface keeps the size it was saved with.
 */
function sceneCamera(scene: IsoScene, pin: SurfacePin) {
  const surface = scene.surfaces.find((s) => s.id === pin.surfaceId);
  if (!surface) return null;
  const { w, d } = surface.rect;
  const camera = cameraFromPin(pin.corners, pin.frame, w, [d, d]);
  if (!camera) return null;
  const origin: Vec3 = [surface.rect.x, surface.rect.y, surface.z];
  // Camera space from scene space: p = R·(W − origin) + t, R's rows r1, r2, up as columns.
  const toCamera = (W: Vec3): Vec3 => {
    const X = W[0] - origin[0];
    const Y = W[1] - origin[1];
    const Z = W[2] - origin[2];
    return [0, 1, 2].map(
      (k) => X * camera.r1[k]! + Y * camera.r2[k]! + Z * camera.up[k]! + camera.t[k]!,
    ) as Vec3;
  };
  // The camera's centre and a pixel's ray, back in scene space.
  const back = (p: Vec3): Vec3 => [dot(camera.r1, p), dot(camera.r2, p), dot(camera.up, p)];
  const c = back(camera.t);
  const centre: Vec3 = [origin[0] - c[0], origin[1] - c[1], origin[2] - c[2]];
  const ray = (px: number, py: number) =>
    back([(px - camera.cx) / camera.f, (py - camera.cy) / camera.f, 1]);
  return { camera, toCamera, centre, ray };
}

/** Where a ray first meets a box, as distance along the camera's axis (the ray's z is 1). */
function hitBox(o: Vec3, dir: Vec3, prop: IsoProp): number {
  let near = 0;
  let far = Infinity;
  const lo: Vec3 = [prop.at.x, prop.at.y, prop.at.z];
  const hi: Vec3 = [prop.at.x + prop.size.w, prop.at.y + prop.size.d, prop.at.z + prop.size.h];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(dir[k]!) < 1e-12) {
      if (o[k]! < lo[k]! || o[k]! > hi[k]!) return Infinity;
      continue;
    }
    let a = (lo[k]! - o[k]!) / dir[k]!;
    let b = (hi[k]! - o[k]!) / dir[k]!;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return Infinity;
  }
  return near;
}

function sample(photo: Rgba, x: number, y: number): [number, number, number] {
  const fx = Math.max(0, Math.min(photo.width - 1.001, x - 0.5));
  const fy = Math.max(0, Math.min(photo.height - 1.001, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const at = (xx: number, yy: number) => photo.data[(yy * photo.width + xx) * 4 + k]!;
    out[k] =
      at(x0, y0) * (1 - ax) * (1 - ay) +
      at(x0 + 1, y0) * ax * (1 - ay) +
      at(x0, y0 + 1) * (1 - ax) * ay +
      at(x0 + 1, y0 + 1) * ax * ay;
  }
  return out;
}

/**
 * Each prop's faces as the photo shows them. The scene's boxes are drawn from
 * the pin's camera into a depth buffer; a point of a face takes the photo's
 * colour where nothing of the scene stands in front of it, and the face's
 * mean colour where something does (a chair before the drawers). A face the
 * camera saw too little of, or from behind, gets none.
 */
export function photoTextures(
  scene: IsoScene,
  pin: SurfacePin,
  photo: Rgba,
): Map<string, Partial<Record<PropFace, Rgba>>> {
  const out = new Map<string, Partial<Record<PropFace, Rgba>>>();
  const cam = sceneCamera(scene, pin);
  if (!cam) return out;
  const { camera, toCamera, centre, ray } = cam;
  const frame = pin.frame;
  const sx = photo.width / frame.width;
  const sy = photo.height / frame.height;

  const k = DEPTH_WIDTH / frame.width;
  const dw = DEPTH_WIDTH;
  const dh = Math.round(frame.height * k);
  const depth = new Float32Array(dw * dh).fill(Infinity);
  for (let py = 0; py < dh; py++)
    for (let px = 0; px < dw; px++) {
      const dir = ray((px + 0.5) / k, (py + 0.5) / k);
      let near = Infinity;
      for (const p of scene.props) near = Math.min(near, hitBox(centre, dir, p));
      depth[py * dw + px] = near;
    }
  const nearest = (x: number, y: number) => {
    const px = Math.floor(x * k);
    const py = Math.floor(y * k);
    if (px < 0 || py < 0 || px >= dw || py >= dh) return -Infinity;
    // The farthest of a pixel and its neighbours, so a face's own edges aren't lost to rounding.
    let best = -Infinity;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = px + dx;
        const yy = py + dy;
        if (xx >= 0 && yy >= 0 && xx < dw && yy < dh) best = Math.max(best, depth[yy * dw + xx]!);
      }
    return best;
  };

  for (const prop of scene.props) {
    const faces: Partial<Record<PropFace, Rgba>> = {};
    for (const face of PROP_FACES) {
      if (prop.shape === 'cylinder' && face !== 'top') continue;
      const f = faceFrame(prop, face);
      const mid: Vec3 = [0, 1, 2].map((i) => f.origin[i]! + (f.u[i]! + f.v[i]!) / 2) as Vec3;
      const toward: Vec3 = [centre[0] - mid[0], centre[1] - mid[1], centre[2] - mid[2]];
      if (dot(toward, NORMAL[face]) <= 0) continue;
      const lu = Math.hypot(...f.u);
      const lv = Math.hypot(...f.v);
      const cols = Math.max(2, Math.min(MAX_SIDE, Math.round(lu * DENSITY)));
      const rows = Math.max(2, Math.min(MAX_SIDE, Math.round(lv * DENSITY)));
      const data = new Uint8ClampedArray(cols * rows * 4);
      const seen = new Uint8Array(cols * rows);
      let count = 0;
      const sum: [number, number, number] = [0, 0, 0];
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const a = (i + 0.5) / cols;
          const b = (j + 0.5) / rows;
          const W: Vec3 = [0, 1, 2].map((n) => f.origin[n]! + f.u[n]! * a + f.v[n]! * b) as Vec3;
          const p = toCamera(W);
          if (p[2] <= 1e-6) continue;
          const x = (camera.f * p[0]) / p[2] + camera.cx;
          const y = (camera.f * p[1]) / p[2] + camera.cy;
          if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
          // Seen when nothing in the scene is nearer the camera along this pixel.
          if (nearest(x, y) < p[2] - Math.max(0.06, p[2] * 0.02)) continue;
          const c = sample(photo, x * sx, y * sy);
          const at = (j * cols + i) * 4;
          data[at] = c[0];
          data[at + 1] = c[1];
          data[at + 2] = c[2];
          data[at + 3] = 255;
          seen[j * cols + i] = 1;
          count++;
          sum[0] += c[0];
          sum[1] += c[1];
          sum[2] += c[2];
        }
      if (count < MIN_SEEN * cols * rows) continue;
      const mean = sum.map((s) => s / count) as [number, number, number];
      for (let n = 0; n < seen.length; n++) if (!seen[n]) data.set([...mean, 255], n * 4);
      faces[face] = { width: cols, height: rows, data };
    }
    if (Object.keys(faces).length) out.set(prop.id, faces);
  }
  return out;
}
