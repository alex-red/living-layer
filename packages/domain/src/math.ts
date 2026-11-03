/** Small numeric helpers the modules share. */

export type Vec3 = [number, number, number];

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const norm = (a: Vec3) => Math.hypot(...a);
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const unit = (a: Vec3): Vec3 => scale(a, 1 / norm(a));

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Like `clamp`, but NaN and ±Infinity give `lo` instead of passing through. */
export const clampFiniteOrLow = (n: number, lo: number, hi: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;

/**
 * The value below which a share `q` of the values lie (unsorted input; the
 * value at index floor(q·n) when sorted). Undefined for no values.
 */
export const quantile = (vs: number[], q: number) =>
  [...vs].sort((a, b) => a - b)[Math.min(vs.length - 1, Math.floor(q * vs.length))]!;

/**
 * Unlike `quantile`, takes values already sorted, indexes by q·(n−1) (so q=1
 * is the last value) and gives 0 for none.
 */
export const quantileAt = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]! : 0;

/** The middle value (the upper one for an even count); 0 for no values. */
export const median = (xs: number[]) => (xs.length ? quantile(xs, 0.5) : 0);

/** A point on a Bézier curve of 2 to 4 control points. */
export function bezier(p: Vec3[], t: number): Vec3 {
  let pts = p;
  while (pts.length > 1)
    pts = pts.slice(1).map((q, i) => {
      const a = pts[i]!;
      return [a[0] + (q[0] - a[0]) * t, a[1] + (q[1] - a[1]) * t, a[2] + (q[2] - a[2]) * t];
    });
  return pts[0]!;
}

/** Whether (x, y) lies inside the polygon (even-odd rule). */
export function pointInPolygon(poly: { x: number; y: number }[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** The key light of the isometric sprites and the room camera's renders: upper left, a little in front. */
export const KEY_LIGHT: Vec3 = (() => {
  const v: Vec3 = [0.15, 0.75, 1];
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
})();
