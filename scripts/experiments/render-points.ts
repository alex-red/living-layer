/**
 * Points for SAM from a room's draft: each thing's drawing through the
 * calibrated camera, slid to where the first pass's mask puts it, gives
 * positive points well inside it (its feet and middle) and negative points
 * just outside it (what touches it). See render-prompts.ts.
 */
import type { PromptPoint } from '@meta-sam/parser';
import {
  floorSolid,
  promptBox,
  renderRoom,
  sceneSolids,
  thingSolids,
  type PhotoDraft,
  type PlacedThing,
} from '@livinglayer/domain';
import { layOutInput, layoutInput } from '../lib/rooms.js';
import { bitsOf, type Bits } from './lib.js';

/** How far inside its drawing a positive point sits, and how far outside a negative one: the drawing is only roughly where the thing is. */
const INSET = 6;
/** Negative points go no further than this from the thing's drawing: what touches it is what SAM confuses with it. */
const NEAR = 40;
/** A thing drawn as a box gets positive points only when it is this small (pixels): then a box is its shape. */
const SMALL = 2500;
/** How far a thing's drawing may slide to meet the first pass's mask, in pixels. */
const REACH = 40;

export interface PointOptions {
  /** Positive points on things the catalogue draws, or small ones. */
  positives?: boolean;
  /** Negative points on what is drawn just outside a thing. */
  negatives?: boolean;
}

/** Chamfer distance from each pixel to the nearest pixel where `inside` differs from it. */
function distance(inside: Uint8Array, w: number, h: number) {
  const far = 1e6;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = far;
  // Distance to the nearest pixel of the other kind: seed on the boundary.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = inside[i];
      if (
        (x > 0 && inside[i - 1] !== v) ||
        (x < w - 1 && inside[i + 1] !== v) ||
        (y > 0 && inside[i - w] !== v) ||
        (y < h - 1 && inside[i + w] !== v)
      )
        d[i] = 0;
    }
  const step = (i: number, j: number, c: number) => {
    if (inside[i] === inside[j] && d[j]! + c < d[i]!) d[i] = d[j]! + c;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) step(i, i - 1, 1);
      if (y > 0) step(i, i - w, 1);
      if (x > 0 && y > 0) step(i, i - w - 1, 1.4);
      if (x < w - 1 && y > 0) step(i, i - w + 1, 1.4);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) step(i, i + 1, 1);
      if (y < h - 1) step(i, i + w, 1);
      if (x < w - 1 && y < h - 1) step(i, i + w + 1, 1.4);
      if (x > 0 && y < h - 1) step(i, i + w - 1, 1.4);
    }
  return d;
}

/** Up to `n` of `candidates`, spread out: each the furthest from those already chosen. */
function spread(candidates: number[], n: number, w: number, first?: number) {
  if (!candidates.length) return [];
  const chosen = [first ?? candidates[0]!];
  while (chosen.length < n) {
    let best = -1;
    let bestD = 0;
    for (const c of candidates) {
      const d = Math.min(
        ...chosen.map((k) => Math.hypot((c % w) - (k % w), Math.floor(c / w) - Math.floor(k / w))),
      );
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best < 0 || bestD < 2 * INSET) break;
    chosen.push(best);
  }
  return chosen;
}

/** The points for each thing, from the draft's drawing through its camera. */
export function pointsFor(draft: PhotoDraft, options: PointOptions = {}) {
  const { positives = true, negatives = true } = options;
  const first = layOutInput(layoutInput(draft));
  const { camera } = first.calibration;
  const { width: w, height: h } = camera.frame;
  const objects = first.layout.things.filter((t) => t.status === 'object');
  const picture = renderRoom(
    camera,
    [
      floorSolid(first.layout.scene.grid),
      ...sceneSolids(first.layout.scene),
      ...thingSolids(objects),
    ],
    { labels: true },
  );
  const drawnAs = (t: PlacedThing) => t.group ?? (t.status === 'object' ? t.id : null);
  const result = new Map<
    string,
    { box: NonNullable<ReturnType<typeof promptBox>>; points: PromptPoint[]; drawn: Bits | null }
  >();
  const shifts: string[] = [];
  for (const t of first.layout.things) {
    const box = promptBox(t, camera.frame);
    if (!box || !draft.detections[t.id]) continue;
    const k = drawnAs(t) ? picture.names.indexOf(drawnAs(t)!) : -1;
    if (k < 0) {
      result.set(t.id, { box, points: [], drawn: null });
      continue;
    }
    let own = new Uint8Array(w * h);
    for (let i = 0; i < own.length; i++) if (picture.ids[i] === k) own[i] = 1;
    // The drawing is where the first layout put the thing, which can be off by a few tens of
    // pixels: slide it to where the first pass's mask puts it, so its shape comes from the
    // model and its place from the photo.
    const before = bitsOf(draft.segmentation, draft.detections[t.id]);
    let shift = { dx: 0, dy: 0 };
    if (before) {
      const lit: number[] = [];
      for (let i = 0; i < own.length; i += 2) if (own[i]) lit.push(i);
      const overlap = (dx: number, dy: number) => {
        let n = 0;
        for (const i of lit) {
          const x = (i % w) + dx;
          const y = Math.floor(i / w) + dy;
          if (x >= 0 && y >= 0 && x < w && y < h && before.data[y * w + x]) n++;
        }
        return n;
      };
      let best = overlap(0, 0);
      for (let dy = -REACH; dy <= REACH; dy += 2)
        for (let dx = -REACH; dx <= REACH; dx += 2) {
          const n = overlap(dx, dy);
          if (n > best * 1.05) {
            best = n;
            shift = { dx, dy };
          }
        }
      if (shift.dx || shift.dy) {
        const moved = new Uint8Array(w * h);
        for (let i = 0; i < own.length; i++) {
          if (!own[i]) continue;
          const x = (i % w) + shift.dx;
          const y = Math.floor(i / w) + shift.dy;
          if (x >= 0 && y >= 0 && x < w && y < h) moved[y * w + x] = 1;
        }
        own = moved;
      }
    }
    shifts.push(`${t.id} ${shift.dx},${shift.dy}`);
    const size = own.reduce((s, v) => s + v, 0);
    if (!size) {
      result.set(t.id, { box, points: [], drawn: null });
      continue;
    }
    const d = distance(own, w, h);
    const points: PromptPoint[] = [];
    // Positive: its feet, the lowest well-inside pixel in each third of its width, and its middle.
    const shaped = positives && (!!t.group || size <= SMALL);
    if (shaped) {
      let x0 = w;
      let x1 = 0;
      for (let i = 0; i < own.length; i++)
        if (own[i]) {
          x0 = Math.min(x0, i % w);
          x1 = Math.max(x1, i % w);
        }
      for (let third = 0; third < 3; third++) {
        const lo = x0 + ((x1 - x0) * third) / 3;
        const hi = x0 + ((x1 - x0) * (third + 1)) / 3;
        let low = -1;
        for (let i = 0; i < own.length; i++)
          if (own[i] && d[i]! >= INSET && i % w >= lo && i % w < hi && i > low) low = i;
        if (low >= 0) points.push({ x: low % w, y: Math.floor(low / w) });
      }
      let middle = -1;
      for (let i = 0; i < own.length; i++)
        if (own[i] && (middle < 0 || d[i]! > d[middle]!)) middle = i;
      if (middle >= 0 && d[middle]! >= INSET)
        points.push({ x: middle % w, y: Math.floor(middle / w) });
    }
    // Negative: in its box, something else drawn close to it; inside its drawing's bounds first
    // (between legs, on its top), then around it.
    const candidates: number[] = [];
    let bx0 = w,
      by0 = h,
      bx1 = 0,
      by1 = 0;
    for (let i = 0; i < own.length; i++)
      if (own[i]) {
        bx0 = Math.min(bx0, i % w);
        bx1 = Math.max(bx1, i % w);
        by0 = Math.min(by0, Math.floor(i / w));
        by1 = Math.max(by1, Math.floor(i / w));
      }
    const within: number[] = [];
    for (let y = box.top; y < box.bottom; y++)
      for (let x = box.left; x < box.right; x++) {
        const i = y * w + x;
        if (own[i] || d[i]! < INSET || d[i]! > NEAR) continue;
        (x >= bx0 && x <= bx1 && y >= by0 && y <= by1 ? within : candidates).push(i);
      }
    const away = negatives ? spread(within.length ? within : candidates, 3, w) : [];
    for (const i of away) points.push({ x: i % w, y: Math.floor(i / w), label: 'negative' });
    const drawn = { width: w, height: h, data: own };
    result.set(t.id, { box, points, drawn });
  }
  return { first, result, shifts };
}
