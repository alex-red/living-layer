import { describe, expect, it } from 'bun:test';
import {
  assignTracks,
  boxIoU,
  missed,
  outlineIn,
  pickTracked,
  selectionMask,
  startLocalTrack,
  stepLocalTrack,
  watchFrame,
  watchStep,
  watchThing,
  MULTI,
  WATCH,
  type Detection,
  type LumaFrame,
  type UnitBox,
  type WatchThing,
} from '@livinglayer/domain';

const W = 160;
const H = 100;
function noise(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s >>> 24;
  };
}
/** A noisy desk with a 12×14 thing at each spot, each with its own texture seed. */
function scene(things: { x: number; y: number; seed: number }[]): LumaFrame {
  const desk = noise(1);
  const data = new Uint8Array(W * H);
  for (let i = 0; i < data.length; i++) data[i] = 60 + (desk() >> 2);
  for (const t of things) {
    const texture = noise(t.seed);
    for (let j = 0; j < 14; j++)
      for (let i = 0; i < 12; i++) data[(t.y + j) * W + t.x + i] = 120 + (texture() >> 1);
  }
  return { width: W, height: H, data };
}
const box = (x: number, y: number): UnitBox => ({
  x: x / W,
  y: y / H,
  width: 12 / W,
  height: 14 / H,
});
function thing(id: string, x: number, y: number, frame: LumaFrame): WatchThing {
  return watchThing(
    { id, kind: 'object', label: id, concept: 'mug', zones: [] },
    startLocalTrack(frame, box(x, y), false)!,
    0,
  );
}
/** Steps every thing through the frames together, 100 ms apart. */
function play(things: WatchThing[], frames: LumaFrame[], from = 10_000) {
  let now = from;
  let current = things;
  for (const f of frames) {
    const steps = watchFrame(current, f, now, { quietSteps: 2 });
    current = current.map((t) => steps.get(t.subject.id)?.thing ?? t);
    now += 100;
  }
  return new Map(current.map((t) => [t.subject.id, t]));
}

describe('outlining a thing on this machine', () => {
  /** A grey, slightly noisy desk with a red 20×16 block on it. */
  function picture() {
    const width = 80;
    const height = 60;
    const data = new Uint8Array(width * height * 3);
    const n = noise(3);
    for (let p = 0; p < width * height; p++) {
      const g = 110 + (n() >> 4);
      data.set([g, g, g], p * 3);
    }
    for (let y = 20; y < 36; y++)
      for (let x = 30; x < 50; x++) data.set([200, 40, 30], (y * width + x) * 3);
    return { width, height, data };
  }
  it('keeps what stands out from around the box, and falls back to the box when nothing does', () => {
    const image = picture();
    const frame = { width: image.width, height: image.height };
    // A loose box around the block, in thousandths of the frame.
    const shape = selectionMask(
      { kind: 'rect', box: { x1: 300, y1: 250, x2: 700, y2: 700 } },
      frame,
    );
    const found = outlineIn(image, shape)!;
    expect(found.fallback).toBe(false);
    let hit = 0;
    let extra = 0;
    for (let y = 0; y < frame.height; y++)
      for (let x = 0; x < frame.width; x++) {
        const on = found.bits.data[y * frame.width + x] === 1;
        const block = x >= 30 && x < 50 && y >= 20 && y < 36;
        if (on && block) hit++;
        else if (on) extra++;
      }
    expect(hit / (20 * 16)).toBeGreaterThan(0.9);
    expect(extra).toBeLessThan(20);
    // Drawn on bare desk: nothing stands out, so the shape is the outline.
    const bare = selectionMask({ kind: 'rect', box: { x1: 20, y1: 20, x2: 250, y2: 250 } }, frame);
    expect(outlineIn(image, bare)).toMatchObject({ fallback: true, share: 1 });
  });
});

describe('assigning candidates to things together', () => {
  it('gives each its best overall, says how sure, and lets a far one go without', () => {
    // Thing 0 slightly prefers candidate 0, but thing 1 needs it much more.
    const a = assignTracks([
      [0.1, 0.2],
      [0.15, 0.9],
    ]);
    expect(a.pick).toEqual([1, 0]);
    expect(a.margins[0]!).toBeCloseTo(0.65);
    // Two look-alikes: either way costs the same, so neither is sure.
    const twins = assignTracks([
      [0.3, 0.3],
      [0.3, 0.3],
    ]);
    expect(Math.max(...twins.margins.map((m) => m!))).toBeLessThan(MULTI.minMargin);
    // Nothing close enough: going without is cheaper.
    expect(assignTracks([[5]]).pick).toEqual([null]);
    expect(assignTracks([[Infinity, 0.4]]).pick).toEqual([1]);
  });
  it('never gives a thing its look-alike’s detection', () => {
    const frame = { width: 100, height: 100 };
    const det = (objectId: string, x: number): Detection => ({
      objectId,
      confidence: 0.9,
      box: { x, y: 10, width: 20, height: 20 },
      mask: { width: 1, height: 1, foregroundPixels: 1, svgPath: 'M0 0Z' },
    });
    const at = (x: number) => ({ box: { x, y: 10, width: 20, height: 20 }, frame });
    // Alone, a mug last seen between two detections takes the nearer one…
    expect(pickTracked([det('a', 10), det('b', 40)], frame, at(30))?.detection.objectId).toBe('b');
    // …but not when its look-alike was right there.
    const joint = pickTracked([det('a', 10), det('b', 40)], frame, at(30), [at(40)]);
    expect(joint?.detection.objectId).toBe('a');
    // One detection, and the look-alike is on it: nothing for this one.
    expect(pickTracked([det('b', 40)], frame, at(30), [at(40)])).toBeNull();
  });
});

describe('following several things at once', () => {
  it('learns how fast a carried thing moves, and forgets it once it is still', () => {
    const at = (x: number) => scene([{ x, y: 40, seed: 7 }]);
    let track = startLocalTrack(at(20), box(20, 40), false)!;
    for (let k = 1; k <= 6; k++) track = stepLocalTrack(track, at(20 + 4 * k), null).track;
    expect(track.velocity.x * W).toBeGreaterThan(2.5);
    expect(track.box.x * W).toBeCloseTo(44, 0);
    let t: WatchThing = { ...thing('mug', 44, 40, at(44)), track };
    for (let k = 0; k < 3; k++) t = watchStep(t, at(44), 20_000 + k * 100).thing;
    expect(t.track.velocity).toEqual({ x: 0, y: 0 });
  });
  it('entangles two look-alikes carried past each other, and keeps them so when their looks can’t tell', () => {
    const at = (ax: number, bx: number) =>
      scene([
        { x: ax, y: 40, seed: 7 },
        { x: bx, y: 40, seed: 7 },
      ]);
    const first = at(20, 100);
    const a = thing('a', 20, 40, first);
    const b = thing('b', 100, 40, first);
    // A is carried over towards B, then on beyond it.
    const carry = [30, 40, 50, 60, 70, 80].map((x) => at(x, 100));
    const close = play([a, b], carry);
    expect(close.get('a')!.status).toBe('entangled');
    expect(close.get('b')!.partner).toBe('a');
    const apart = play([...close.values()], Array(8).fill(at(60, 100)));
    // Alike to the pixel: still entangled, and no zone of either is judged meanwhile.
    expect(apart.get('a')!.status).toBe('entangled');
    expect(apart.get('b')!.status).toBe('entangled');
  });
  it('lets go of two that look different once they are apart, each where its own look is', () => {
    const at = (ax: number, bx: number) =>
      scene([
        { x: ax, y: 40, seed: 7 },
        { x: bx, y: 40, seed: 99 },
      ]);
    const first = at(20, 100);
    const a = thing('a', 20, 40, first);
    const b = thing('b', 100, 40, first);
    const close = play(
      [a, b],
      [30, 45, 60, 75, 85].map((x) => at(x, 100)),
    );
    expect(close.get('a')!.status).toBe('entangled');
    const apart = play([...close.values()], Array(8).fill(at(40, 100)));
    expect(apart.get('a')!.status).toBe('following');
    expect(apart.get('a')!.partner).toBeNull();
    expect(boxIoU(apart.get('a')!.track.box, box(40, 40))).toBeGreaterThan(0.7);
    expect(boxIoU(apart.get('b')!.track.box, box(100, 40))).toBeGreaterThan(0.7);
  });
  it('finds a missing thing put back elsewhere once the view changes, with no model call', () => {
    const gone = scene([]);
    let t = thing('mug', 20, 40, scene([{ x: 20, y: 40, seed: 7 }]));
    for (let k = 0; k < WATCH.maxMisses; k++) t = missed(t);
    expect(t.status).toBe('missing');
    t = { ...t, track: { ...t.track, previous: gone } };
    // Put back far from where it was: nothing moved there, but the view changed.
    const back = scene([{ x: 120, y: 60, seed: 7 }]);
    const soon = watchStep({ ...t, lastAsk: 1000 }, back, 2000);
    expect(soon.thing.status).toBe('missing');
    const later = watchStep({ ...t, lastAsk: 1000 }, back, 1000 + WATCH.missingLookMs);
    expect(later.ask).toBeNull();
    expect(later.thing.status).toBe('following');
    expect(boxIoU(later.thing.track.box, box(120, 60))).toBeGreaterThan(0.7);
  });
});
