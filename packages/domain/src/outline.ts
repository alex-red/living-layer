/**
 * A thing's outline found on the machine, with no model call: a person drags
 * a box (or a polygon) around it, and the pixels inside that don't look like
 * what is just around the box are the thing. What stands around it is
 * sampled from a band outside the shape and the shape's own edge, and grouped
 * into a few colours; a pixel inside is the thing when it is far from all of
 * them. The largest piece (and any nearly as large) is kept and its holes are
 * filled, so a mug's dark inside stays part of it.
 *
 * It is a reason to follow something, as SAM's outline is: the watcher cuts
 * its template from it. A shape drawn tight on something plain against a
 * plain desk can't be told apart: then the shape itself is the outline.
 */
import { newBits, type Bits } from './photo-scene.js';

/** What a local outline's segmentation run records as its model. */
export const LOCAL_OUTLINE_MODEL = 'local-outline';

/** An RGB picture, three bytes a pixel. */
interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array;
}
const OUTLINE = {
  /** The band sampled around the shape, as a share of its larger side; at least `minBand` pixels. */
  band: 0.25,
  minBand: 3,
  /** Colours the surroundings are grouped into. */
  colours: 5,
  /** Most surrounding pixels sampled. */
  samples: 2400,
  /** Least colour distance (RGB) from every surrounding colour for a pixel to be the thing. */
  minDistance: 22,
  /** The threshold is also this many times the surroundings' own 90th-percentile spread. */
  spread: 1.6,
  /** A piece is kept beside the largest when it is at least this share of it. */
  keepShare: 0.3,
  /** Under this share of the shape, nothing stood out: the shape is the outline. */
  minShare: 0.06,
};

interface LocalOutline {
  /** Frame-sized, 1 on the thing. */
  bits: Bits;
  /** Share of the shape the outline covers. */
  share: number;
  /** True when nothing stood out from the surroundings and the shape itself was kept. */
  fallback: boolean;
}

/**
 * The thing inside `shape` (frame-sized bits, 1 inside what the person drew),
 * outlined against what is around it.
 */
export function outlineIn(image: RgbImage, shape: Bits): LocalOutline | null {
  const { width, height, data } = image;
  if (shape.width !== width || shape.height !== height) return null;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let inside = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (shape.data[y * width + x]) {
        inside++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0 || inside < 16) return null;
  const band = Math.max(OUTLINE.minBand, Math.round(OUTLINE.band * Math.max(x1 - x0, y1 - y0)));
  // The surroundings: a band outside the shape, and the shape's own edge pixels.
  const around: number[] = [];
  const edge = (x: number, y: number) =>
    x === 0 ||
    y === 0 ||
    x === width - 1 ||
    y === height - 1 ||
    !shape.data[y * width + x - 1] ||
    !shape.data[y * width + x + 1] ||
    !shape.data[(y - 1) * width + x] ||
    !shape.data[(y + 1) * width + x];
  for (let y = Math.max(0, y0 - band); y <= Math.min(height - 1, y1 + band); y++)
    for (let x = Math.max(0, x0 - band); x <= Math.min(width - 1, x1 + band); x++) {
      const k = y * width + x;
      if (!shape.data[k] || edge(x, y)) around.push(k);
    }
  if (around.length < 8) return null;
  const stride = Math.max(1, around.length / OUTLINE.samples);
  const sampled: number[] = [];
  for (let s = 0; s < around.length; s += stride) sampled.push(around[Math.floor(s)]!);
  const centres = groupColours(data, sampled, OUTLINE.colours);
  const far = (k: number) => {
    let best = Infinity;
    for (const c of centres) {
      const d = Math.hypot(
        data[k * 3]! - c[0]!,
        data[k * 3 + 1]! - c[1]!,
        data[k * 3 + 2]! - c[2]!,
      );
      if (d < best) best = d;
    }
    return best;
  };
  const spreads = sampled.map(far).sort((a, b) => a - b);
  const limit = Math.max(
    OUTLINE.minDistance,
    OUTLINE.spread * spreads[Math.floor(spreads.length * 0.9)]!,
  );
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const local = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const k = y * width + x;
      if (shape.data[k] && !edge(x, y) && far(k) > limit) local[(y - y0) * w + x - x0] = 1;
    }
  const kept = fillHoles(largestPieces(smooth(local, w, h), w, h), w, h);
  let count = 0;
  for (const v of kept) count += v;
  const bits = newBits(width, height);
  if (count < OUTLINE.minShare * inside) {
    bits.data.set(shape.data);
    return { bits, share: 1, fallback: true };
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (kept[y * w + x]) bits.data[(y + y0) * width + x + x0] = 1;
  return { bits, share: count / inside, fallback: false };
}

/** A few colours the samples gather around: k-means, seeded by spread-out picks. */
function groupColours(data: Uint8Array, samples: number[], k: number): number[][] {
  const at = (s: number) => [data[s * 3]!, data[s * 3 + 1]!, data[s * 3 + 2]!];
  const dist = (a: number[], b: number[]) =>
    Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  const centres = [at(samples[0]!)];
  // Each next seed is the sample farthest from the seeds so far.
  while (centres.length < k) {
    let best = -1;
    let bestD = 0;
    for (const s of samples) {
      const d = Math.min(...centres.map((c) => dist(c, at(s))));
      if (d > bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best < 0) break;
    centres.push(at(best));
  }
  for (let round = 0; round < 8; round++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      const p = at(s);
      let j = 0;
      for (let c = 1; c < centres.length; c++)
        if (dist(centres[c]!, p) < dist(centres[j]!, p)) j = c;
      const sum = sums[j]!;
      sum[0]! += p[0]!;
      sum[1]! += p[1]!;
      sum[2]! += p[2]!;
      sum[3]!++;
    }
    sums.forEach((s, c) => {
      if (s[3]) centres[c] = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!];
    });
  }
  return centres;
}

/** Drops lone pixels and fills lone gaps: a pixel takes what most of its eight neighbours are. */
function smooth(bits: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(bits.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if ((dx || dy) && x + dx >= 0 && x + dx < w && y + dy >= 0 && y + dy < h)
            n += bits[(y + dy) * w + x + dx]!;
      const k = y * w + x;
      out[k] = bits[k] ? (n >= 2 ? 1 : 0) : n >= 6 ? 1 : 0;
    }
  return out;
}

/** The largest 4-connected piece and any at least `keepShare` of it. */
function largestPieces(bits: Uint8Array, w: number, h: number): Uint8Array {
  const label = new Int32Array(bits.length);
  const sizes: number[] = [0];
  const stack: number[] = [];
  for (let k = 0; k < bits.length; k++) {
    if (!bits[k] || label[k]) continue;
    const id = sizes.length;
    let size = 0;
    stack.push(k);
    label[k] = id;
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      const y = (p - x) / w;
      for (const q of [
        x > 0 ? p - 1 : -1,
        x < w - 1 ? p + 1 : -1,
        y > 0 ? p - w : -1,
        y < h - 1 ? p + w : -1,
      ])
        if (q >= 0 && bits[q] && !label[q]) {
          label[q] = id;
          stack.push(q);
        }
    }
    sizes.push(size);
  }
  const largest = Math.max(0, ...sizes);
  const out = new Uint8Array(bits.length);
  for (let k = 0; k < bits.length; k++)
    if (label[k] && sizes[label[k]!]! >= OUTLINE.keepShare * largest) out[k] = 1;
  return out;
}

/** Fills what the outside can't reach: the dark inside of a mug, a label's letters. */
function fillHoles(bits: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(bits.length);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const p = stack.pop()!;
    if (bits[p] || outside[p]) continue;
    outside[p] = 1;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  const out = new Uint8Array(bits.length);
  for (let k = 0; k < bits.length; k++) out[k] = outside[k] ? 0 : 1;
  return out;
}
