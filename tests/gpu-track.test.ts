import { describe, expect, it } from 'bun:test';
import {
  GPU_TRACK,
  WATCH,
  gpuCorrections,
  gpuGiven,
  gpuHealth,
  gpuOverruled,
  gpuTrackerLine,
  boxIoU,
  startLocalTrack,
  watchFrame,
  watchStep,
  watchThing,
  type GpuSeen,
  type GpuTrackerView,
  type LumaFrame,
  type UnitBox,
  type WatchThing,
} from '@livinglayer/domain';
import { GpuTracker, type GpuTracks } from '../apps/server/src/gpu-tracker.js';

const W = 160;
const H = 100;
/** A desk with a textured 20×24 thing at (x, y). */
function scene(x: number, y: number): LumaFrame {
  const data = new Uint8Array(W * H).fill(70);
  let s = 7;
  for (let j = 0; j < 24; j++)
    for (let i = 0; i < 20; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      data[(y + j) * W + x + i] = 120 + (s >>> 25);
    }
  return { width: W, height: H, data };
}
const box = (x: number, y: number): UnitBox => ({
  x: x / W,
  y: y / H,
  width: 20 / W,
  height: 24 / H,
});
function thing(id: string, x = 30, y = 40, change: Partial<WatchThing> = {}): WatchThing {
  const subject = { id, kind: 'mug' as const, label: id, concept: 'mug', zones: [] };
  const made = watchThing(subject, startLocalTrack(scene(x, y), box(x, y), false)!, 0);
  return { ...made, ...change };
}
const resting = (t: WatchThing): WatchThing => ({
  ...t,
  track: { ...t.track, stillSteps: WATCH.quietSteps },
});
const sure = (id: string, b: UnitBox): GpuSeen => ({ id, seen: true, score: 0.95, box: b });
const none = new Map<string, number>();

describe('gpuCorrections', () => {
  it('starts a lost local track again where the GPU steadily sees it', () => {
    const lost = thing('mug', 30, 40, { status: 'unsure' });
    const there = box(100, 50);
    const fixes = gpuCorrections(
      [lost],
      [sure('mug', there)],
      new Map([['mug', there]]),
      new Set(),
      none,
      0,
    );
    expect(fixes.local).toEqual([{ id: 'mug', box: there }]);
  });

  it('leaves a local track alone where the GPU agrees with it', () => {
    const fixes = gpuCorrections(
      [thing('mug')],
      [sure('mug', box(31, 40))],
      new Map([['mug', box(31, 40)]]),
      new Set(),
      none,
      0,
    );
    expect(fixes).toEqual({ local: [], reseed: [] });
  });

  it('moves a local track that the GPU steadily sees elsewhere', () => {
    const there = box(110, 10);
    const fixes = gpuCorrections(
      [thing('mug')],
      [sure('mug', there)],
      new Map([['mug', there]]),
      new Set(),
      none,
      0,
    );
    expect(fixes.local).toEqual([{ id: 'mug', box: there }]);
  });

  it('waits for a GPU box to hold still before correcting with it', () => {
    const fixes = gpuCorrections(
      [thing('mug', 30, 40, { status: 'unsure' })],
      [sure('mug', box(100, 50))],
      new Map([['mug', box(60, 50)]]),
      new Set(),
      none,
      0,
    );
    expect(fixes.local).toEqual([]);
  });

  it('ignores a GPU box below the sure score', () => {
    const there = box(100, 50);
    const fixes = gpuCorrections(
      [thing('mug', 30, 40, { status: 'unsure' })],
      [{ id: 'mug', seen: true, score: GPU_TRACK.sureScore - 0.1, box: there }],
      new Map([['mug', there]]),
      new Set(),
      none,
      0,
    );
    expect(fixes.local).toEqual([]);
  });

  it('leaves alone a thing SAM or the whole-frame search is looking for', () => {
    const there = box(100, 50);
    const fixes = gpuCorrections(
      [thing('mug', 30, 40, { status: 'unsure' })],
      [sure('mug', there)],
      new Map([['mug', there]]),
      new Set(['mug']),
      none,
      0,
    );
    expect(fixes.local).toEqual([]);
  });

  it('trusts neither of two corrections onto one place', () => {
    const there = box(100, 50);
    const fixes = gpuCorrections(
      [thing('a', 30, 40, { status: 'unsure' }), thing('b', 10, 10, { status: 'unsure' })],
      [sure('a', there), sure('b', there)],
      new Map([
        ['a', there],
        ['b', there],
      ]),
      new Set(),
      none,
      0,
    );
    expect(fixes.local).toEqual([]);
  });

  it('hands a resting thing the GPU lost back to it at the local box, once per gap', () => {
    const mug = resting(thing('mug'));
    const lostOnGpu: GpuSeen[] = [{ id: 'mug', seen: false, score: 0 }];
    const first = gpuCorrections([mug], lostOnGpu, new Map(), new Set(), none, 50_000);
    expect(first.reseed).toEqual([{ id: 'mug', box: mug.track.box }]);
    const again = gpuCorrections(
      [mug],
      lostOnGpu,
      new Map(),
      new Set(),
      new Map([['mug', 50_000]]),
      50_000 + GPU_TRACK.reseedGapMs - 1,
    );
    expect(again.reseed).toEqual([]);
  });

  it('does not hand back a thing still moving on this machine', () => {
    const fixes = gpuCorrections(
      [thing('mug')],
      [{ id: 'mug', seen: false, score: 0 }],
      new Map(),
      new Set(),
      none,
      50_000,
    );
    expect(fixes.reseed).toEqual([]);
  });
});

describe('GpuTracker', () => {
  it('opens the camera on the node with the things, then passes on each result', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const result: GpuTracks & { type: string } = {
      type: 'tracks',
      seq: 3,
      ms: 31,
      things: [sure('mug', box(30, 40))],
    };
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({
        method: init?.method ?? 'GET',
        path,
        body: init?.body && JSON.parse(String(init.body)),
      });
      if (path === '/tracks')
        return new Response(`: idle\n\ndata: ${JSON.stringify(result)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      return Response.json({});
    };
    const gpu = new GpuTracker('http://gpu.test:43450', 'secret', fetcher);
    const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.5 };
    const got = await new Promise<GpuTracks>((done) =>
      gpu.start('rtsp://cam/ch0', crop, [{ id: 'mug', box: box(30, 40) }], done, () => {}),
    );
    gpu.stop();
    expect(got.things).toEqual(result.things);
    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/session',
      body: { source: 'rtsp://cam/ch0', crop, fps: 10, things: [{ id: 'mug', box: box(30, 40) }] },
    });
    expect(calls[1]?.path).toBe('/tracks');
  });
});

describe('GpuTracker, when the node fails', () => {
  const fast = { callMs: 50, stallMs: 80, retryMs: 10 };
  /** A node that takes requests and never answers, until the request is given up on. */
  const frozen = async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, fail) =>
      init?.signal?.addEventListener('abort', () => fail(new Error('aborted'))),
    );

  it('says a node that doesn’t answer is unavailable, instead of connecting forever', async () => {
    const gpu = new GpuTracker('http://gpu.test:43450', 'secret', frozen, fast);
    const note = await new Promise<string>((done) =>
      gpu.start(
        'rtsp://cam/ch0',
        null,
        [],
        () => {},
        (state, n) => state === 'error' && done(n),
      ),
    );
    gpu.stop();
    expect(note).toBe('The GPU tracker doesn’t answer.');
  });

  it('opens the camera again after its results stream went quiet', async () => {
    let sessions = 0;
    const quiet = async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new Error('aborted');
      const path = new URL(String(input)).pathname;
      if (path === '/session' && init?.method === 'PUT') sessions++;
      // Open and silent; given up on, it errors, as a real fetch's body does.
      if (path === '/tracks')
        return new Response(
          new ReadableStream({
            start(c) {
              init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
            },
          }),
        );
      return Response.json({});
    };
    const gpu = new GpuTracker('http://gpu.test:43450', 'secret', quiet, fast);
    gpu.start(
      'rtsp://cam/ch0',
      null,
      [],
      () => {},
      () => {},
    );
    for (let i = 0; i < 100 && sessions < 3; i++) await new Promise((r) => setTimeout(r, 10));
    gpu.stop();
    expect(sessions).toBeGreaterThanOrEqual(3);
  });
});

describe('gpuTrackerLine', () => {
  it('says how fast the GPU tracker follows and what it fixed', () => {
    expect(
      gpuTrackerLine({
        state: 'following',
        note: '',
        ms: 31.4,
        rate: 9.8,
        sinceMs: 200,
        placing: 1,
        fixes: 2,
        overruled: 0,
        reseeds: 0,
      }),
    ).toBe('GPU tracker 31 ms, 9.8/s · 2 fixed by GPU');
  });

  it('says why the GPU tracker is unavailable', () => {
    expect(
      gpuTrackerLine({
        state: 'error',
        note: 'connection refused',
        ms: null,
        rate: 0,
        sinceMs: null,
        placing: 0,
        fixes: 0,
        overruled: 0,
        reseeds: 0,
      }),
    ).toBe('GPU tracker unavailable: connection refused');
  });
});

describe('gpuHealth', () => {
  const healthy = {
    verdict: 'healthy' as const,
    reason: '10.4 fps · <1 ms a frame',
    fps: 10.4,
    wantFps: 10,
    workP50: 0.1,
    workP95: 1,
    budgetMs: 100,
    busy: 0.01,
    staleMs: 100,
    queued: 0,
    driftMs: null,
    cpu: null,
    ffmpegCpu: null,
    looking: 0,
    lost: 0,
    things: 1,
    recent: [0.1],
  };
  const gpu = (change: Partial<GpuTrackerView>): GpuTrackerView => ({
    state: 'following',
    note: '',
    ms: 16,
    rate: 1,
    sinceMs: 400,
    placing: 1,
    fixes: 0,
    overruled: 0,
    reseeds: 0,
    ...change,
  });

  it('waits, not healthy, while the GPU tracker connects', () => {
    expect(gpuHealth(healthy, gpu({ state: 'connecting', sinceMs: null }))).toMatchObject({
      verdict: 'waiting',
      reason: 'GPU tracker connecting',
    });
  });

  it('says the GPU tracker is unavailable, and that this machine follows meanwhile', () => {
    const h = gpuHealth(healthy, gpu({ state: 'error', note: 'The GPU tracker doesn’t answer.' }));
    expect(h.verdict).toBe('stalled');
    expect(h.reason).toBe(
      'GPU tracker unavailable, following on this machine: The GPU tracker doesn’t answer.',
    );
  });

  it('is behind when no GPU result came for longer than the node ever waits', () => {
    expect(gpuHealth(healthy, gpu({ sinceMs: GPU_TRACK.staleMs + 1000 }))).toMatchObject({
      verdict: 'lagging',
      reason: 'No GPU result for 6 s',
    });
  });

  it('keeps this machine’s verdict while GPU results arrive', () => {
    expect(gpuHealth(healthy, gpu({}))).toEqual(healthy);
  });

  it('keeps this machine’s stall first: without camera frames nothing else matters', () => {
    const stalled = { ...healthy, verdict: 'stalled' as const, reason: 'No frame for 4 s' };
    expect(gpuHealth(stalled, gpu({ state: 'connecting' }))).toEqual(stalled);
  });
});

describe('the GPU tracker’s boxes in each frame', () => {
  const zone = { x: 0.5, y: 0, width: 0.5, height: 1 };
  const inZone = (inside: boolean): WatchThing => {
    const t = thing('mug');
    return { ...t, subject: { ...t.subject, zones: [{ id: 'z', rect: zone, inside }] } };
  };

  it('takes the GPU’s box where the local match would lose it, with no search or ask', () => {
    // The thing moved far, past where the local match searches.
    const frame = scene(120, 60);
    const [step] = [
      ...watchFrame(
        [thing('mug')],
        frame,
        1000,
        {},
        new Set(),
        new Map(),
        new Map([['mug', box(120, 60)]]),
      ).values(),
    ];
    expect(step!.thing.track.box).toEqual(box(120, 60));
    expect(step!.thing).toMatchObject({ status: 'following', layer: 'gpu' });
    expect(step!.thing.track.lostSteps).toBe(0);
    expect(step).toMatchObject({ ask: null, refind: false });
  });

  it('still judges a zone the GPU’s box crossed, once it settles there', () => {
    let t = inZone(false);
    const frame = scene(120, 60);
    let placed = false;
    for (let i = 0; i < WATCH.settleSteps + WATCH.quietSteps + 2 && !placed; i++) {
      const step = watchStep(t, frame, 10_000 + i * 100, { given: box(120, 60) });
      t = step.thing;
      placed = step.place;
    }
    expect(placed).toBe(true);
  });

  it('follows a missing thing again where the GPU sees it', () => {
    const missing = thing('mug', 30, 40, { status: 'missing' });
    const step = watchStep(missing, scene(90, 20), 5000, { given: box(90, 20) });
    expect(step.thing).toMatchObject({ status: 'following', layer: 'gpu' });
    expect(step.thing.track.box).toEqual(box(90, 20));
  });

  it('gives only boxes fresh enough to stand in for the local match', () => {
    const seen = new Map([
      ['mug', { box: box(30, 40), at: 10_000 }],
      ['mouse', { box: box(90, 20), at: 10_000 - GPU_TRACK.freshMs - 1 }],
    ]);
    expect([...gpuGiven(seen, 10_000).keys()]).toEqual(['mug']);
  });
});

describe('gpuOverruled', () => {
  it('overrules a GPU box on the empty desk beside the thing, with where its own look is', () => {
    // The thing stands where it was confirmed; the GPU holds on to the desk beside it.
    const local = gpuOverruled(thing('mug'), scene(30, 40), box(60, 50));
    expect(local).not.toBeNull();
    expect(boxIoU(local!, box(30, 40))).toBeGreaterThan(0.8);
  });

  it('leaves a GPU box on the thing alone', () => {
    expect(gpuOverruled(thing('mug'), scene(32, 41), box(32, 41))).toBeNull();
  });

  it('lets the GPU stand where the thing’s own look is found nowhere surely', () => {
    const empty: LumaFrame = { width: W, height: H, data: new Uint8Array(W * H).fill(70) };
    expect(gpuOverruled(thing('mug'), empty, box(60, 50))).toBeNull();
  });
});
