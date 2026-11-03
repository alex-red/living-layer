/**
 * Whether a zone is occupied, decided locally by comparing it with how it
 * looked empty. Unlike motion, someone sitting still still differs from the
 * empty chair. Feature patches (the appearance model) shrug off most light
 * changes; plain grey levels, the fallback without the model, don't.
 */
import type { PatchGrid } from './appearance.js';
import type { LumaFrame, UnitBox } from './tracker.js';

export const OCCUPANCY = {
  /** A feature patch has changed when its cosine with the empty look falls under this. */
  featureSimilarity: 0.8,
  /** A grey pixel has changed when it moves by more than this, as in the motion gate. */
  pixelDelta: 24,
  /** Occupied once this share of the zone has changed… */
  occupiedShare: 0.12,
  /** …and clear again only under this share, so it doesn't flicker at the edge. */
  clearShare: 0.06,
  /** How often the watcher compares, in ms. */
  everyMs: 3000,
  /** The least time between two billed SAM confirmations of one zone, in ms. */
  samGapMs: 60_000,
  /** The grey sample of a zone, for the fallback. */
  sample: { width: 32, height: 24 },
};

/** How a zone looks empty: its feature patches, or a small grey sample. */
export type EmptyLook =
  | { method: 'features'; grid: PatchGrid }
  | { method: 'pixels'; width: number; height: number; data: Uint8Array };

/** Share of patches that no longer look like the empty zone, 0–1. A grid of another size is all change. */
export function featureDifference(empty: PatchGrid, now: PatchGrid): number {
  if (empty.cols !== now.cols || empty.rows !== now.rows || empty.dim !== now.dim) return 1;
  const n = empty.cols * empty.rows;
  let changed = 0;
  for (let p = 0; p < n; p++) {
    let dot = 0;
    let a = 0;
    let b = 0;
    for (let k = 0; k < empty.dim; k++) {
      const x = empty.data[p * empty.dim + k]!;
      const y = now.data[p * now.dim + k]!;
      dot += x * y;
      a += x * x;
      b += y * y;
    }
    if (dot / (Math.sqrt(a * b) || 1) < OCCUPANCY.featureSimilarity) changed++;
  }
  return n ? changed / n : 0;
}
/** A zone of a grey frame, sampled to a small fixed size. */
export function zoneSample(frame: LumaFrame, zone: UnitBox): Uint8Array {
  const { width: w, height: h } = OCCUPANCY.sample;
  return sampleInto(frame, zone, new Uint8Array(w * h), w, h);
}
/** The same into a buffer of `w × h` the caller keeps, so a sample taken every second allocates nothing. */
export function sampleInto(
  frame: LumaFrame,
  zone: UnitBox,
  out: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const fx = Math.min(
        frame.width - 1,
        Math.floor((zone.x + ((x + 0.5) / w) * zone.width) * frame.width),
      );
      const fy = Math.min(
        frame.height - 1,
        Math.floor((zone.y + ((y + 0.5) / h) * zone.height) * frame.height),
      );
      out[y * w + x] = frame.data[fy * frame.width + fx]!;
    }
  return out;
}
/** Share of a grey sample that differs from the empty one, 0–1. */
export function pixelDifference(empty: Uint8Array, now: Uint8Array): number {
  if (empty.length !== now.length) return 1;
  let changed = 0;
  for (let i = 0; i < empty.length; i++)
    if (Math.abs(empty[i]! - now[i]!) > OCCUPANCY.pixelDelta) changed++;
  return empty.length ? changed / empty.length : 0;
}
/** Occupied or not, from the difference and what it was, with a gap so it doesn't flicker. */
export function nextOccupied(was: boolean, score: number): boolean {
  return was ? score >= OCCUPANCY.clearShare : score >= OCCUPANCY.occupiedShare;
}
