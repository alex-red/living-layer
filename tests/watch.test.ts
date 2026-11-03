import { describe, expect, it } from 'bun:test';
import { tempDir, testApp } from './lib/app.js';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Appearance, appearanceModelPath } from '../apps/server/src/appearance.js';
import { DemoSource, FfmpegSource, LUMA_WIDTH } from '../apps/server/src/frames.js';
import { demoSegmentation } from '../apps/server/src/demo.js';
import { watchersOf } from '../apps/server/src/app.js';
import {
  appearanceRegion,
  cropMask,
  findByAppearance,
  intoRegion,
  outOfRegion,
  searchRegion,
  appearanceSure,
  fixtureInFrame,
  mugItem,
  prototypeOf,
  sightingSpot,
  startLocalTrack,
  watchStep,
  watchThing,
  missed,
  asked,
  WATCH,
  DEMO_SURFACE,
  maskBits,
  patchWeights,
  type DeskMemory,
  type EvidenceRun,
  type LumaFrame,
  type PatchGrid,
  type Segmentation,
  type WatchSubject,
  type WatchThing,
  type WatchView,
  type ExposeView,
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
/** A noisy desk with a textured 20×24 thing at (x, y), or none. */
function scene(x: number | null, y = 0): LumaFrame {
  const desk = noise(1);
  const data = new Uint8Array(W * H);
  for (let i = 0; i < data.length; i++) data[i] = 60 + (desk() >> 2);
  if (x !== null) {
    const texture = noise(7);
    for (let j = 0; j < 24; j++)
      for (let i = 0; i < 20; i++) data[(y + j) * W + x + i] = 120 + (texture() >> 1);
  }
  return { width: W, height: H, data };
}
const box = (x: number, y: number) => ({ x: x / W, y: y / H, width: 20 / W, height: 24 / H });
const zone = { x: 0, y: 0, width: 0.5, height: 1 };
function start(inside = true): WatchThing {
  const subject: WatchSubject = {
    id: 'mug',
    kind: 'mug',
    label: 'Mug',
    concept: 'mug',
    zones: [{ id: 'z', rect: zone, inside }],
  };
  return watchThing(subject, startLocalTrack(scene(30, 40), box(30, 40), inside)!, 0);
}
/** Feed `frames` to `thing` at 100 ms a frame, collecting what each step asked for. */
function run(thing: WatchThing, frames: LumaFrame[], from = 10_000) {
  const asks: (string | null)[] = [];
  let refinds = 0;
  frames.forEach((f, i) => {
    const step = watchStep(thing, f, from + i * 100);
    // The watcher marks every ask it sends to SAM.
    thing = step.ask ? asked(step.thing, step.ask, from + i * 100) : step.thing;
    asks.push(step.ask);
    if (step.refind) refinds++;
  });
  return { thing, asks, refinds };
}

describe('watching one thing', () => {
  it('costs nothing while the thing stays put', () => {
    const r = run(start(), Array(20).fill(scene(30, 40)));
    expect(r.asks.every((a) => a === null)).toBe(true);
    expect(r.thing.status).toBe('following');
    expect(r.thing.layer).toBe('sam');
  });
  it('keeps a still thing’s box without matching, and matches it again once a second', () => {
    // Moved with no motion seen around it: as a thing creeping too slowly to count would.
    const moved = scene(36, 40);
    let thing: WatchThing = { ...start(), track: { ...start().track, previous: moved } };
    for (let i = 1; i < WATCH.recheckSteps; i++) {
      thing = watchStep(thing, moved, 10_000 + i * 100).thing;
      expect(thing.track.box.x).toBeCloseTo(30 / W, 3);
      expect(thing.track.stillSteps).toBe(i);
    }
    thing = watchStep(thing, moved, 11_000).thing;
    expect(thing.track.box.x).toBeCloseTo(36 / W, 3);
    expect(thing.status).toBe('following');
  });
  it('doesn’t search an unchanged frame for a lost thing again, and finds it when it is put back', () => {
    const lost = run(start(), Array(12).fill(scene(null)));
    expect(lost.thing.track.lostSteps).toBe(12);
    const back = watchStep(lost.thing, scene(70, 30), 20_000).thing;
    expect(back.track.lostSteps).toBe(0);
    expect(back.track.box.x).toBeCloseTo(70 / W, 3);
  });
  it('asks SAM to confirm a crossing only once the thing has settled on the other side', () => {
    const r = run(start(), Array(12).fill(scene(110, 40)));
    expect(r.asks.filter(Boolean)).toEqual(['confirm']);
    // Settled means still for `quietSteps` frames, then the crossing counted for `settleSteps`.
    expect(r.asks.indexOf('confirm')).toBeGreaterThanOrEqual(WATCH.quietSteps - 1);
    expect(r.thing.layer).toBe('local');
    expect(r.thing.track.box.x).toBeCloseTo(110 / W, 2);
  });
  it('looks by appearance first, then asks SAM, then backs off and gives up', () => {
    const gone = Array(30).fill(scene(null));
    const r = run(start(), gone);
    expect(r.refinds).toBe(1);
    expect(r.asks.filter(Boolean)).toEqual(['reanchor']);
    expect(r.thing.status).toBe('unsure');
    expect(r.thing.reanchorGap).toBe(2 * WATCH.reanchorGapMs.first);
    // SAM missed too: the next ask waits the doubled gap.
    let thing = missed(r.thing);
    const soon = run(thing, gone, r.thing.lastAsk + 100);
    expect(soon.asks.filter(Boolean)).toEqual([]);
    const later = run(soon.thing, gone, r.thing.lastAsk + thing.reanchorGap);
    expect(later.asks.filter(Boolean)).toEqual(['reanchor']);
    // Enough misses in a row and it is missing: frames that don't change where it was cost nothing.
    for (let i = 1; i < WATCH.maxMisses; i++) thing = missed(thing);
    expect(thing.status).toBe('missing');
    const quiet = run(thing, gone, 60_000);
    expect(quiet.asks.filter(Boolean)).toEqual([]);
    expect(quiet.thing.status).toBe('missing');
    // Something moving where it was wakes it up.
    const back = watchStep(quiet.thing, scene(30, 40), 70_000);
    expect(back.thing.status).toBe('unsure');
    expect(back.thing.misses).toBe(0);
  });
});

describe('finding a thing by appearance', () => {
  /** A 10×6 grid of 4-d features: the thing's patches point one way, the rest another. */
  function grid(at: { c: number; r: number } | null, twin?: { c: number; r: number }): PatchGrid {
    const cols = 10;
    const rows = 6;
    const data = new Float32Array(cols * rows * 4);
    for (let p = 0; p < cols * rows; p++) data.set([0.1, 1, 0.2 * (p % 3), 0], p * 4);
    for (const t of [at, twin])
      if (t)
        for (let r = t.r; r < t.r + 2; r++)
          for (let c = t.c; c < t.c + 2; c++) data.set([1, 0.1, 0, 0.3], (r * cols + c) * 4);
    return { cols, rows, dim: 4, data };
  }
  const weights = (at: { c: number; r: number }) => {
    const w = new Float32Array(60);
    for (let r = at.r; r < at.r + 2; r++) for (let c = at.c; c < at.c + 2; c++) w[r * 10 + c] = 1;
    return w;
  };
  it('finds it where it moved, and refuses when two places look alike', () => {
    const proto = prototypeOf(grid({ c: 1, r: 1 }), weights({ c: 1, r: 1 }))!;
    const size = { width: 0.2, height: 2 / 6 };
    const found = findByAppearance(grid({ c: 6, r: 3 }), [proto], size);
    expect(appearanceSure(found)).toBe(true);
    expect(found!.box.x).toBeCloseTo(0.6);
    expect(found!.box.y).toBeCloseTo(0.5);
    expect(appearanceSure(findByAppearance(grid(null), [proto], size))).toBe(false);
    const twins = findByAppearance(grid({ c: 1, r: 1 }, { c: 6, r: 3 }), [proto], size);
    expect(twins!.score).toBeGreaterThan(0.9);
    expect(appearanceSure(twins)).toBe(false);
  });
});

describe('where a fixture shows in the frame', () => {
  it('uses where the camera last saw it, else its place drawn through the pin', () => {
    const o = {
      box: { x: 400, y: 200, width: 100, height: 80 },
      frame: { width: 960, height: 640 },
    };
    const f = {
      scene: 'desk' as const,
      surfaceId: 'desk:top',
      at: { x: 1, y: 1 },
      turns: 0 as const,
      size: { w: 0.5, d: 0.5, h: 0.5 },
    };
    const seen = fixtureInFrame({ ...f, seen: sightingSpot(o) }, DEMO_SURFACE, null)!;
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(seen[k]).toBeCloseTo(o.box[k]);
    const drawn = fixtureInFrame(f, DEMO_SURFACE, null);
    expect(drawn).not.toBeNull();
    expect(drawn!.width).toBeGreaterThan(4);
    // The office's own floor isn't what the desk camera sees.
    expect(fixtureInFrame({ ...f, scene: 'fridge' }, DEMO_SURFACE, null)).toBeNull();
  });
});

async function setup() {
  const { app, post, memory } = await testApp({
    name: 'watch',
    appearance: async () => null,
    browseCameras: async () => [],
  });
  const watcher = watchersOf(app).demo;
  const move = async (position: string) => {
    await post('watch/demo', { position, mode: undefined });
    await watcher.idle();
  };
  return { app, post, memory, watcher, move };
}

describe('the server watching the demo desk', () => {
  it('follows the mug with no tab open, and fires the lamp only on SAM’s answer', async () => {
    const s = await setup();
    const segment = (await s.post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
    const selected = (
      await s.post('desk/select', { segmentRunId: segment.id, detectionId: '7' })
    ).json<DeskMemory>();
    await s.post('desk/camera', { fixed: true });
    await s.post('desk/zone', {
      observationId: selected.observation!.id,
      rect: { x: 0.5, y: 0.3, width: 0.1, height: 0.12 },
    });
    // Inside to start with: SAM confirms it once, so the next entry is an entry.
    await s.post('desk/verify', {
      observationId: selected.observation!.id,
      zoneId: (await s.memory()).zone!.id,
    });
    expect((await s.memory()).placement).toBe('inside');
    const on = await s.post('watch', { on: true });
    expect(on.statusCode, on.body).toBe(200);
    await s.watcher.idle();
    let view = s.watcher.view();
    expect(view).toMatchObject({ on: true, state: 'watching', appearance: false });
    expect(view.things).toEqual([expect.objectContaining({ kind: 'mug', status: 'following' })]);
    const runs = async () => (await s.app.inject('/api/runs')).json<EvidenceRun[]>();
    const segments = (await runs()).filter((r) => r.kind === 'segment').length;

    // Moving it out of the zone: followed locally, then SAM confirms the crossing.
    await s.move('right');
    let memory = await s.memory();
    expect(memory.placement).toBe('outside');
    expect(memory.lastDecision?.output.transition).toBe('left');
    expect(memory.observation!.identity).toBe('tracked');
    expect((await runs()).filter((r) => r.kind === 'segment').length).toBe(segments + 1);
    view = s.watcher.view();
    expect(view.checks).toBe(1);

    // Back in: the lamp fires on SAM's observation.
    await s.move('centre');
    memory = await s.memory();
    expect(memory.lastDecision?.output).toMatchObject({
      transition: 'entered',
      action: 'confirmed',
    });
    expect(s.watcher.view().checks).toBe(2);

    // The mug moving counts as motion in its zone, for entities in Home Assistant.
    expect(s.watcher.exposeWatch().motionAt.main).toBeGreaterThan(0);
    await s.post('expose/save', {
      entity: {
        key: 'desk_presence',
        name: 'Desk presence',
        kind: 'binary_sensor',
        source: { kind: 'motion', zoneId: 'main', holdS: 300 },
      },
    });
    const exposed = (await s.app.inject('/api/expose/demo')).json<ExposeView>();
    expect(exposed.states[0]).toMatchObject({ state: 'ON', available: true });

    // Occupancy: a zone just around the mug, learned as it looks now; a change there reads as
    // occupied, locally.
    const here = (await s.memory()).observation!;
    const tight = (
      await s.post('desk/rules/save', {
        rule: {
          label: 'Mug spot',
          objects: [here.objectId],
          entityId: null,
          rect: {
            x: here.box.x / here.frame.width,
            y: here.box.y / here.frame.height,
            width: here.box.width / here.frame.width,
            height: here.box.height / here.frame.height,
          },
        },
      })
    ).json<DeskMemory>();
    const spot = tight.rules!.find((r) => r.label === 'Mug spot')!.id;
    await s.watcher.idle();
    await s.post('expose/save', {
      entity: {
        key: 'desk_occupied',
        name: 'Desk occupied',
        kind: 'binary_sensor',
        source: { kind: 'occupied', zoneId: spot, holdS: 0, samConfirm: false },
      },
    });
    await s.watcher.idle();
    const occupied = async () =>
      (await s.app.inject('/api/expose/demo'))
        .json<ExposeView>()
        .states.find((x) => x.key === 'desk_occupied')!;
    expect((await occupied()).reason).toMatch(/empty first/);
    const learned = await s.post('expose/learn-empty', { zoneId: spot });
    expect(learned.json()).toMatchObject({ method: 'pixels' });
    await s.move('right');
    expect(await occupied()).toMatchObject({ state: 'ON', attributes: { method: 'pixels' } });
    await s.move('centre');
    expect((await occupied()).state).toBe('OFF');
    // Not opted in: no SAM call was spent on presence (the moves' own zone checks aside).
    expect(
      (await runs()).filter(
        (r) => r.kind === 'segment' && (r.output as Segmentation).concept === 'person',
      ),
    ).toHaveLength(0);

    // Watching survives a restart of the server: it is kept in desk memory.
    expect(memory.watch).toEqual({ on: true, camera: null });
    const off = (await s.post('watch', { on: false })).json<WatchView>();
    expect(off).toMatchObject({ on: false, state: 'off' });
    await s.app.close();
  });

  it('follows a fixture confirmed in the camera, moving it in the room', async () => {
    const s = await setup();
    const saved = (
      await s.post('fixtures/save', {
        fixture: {
          label: 'Mug lamp',
          scene: 'desk',
          surfaceId: 'desk:top',
          at: { x: 1, y: 1 },
          turns: 0,
          size: { w: 0.5, d: 0.5, h: 0.5 },
          model: { label: 'mug', parts: mugItem().parts },
          reference: null,
          control: { kind: 'none' },
        },
      })
    ).json<DeskMemory>();
    const id = saved.fixtures![0]!.id;
    // A fixture is confirmed by hand from a segmentation, like an object.
    const segment = (await s.post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
    const anchored = await s.post('fixtures/anchor', {
      id,
      segmentRunId: segment.id,
      detectionId: '7',
    });
    expect(anchored.statusCode, anchored.body).toBe(200);
    let fixture = anchored.json<DeskMemory>().fixtures![0]!;
    expect(fixture.track).toMatchObject({ concept: 'mug', status: 'seen' });
    const placed = fixture.at;
    // Looking for it again points SAM at where it was seen.
    const found = await s.post('fixtures/find', { id });
    expect(found.statusCode, found.body).toBe(200);
    expect(found.json<EvidenceRun<Segmentation>>().output.detections.length).toBeGreaterThan(0);

    // Re-anchored by the mug segmentation above, so the watcher can follow it.
    const again = (await s.post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
    await s.post('fixtures/anchor', { id, segmentRunId: again.id, detectionId: '7' });
    await s.post('desk/camera', { fixed: true });
    // A rule makes the move worth confirming: the fixture is its subject.
    const rule = await s.post('desk/rules/save', {
      rule: {
        label: 'Lamp spot',
        objects: [id],
        entityId: 'switch.demo_fan',
        rect: { x: 0.5, y: 0.3, width: 0.1, height: 0.12 },
      },
    });
    expect(rule.statusCode, rule.body).toBe(200);
    await s.post('desk/rules/verify');
    await s.post('watch', { on: true });
    await s.watcher.idle();
    expect(s.watcher.view().things).toEqual([
      expect.objectContaining({ id, kind: 'fixture', status: 'following' }),
    ]);
    await s.move('right');
    fixture = (await s.memory()).fixtures![0]!;
    expect(fixture.track!.status).toBe('moved');
    expect(fixture.at).not.toEqual(placed);
    expect((await s.memory()).rules![0]!.placement).toBe('outside');
    // Moving it by hand stops the camera following it.
    const {
      id: _i,
      createdAt: _c,
      updatedAt: _u,
      track: _t,
      seen: _s,
      state: _st,
      model,
      ...rest
    } = fixture;
    const moved = await s.post('fixtures/save', {
      fixture: {
        ...rest,
        id,
        at: { x: 1, y: 1 },
        model: { label: model.label, parts: model.parts },
      },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json<DeskMemory>().fixtures![0]!.track).toBeUndefined();
    await s.app.close();
  });

  it('refuses a live camera the server can’t read', async () => {
    const s = await setup();
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/watch',
      payload: { mode: 'live', on: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('watch_camera');
    await s.app.close();
  });
});

const hasFfmpeg = Bun.which('ffmpeg') !== null && Bun.which('ffprobe') !== null;
describe.skipIf(!hasFfmpeg)('reading a camera through ffmpeg', () => {
  it('streams grey frames at the watcher’s size and takes full-size snapshots', async () => {
    const dir = tempDir('frames');
    const clip = join(dir, 'clip.mp4');
    const made = Bun.spawnSync([
      'ffmpeg',
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=10',
      '-t',
      '2',
      '-pix_fmt',
      'yuv420p',
      clip,
    ]);
    expect(made.exitCode).toBe(0);
    const source = new FfmpegSource(clip);
    const frames: LumaFrame[] = [];
    const ended = new Promise<Error | undefined>(
      (done) => void source.start((f) => frames.push(f), done),
    );
    expect((await ended)?.message).toBe('The camera stream ended.');
    expect(frames.length).toBeGreaterThanOrEqual(18);
    expect(frames[0]).toMatchObject({ width: LUMA_WIDTH, height: 180 });
    // The same process kept a full picture, so a snapshot is a file read, not a new ffmpeg.
    const kept = (source as unknown as { stillPath: string }).stillPath;
    expect(existsSync(kept)).toBe(true);
    const shot = await source.snapshot();
    expect(shot).toMatchObject({ width: 640, height: 360 });
    source.stop();
    expect(existsSync(kept)).toBe(false);
  });

  it('cuts every frame to a camera’s zoomed view', async () => {
    const dir = tempDir('frames');
    const clip = join(dir, 'clip.mp4');
    const made = Bun.spawnSync([
      'ffmpeg',
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=10',
      '-t',
      '1',
      '-pix_fmt',
      'yuv420p',
      clip,
    ]);
    expect(made.exitCode).toBe(0);
    const source = new FfmpegSource(clip, 'ffmpeg', { x: 0.25, y: 0.5, w: 0.5, h: 0.5 });
    expect(await source.snapshot()).toMatchObject({ width: 320, height: 180 });
    const frames: LumaFrame[] = [];
    await new Promise<Error | undefined>((done) => void source.start((f) => frames.push(f), done));
    // 320 × 180 is 16:9 still, so the grey frames keep the watcher's size.
    expect(frames[0]).toMatchObject({ width: LUMA_WIDTH, height: 180 });
    source.stop();
  });
});

const modelDir = resolve('.data');
describe.skipIf(!existsSync(appearanceModelPath(modelDir)))(
  'the feature model on the demo desk',
  () => {
    it('finds the moved mug nearby, and is never sure of a wrong place', async () => {
      // Across the room the mug is about 17 × 23 pixels. A zoomed square still gives it a
      // prototype, but a match is only a reason to look again: what matters is that a
      // confident match is a right one. When it isn't sure, SAM is asked.
      const model = (await Appearance.load(modelDir))!;
      expect(model).not.toBeNull();
      const desk = new DemoSource();
      const centre = (await desk.snapshot()).png;
      const mug = (await demoSegmentation('mug', 'centre')).output;
      const d = mug.detections[0]!;
      const share = {
        x: d.box.x / 960,
        y: d.box.y / 640,
        width: d.box.width / 960,
        height: d.box.height / 640,
      };
      const learn = appearanceRegion(share, mug.frame);
      const grid = await model.embed(centre, learn);
      const proto = prototypeOf(
        grid,
        patchWeights(cropMask(maskBits(d, mug.frame, 1), learn), grid.cols, grid.rows),
      )!;
      expect(proto).not.toBeNull();
      for (const position of ['right', 'front'] as const) {
        await desk.show(position);
        const { region, side } = searchRegion(share, mug.frame);
        const moved = await model.embed((await desk.snapshot()).png, region, side);
        const found = findByAppearance(moved, [proto], intoRegion(share, region));
        const match = { ...found!, box: outOfRegion(found!.box, region) };
        const there = (await demoSegmentation('mug', position)).output.detections[0]!.box;
        const want = {
          x: (there.x + there.width / 2) / 960,
          y: (there.y + there.height / 2) / 640,
        };
        const right =
          Math.abs(match.box.x + match.box.width / 2 - want.x) < 0.03 &&
          Math.abs(match.box.y + match.box.height / 2 - want.y) < 0.04;
        if (appearanceSure(found)) expect(right).toBe(true);
        if (position === 'right') expect(right).toBe(true);
      }
    });
  },
);
