import { afterEach, describe, expect, it } from 'bun:test';
import {
  startLocalTrack,
  watchFrame,
  watchThing,
  type LumaFrame,
  type UnitBox,
  type WatchThing,
} from '@livinglayer/domain';
import { VisionTracker } from '../apps/server/src/vision-tracker.js';

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
const at = (t: WatchThing | undefined) => ({
  x: Math.round(t!.track.box.x * W),
  y: Math.round(t!.track.box.y * H),
});

describe('steering the local match with a hint', () => {
  const start = scene([{ x: 20, y: 20, seed: 7 }]);
  const mug = thing('mug', 20, 20, start);

  it('follows a thing moved past the search to where the hint saw it', () => {
    const moved = scene([{ x: 130, y: 70, seed: 7 }]);
    const unsteered = watchFrame([mug], moved, 10_000).get('mug')!.thing;
    expect(unsteered.track.lostSteps).toBe(1);
    const steered = watchFrame(
      [mug],
      moved,
      10_000,
      {},
      new Set(),
      new Map([['mug', box(127, 68)]]),
    );
    expect(steered.get('mug')!.thing.status).toBe('following');
    expect(at(steered.get('mug')!.thing)).toEqual({ x: 130, y: 70 });
  });

  it('finds it by the usual search when the hint is somewhere else', () => {
    const moved = scene([{ x: 24, y: 22, seed: 7 }]);
    const steps = watchFrame([mug], moved, 10_000, {}, new Set(), new Map([['mug', box(120, 60)]]));
    expect(at(steps.get('mug')!.thing)).toEqual({ x: 24, y: 22 });
  });

  it("doesn't take a look-alike followed elsewhere when the hint points at it", () => {
    const both = [
      { x: 20, y: 20, seed: 7 },
      { x: 110, y: 60, seed: 7 },
    ];
    const first = scene(both);
    const things = [thing('mug', 20, 20, first), thing('twin', 110, 60, first)];
    const moved = scene([{ x: 26, y: 22, seed: 7 }, both[1]!]);
    const steps = watchFrame(
      things,
      moved,
      10_000,
      {},
      new Set(),
      new Map([['mug', box(110, 60)]]),
    );
    expect(at(steps.get('mug')!.thing)).toEqual({ x: 26, y: 22 });
    expect(at(steps.get('twin')!.thing)).toEqual({ x: 110, y: 60 });
  });
});

/** Answers each request with every box moved right by the frame's first pixel / 100; `unsure` is barely seen. */
const ECHO = `
let buf = Buffer.alloc(0), header = null;
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (!header) {
      const end = buf.indexOf(10);
      if (end < 0) return;
      header = JSON.parse(buf.subarray(0, end).toString());
      buf = buf.subarray(end + 1);
    }
    const n = header.width * header.height;
    if (buf.length < n) return;
    const first = buf[0];
    buf = buf.subarray(n);
    const boxes = {};
    for (const t of header.things)
      boxes[t.id] = [t.box[0] + first / 100, t.box[1], t.box[2], t.box[3], t.id === 'unsure' ? 0.1 : 0.9];
    process.stdout.write(JSON.stringify({ boxes, ms: 0 }) + '\\n');
    header = null;
  }
});`;

describe('the Vision helper', () => {
  let helper: VisionTracker | null = null;
  afterEach(() => helper?.close());
  const frame = (first: number): LumaFrame => {
    const data = new Uint8Array(W * H);
    data[0] = first;
    return { width: W, height: H, data };
  };

  it("passes on where it saw each thing in the frame sent, leaving out what it isn't sure of", async () => {
    helper = VisionTracker.spawn([process.execPath, '-e', ECHO]);
    const boxes = new Map([
      ['mug', box(20, 20)],
      ['unsure', box(80, 40)],
    ]);
    const first = await helper.step(frame(10), boxes);
    expect([...first.keys()]).toEqual(['mug']);
    expect(first.get('mug')!.x).toBeCloseTo(20 / W + 0.1);
    const second = await helper.step(frame(20), boxes);
    expect(second.get('mug')!.x).toBeCloseTo(20 / W + 0.2);
  });

  it('goes on without boxes when it stops answering', async () => {
    helper = VisionTracker.spawn([process.execPath, '-e', 'process.stdin.resume()']);
    const started = performance.now();
    expect((await helper.step(frame(10), new Map([['mug', box(20, 20)]]))).size).toBe(0);
    expect((await helper.step(frame(10), new Map([['mug', box(20, 20)]]))).size).toBe(0);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
