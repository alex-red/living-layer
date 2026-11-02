/**
 * A Gaussian splat from SAM 3D Objects, read as the shape of a turned body:
 * SAM 3D sees a whole thing from one crop (the hidden side, the handle's
 * loop), where the fitter measures only the side the photo shows. Its shape
 * replaces the fit's guessed profile, radius, height and handle; colours,
 * bands and print stay the photo's, which SAM 3D only guesses for the sides
 * it can't see. See docs/plans/sam3d-experiment.md.
 */
import type { LatheFit } from './iso-archetypes.js';

export interface SplatPoint {
  /** Position, with z up (SAM 3D's frame). */
  x: number;
  y: number;
  z: number;
  /** Opacity, 0 to 1. */
  opacity: number;
}

/** A binary little-endian PLY's vertices: position and opacity (a splat's is a logit). */
export function readSplat(bytes: Uint8Array): SplatPoint[] {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  const end = text.indexOf('end_header\n');
  if (!text.startsWith('ply') || end < 0) throw new Error('Not a PLY file.');
  const header = text.slice(0, end).split('\n');
  if (!header.some((l) => l.startsWith('format binary_little_endian')))
    throw new Error('Only binary little-endian PLY files are read.');
  const count = Number(header.find((l) => l.startsWith('element vertex'))?.split(' ')[2]);
  const sizes: Record<string, number> = { float: 4, uchar: 1, double: 8, int: 4, uint: 4 };
  const offsets = new Map<string, { at: number; type: string }>();
  let stride = 0;
  for (const line of header.filter((l) => l.startsWith('property'))) {
    const [, type, name] = line.split(' ');
    offsets.set(name!, { at: stride, type: type! });
    stride += sizes[type!] ?? 4;
  }
  const body = end + 'end_header\n'.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = (i: number, name: string, fallback: number) => {
    const o = offsets.get(name);
    if (!o) return fallback;
    const at = body + i * stride + o.at;
    return o.type === 'uchar' ? view.getUint8(at) / 255 : view.getFloat32(at, true);
  };
  const logit = offsets.has('opacity');
  const points: SplatPoint[] = [];
  for (let i = 0; i < count; i++) {
    const o = read(i, 'opacity', 1);
    points.push({
      x: read(i, 'x', 0),
      y: read(i, 'y', 0),
      z: read(i, 'z', 0),
      opacity: logit ? 1 / (1 + Math.exp(-o)) : o,
    });
  }
  return points;
}

const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]! : 0;
const sortedOf = (values: number[]) => values.toSorted((a, b) => a - b);

/** How many slices up the body its profile is read in. */
const SLICES = 12;
/** Points fainter than this are haze around the surface, not the thing. */
const MIN_OPACITY = 0.2;

/**
 * The turned body a splat shows, as a lathe fit's shape: profile, radius,
 * height and handle, in the units of `like` (its radius is kept, so the
 * model's scale doesn't change). Everything else comes from `like`.
 *
 * The axis is the middle of the base, where no handle reaches. A handle is
 * what stands well clear of the body on one side; its side is left out of
 * the body's radius, which is read from the outer surface (a high quantile
 * of distances from the axis: the hollow inside sits nearer it).
 */
export function latheFromSplat(points: SplatPoint[], like: LatheFit): LatheFit {
  const solid = points.filter((p) => p.opacity >= MIN_OPACITY);
  if (solid.length < 200) throw new Error('The splat is too sparse to read a shape from.');
  const zs = sortedOf(solid.map((p) => p.z));
  const z0 = quantile(zs, 0.005);
  const z1 = quantile(zs, 0.995);
  const height = z1 - z0;
  if (height <= 0) throw new Error('The splat has no height.');
  const share = (z: number) => (z - z0) / height;
  // The axis: the middle of the base's spread, which no handle reaches.
  const base = solid.filter((p) => share(p.z) < 0.12);
  const xs = sortedOf(base.map((p) => p.x));
  const ys = sortedOf(base.map((p) => p.y));
  const cx = (quantile(xs, 0.02) + quantile(xs, 0.98)) / 2;
  const cy = (quantile(ys, 0.02) + quantile(ys, 0.98)) / 2;
  const polar = solid.map((p) => ({
    z: share(p.z),
    r: Math.hypot(p.x - cx, p.y - cy),
    a: Math.atan2(p.y - cy, p.x - cx),
  }));
  // The body's rough radius, then what stands well clear of it: the handle's side.
  const rough = quantile(sortedOf(polar.map((p) => p.r)), 0.6);
  const clear = polar.filter((p) => p.r > rough * 1.35 && p.z > 0.05 && p.z < 0.98);
  let handleAngle: number | null = null;
  if (clear.length > solid.length * 0.01) {
    const sx = clear.reduce((s, p) => s + Math.cos(p.a), 0);
    const sy = clear.reduce((s, p) => s + Math.sin(p.a), 0);
    // Only when they gather on one side: a flared rim reaches out all round.
    if (Math.hypot(sx, sy) / clear.length > 0.6) handleAngle = Math.atan2(sy, sx);
  }
  const offHandle = (a: number) =>
    handleAngle === null ||
    Math.abs(Math.atan2(Math.sin(a - handleAngle), Math.cos(a - handleAngle))) > 0.7;
  // The body's radius in each slice, from its outer surface away from the handle.
  const radii: { z: number; r: number }[] = [];
  for (let i = 0; i < SLICES; i++) {
    const lo = i / SLICES;
    const hi = (i + 1) / SLICES;
    const slice = polar.filter((p) => p.z >= lo && p.z < hi && offHandle(p.a)).map((p) => p.r);
    if (slice.length < 20) continue;
    radii.push({ z: (lo + hi) / 2, r: quantile(sortedOf(slice), 0.95) });
  }
  if (radii.length < 3) throw new Error('Too few slices of the splat to read a profile.');
  const widest = Math.max(...radii.map((s) => s.r));
  // The model keeps `like`'s radius; height and handle follow in the same units.
  const unit = like.radius / widest;
  const profile = [
    { z: 0, r: radii[0]!.r / widest },
    ...radii.map((s) => ({ z: s.z, r: s.r / widest })),
    { z: 1, r: radii.at(-1)!.r / widest },
  ];
  const bodyAt = (z: number) => {
    for (let i = 1; i < profile.length; i++)
      if (profile[i]!.z >= z) {
        const a = profile[i - 1]!;
        const b = profile[i]!;
        return widest * (a.r + ((b.r - a.r) * (z - a.z)) / (b.z - a.z || 1));
      }
    return widest * profile.at(-1)!.r;
  };
  let handle: LatheFit['handle'] = null;
  if (handleAngle !== null) {
    const loop = polar.filter((p) => !offHandle(p.a) && p.r > bodyAt(p.z) * 1.08);
    if (loop.length > solid.length * 0.005) {
      const hz = sortedOf(loop.map((p) => p.z));
      const reach = quantile(sortedOf(loop.map((p) => p.r - bodyAt(p.z))), 0.98);
      handle = {
        top: quantile(hz, 0.98),
        bottom: quantile(hz, 0.02),
        reach: reach * unit,
        thickness: like.handle?.thickness ?? reach * unit * 0.3,
      };
    }
  }
  return { ...like, radius: like.radius, height: height * unit, profile, handle };
}
