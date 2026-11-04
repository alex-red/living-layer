import { KEY_LIGHT, bezier } from './math.js';
import { ISO_RISE, ISO_TILE, fromIso, toIso } from './iso.js';
import { ITEM_MATERIALS, type ItemMaterial, type ItemPart } from './iso-item.js';
import { hexLab, labRgb, nearest, outlineLab, rampLab, type Lab } from './color.js';

/**
 * The model kernel: every part becomes a signed distance function, the
 * union is sampled on a voxel grid, and the grid is lit into a pixel-art
 * isometric sprite. The same grid renders from the photo's camera, so a
 * fitted model can be checked against the mask it came from. Pure
 * TypeScript: it runs in the browser, on the server and in tests alike.
 */
type V3 = [number, number, number];
// Bun's Math.hypot with three arguments gives these same bits, far slower, and these run
// per voxel. (The two-argument form rounds differently, so it stays Math.hypot.)
const sqrt3 = (a: number, b: number, c: number) => Math.sqrt(a * a + b * b + c * c);
interface Prim {
  part: number;
  min: V3;
  max: V3;
  dist: (x: number, y: number, z: number) => number;
  /**
   * Which surface a point belongs to: 0 the outside, 1 an inner wall, 2 a
   * liquid. The normal decides between walls thinner than a voxel or two.
   */
  zone?: (x: number, y: number, z: number, n: V3) => number;
}

/** Signed distance to a closed polygon of [x, y] points; negative inside. */
function sdPolygon(px: number, py: number, v: number[]): number {
  const n = v.length / 2;
  let d = (px - v[0]!) ** 2 + (py - v[1]!) ** 2;
  let s = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const vix = v[2 * i]!;
    const viy = v[2 * i + 1]!;
    const ex = v[2 * j]! - vix;
    const ey = v[2 * j + 1]! - viy;
    const wx = px - vix;
    const wy = py - viy;
    const ee = ex * ex + ey * ey;
    const t = ee > 0 ? Math.max(0, Math.min(1, (wx * ex + wy * ey) / ee)) : 0;
    const bx = wx - ex * t;
    const by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= viy;
    const c2 = py < v[2 * j + 1]!;
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}
function segDist(px: number, py: number, pz: number, a: V3, b: V3): number {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const ez = b[2] - a[2];
  const wx = px - a[0];
  const wy = py - a[1];
  const wz = pz - a[2];
  const ee = ex * ex + ey * ey + ez * ez;
  const t = ee > 0 ? Math.max(0, Math.min(1, (wx * ex + wy * ey + wz * ez) / ee)) : 0;
  return sqrt3(wx - ex * t, wy - ey * t, wz - ez * t);
}
/** Cheap repeatable value noise in [-1, 1], for lumpy blobs. */
function noise3(x: number, y: number, z: number): number {
  const hash = (i: number, j: number, k: number) => {
    let h = (i * 374761393 + j * 668265263 + k * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) & 0xffff) / 0x7fff - 1;
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(fx);
  const v = s(fy);
  const w = s(fz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

interface Box {
  at: { x: number; y: number; z: number };
  size: { w: number; d: number; h: number };
}
type Profile = { r: number; z: number }[];
type Inside = Extract<ItemPart, { shape: 'lathe' }>['inside'];
/** The hollow of an open turned part; no other shape has one. */
const insideOf = (p: ItemPart): Inside => (p.shape === 'lathe' ? p.inside : undefined);
function lathePrim(
  part: number,
  { at, size }: Box,
  profile: Profile,
  wall = 0,
  inside?: Inside,
): Prim {
  const rx = size.w / 2;
  const ry = size.d / 2;
  const cx = at.x + rx;
  const cy = at.y + ry;
  const R = Math.min(rx, ry);
  const h = size.h;
  const pts = profile.map((p) => [p.r * R, at.z + p.z * h] as const);
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  // Mirror the profile across the axis, so the axis lies inside the polygon
  // and never counts as a surface (it would bend normals near the centre).
  const mirrored = (side: (readonly [number, number])[]) => [
    ...[...side].reverse().flatMap(([r, z]) => [-r, z]),
    ...side.flatMap(([r, z]) => [r, z]),
  ];
  const outer = mirrored(pts);
  const radiusAt = (z: number) => {
    if (z <= first[1]) return first[0];
    for (let i = 1; i < pts.length; i++) {
      const [r1, z1] = pts[i]!;
      const [r0, z0] = pts[i - 1]!;
      if (z <= z1) return z1 > z0 ? r0 + ((r1 - r0) * (z - z0)) / (z1 - z0) : r1;
    }
    return last[0];
  };
  let inner: number[] | null = null;
  let level = -Infinity;
  if (wall > 0) {
    const t = Math.max(wall * R, 1e-3);
    const floor = first[1] + Math.min(t, (last[1] - first[1]) * 0.3);
    const lip = last[1] + 3 * t;
    const side: [number, number][] = [[Math.max(radiusAt(floor) - t, 1e-3), floor]];
    for (const [r, z] of pts) if (z > floor) side.push([Math.max(r - t, 1e-3), z]);
    side.push([Math.max(last[0] - t, 1e-3), lip]);
    inner = mirrored(side);
    if (inside?.liquid && inside.level > 0) level = floor + inside.level * (last[1] - floor);
  }
  const rho = (x: number, y: number) => Math.hypot(((x - cx) / rx) * R, ((y - cy) / ry) * R);
  const parts = (x: number, y: number, z: number) => {
    const r = rho(x, y);
    const out = sdPolygon(r, z, outer);
    if (!inner) return { shell: out, cavity: Infinity, liquid: Infinity };
    const cav = sdPolygon(r, z, inner);
    return { shell: Math.max(out, -cav), cavity: -cav, liquid: Math.max(cav, z - level) };
  };
  return {
    part,
    min: [at.x, at.y, at.z],
    max: [at.x + size.w, at.y + size.d, at.z + size.h],
    dist: (x, y, z) => {
      const p = parts(x, y, z);
      return Math.min(p.shell, p.liquid);
    },
    zone: (x, y, z, n) => {
      if (!inner) return 0;
      const r = rho(x, y);
      const out = sdPolygon(r, z, outer);
      const cav = sdPolygon(r, z, inner);
      if (Math.max(cav, z - level) < Math.max(out, -cav)) return 2;
      // Facing the axis means the inside of the wall; the rim faces up.
      const radial =
        r > 1e-6 ? (n[0] * (x - cx) + n[1] * (y - cy)) / Math.hypot(x - cx, y - cy) : 0;
      return z > first[1] && z < last[1] - 1e-6 && radial < -0.25 && n[2] < 0.8 ? 1 : 0;
    },
  };
}
function rboxPrim(part: number, { at, size }: Box, radius: number): Prim {
  const r = Math.min(radius, size.w / 2, size.d / 2, size.h / 2);
  const c: V3 = [at.x + size.w / 2, at.y + size.d / 2, at.z + size.h / 2];
  const b: V3 = [size.w / 2 - r, size.d / 2 - r, size.h / 2 - r];
  return {
    part,
    min: [at.x, at.y, at.z],
    max: [at.x + size.w, at.y + size.d, at.z + size.h],
    dist: (x, y, z) => {
      const qx = Math.abs(x - c[0]) - b[0];
      const qy = Math.abs(y - c[1]) - b[1];
      const qz = Math.abs(z - c[2]) - b[2];
      return (
        sqrt3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) +
        Math.min(Math.max(qx, qy, qz), 0) -
        r
      );
    },
  };
}
function tubePrim(part: number, control: V3[], radius: number): Prim {
  const samples = Array.from({ length: 25 }, (_, i) => bezier(control, i / 24));
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const s of samples)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, s[k]! - radius);
      max[k] = Math.max(max[k]!, s[k]! + radius);
    }
  return {
    part,
    min,
    max,
    dist: (x, y, z) => {
      let d = Infinity;
      for (let i = 1; i < samples.length; i++)
        d = Math.min(d, segDist(x, y, z, samples[i - 1]!, samples[i]!));
      return d - radius;
    },
  };
}
function extrudePrim(
  part: number,
  { at, size }: Box,
  outline: { x: number; y: number }[],
  bevel: number,
): Prim {
  const v = outline.flatMap((p) => [at.x + p.x * size.w, at.y + p.y * size.d]);
  const r = Math.min(bevel, size.h / 2);
  const zc = at.z + size.h / 2;
  return {
    part,
    min: [at.x, at.y, at.z],
    max: [at.x + size.w, at.y + size.d, at.z + size.h],
    dist: (x, y, z) => {
      const dxy = sdPolygon(x, y, v) + r;
      const dz = Math.abs(z - zc) - (size.h / 2 - r);
      return Math.min(Math.max(dxy, dz), 0) + Math.hypot(Math.max(dxy, 0), Math.max(dz, 0)) - r;
    },
  };
}
function blobPrim(part: number, { at, size }: Box, rough: number): Prim {
  const r: V3 = [size.w / 2, size.d / 2, size.h / 2];
  const c: V3 = [at.x + r[0], at.y + r[1], at.z + r[2]];
  const m = Math.min(...r);
  const freq = 3.2 / m;
  // The bounds allow for bumps that push out past the ellipsoid.
  const grow = rough * 0.22 * m;
  return {
    part,
    min: [at.x - grow, at.y - grow, at.z],
    max: [at.x + size.w + grow, at.y + size.d + grow, at.z + size.h + grow],
    dist: (x, y, z) => {
      const px = (x - c[0]) / r[0];
      const py = (y - c[1]) / r[1];
      const pz = (z - c[2]) / r[2];
      const k0 = sqrt3(px, py, pz);
      const k1 = sqrt3(px / r[0], py / r[1], pz / r[2]);
      const base = k1 > 0 ? (k0 * (k0 - 1)) / k1 : -m;
      return Math.max(base - grow * noise3(x * freq, y * freq, z * freq), at.z - z);
    },
  };
}

/** The primitives a part is drawn with. */
export function partPrims(p: ItemPart, index: number): Prim[] {
  const box: Box = { at: p.at, size: p.size };
  const minSide = Math.min(p.size.w, p.size.d, p.size.h);
  switch (p.shape) {
    case 'lathe':
      return [lathePrim(index, box, p.profile, p.wall ?? 0, p.inside)];
    case 'rbox':
      return [rboxPrim(index, box, (p.radius ?? 0.1) * minSide)];
    case 'extrude':
      return [extrudePrim(index, box, p.outline, (p.radius ?? 0) * minSide)];
    case 'blob':
      return [blobPrim(index, box, p.rough ?? 0.4)];
    case 'tube': {
      const control = p.path.map((q): V3 => [
        p.at.x + q.x * p.size.w,
        p.at.y + q.y * p.size.d,
        p.at.z + q.z * p.size.h,
      ]);
      return [tubePrim(index, control, Math.max(0.005, p.radius ?? minSide / 2))];
    }
  }
}

/** Where a point sits on a part's surface: `u` around (0.5 facing the viewer), `v` up. */
function surfaceUv(p: ItemPart, x: number, y: number, z: number): { u: number; v: number } {
  const dx = (x - (p.at.x + p.size.w / 2)) / (p.size.w / 2);
  const dy = (y - (p.at.y + p.size.d / 2)) / (p.size.d / 2);
  const theta = Math.atan2(dy, dx);
  let u = (theta - Math.PI / 4) / (2 * Math.PI) + 0.5;
  u -= Math.floor(u);
  return { u, v: Math.max(0, Math.min(1, (z - p.at.z) / p.size.h)) };
}
const DECAL = '0123456789abcdef';
/** The painted colour of a part's outside at a point, or its base colour. */
export function paintAt(p: ItemPart, x: number, y: number, z: number, nz: number): string {
  if (!p.paint?.length) return p.color;
  const { u, v } = surfaceUv(p, x, y, z);
  let color = p.color;
  for (const layer of p.paint) {
    switch (layer.kind) {
      case 'band':
        if (v >= Math.min(layer.from, layer.to) && v <= Math.max(layer.from, layer.to))
          color = layer.color;
        break;
      case 'stripes': {
        const a = (layer.angle * Math.PI) / 180;
        const t = (u * Math.cos(a) + v * Math.sin(a)) * layer.count;
        if (t - Math.floor(t) < layer.width) color = layer.color;
        break;
      }
      case 'dots': {
        const cu = u * layer.count;
        const cv = v * layer.rows;
        if (Math.hypot(cu - Math.floor(cu) - 0.5, cv - Math.floor(cv) - 0.5) < layer.size / 2)
          color = layer.color;
        break;
      }
      case 'top':
        if (nz > 0.7) color = layer.color;
        break;
      case 'decal': {
        let s: number;
        let t: number;
        if (layer.face === 'top') {
          if (nz <= 0.7) break;
          s = (x - p.at.x) / p.size.w;
          t = (y - p.at.y) / p.size.d;
          // Undo the quarter turns: (x, y) went to (1 - y, x) each time.
          for (let k = 0; k < layer.turns; k++) [s, t] = [t, 1 - s];
        } else {
          s = u < layer.u0 ? u + 1 : u;
          t = 1 - v;
        }
        const tv = layer.face === 'top' ? t : v;
        if (s < layer.u0 || s > layer.u1 || tv < layer.v0 || tv > layer.v1) break;
        const col = Math.min(
          layer.w - 1,
          Math.floor(((s - layer.u0) / (layer.u1 - layer.u0)) * layer.w),
        );
        const frac = (tv - layer.v0) / (layer.v1 - layer.v0);
        // Around a part, row 0 is the top; on the top face, row 0 is the back.
        const row = Math.min(
          layer.h - 1,
          Math.floor((layer.face === 'top' ? frac : 1 - frac) * layer.h),
        );
        const ch = layer.data[row * layer.w + col];
        if (ch && ch !== '.') color = layer.colors[DECAL.indexOf(ch)] ?? color;
        break;
      }
    }
  }
  return color;
}

export interface VoxelGrid {
  nx: number;
  ny: number;
  nz: number;
  /** The grid's corner in item units, and one voxel's edge. */
  origin: V3;
  size: number;
  /** Part index + 1 for a filled voxel, 0 for empty. */
  occ: Uint8Array;
  /** Index into the surface arrays for a surface voxel, -1 otherwise. */
  surf: Int32Array;
  normals: Float32Array;
  colors: Float32Array;
  mats: Uint8Array;
  ao: Float32Array;
  /** The footprint on z = 0, for the contact shadow. */
  footprint: { cx: number; cy: number; rx: number; ry: number };
  /** The parts it was sampled from. */
  parts: ItemPart[];
  /** 1 for a surface voxel on the outside of a part with a decal, which a clean finish paints per pixel. */
  decals: Uint8Array;
}
const MAX_VOXELS = 600_000;
/**
 * Sample the parts on a grid. `resolution` voxels span the longest side of
 * the bounds, unless `voxel` fixes the edge length (props use one density so
 * a room reads as one style).
 */
export function voxelize(
  parts: ItemPart[],
  { resolution = 32, voxel }: { resolution?: number; voxel?: number } = {},
): VoxelGrid {
  const prims = parts.flatMap((p, i) => partPrims(p, i));
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of prims)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, p.min[k]!);
      hi[k] = Math.max(hi[k]!, p.max[k]!);
    }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-3);
  let size = voxel ?? span / resolution;
  const dims = () => [0, 1, 2].map((k) => Math.ceil((hi[k]! - lo[k]!) / size) + 2);
  while (dims().reduce((a, b) => a * b, 1) > MAX_VOXELS) size *= 1.25;
  const [nx, ny, nz] = dims() as V3;
  // Whole voxels of margin, so shape edges fall on voxel faces, never on centres.
  const origin: V3 = [lo[0] - size, lo[1] - size, lo[2] - size];
  const n = nx * ny * nz;
  const occ = new Uint8Array(n);
  const owner = new Int16Array(n).fill(-1);
  const pad = size * 2;
  const inReach = (p: Prim, x: number, y: number, z: number) =>
    x >= p.min[0] - pad &&
    y >= p.min[1] - pad &&
    z >= p.min[2] - pad &&
    x <= p.max[0] + pad &&
    y <= p.max[1] + pad &&
    z <= p.max[2] + pad;
  const field = (x: number, y: number, z: number, near: number[]) => {
    let d = Infinity;
    for (let j = 0; j < near.length; j++) {
      const p = prims[near[j]!]!;
      if (!inReach(p, x, y, z)) continue;
      const pd = p.dist(x, y, z);
      if (pd < d) d = pd;
    }
    return d;
  };
  // The parts that can reach a point near a block of voxels, in order. A normal is
  // taken within a voxel of the voxel's centre, so a block's list is every part whose
  // padded bounds touch the block grown by a voxel and a half.
  const BLOCK = 8;
  const blocksX = Math.ceil(nx / BLOCK);
  const blocksY = Math.ceil(ny / BLOCK);
  const blockLists: (number[] | undefined)[] = [];
  const nearBlock = (ix: number, iy: number, iz: number) => {
    const bx = Math.floor(ix / BLOCK);
    const by = Math.floor(iy / BLOCK);
    const bz = Math.floor(iz / BLOCK);
    const key = bx + blocksX * (by + blocksY * bz);
    let list = blockLists[key];
    if (!list) {
      const slack = size * 1.5;
      const lo = [bx, by, bz].map((b, k) => origin[k]! + b * BLOCK * size - slack);
      const hi = [bx, by, bz].map((b, k) => origin[k]! + (b + 1) * BLOCK * size + slack);
      list = [];
      for (let i = 0; i < prims.length; i++) {
        const p = prims[i]!;
        let touches = true;
        for (let k = 0; k < 3; k++)
          if (p.min[k]! - pad > hi[k]! || p.max[k]! + pad < lo[k]!) touches = false;
        if (touches) list.push(i);
      }
      blockLists[key] = list;
    }
    return list;
  };
  // Part by part over the voxels near it. The first part to reach the least
  // distance keeps the voxel, as when each voxel asked every part in order.
  const best = new Float64Array(n).fill(Infinity);
  for (let pi = 0; pi < prims.length; pi++) {
    const p = prims[pi]!;
    // One voxel of slack either side; the exact test below decides.
    const span = (k: 0 | 1 | 2, nk: number): [number, number] => [
      Math.max(0, Math.floor((p.min[k] - pad - origin[k]) / size - 0.5) - 1),
      Math.min(nk - 1, Math.ceil((p.max[k] + pad - origin[k]) / size - 0.5) + 1),
    ];
    const [x0, x1] = span(0, nx);
    const [y0, y1] = span(1, ny);
    const [z0, z1] = span(2, nz);
    for (let iz = z0; iz <= z1; iz++) {
      const z = origin[2] + (iz + 0.5) * size;
      for (let iy = y0; iy <= y1; iy++) {
        const y = origin[1] + (iy + 0.5) * size;
        let i = x0 + nx * (iy + ny * iz);
        for (let ix = x0; ix <= x1; ix++, i++) {
          const x = origin[0] + (ix + 0.5) * size;
          if (!inReach(p, x, y, z)) continue;
          const pd = p.dist(x, y, z);
          if (pd < best[i]!) {
            best[i] = pd;
            owner[i] = pi;
          }
        }
      }
    }
  }
  // A part thinner than a voxel can fall between voxel centres and vanish: a
  // monitor's screen in front of its bezel. One that kept no voxel takes the
  // empty voxels it passes through (within half a voxel), as a layer of its
  // own, nearest part first; what other parts filled stays theirs.
  const kept = new Uint8Array(prims.length);
  for (let i = 0; i < n; i++) if (best[i]! <= 0) kept[owner[i]!] = 1;
  const half = size / 2;
  const lost = prims.flatMap((p, pi) =>
    !kept[pi] && Math.min(p.max[0] - p.min[0], p.max[1] - p.min[1], p.max[2] - p.min[2]) < size
      ? [pi]
      : [],
  );
  const empty = lost.length ? new Uint8Array(n) : null;
  if (empty) for (let i = 0; i < n; i++) empty[i] = best[i]! > 0 ? 1 : 0;
  for (const pi of lost) {
    const p = prims[pi]!;
    const span = (k: 0 | 1 | 2, nk: number): [number, number] => [
      Math.max(0, Math.floor((p.min[k] - half - origin[k]) / size)),
      Math.min(nk - 1, Math.ceil((p.max[k] + half - origin[k]) / size)),
    ];
    const [x0, x1] = span(0, nx);
    const [y0, y1] = span(1, ny);
    const [z0, z1] = span(2, nz);
    for (let iz = z0; iz <= z1; iz++) {
      const z = origin[2] + (iz + 0.5) * size;
      for (let iy = y0; iy <= y1; iy++) {
        const y = origin[1] + (iy + 0.5) * size;
        let i = x0 + nx * (iy + ny * iz);
        for (let ix = x0; ix <= x1; ix++, i++) {
          if (!empty![i]) continue;
          const pd = p.dist(origin[0] + (ix + 0.5) * size, y, z);
          // Below zero, so the voxel is filled; nearer parts win as above.
          if (pd <= half && pd - half - size < best[i]!) {
            best[i] = pd - half - size;
            owner[i] = pi;
          }
        }
      }
    }
  }
  for (let i = 0; i < n; i++) if (best[i]! <= 0) occ[i] = prims[owner[i]!]!.part + 1;
  const at = (ix: number, iy: number, iz: number) =>
    ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz
      ? 0
      : occ[ix + nx * (iy + ny * iz)]!;
  const surf = new Int32Array(n).fill(-1);
  const list: number[] = [];
  for (let iz = 0; iz < nz; iz++)
    for (let iy = 0; iy < ny; iy++)
      for (let ix = 0; ix < nx; ix++) {
        const i = ix + nx * (iy + ny * iz);
        if (!occ[i]) continue;
        if (
          !at(ix - 1, iy, iz) ||
          !at(ix + 1, iy, iz) ||
          !at(ix, iy - 1, iz) ||
          !at(ix, iy + 1, iz) ||
          !at(ix, iy, iz - 1) ||
          !at(ix, iy, iz + 1)
        ) {
          surf[i] = list.length;
          list.push(i);
        }
      }
  const s = list.length;
  const normals = new Float32Array(s * 3);
  const colors = new Float32Array(s * 3);
  const mats = new Uint8Array(s);
  const decals = new Uint8Array(s);
  const ao = new Float32Array(s);
  const e = size * 0.5;
  const labs = new Map<string, Lab>();
  const lab = (hex: string) => labs.get(hex) ?? (labs.set(hex, hexLab(hex)), labs.get(hex)!);
  const materialIndex = (m?: ItemMaterial) => ITEM_MATERIALS.indexOf(m ?? 'matte');
  list.forEach((i, k) => {
    const ix = i % nx;
    const iy = Math.floor(i / nx) % ny;
    const iz = Math.floor(i / (nx * ny));
    const x = origin[0] + (ix + 0.5) * size;
    const y = origin[1] + (iy + 0.5) * size;
    const z = origin[2] + (iz + 0.5) * size;
    // Take the gradient just outside the voxel's open faces: in a wall thinner
    // than a voxel or two, the centre can be nearer the other side's surface.
    const ox = (at(ix + 1, iy, iz) ? 0 : 1) - (at(ix - 1, iy, iz) ? 0 : 1);
    const oy = (at(ix, iy + 1, iz) ? 0 : 1) - (at(ix, iy - 1, iz) ? 0 : 1);
    const oz = (at(ix, iy, iz + 1) ? 0 : 1) - (at(ix, iy, iz - 1) ? 0 : 1);
    const ol = sqrt3(ox, oy, oz) || 1;
    const px = x + (ox / ol) * e;
    const py = y + (oy / ol) * e;
    const pz = z + (oz / ol) * e;
    const near = nearBlock(ix, iy, iz);
    let gx = field(px + e, py, pz, near) - field(px - e, py, pz, near);
    let gy = field(px, py + e, pz, near) - field(px, py - e, pz, near);
    let gz = field(px, py, pz + e, near) - field(px, py, pz - e, near);
    // Still facing into the voxel's neighbours: trust the open faces instead.
    if (gx * ox + gy * oy + gz * oz < 0) [gx, gy, gz] = [ox, oy, oz];
    if (!Number.isFinite(gx + gy + gz)) [gx, gy, gz] = [0, 0, 1];
    let len = sqrt3(gx, gy, gz);
    if (len < 1e-9) {
      // Fall back to the open faces of the voxel.
      gx = (at(ix + 1, iy, iz) ? 0 : 1) - (at(ix - 1, iy, iz) ? 0 : 1);
      gy = (at(ix, iy + 1, iz) ? 0 : 1) - (at(ix, iy - 1, iz) ? 0 : 1);
      gz = (at(ix, iy, iz + 1) ? 0 : 1) - (at(ix, iy, iz - 1) ? 0 : 1);
      len = sqrt3(gx, gy, gz) || 1;
      if (!gx && !gy && !gz) gz = len = 1;
    }
    normals[k * 3] = gx / len;
    normals[k * 3 + 1] = gy / len;
    normals[k * 3 + 2] = gz / len;
    const prim = prims[owner[i]!]!;
    const part = parts[prim.part]!;
    const zone =
      prim.zone?.(x, y, z, [normals[k * 3]!, normals[k * 3 + 1]!, normals[k * 3 + 2]!]) ?? 0;
    const hex =
      zone === 2
        ? insideOf(part)!.liquid!
        : zone === 1
          ? (insideOf(part)?.wall ?? part.color)
          : paintAt(
              part,
              x,
              y,
              z,
              // In a slab one voxel thick (a coaster at room size) the normal can point anywhere:
              // open above and below, it is the top the room sees, and paints as one.
              oz === 0 && !at(ix, iy, iz + 1) ? 1 : normals[k * 3 + 2]!,
            );
    let c = lab(hex);
    const material = zone === 2 ? 'gloss' : (part.material ?? 'matte');
    if (material === 'wood') {
      // Grain along the part's longer side.
      const along = part.size.w >= part.size.d ? x - part.at.x : y - part.at.y;
      const across = part.size.w >= part.size.d ? y - part.at.y : x - part.at.x;
      const len2 = Math.max(part.size.w, part.size.d);
      const g = ((across / len2) * 9 + Math.sin((along / len2) * 5 + across * 3) * 0.12) % 1;
      // Fine streaks, a shade apart: grain, not stripes.
      if (g - Math.floor(g) < 0.08) c = [c[0] * 0.9, c[1], c[2] * 1.03];
    } else if (material === 'fabric' && (ix + iy + iz) % 2) c = [c[0] * 0.95, c[1], c[2]];
    colors[k * 3] = c[0];
    colors[k * 3 + 1] = c[1];
    colors[k * 3 + 2] = c[2];
    mats[k] = materialIndex(material);
    if (zone === 0 && part.paint?.some((l) => l.kind === 'decal')) decals[k] = 1;
  });
  // Ambient occlusion: how many short rays from the surface are blocked.
  list.forEach((i, k) => {
    const ix = i % nx;
    const iy = Math.floor(i / nx) % ny;
    const iz = Math.floor(i / (nx * ny));
    const nxv = normals[k * 3]!;
    const nyv = normals[k * 3 + 1]!;
    const nzv = normals[k * 3 + 2]!;
    // A tangent basis around the normal.
    const ax = Math.abs(nzv) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let t1 = [
      nyv * ax[2]! - nzv * ax[1]!,
      nzv * ax[0]! - nxv * ax[2]!,
      nxv * ax[1]! - nyv * ax[0]!,
    ];
    const l1 = sqrt3(t1[0]!, t1[1]!, t1[2]!) || 1;
    t1 = t1.map((v) => v / l1);
    const t2 = [
      nyv * t1[2]! - nzv * t1[1]!,
      nzv * t1[0]! - nxv * t1[2]!,
      nxv * t1[1]! - nyv * t1[0]!,
    ];
    let blocked = 0;
    const rays = 9;
    for (let r = 0; r < rays; r++) {
      const a = (r * Math.PI) / 4;
      const spread = r === 8 ? 0 : 0.85;
      let dx = nxv + spread * (Math.cos(a) * t1[0]! + Math.sin(a) * t2[0]!);
      let dy = nyv + spread * (Math.cos(a) * t1[1]! + Math.sin(a) * t2[1]!);
      let dz = nzv + spread * (Math.cos(a) * t1[2]! + Math.sin(a) * t2[2]!);
      const dl = sqrt3(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      // Start past the next voxel layer, so a stair step on a slope does not shade itself.
      for (let step = 2.5; step <= 10; step += 1) {
        if (
          at(Math.round(ix + dx * step), Math.round(iy + dy * step), Math.round(iz + dz * step))
        ) {
          blocked += 1 - (step - 2.5) / 10;
          break;
        }
      }
    }
    ao[k] = 1 - (blocked / rays) * 0.75;
  });
  let fx0 = Infinity;
  let fx1 = -Infinity;
  let fy0 = Infinity;
  let fy1 = -Infinity;
  for (const i of list) {
    const ix = i % nx;
    const iy = Math.floor(i / nx) % ny;
    fx0 = Math.min(fx0, ix);
    fx1 = Math.max(fx1, ix + 1);
    fy0 = Math.min(fy0, iy);
    fy1 = Math.max(fy1, iy + 1);
  }
  const footprint = list.length
    ? {
        cx: origin[0] + ((fx0 + fx1) / 2) * size,
        cy: origin[1] + ((fy0 + fy1) / 2) * size,
        rx: ((fx1 - fx0) / 2) * size,
        ry: ((fy1 - fy0) / 2) * size,
      }
    : { cx: 0, cy: 0, rx: 0, ry: 0 };
  return {
    nx,
    ny,
    nz,
    origin,
    size,
    occ,
    surf,
    normals,
    colors,
    mats,
    ao,
    footprint,
    parts,
    decals,
  };
}

/**
 * Walk a ray through the grid (Amanatides and Woo), from `o` along the unit
 * vector `d`, both in voxel units. `visit` gets each filled voxel and the
 * distance to it; returning true stops the walk.
 */
function cast(g: VoxelGrid, o: V3, d: V3, visit: (index: number, t: number) => boolean): void {
  const { nx, ny, nz, occ } = g;
  const o0 = o[0];
  const o1 = o[1];
  const o2 = o[2];
  const d0 = d[0];
  const d1 = d[1];
  const d2 = d[2];
  let t0 = 0;
  let t1 = Infinity;
  // The ray's span inside the grid's box, one axis at a time (a slab test).
  for (let k = 0; k < 3; k++) {
    const dk = k === 0 ? d0 : k === 1 ? d1 : d2;
    const ok = k === 0 ? o0 : k === 1 ? o1 : o2;
    const nk = k === 0 ? nx : k === 1 ? ny : nz;
    if (Math.abs(dk) < 1e-12) {
      if (ok < 0 || ok > nk) return;
      continue;
    }
    let a = (0 - ok) / dk;
    let b = (nk - ok) / dk;
    if (a > b) {
      const swap = a;
      a = b;
      b = swap;
    }
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
  }
  if (t0 > t1) return;
  const p0 = o0 + d0 * (t0 + 1e-7);
  const p1 = o1 + d1 * (t0 + 1e-7);
  const p2 = o2 + d2 * (t0 + 1e-7);
  let c0 = Math.min(nx - 1, Math.max(0, Math.floor(p0)));
  let c1 = Math.min(ny - 1, Math.max(0, Math.floor(p1)));
  let c2 = Math.min(nz - 1, Math.max(0, Math.floor(p2)));
  const s0 = d0 > 0 ? 1 : -1;
  const s1 = d1 > 0 ? 1 : -1;
  const s2 = d2 > 0 ? 1 : -1;
  let m0 = Math.abs(d0) < 1e-12 ? Infinity : t0 + (c0 + (s0 > 0 ? 1 : 0) - p0) / d0;
  let m1 = Math.abs(d1) < 1e-12 ? Infinity : t0 + (c1 + (s1 > 0 ? 1 : 0) - p1) / d1;
  let m2 = Math.abs(d2) < 1e-12 ? Infinity : t0 + (c2 + (s2 > 0 ? 1 : 0) - p2) / d2;
  const e0 = Math.abs(d0) < 1e-12 ? Infinity : Math.abs(1 / d0);
  const e1 = Math.abs(d1) < 1e-12 ? Infinity : Math.abs(1 / d1);
  const e2 = Math.abs(d2) < 1e-12 ? Infinity : Math.abs(1 / d2);
  let t = t0;
  for (let guard = 0; guard < 4096; guard++) {
    const i = c0 + nx * (c1 + ny * c2);
    if (occ[i] && visit(i, t)) return;
    // Step along the axis whose boundary is nearest (x, then z, on ties).
    if (m0 < m1 && m0 < m2) {
      t = m0;
      c0 += s0;
      if (c0 < 0 || c0 >= nx) return;
      m0 += e0;
    } else if (!(m0 < m1) && m1 < m2) {
      t = m1;
      c1 += s1;
      if (c1 < 0 || c1 >= ny) return;
      m1 += e1;
    } else {
      t = m2;
      c2 += s2;
      if (c2 < 0 || c2 >= nz) return;
      m2 += e2;
    }
  }
}

/** The key light: from the upper left and a little in front, as in the flat scene. */
const LIGHT: V3 = KEY_LIGHT;
/** Toward the viewer of the isometric view: along it, screen position doesn't change. */
const VIEW: V3 = (() => {
  const v: V3 = [1, 1, ISO_TILE.height / ISO_RISE];
  const l = Math.hypot(...v);
  return v.map((c) => c / l) as V3;
})();
const HALF: V3 = (() => {
  const v = LIGHT.map((c, k) => c + VIEW[k]!) as V3;
  const l = Math.hypot(...v);
  return v.map((c) => c / l) as V3;
})();
/** Where a clean finish samples a pixel's paint: a 4 × 4 grid. */
const SUBPIXELS = [-0.375, -0.125, 0.125, 0.375].flatMap((dy) =>
  [-0.375, -0.125, 0.125, 0.375].map((dx) => [dx, dy] as const),
);
/** The share of a pixel a decal's marks must cover to take it. */
const MARK_SHARE = 0.3;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const ACCENT = hexLab('#e68cc4');
const SHADOW: Lab = hexLab('#05060a');

interface SpriteOptions {
  /** Tiles per item unit: how big the model stands in the scene. */
  scale: number;
  /** Iso pixels per sprite pixel. */
  pixel?: number;
  /** Snap every colour to this palette. */
  palette?: string[];
  /** A soft two-step contact shadow on the ground. */
  shadow?: boolean;
  /** Light the whole model with this colour, as a lit lamp. */
  glow?: string | null;
  /** Outline this part in the accent colour. */
  select?: number;
  /**
   * `pixel` (the default) is the room's look: four dithered steps with cool
   * shadows. `clean` is an item seen up close, drawn as pixel art is: six flat
   * steps, shadows warmer and highlights yellower than the base, no dither,
   * and a near-black outline with the colour's own hue.
   */
  finish?: 'pixel' | 'clean';
}
export interface Sprite {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** The sprite's top-left corner in iso pixels, relative to the item origin. */
  x: number;
  y: number;
  pixel: number;
  /** The part each pixel shows, by index into the model's parts; -1 where none does. */
  owner: Int16Array;
}

/** A clean finish's steps from darkest to lightest. */
const CLEAN_STEPS = 6;
/** One of a clean finish's steps: darker toward red-violet, lighter toward yellow. */
function cleanStep([L, a, b]: Lab, level: number): Lab {
  const q = Math.round(Math.max(0, Math.min(1, level)) * (CLEAN_STEPS - 1)) / (CLEAN_STEPS - 1);
  // 0.75 is the lit-side-on face, which keeps the base colour.
  const d = q - 0.75;
  return [
    Math.max(0.05, Math.min(0.985, L * (1 + 0.42 * d) + 0.04 * Math.max(0, d))),
    a - 0.03 * d + (d < 0 ? Math.abs(a) * -d * 0.3 : 0),
    b + 0.02 * d,
  ];
}
function cleanOutline([L, a, b]: Lab): Lab {
  return [Math.min(0.26, L * 0.3), a * 0.6 + 0.012, b * 0.6 + 0.004];
}
function shadeVoxel(
  g: VoxelGrid,
  k: number,
  px: number,
  py: number,
  glow: Lab | null,
  clean: boolean,
  painted: Lab | null = null,
): Lab {
  const n: V3 = [g.normals[k * 3]!, g.normals[k * 3 + 1]!, g.normals[k * 3 + 2]!];
  const base: Lab = glow ??
    painted ?? [g.colors[k * 3]!, g.colors[k * 3 + 1]!, g.colors[k * 3 + 2]!];
  const material = ITEM_MATERIALS[g.mats[k]!]!;
  const nl = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  let level: number;
  if (material === 'fabric') level = 0.45 + 0.5 * nl;
  else if (material === 'metal') {
    // A stylised environment: up-facing reflections catch the sky.
    const nv = n[0] * VIEW[0] + n[1] * VIEW[1] + n[2] * VIEW[2];
    const rz = 2 * nv * n[2] - VIEW[2];
    level = 0.25 + 0.35 * nl + 0.4 * Math.max(0, Math.min(1, rz * 0.5 + 0.5));
  } else level = 0.3 + 0.7 * nl;
  level *= 0.45 + 0.55 * g.ao[k]!;
  if (glow) level = Math.max(level, 0.7);
  let c: Lab;
  if (clean) c = cleanStep(base, (level - 0.25) / 0.7);
  else {
    level += (BAYER[(py & 3) * 4 + (px & 3)]! / 16 - 0.47) * 0.07;
    c = rampLab(base, level > 0.8 ? 3 : level > 0.6 ? 2 : level > 0.45 ? 1 : 0);
  }
  const exponent =
    material === 'metal' ? 16 : material === 'gloss' || material === 'glass' ? 40 : 0;
  if (exponent) {
    const nh = Math.max(0, n[0] * HALF[0] + n[1] * HALF[1] + n[2] * HALF[2]);
    if (nh ** exponent > (material === 'metal' ? 0.45 : 0.55))
      c = [Math.min(0.99, c[0] * 0.35 + 0.65), c[1] * 0.35, c[2] * 0.35 + 0.006];
  }
  return c;
}

/** The model lit and drawn as an isometric pixel-art sprite. */
export function renderSprite(g: VoxelGrid, opts: SpriteOptions): Sprite {
  const { scale, pixel = 1, shadow = true } = opts;
  const clean = opts.finish === 'clean';
  const glow = opts.glow ? hexLab(opts.glow) : null;
  const palette = opts.palette?.map(hexLab);
  // Bounds: the grid's corners, plus room for the shadow.
  const corners: { sx: number; sy: number }[] = [];
  for (const i of [0, 1])
    for (const j of [0, 1])
      for (const k of [0, 1])
        corners.push(
          toIso({
            x: (g.origin[0] + i * g.nx * g.size) * scale,
            y: (g.origin[1] + j * g.ny * g.size) * scale,
            z: (g.origin[2] + k * g.nz * g.size) * scale,
          }),
        );
  const fp = g.footprint;
  if (shadow)
    for (const [dx, dy] of [
      [-1.4, 0],
      [1.4, 0],
      [0, -1.4],
      [0, 1.4],
    ])
      corners.push(
        toIso({ x: (fp.cx + dx! * fp.rx) * scale, y: (fp.cy + dy! * fp.ry) * scale, z: 0 }),
      );
  const x0 = Math.floor(Math.min(...corners.map((c) => c.sx))) - pixel;
  const y0 = Math.floor(Math.min(...corners.map((c) => c.sy))) - pixel;
  const width = Math.ceil((Math.max(...corners.map((c) => c.sx)) + pixel - x0) / pixel);
  const height = Math.ceil((Math.max(...corners.map((c) => c.sy)) + pixel - y0) / pixel);
  const count = width * height;
  const hitPart = new Int16Array(count).fill(-1);
  const depth = new Float32Array(count).fill(Infinity);
  const color = new Float32Array(count * 3);
  const alpha = new Float32Array(count);
  const reach = (g.nx + g.ny + g.nz) * 2;
  const toward: V3 = [-VIEW[0], -VIEW[1], -VIEW[2]];
  const o: V3 = [0, 0, 0];
  // One walk's state, shared by every pixel's visit.
  let px = 0;
  let py = 0;
  let p = 0;
  let glassPart = -1;
  let lastT = 0;
  let layers = 0;
  let out0 = 0;
  let out1 = 0;
  let out2 = 0;
  let a = 0;
  // A clean finish paints a decal per pixel, as pixel art letters one: the
  // part's paint at 4 × 4 points of the pixel, on the part's own surface, and
  // the commonest mark takes the pixel when marks cover enough of it, so thin
  // strokes stay solid and nothing is blurred.
  const labOf = new Map<string, Lab>();
  const primsOf = new Map<number, Prim[]>();
  const paintHere = (part: number, k: number, t: number): Lab => {
    let prims = primsOf.get(part);
    if (!prims) primsOf.set(part, (prims = partPrims(g.parts[part]!, part)));
    const own = g.parts[part]!.color;
    const counts = new Map<string, number>();
    let marks = 0;
    let outside = 0;
    for (const [dx, dy] of SUBPIXELS) {
      const f = fromIso({ sx: x0 + (px + 0.5 + dx) * pixel, sy: y0 + (py + 0.5 + dy) * pixel }, 0);
      const vx = (f.x / scale - g.origin[0]) / g.size + VIEW[0] * (reach - t);
      const vy = (f.y / scale - g.origin[1]) / g.size + VIEW[1] * (reach - t);
      const vz = (0 - g.origin[2]) / g.size + VIEW[2] * (reach - t);
      // From a voxel short of the hit, onto the part's own surface.
      let x = g.origin[0] + (vx + VIEW[0]) * g.size;
      let y = g.origin[1] + (vy + VIEW[1]) * g.size;
      let z = g.origin[2] + (vz + VIEW[2]) * g.size;
      for (let step = 0; step < 16; step++) {
        let d = Infinity;
        for (const prim of prims) d = Math.min(d, prim.dist(x, y, z));
        if (d < g.size * 0.02 || d > g.size * 4) break;
        x -= VIEW[0] * d;
        y -= VIEW[1] * d;
        z -= VIEW[2] * d;
      }
      // A wall thinner than a voxel or two can leave an inner wall's voxel marked
      // as outside: a point the part itself calls inner takes no print.
      // The surface's own normal there, not the voxel's: a thin wall's voxel can face either way.
      const e = g.size * 0.25;
      const at = (ax: number, ay: number, az: number) => {
        let d = Infinity;
        for (const prim of prims) d = Math.min(d, prim.dist(ax, ay, az));
        return d;
      };
      const gx = at(x + e, y, z) - at(x - e, y, z);
      const gy = at(x, y + e, z) - at(x, y - e, z);
      const gz = at(x, y, z + e) - at(x, y, z - e);
      const gl = sqrt3(gx, gy, gz) || 1;
      const n: V3 = [gx / gl, gy / gl, gz / gl];
      if (prims.some((prim) => (prim.zone?.(x, y, z, n) ?? 0) !== 0)) continue;
      outside++;
      const hex = paintAt(g.parts[part]!, x, y, z, n[2]);
      if (hex === own) continue;
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
      marks++;
    }
    if (!outside) return [g.colors[k * 3]!, g.colors[k * 3 + 1]!, g.colors[k * 3 + 2]!];
    let hex = own;
    if (marks >= SUBPIXELS.length * MARK_SHARE) {
      let best = 0;
      for (const [h, n] of counts) if (n > best) [hex, best] = [h, n];
    }
    let c = labOf.get(hex);
    if (!c) labOf.set(hex, (c = hexLab(hex)));
    return c;
  };
  const visit = (i: number, t: number) => {
    const part = g.occ[i]! - 1;
    if (part === glassPart && t - lastT < 1.8) {
      lastT = t;
      return false;
    }
    const k = g.surf[i]!;
    if (k < 0) return false;
    const c = shadeVoxel(
      g,
      k,
      px,
      py,
      glow,
      clean,
      clean && g.decals[k] ? paintHere(part, k, t) : null,
    );
    const glass = layers === 0 && ITEM_MATERIALS[g.mats[k]!] === 'glass';
    if (layers === 0) {
      hitPart[p] = part;
      depth[p] = t;
    }
    const alphaHere = glass ? 0.5 : 1;
    const remaining = 1 - a;
    out0 += c[0] * alphaHere * remaining;
    out1 += c[1] * alphaHere * remaining;
    out2 += c[2] * alphaHere * remaining;
    a += alphaHere * remaining;
    layers++;
    if (glass) {
      glassPart = part;
      lastT = t;
      return false;
    }
    return true;
  };
  for (py = 0; py < height; py++)
    for (px = 0; px < width; px++) {
      const sx = x0 + (px + 0.5) * pixel;
      const sy = y0 + (py + 0.5) * pixel;
      const floor = fromIso({ sx, sy }, 0);
      // The ground point in voxel units, moved back toward the viewer.
      o[0] = (floor.x / scale - g.origin[0]) / g.size + VIEW[0] * reach;
      o[1] = (floor.y / scale - g.origin[1]) / g.size + VIEW[1] * reach;
      o[2] = (0 - g.origin[2]) / g.size + VIEW[2] * reach;
      p = px + py * width;
      // Glass lets the next surface show through: skip the rest of the glass
      // part's own voxels, then take whatever is behind it.
      glassPart = -1;
      lastT = 0;
      layers = 0;
      out0 = out1 = out2 = 0;
      a = 0;
      cast(g, o, toward, visit);
      if (a > 0) {
        color[p * 3] = out0 / a;
        color[p * 3 + 1] = out1 / a;
        color[p * 3 + 2] = out2 / a;
        alpha[p] = a;
      } else if (shadow && fp.rx > 0) {
        const fx = (floor.x / scale - fp.cx) / (fp.rx * 1.05);
        const fy = (floor.y / scale - fp.cy) / (fp.ry * 1.05);
        const r2 = fx * fx + fy * fy;
        if (r2 < 1.9) {
          color.set(SHADOW, p * 3);
          alpha[p] = r2 < 1 ? 0.4 : 0.2;
        }
      }
    }
  // Outlines: a darker shade of each colour where the model meets the
  // background, and a lighter line where a nearer surface overlaps a farther one.
  const final = new Float32Array(color);
  // How far apart, in voxels, two neighbouring pixels on one smooth surface can be.
  const gap = 6 + (3 * pixel) / (scale * 32 * g.size);
  for (let py = 0; py < height; py++)
    for (let px = 0; px < width; px++) {
      const p = px + py * width;
      if (hitPart[p]! < 0) continue;
      const lab: Lab = [color[p * 3]!, color[p * 3 + 1]!, color[p * 3 + 2]!];
      let edge = false;
      let behind = false;
      let other = false;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const qx = px + dx!;
        const qy = py + dy!;
        const q = qx + qy * width;
        if (qx < 0 || qy < 0 || qx >= width || qy >= height || hitPart[q]! < 0) {
          edge = true;
          continue;
        }
        if (depth[q]! < depth[p]! - (hitPart[q] !== hitPart[p] ? 2.5 : gap)) behind = true;
        if (hitPart[q] !== hitPart[p]) other = true;
      }
      let c = lab;
      if (opts.select === hitPart[p] && (edge || other)) c = ACCENT;
      else if (edge) c = clean ? cleanOutline(lab) : outlineLab(lab);
      else if (behind) c = [lab[0] * 0.74, lab[1], lab[2] - 0.012];
      final.set(c, p * 3);
    }
  const rgba = new Uint8ClampedArray(count * 4);
  for (let p = 0; p < count; p++) {
    if (!alpha[p]) continue;
    let lab: Lab = [final[p * 3]!, final[p * 3 + 1]!, final[p * 3 + 2]!];
    if (palette && hitPart[p]! >= 0) lab = nearest(lab, palette);
    const [r, gg, b] = labRgb(lab);
    rgba[p * 4] = r;
    rgba[p * 4 + 1] = gg;
    rgba[p * 4 + 2] = b;
    rgba[p * 4 + 3] = Math.round(alpha[p]! * 255);
  }
  return { width, height, rgba, x: x0, y: y0, pixel, owner: hitPart };
}

interface ItemView {
  width: number;
  height: number;
  /** 1 where the model covers the pixel. */
  mask: Uint8Array;
  /** Unlit OKLab colour per pixel: the model's own colours, as a photo would sample them. */
  lab: Float32Array;
}
/**
 * The model as the photo's camera sees it: an orthographic view from the
 * front (the viewer's side of the iso view), `elevation` degrees above the
 * surface, at `ppu` pixels per item unit. The image is cropped to the model.
 */
export function renderView(
  g: VoxelGrid,
  { elevation, ppu }: { elevation: number; ppu: number },
): ItemView {
  const e = (elevation * Math.PI) / 180;
  const c = Math.cos(e);
  const s = Math.sin(e);
  const r2 = Math.SQRT1_2;
  const f: V3 = [-c * r2, -c * r2, -s];
  const right: V3 = [r2, -r2, 0];
  const up: V3 = [-s * r2, -s * r2, c];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let r0 = Infinity;
  let r1 = -Infinity;
  let u0 = Infinity;
  let u1 = -Infinity;
  for (const i of [0, 1])
    for (const j of [0, 1])
      for (const k of [0, 1]) {
        const p: V3 = [
          g.origin[0] + i * g.nx * g.size,
          g.origin[1] + j * g.ny * g.size,
          g.origin[2] + k * g.nz * g.size,
        ];
        r0 = Math.min(r0, dot(p, right));
        r1 = Math.max(r1, dot(p, right));
        u0 = Math.min(u0, dot(p, up));
        u1 = Math.max(u1, dot(p, up));
      }
  const fullW = Math.max(1, Math.ceil((r1 - r0) * ppu));
  const fullH = Math.max(1, Math.ceil((u1 - u0) * ppu));
  const mask = new Uint8Array(fullW * fullH);
  const lab = new Float32Array(fullW * fullH * 3);
  const back = (g.nx + g.ny + g.nz) * g.size * 2;
  let minX = fullW;
  let minY = fullH;
  let maxX = -1;
  let maxY = -1;
  const o: V3 = [0, 0, 0];
  let px = 0;
  let py = 0;
  const visit = (i: number) => {
    const k = g.surf[i]!;
    if (k < 0) return false;
    const p = px + py * fullW;
    mask[p] = 1;
    lab[p * 3] = g.colors[k * 3]!;
    lab[p * 3 + 1] = g.colors[k * 3 + 1]!;
    lab[p * 3 + 2] = g.colors[k * 3 + 2]!;
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
    return true;
  };
  for (py = 0; py < fullH; py++)
    for (px = 0; px < fullW; px++) {
      const a = r0 + (px + 0.5) / ppu;
      const b = u1 - (py + 0.5) / ppu;
      o[0] = (right[0] * a + up[0] * b - f[0] * back - g.origin[0]) / g.size;
      o[1] = (right[1] * a + up[1] * b - f[1] * back - g.origin[1]) / g.size;
      o[2] = (right[2] * a + up[2] * b - f[2] * back - g.origin[2]) / g.size;
      cast(g, o, f, visit);
    }
  if (maxX < 0) return { width: 1, height: 1, mask: new Uint8Array(1), lab: new Float32Array(3) };
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const cropMask = new Uint8Array(width * height);
  const cropLab = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = x + minX + (y + minY) * fullW;
      const to = x + y * width;
      cropMask[to] = mask[from]!;
      cropLab[to * 3] = lab[from * 3]!;
      cropLab[to * 3 + 1] = lab[from * 3 + 1]!;
      cropLab[to * 3 + 2] = lab[from * 3 + 2]!;
    }
  return { width, height, mask: cropMask, lab: cropLab };
}
