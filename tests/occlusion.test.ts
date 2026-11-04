import { describe, expect, it } from 'bun:test';
import {
  startLocalTrack,
  stillCovered,
  visibleMatch,
  watchFrame,
  watchStep,
  watchThing,
  WATCH,
  type LumaFrame,
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
/** A textured w×h patch at (x, y), drawn over `data`. */
function patch(data: Uint8Array, seed: number, x: number, y: number, w: number, h: number) {
  const texture = noise(seed);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) data[(y + j) * W + x + i] = 120 + (texture() >> 1);
}
/** A noisy desk, a 20×24 coaster at (30, 40) unless taken, and a 24×32 mug at `mug`, in front. */
function desk({ coaster = true, mug = null as number | null, hand = null as number | null } = {}) {
  const grain = noise(1);
  const data = new Uint8Array(W * H);
  for (let i = 0; i < data.length; i++) data[i] = 60 + (grain() >> 2);
  if (coaster) patch(data, 7, 30, 40, 20, 24);
  if (mug !== null) patch(data, 11, mug, 44, 24, 32);
  // A hand nobody follows, over the coaster's left side.
  if (hand !== null) patch(data, 13, 30, 40, hand, 24);
  return { width: W, height: H, data } as LumaFrame;
}
const coasterBox = { x: 30 / W, y: 40 / H, width: 20 / W, height: 24 / H };
const mugBox = (x: number) => ({ x: x / W, y: 44 / H, width: 24 / W, height: 32 / H });
function thing(id: string, frame: LumaFrame, box: typeof coasterBox): WatchThing {
  const subject = { id, kind: 'fixture' as const, label: id, concept: id, zones: [] };
  return watchThing(subject, startLocalTrack(frame, box, false)!, 0);
}
/** The coaster and the mug, followed together, through `frames` at 100 ms a frame. */
function watch(frames: LumaFrame[], mugFrom = 100, coaster = thing('coaster', desk(), coasterBox)) {
  let things = [coaster, thing('mug', desk({ mug: mugFrom }), mugBox(mugFrom))];
  const seen: { status: string; ask: string | null }[] = [];
  frames.forEach((f, i) => {
    const steps = watchFrame(things, f, 10_000 + i * 100, { quietSteps: 0, placeGapMs: 0 });
    things = things.map((t) => steps.get(t.subject.id)?.thing ?? t);
    const c = steps.get('coaster')!;
    seen.push({ status: c.thing.status, ask: c.ask });
  });
  return { things, seen };
}
// The mug carried in from the right, a step at a time, to stand over the coaster's left side.
const carriedIn = [100, 80, 60, 40, 20].map((mug) => desk({ mug }));

describe('a thing partly behind another', () => {
  it('still matches where it shows when a thing in front hides the rest', () => {
    const coaster = thing('coaster', desk(), coasterBox);
    const seen = visibleMatch(desk({ mug: 20 }), coaster.track.template, coasterBox, [mugBox(20)]);
    expect(seen.hidden).toBeGreaterThan(0.4);
    expect(seen.showing).toBeGreaterThanOrEqual(0.25);
    expect(seen.score).toBeGreaterThan(0.9);
  });

  it('still matches where it shows at the size a coaster is across the room', () => {
    // About 120 points, as the real one is in the watcher's 320-wide frames.
    const small = (mug: boolean) => {
      const frame = desk({ coaster: false });
      patch(frame.data, 7, 30, 40, 15, 8);
      if (mug) patch(frame.data, 11, 24, 42, 10, 16);
      return frame;
    };
    const box = { x: 30 / W, y: 40 / H, width: 15 / W, height: 8 / H };
    const template = startLocalTrack(small(false), box, false)!.template;
    const cover = { x: 24 / W, y: 42 / H, width: 10 / W, height: 16 / H };
    expect(stillCovered(small(true), template, box, [cover])).toBe(true);
  });

  it('is not covered when what shows beside the thing in front is bare desk', () => {
    const coaster = thing('coaster', desk(), coasterBox);
    const frame = desk({ coaster: false, mug: 20 });
    expect(stillCovered(frame, coaster.track.template, coasterBox, [mugBox(20)])).toBe(false);
  });

  it('is covered, held where it was and asks nothing, while a followed mug stands in front', () => {
    const { things, seen } = watch([...carriedIn, ...Array(20).fill(desk({ mug: 20 }))]);
    const coaster = things.find((t) => t.subject.id === 'coaster')!;
    expect(seen.at(-1)!.status).toBe('covered');
    expect(seen.every((s) => s.ask === null && s.status !== 'missing')).toBe(true);
    expect(coaster.track.box).toEqual(coasterBox);
  });

  it('is followed again once the mug in front is taken away', () => {
    const away = [40, 60, 80, 100].map((mug) => desk({ mug }));
    const { seen } = watch([...carriedIn, ...away, desk({ mug: 100 })]);
    expect(seen.some((s) => s.status === 'covered')).toBe(true);
    expect(seen.at(-1)!.status).toBe('following');
  });

  it('is lost, not covered, when taken away from behind the mug', () => {
    const gone = Array(WATCH.lostSteps + 2).fill(desk({ coaster: false, mug: 20 }));
    const { seen } = watch([...carriedIn, ...gone]);
    expect(seen.at(-1)!.status).toBe('unsure');
  });

  it('is covered when an untracked hand hides a third of it', () => {
    const coaster = thing('coaster', desk(), coasterBox);
    const step = watchStep(coaster, desk({ hand: 8 }), 10_000, { quietSteps: 0 });
    expect(step.thing.status).not.toBe('unsure');
    expect(step.ask).toBeNull();
  });

  it('is not covered when an untracked hand hides most of it', () => {
    const coaster = thing('coaster', desk(), coasterBox);
    expect(stillCovered(desk({ hand: 16 }), coaster.track.template, coasterBox, [])).toBe(false);
  });

  it('comes back from missing when the part beside a mug in front matches', () => {
    const missing = { ...thing('coaster', desk(), coasterBox), status: 'missing' as const };
    const { seen } = watch([desk({ mug: 20 })], 20, missing);
    expect(seen[0]!.status).toBe('covered');
  });

  it('is covered while a mug in front hides nearly all of it', () => {
    const over = [desk({ mug: 28 }), ...Array(10).fill(desk({ mug: 28 }))];
    const { seen } = watch([...carriedIn, ...over]);
    expect(seen.at(-1)!.status).toBe('covered');
  });

  it('is not brought back from missing by a mug that hides where it was', () => {
    const missing = { ...thing('coaster', desk(), coasterBox), status: 'missing' as const };
    const bare = [100, 80, 60, 40, 28].map((mug) => desk({ coaster: false, mug }));
    const over = Array(WATCH.lostSteps + 3).fill(desk({ coaster: false, mug: 28 }));
    const { seen } = watch([...bare, ...over], 100, missing);
    expect(seen.some((s) => s.status === 'covered')).toBe(false);
  });

  it('stays missing when the mug stands where it was and the rest is bare desk', () => {
    const missing = { ...thing('coaster', desk(), coasterBox), status: 'missing' as const };
    const { seen } = watch([desk({ coaster: false, mug: 20 })], 20, missing);
    expect(seen[0]!.status).not.toBe('covered');
  });
});
