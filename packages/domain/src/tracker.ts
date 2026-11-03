/**
 * Local tracking between model calls. After SAM has found the mug once, its
 * pixels become a template, and each new frame is searched for the best match
 * near the last box by normalized cross-correlation. Nothing leaves the
 * browser. SAM is only asked again when the match gets weak or ambiguous
 * (re-anchor) or the box crosses the zone boundary (confirm), since the lamp
 * must never fire on a local guess, and only once the scene around the mug
 * has gone still: picking the mug up always breaks the match for a moment,
 * and a hand-blurred frame is a poor one to spend a SAM call on.
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
/**
 * The pixels to match, as a sparse list so a mask can leave out the
 * background. Offsets are relative to the template's top-left corner.
 */
interface Template {
  width: number;
  height: number;
  rows: Int32Array;
  cols: Int32Array;
  /** Pixels minus their mean, so matching ignores overall brightness. */
  values: Float32Array;
  norm: number;
  /** Whether a SAM mask chose the pixels, rather than the whole box. */
  masked: boolean;
}
export type LocalVerdict = 'follow' | 'reanchor' | 'confirm';
interface LocalMatch {
  box: UnitBox;
  score: number;
  /**
   * How far the best match leads the best one elsewhere in the search. Near
   * zero means two places look like the mug, as a white mug beside a white
   * shirt can, and neither should be trusted.
   */
  lead: number;
}
export interface LocalTrack {
  /** Cut from the last SAM-confirmed frame, never from a local guess, so it can't drift. */
  template: Template;
  box: UnitBox;
  score: number;
  lead: number;
  /** The last verdict SAM confirmed. */
  inside: boolean;
  /** Consecutive weak or ambiguous matches; the box holds still meanwhile. */
  lostSteps: number;
  /** Consecutive matches on the other side of the zone boundary from `inside`. */
  crossingSteps: number;
  /** The frame the last step saw, to measure motion against. */
  previous: LumaFrame;
  /** Share of pixels around the mug that changed in the last step, 0–1. */
  motion: number;
  /** Consecutive steps with the area around the mug still. */
  stillSteps: number;
  /**
   * How far the box moved per step lately, as shares of the frame: the search
   * starts where that puts it, so a thing being carried is looked for ahead of
   * its last box. An alpha–beta filter, the steady state of a constant-velocity
   * Kalman filter; on a still desk it stays at zero.
   */
  velocity: { x: number; y: number };
}
export const LOCAL_TRACK = {
  /** Below this correlation the match is treated as lost. */
  lostScore: 0.6,
  /** Below this lead over the runner-up the match is treated as ambiguous. */
  minLead: 0.1,
  /** How far from the last box to search, as a share of the frame. Grows while lost. */
  searchRadius: 0.25,
  /** Score taken off per search radius of distance, so a near match beats an equal far one. */
  distancePenalty: 0.08,
  /** Smallest template side, in luma pixels. */
  minSide: 6,
  /** Templates are thinned to about this many pixels to keep each step cheap. */
  maxPoints: 900,
  /** A pixel has changed when its luma moves by more than this, as in the playground's gate. */
  pixelDelta: 24,
  /** The area around the mug is moving when more than this share of it changed, as in the playground. */
  motionShare: 0.015,
  /**
   * A place overlapping another followed thing's box at least this much (IoU)
   * belongs to that thing, so a search doesn't settle there.
   */
  claimIoU: 0.3,
  /** How much of each step's surprise goes into the velocity. */
  velocityGain: 0.4,
  /** How much velocity a lost step keeps, so a guess ahead fades rather than runs off. */
  velocityKeep: 0.5,
};

/** The box moved on by the track's velocity, kept inside the frame. */
function predicted(track: Pick<LocalTrack, 'box' | 'velocity'>): UnitBox {
  const { box, velocity } = track;
  return {
    ...box,
    x: Math.min(1 - box.width, Math.max(0, box.x + velocity.x)),
    y: Math.min(1 - box.height, Math.max(0, box.y + velocity.y)),
  };
}

/** Intersection over union of two boxes, 0–1. */
export function boxIoU(a: UnitBox, b: UnitBox): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/**
 * Share of pixels within `region` that changed between two frames, 0–1. A
 * size change counts as all motion. The region keeps someone typing at the
 * other end of the desk from holding back a check the mug needs.
 */
export function frameMotion(a: LumaFrame, b: LumaFrame, region: UnitBox): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const r = pixelRect(b, region);
  if (r.width <= 0 || r.height <= 0) return 0;
  let changed = 0;
  for (let y = r.y; y < r.y + r.height; y++)
    for (let x = r.x; x < r.x + r.width; x++) {
      const k = y * b.width + x;
      if (Math.abs(a.data[k]! - b.data[k]!) > LOCAL_TRACK.pixelDelta) changed++;
    }
  return changed / (r.width * r.height);
}
/** The box grown by its own size on every side, clamped to the frame: where a hand reaching for the mug shows up. */
export const around = (b: UnitBox): UnitBox => {
  const x = Math.max(0, b.x - b.width);
  const y = Math.max(0, b.y - b.height);
  return {
    x,
    y,
    width: Math.min(1, b.x + 2 * b.width) - x,
    height: Math.min(1, b.y + 2 * b.height) - y,
  };
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

/**
 * The template under `box`, or null when it is too small or too plain to
 * match reliably. `mask` is frame-sized, 1 on the object: with it, only the
 * mug's own pixels are matched, so it can move onto a different surface (a
 * white shirt, say) without the old background in its template pulling the
 * score down. Its outline is deliberately left out for the same reason. A
 * mask too plain to match (a white mug with no shading) falls back to the
 * whole box.
 */
export function cutTemplate(frame: LumaFrame, box: UnitBox, mask?: Uint8Array): Template | null {
  const r = pixelRect(frame, box);
  if (r.width < LOCAL_TRACK.minSide || r.height < LOCAL_TRACK.minSide) return null;
  if (mask) {
    const masked = build(frame, r, (i, j) => mask[(r.y + j) * frame.width + r.x + i] === 1);
    if (masked) return { ...masked, masked: true };
  }
  const whole = build(frame, r, () => true);
  return whole && { ...whole, masked: false };
}

function build(
  frame: LumaFrame,
  r: ReturnType<typeof pixelRect>,
  keep: (i: number, j: number) => boolean,
): Omit<Template, 'masked'> | null {
  const picked: number[] = [];
  for (let j = 0; j < r.height; j++)
    for (let i = 0; i < r.width; i++) if (keep(i, j)) picked.push(j * r.width + i);
  // Too few pixels for a mug-sized shape to be told apart from noise.
  if (picked.length < LOCAL_TRACK.minSide ** 2) return null;
  const stride = Math.max(1, picked.length / LOCAL_TRACK.maxPoints);
  const count = Math.floor(picked.length / stride);
  const rows = new Int32Array(count);
  const cols = new Int32Array(count);
  const values = new Float32Array(count);
  let sum = 0;
  for (let k = 0; k < count; k++) {
    const p = picked[Math.floor(k * stride)]!;
    rows[k] = Math.floor(p / r.width);
    cols[k] = p % r.width;
    values[k] = frame.data[(r.y + rows[k]!) * frame.width + r.x + cols[k]!]!;
    sum += values[k]!;
  }
  const mean = sum / count;
  let squares = 0;
  for (let k = 0; k < count; k++) {
    values[k]! -= mean;
    squares += values[k]! ** 2;
  }
  const norm = Math.sqrt(squares);
  // Under ~2 grey levels of spread there is nothing to lock onto.
  if (norm / Math.sqrt(count) < 2) return null;
  return { width: r.width, height: r.height, rows, cols, values, norm };
}

/**
 * Find the template near `near`. Returns the best-correlated box, its score
 * (-1 to 1) and its lead over the best match away from it, or null when the
 * template no longer fits the frame. Places on an `exclude` box (other
 * things' boxes) are neither a match nor a runner-up: a look-alike already
 * followed there is that thing, not a rival.
 */
export function matchTemplate(
  frame: LumaFrame,
  template: Template,
  near: UnitBox,
  radius = LOCAL_TRACK.searchRadius,
  exclude: UnitBox[] = [],
): LocalMatch | null {
  const { width: tw, height: th, rows, cols, values, norm } = template;
  if (tw > frame.width || th > frame.height) return null;
  const start = pixelRect(frame, near);
  const rx = Math.ceil(radius * frame.width);
  const ry = Math.ceil(radius * frame.height);
  const x0 = Math.max(0, start.x - rx);
  const y0 = Math.max(0, start.y - ry);
  const x1 = Math.min(frame.width - tw, start.x + rx);
  const y1 = Math.min(frame.height - th, start.y + ry);
  if (x1 < x0 || y1 < y0) return null;
  const n = values.length;
  const reach = Math.max(rx, ry, 1);
  const ranked = new Float32Array((x1 - x0 + 1) * (y1 - y0 + 1)).fill(-Infinity);
  const scores = new Float32Array(ranked.length);
  let best = -1;
  // Only boxes reaching into the searched area can claim a place in it.
  const taken = exclude
    .map((e) => pixelRect(frame, e))
    .filter((e) => e.x < x1 + tw && e.x + e.width > x0 && e.y < y1 + th && e.y + e.height > y0);
  const claimed = (x: number, y: number) =>
    taken.some((e) => {
      const w = Math.min(x + tw, e.x + e.width) - Math.max(x, e.x);
      const h = Math.min(y + th, e.y + e.height) - Math.max(y, e.y);
      return (
        w > 0 && h > 0 && (w * h) / (tw * th + e.width * e.height - w * h) >= LOCAL_TRACK.claimIoU
      );
    });
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (taken.length && claimed(x, y)) continue;
      let dot = 0;
      let sum = 0;
      let squares = 0;
      for (let k = 0; k < n; k++) {
        const f = frame.data[(y + rows[k]!) * frame.width + x + cols[k]!]!;
        // The template is zero-mean, so the window's mean drops out of the numerator.
        dot += values[k]! * f;
        sum += f;
        squares += f * f;
      }
      const spread = squares - (sum * sum) / n;
      if (spread <= 1e-6) continue;
      const k = (y - y0) * (x1 - x0 + 1) + x - x0;
      scores[k] = dot / (norm * Math.sqrt(spread));
      ranked[k] =
        scores[k]! - (LOCAL_TRACK.distancePenalty * Math.hypot(x - start.x, y - start.y)) / reach;
      if (best < 0 || ranked[k]! > ranked[best]!) best = k;
    }
  if (best < 0) return null;
  const bx = x0 + (best % (x1 - x0 + 1));
  const by = y0 + Math.floor(best / (x1 - x0 + 1));
  // The runner-up must be a separate place, not the best match nudged by a pixel or two.
  let second = -Infinity;
  for (let k = 0; k < ranked.length; k++) {
    const x = x0 + (k % (x1 - x0 + 1));
    const y = y0 + Math.floor(k / (x1 - x0 + 1));
    if (Math.abs(x - bx) * 2 < tw && Math.abs(y - by) * 2 < th) continue;
    if (ranked[k]! > second) second = ranked[k]!;
  }
  return {
    box: {
      x: bx / frame.width,
      y: by / frame.height,
      width: tw / frame.width,
      height: th / frame.height,
    },
    score: scores[best]!,
    lead: second === -Infinity ? 1 : ranked[best]! - second,
  };
}

/** Start following from a SAM-confirmed box and, ideally, its mask. Null when the patch can't be followed. */
export function startLocalTrack(
  frame: LumaFrame,
  box: UnitBox,
  inside: boolean,
  mask?: Uint8Array,
): LocalTrack | null {
  const template = cutTemplate(frame, box, mask);
  return template
    ? {
        template,
        box,
        score: 1,
        lead: 1,
        inside,
        lostSteps: 0,
        crossingSteps: 0,
        previous: frame,
        motion: 0,
        stillSteps: 0,
        velocity: { x: 0, y: 0 },
      }
    : null;
}

const inZone = (b: UnitBox, zone: UnitBox) =>
  b.x >= zone.x &&
  b.y >= zone.y &&
  b.x + b.width <= zone.x + zone.width &&
  b.y + b.height <= zone.y + zone.height;

/**
 * One local step. `follow` needs no model call. `reanchor` means the match has
 * been weak or ambiguous for `lostSteps` frames in a row; the box holds still
 * meanwhile rather than chase a look-alike, and the search widens each step so
 * a mug that moved fast can still be found. `confirm` means the box has sat on
 * the other side of the zone boundary for `settleSteps` frames. Both call for
 * SAM, after which the caller starts a fresh track from its answer. Leaving
 * the zone is confirmed too, so the server knows the next entry is an entry.
 *
 * Neither is asked for until the area around the mug has been still for
 * `quietSteps` frames. A mug being carried is usually lost and often crossing
 * the zone; once it is set down the widened search mostly finds it again by
 * itself, and SAM is only needed if it doesn't.
 */
export function stepLocalTrack(
  track: LocalTrack,
  frame: LumaFrame,
  zone: UnitBox | null,
  { settleSteps = 3, lostSteps = 3, quietSteps = 8, exclude = [] as UnitBox[] } = {},
): { track: LocalTrack; verdict: LocalVerdict } {
  const motion = frameMotion(track.previous, frame, around(track.box));
  const still = {
    previous: frame,
    motion,
    stillSteps: motion > LOCAL_TRACK.motionShare ? 0 : track.stillSteps + 1,
  };
  const settled = still.stillSteps >= quietSteps;
  const radius = Math.min(1, LOCAL_TRACK.searchRadius * (1 + track.lostSteps));
  const ahead = predicted(track);
  const match = matchTemplate(frame, track.template, ahead, radius, exclude);
  if (!match || match.score < LOCAL_TRACK.lostScore || match.lead < LOCAL_TRACK.minLead) {
    const keep = LOCAL_TRACK.velocityKeep;
    const next = {
      ...track,
      ...still,
      score: match?.score ?? 0,
      lead: match?.lead ?? 0,
      lostSteps: track.lostSteps + 1,
      crossingSteps: 0,
      velocity: { x: track.velocity.x * keep, y: track.velocity.y * keep },
    };
    return {
      track: next,
      verdict: next.lostSteps >= lostSteps && settled ? 'reanchor' : 'follow',
    };
  }
  const crossed = zone !== null && inZone(match.box, zone) !== track.inside;
  const gain = LOCAL_TRACK.velocityGain;
  const next = {
    ...track,
    ...still,
    velocity: {
      x: track.velocity.x + gain * (match.box.x - ahead.x),
      y: track.velocity.y + gain * (match.box.y - ahead.y),
    },
    box: match.box,
    score: match.score,
    lead: match.lead,
    lostSteps: 0,
    crossingSteps: crossed ? track.crossingSteps + 1 : 0,
  };
  return {
    track: next,
    verdict: next.crossingSteps >= settleSteps && settled ? 'confirm' : 'follow',
  };
}
