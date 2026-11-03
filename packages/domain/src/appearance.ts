/**
 * Finding a thing again by how it looks. A self-supervised vision model
 * (DINOv3) turns an image into one feature vector per 16 px patch. Averaging
 * the patches under SAM's mask gives the thing's prototype; a later frame's
 * patches are compared with it, and the best window the thing's size is where
 * it is now. Unlike the local template, this survives turns, lighting and
 * low contrast, and tells look-alikes apart. The model runs on the server;
 * this is the arithmetic around it.
 */
import type { UnitBox } from './tracker.js';

/** The model's patch features for one image, row-major: `cols × rows` vectors of `dim`. */
export interface PatchGrid {
  cols: number;
  rows: number;
  dim: number;
  data: Float32Array;
}
interface AppearanceMatch {
  /** Where it is, as a share of the image the grid was made from. */
  box: UnitBox;
  /** Mean cosine similarity over the window, -1 to 1. */
  score: number;
  /** How far the best window leads the best one elsewhere. */
  lead: number;
}
export const APPEARANCE = {
  /** The model's patch size, in pixels. */
  patch: 16,
  /** The longer side images are scaled to before embedding, a multiple of the patch. */
  side: 448,
  /** Below this mean similarity the thing isn't there. A desk without the mug still scores about 0.7. */
  minScore: 0.6,
  /** Below this lead two places look alike and neither is trusted; a mug that isn't there leads by about 0.03. */
  minLead: 0.06,
  /** Prototypes kept per thing, from different sightings. */
  maxPrototypes: 4,
  /**
   * A thing is embedded from a square of the frame this many times its size,
   * so a mug across the room still spans a few patches; the square is also
   * where a lost thing is looked for.
   */
  zoom: 7,
  /** A lost thing is looked for in a square twice as wide, embedded at up to twice the side. */
  searchZoom: 14,
};

/**
 * Where to look for a lost thing last seen at `box`, and the side to embed
 * it at so the thing keeps the scale its prototypes were made at.
 */
export function searchRegion(box: UnitBox, frame: { width: number; height: number }) {
  const learn = appearanceRegion(box, frame);
  const region = appearanceRegion(box, frame, APPEARANCE.searchZoom);
  const px = (r: UnitBox) => Math.max(r.width * frame.width, r.height * frame.height);
  const side =
    Math.round(
      Math.min(2, Math.max(1, px(region) / px(learn))) * (APPEARANCE.side / APPEARANCE.patch),
    ) * APPEARANCE.patch;
  return { region, side };
}

/**
 * The square of the frame (as shares of it) to embed for a thing at `box`:
 * `APPEARANCE.zoom` times its longer side, centred on it and kept inside the
 * frame. A thing too big for that gets the whole frame.
 */
export function appearanceRegion(
  box: UnitBox,
  frame: { width: number; height: number },
  zoom = APPEARANCE.zoom,
): UnitBox {
  const side = Math.max(box.width * frame.width, box.height * frame.height) * zoom;
  if (side >= Math.min(frame.width, frame.height)) return { x: 0, y: 0, width: 1, height: 1 };
  const w = side / frame.width;
  const h = side / frame.height;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return {
    x: Math.min(1 - w, Math.max(0, cx - w / 2)),
    y: Math.min(1 - h, Math.max(0, cy - h / 2)),
    width: w,
    height: h,
  };
}
/** A box in frame shares as shares of `region`, and back. */
export const intoRegion = (b: UnitBox, r: UnitBox): UnitBox => ({
  x: (b.x - r.x) / r.width,
  y: (b.y - r.y) / r.height,
  width: b.width / r.width,
  height: b.height / r.height,
});
export const outOfRegion = (b: UnitBox, r: UnitBox): UnitBox => ({
  x: r.x + b.x * r.width,
  y: r.y + b.y * r.height,
  width: b.width * r.width,
  height: b.height * r.height,
});
/** The part of a frame-sized mask inside `region`. */
export function cropMask(
  mask: { width: number; height: number; data: Uint8Array },
  r: UnitBox,
): { width: number; height: number; data: Uint8Array } {
  const left = Math.max(0, Math.floor(r.x * mask.width));
  const top = Math.max(0, Math.floor(r.y * mask.height));
  const width = Math.max(1, Math.min(mask.width - left, Math.round(r.width * mask.width)));
  const height = Math.max(1, Math.min(mask.height - top, Math.round(r.height * mask.height)));
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    data.set(
      mask.data.subarray((top + y) * mask.width + left, (top + y) * mask.width + left + width),
      y * width,
    );
  return { width, height, data };
}

function normalize(v: Float32Array): Float32Array | null {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n < 1e-6) return null;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

/**
 * The weighted mean of the patches, normalized, where `weights` (one per
 * patch, 0–1) is how much of each patch the mask covers. Null when the mask
 * covers less than one patch's worth.
 */
export function prototypeOf(grid: PatchGrid, weights: Float32Array): Float32Array | null {
  const out = new Float32Array(grid.dim);
  let total = 0;
  for (let p = 0; p < grid.cols * grid.rows; p++) {
    const w = weights[p] ?? 0;
    if (w <= 0) continue;
    total += w;
    // Each patch counts by direction, not length, so a bright patch doesn't outvote the rest.
    let n = 0;
    for (let k = 0; k < grid.dim; k++) n += grid.data[p * grid.dim + k]! ** 2;
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < grid.dim; k++) out[k]! += (w * grid.data[p * grid.dim + k]!) / n;
  }
  return total >= 1 ? normalize(out) : null;
}

/** Each patch's best cosine similarity with any of the prototypes. */
function similarityMap(grid: PatchGrid, prototypes: Float32Array[]): Float32Array {
  const map = new Float32Array(grid.cols * grid.rows).fill(-1);
  for (let p = 0; p < map.length; p++) {
    let n = 0;
    for (let k = 0; k < grid.dim; k++) n += grid.data[p * grid.dim + k]! ** 2;
    n = Math.sqrt(n) || 1;
    for (const proto of prototypes) {
      let dot = 0;
      for (let k = 0; k < grid.dim; k++) dot += grid.data[p * grid.dim + k]! * proto[k]!;
      map[p] = Math.max(map[p]!, dot / n);
    }
  }
  return map;
}

/**
 * The window of `size` (a share of the image) whose patches are most like
 * the prototypes, with how far it leads the best window that doesn't overlap
 * it. Null when the grid is smaller than one window.
 */
export function findByAppearance(
  grid: PatchGrid,
  prototypes: Float32Array[],
  size: { width: number; height: number },
): AppearanceMatch | null {
  if (!prototypes.length) return null;
  const map = similarityMap(grid, prototypes);
  const w = Math.max(1, Math.min(grid.cols, Math.round(size.width * grid.cols)));
  const h = Math.max(1, Math.min(grid.rows, Math.round(size.height * grid.rows)));
  // A summed-area table makes every window's mean one lookup.
  const sat = new Float64Array((grid.cols + 1) * (grid.rows + 1));
  for (let r = 0; r < grid.rows; r++)
    for (let c = 0; c < grid.cols; c++)
      sat[(r + 1) * (grid.cols + 1) + c + 1] =
        map[r * grid.cols + c]! +
        sat[r * (grid.cols + 1) + c + 1]! +
        sat[(r + 1) * (grid.cols + 1) + c]! -
        sat[r * (grid.cols + 1) + c]!;
  const mean = (c: number, r: number) =>
    (sat[(r + h) * (grid.cols + 1) + c + w]! -
      sat[r * (grid.cols + 1) + c + w]! -
      sat[(r + h) * (grid.cols + 1) + c]! +
      sat[r * (grid.cols + 1) + c]!) /
    (w * h);
  let best = { c: -1, r: -1, score: -Infinity };
  for (let r = 0; r + h <= grid.rows; r++)
    for (let c = 0; c + w <= grid.cols; c++) {
      const score = mean(c, r);
      if (score > best.score) best = { c, r, score };
    }
  if (best.c < 0) return null;
  let second = -Infinity;
  for (let r = 0; r + h <= grid.rows; r++)
    for (let c = 0; c + w <= grid.cols; c++)
      if (Math.abs(c - best.c) >= w || Math.abs(r - best.r) >= h)
        second = Math.max(second, mean(c, r));
  return {
    box: {
      x: best.c / grid.cols,
      y: best.r / grid.rows,
      width: w / grid.cols,
      height: h / grid.rows,
    },
    score: best.score,
    lead: second === -Infinity ? 1 : best.score - second,
  };
}

/** A confident match: like the thing, and unlike anywhere else. */
export const appearanceSure = (m: AppearanceMatch | null): m is AppearanceMatch =>
  m !== null && m.score >= APPEARANCE.minScore && m.lead >= APPEARANCE.minLead;

/** The size, in pixels and a multiple of the patch, an image of `width × height` is embedded at. */
export function embedSize(width: number, height: number, side = APPEARANCE.side) {
  const scale = side / Math.max(width, height);
  const snap = (v: number) =>
    Math.max(APPEARANCE.patch, Math.round((v * scale) / APPEARANCE.patch) * APPEARANCE.patch);
  return { width: snap(width), height: snap(height) };
}

/** How much of each patch a frame-sized 0/1 mask covers, for `prototypeOf`. */
export function patchWeights(
  mask: { width: number; height: number; data: Uint8Array },
  cols: number,
  rows: number,
): Float32Array {
  const weights = new Float32Array(cols * rows);
  const counts = new Float32Array(cols * rows);
  for (let y = 0; y < mask.height; y++)
    for (let x = 0; x < mask.width; x++) {
      const p =
        Math.min(rows - 1, Math.floor((y * rows) / mask.height)) * cols +
        Math.min(cols - 1, Math.floor((x * cols) / mask.width));
      counts[p]!++;
      weights[p]! += mask.data[y * mask.width + x]!;
    }
  for (let p = 0; p < weights.length; p++) weights[p] = counts[p] ? weights[p]! / counts[p]! : 0;
  return weights;
}
