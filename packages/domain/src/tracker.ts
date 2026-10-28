/**
 * Local tracking between model calls. After SAM has found the mug once, its
 * pixels become a template, and each new frame is searched for the best match
 * near the last box by normalized cross-correlation. Nothing leaves the
 * browser. SAM is only asked again when the match gets weak (re-anchor) or the
 * box crosses the zone boundary (confirm), since the lamp must never fire on a
 * local guess.
 */

/** A grayscale frame, downsampled for speed. */
export interface LumaFrame {
  width: number;
  height: number;
  data: Uint8Array;
}
/** A box as a share of the frame, 0–1 on each axis. */
export interface UnitBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Template {
  width: number;
  height: number;
  /** Pixels minus their mean, so matching ignores overall brightness. */
  data: Float32Array;
  norm: number;
}
export type LocalVerdict = 'follow' | 'reanchor' | 'confirm';
export interface LocalTrack {
  /** Cut from the last SAM-confirmed frame, never from a local guess, so it can't drift. */
  template: Template;
  box: UnitBox;
  score: number;
  /** The last verdict SAM confirmed. */
  inside: boolean;
  /** Consecutive weak matches. */
  lostSteps: number;
  /** Consecutive matches on the other side of the zone boundary from `inside`. */
  crossingSteps: number;
}
export const LOCAL_TRACK = {
  /** Below this correlation the match is treated as lost. */
  lostScore: 0.55,
  /** How far from the last box to search, as a share of the frame. */
  searchRadius: 0.25,
  /** Smallest template side, in luma pixels. */
  minSide: 6,
};

/** Same luma weights as the playground's motion gate. */
export function toLuma(rgba: Uint8ClampedArray, width: number, height: number): LumaFrame {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++)
    data[i] = (rgba[i * 4]! * 77 + rgba[i * 4 + 1]! * 150 + rgba[i * 4 + 2]! * 29) >> 8;
  return { width, height, data };
}

function pixelRect(frame: LumaFrame, box: UnitBox) {
  const x = Math.max(0, Math.round(box.x * frame.width));
  const y = Math.max(0, Math.round(box.y * frame.height));
  return {
    x,
    y,
    width: Math.min(frame.width - x, Math.round(box.width * frame.width)),
    height: Math.min(frame.height - y, Math.round(box.height * frame.height)),
  };
}

/** The template under `box`, or null when it is too small or too plain to match reliably. */
export function cutTemplate(frame: LumaFrame, box: UnitBox): Template | null {
  const r = pixelRect(frame, box);
  if (r.width < LOCAL_TRACK.minSide || r.height < LOCAL_TRACK.minSide) return null;
  const data = new Float32Array(r.width * r.height);
  let sum = 0;
  for (let j = 0; j < r.height; j++)
    for (let i = 0; i < r.width; i++) {
      const v = frame.data[(r.y + j) * frame.width + r.x + i]!;
      data[j * r.width + i] = v;
      sum += v;
    }
  const mean = sum / data.length;
  let squares = 0;
  for (let k = 0; k < data.length; k++) {
    data[k]! -= mean;
    squares += data[k]! ** 2;
  }
  const norm = Math.sqrt(squares);
  // Under ~2 grey levels of spread there is nothing to lock onto.
  return norm / Math.sqrt(data.length) < 2
    ? null
    : { width: r.width, height: r.height, data, norm };
}

/** Summed-area tables of the pixels and their squares, for O(1) window statistics. */
function integrals(frame: LumaFrame) {
  const w = frame.width + 1;
  const sum = new Float64Array(w * (frame.height + 1));
  const squares = new Float64Array(sum.length);
  for (let y = 0; y < frame.height; y++)
    for (let x = 0; x < frame.width; x++) {
      const v = frame.data[y * frame.width + x]!;
      const k = (y + 1) * w + x + 1;
      sum[k] = v + sum[k - 1]! + sum[k - w]! - sum[k - w - 1]!;
      squares[k] = v * v + squares[k - 1]! + squares[k - w]! - squares[k - w - 1]!;
    }
  const area = (t: Float64Array, x: number, y: number, tw: number, th: number) =>
    t[(y + th) * w + x + tw]! - t[y * w + x + tw]! - t[(y + th) * w + x]! + t[y * w + x]!;
  return { sum, squares, area };
}

/**
 * Find the template near `near`. Returns the best-correlated box and its score
 * (-1 to 1), or null when the template no longer fits the frame.
 */
export function matchTemplate(
  frame: LumaFrame,
  template: Template,
  near: UnitBox,
  radius = LOCAL_TRACK.searchRadius,
): { box: UnitBox; score: number } | null {
  const { width: tw, height: th } = template;
  if (tw > frame.width || th > frame.height) return null;
  const start = pixelRect(frame, near);
  const rx = Math.ceil(radius * frame.width);
  const ry = Math.ceil(radius * frame.height);
  const { sum, squares, area } = integrals(frame);
  const n = tw * th;
  let best = { x: 0, y: 0, score: -Infinity, distance: Infinity };
  for (let y = Math.max(0, start.y - ry); y <= Math.min(frame.height - th, start.y + ry); y++)
    for (let x = Math.max(0, start.x - rx); x <= Math.min(frame.width - tw, start.x + rx); x++) {
      const s = area(sum, x, y, tw, th);
      const spread = area(squares, x, y, tw, th) - (s * s) / n;
      if (spread <= 1e-6) continue;
      // The template is zero-mean, so the window's mean drops out of the numerator.
      let dot = 0;
      for (let j = 0; j < th; j++) {
        const row = (y + j) * frame.width + x;
        for (let i = 0; i < tw; i++) dot += template.data[j * tw + i]! * frame.data[row + i]!;
      }
      const score = dot / (template.norm * Math.sqrt(spread));
      const distance = Math.hypot(x - start.x, y - start.y);
      if (score > best.score + 1e-9 || (score > best.score - 1e-9 && distance < best.distance))
        best = { x, y, score, distance };
    }
  if (best.score === -Infinity) return null;
  return {
    box: {
      x: best.x / frame.width,
      y: best.y / frame.height,
      width: tw / frame.width,
      height: th / frame.height,
    },
    score: best.score,
  };
}

/** Start following from a SAM-confirmed box. Null when the patch can't be followed. */
export function startLocalTrack(
  frame: LumaFrame,
  box: UnitBox,
  inside: boolean,
): LocalTrack | null {
  const template = cutTemplate(frame, box);
  return template ? { template, box, score: 1, inside, lostSteps: 0, crossingSteps: 0 } : null;
}

const inZone = (b: UnitBox, zone: UnitBox) =>
  b.x >= zone.x &&
  b.y >= zone.y &&
  b.x + b.width <= zone.x + zone.width &&
  b.y + b.height <= zone.y + zone.height;

/**
 * One local step. `follow` needs no model call. `reanchor` means the match has
 * been weak for `lostSteps` frames in a row; `confirm` means the box has sat on
 * the other side of the zone boundary for `settleSteps` frames. Both call for
 * SAM, after which the caller starts a fresh track from its answer. Leaving
 * the zone is confirmed too, so the server knows the next entry is an entry.
 */
export function stepLocalTrack(
  track: LocalTrack,
  frame: LumaFrame,
  zone: UnitBox | null,
  { settleSteps = 3, lostSteps = 3 } = {},
): { track: LocalTrack; verdict: LocalVerdict } {
  const match = matchTemplate(frame, track.template, track.box);
  if (!match || match.score < LOCAL_TRACK.lostScore) {
    const next = {
      ...track,
      score: match?.score ?? 0,
      lostSteps: track.lostSteps + 1,
      crossingSteps: 0,
    };
    return { track: next, verdict: next.lostSteps >= lostSteps ? 'reanchor' : 'follow' };
  }
  const crossed = zone !== null && inZone(match.box, zone) !== track.inside;
  const next = {
    ...track,
    box: match.box,
    score: match.score,
    lostSteps: 0,
    crossingSteps: crossed ? track.crossingSteps + 1 : 0,
  };
  return { track: next, verdict: next.crossingSteps >= settleSteps ? 'confirm' : 'follow' };
}
