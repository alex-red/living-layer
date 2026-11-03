import { describe, expect, it } from 'bun:test';
import { mainZone, placement, sighting } from './lib/mug.js';
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
  candidatePlaces,
  closeRegion,
  APPEARANCE,
  closeMatch,
  closeScore,
  closeSure,
  patchTemplate,
  intoRegion,
  outOfRegion,
  searchRegion,
  appearanceSure,
  fixtureInFrame,
  mugItem,
  prototypeOf,
  sightingSpot,
  startLocalTrack,
  stepLocalTrack,
  watchStep,
  watchThing,
  missed,
  asked,
  placed,
  refound,
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
  const places: boolean[] = [];
  let refinds = 0;
  frames.forEach((f, i) => {
    const now = from + i * 100;
    const step = watchStep(thing, f, now);
    // The watcher marks every ask it sends to SAM.
    thing = step.ask ? asked(step.thing, step.ask, now) : step.thing;
    // A judgement flips the crossed zones' verdicts, as desk memory would.
    if (step.place)
      thing = {
        ...placed(thing, now, false),
        subject: {
          ...thing.subject,
          zones: thing.subject.zones.map((z) => ({ ...z, inside: !z.inside })),
        },
      };
    asks.push(step.ask);
    places.push(step.place);
    if (step.refind) refinds++;
  });
  return { thing, asks, places, refinds };
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
  it('judges a crossing where it follows the thing, once settled, asking SAM nothing', () => {
    const r = run(start(), Array(12).fill(scene(110, 40)));
    expect(r.asks.filter(Boolean)).toEqual([]);
    // Settled means still for `quietSteps` frames, then the crossing counted for `settleSteps`;
    // judged once, then not again before the gap even while it stays across.
    expect(r.places.filter(Boolean)).toHaveLength(1);
    expect(r.places.indexOf(true)).toBeGreaterThanOrEqual(WATCH.quietSteps - 1);
    expect(r.thing.layer).toBe('local');
    expect(r.thing.track.box.x).toBeCloseTo(110 / W, 2);
  });
  it('keeps a still thing through a recheck that can’t tell it from its neighbour', () => {
    // A twin beside it: the once-a-second match can't say which is which.
    const twins = scene(30, 40);
    const texture = noise(7);
    for (let j = 0; j < 24; j++)
      for (let i = 0; i < 20; i++) twins.data[(40 + j) * W + 54 + i] = 120 + (texture() >> 1);
    const thing = { ...start(), track: { ...start().track, previous: twins } };
    expect(stepLocalTrack(thing.track, twins, null).track.lostSteps).toBe(1);
    // Nothing moves around it, so it is still there.
    const r = run(thing, Array(WATCH.recheckSteps + 2).fill(twins));
    expect(r.thing.status).toBe('following');
    expect(r.thing.track.lostSteps).toBe(0);
    expect(r.refinds).toBe(0);
  });
  it('follows a thing found again where it is now, and judges its zones at once', () => {
    // Learned with the desk around it, as an outline drawn loosely is.
    const loose = (x: number, y: number) => ({
      x: (x - 10) / W,
      y: (y - 10) / H,
      width: 40 / W,
      height: 44 / H,
    });
    const subject: WatchSubject = {
      id: 'mug',
      kind: 'mug',
      label: 'Mug',
      concept: 'mug',
      zones: [{ id: 'z', rect: zone, inside: true }],
    };
    const thing = watchThing(subject, startLocalTrack(scene(30, 40), loose(30, 40), true)!, 0);
    const there = scene(110, 40);
    // Read again where it was found, it is followed there, and out of the zone at the next step.
    const fresh = run(refound(thing, loose(110, 40), there), Array(8).fill(there));
    expect(fresh.thing.track.lostSteps).toBe(0);
    expect(fresh.thing.status).toBe('following');
    // Without the frame it waits to be still again first.
    const stale = run(refound(thing, loose(110, 40)), Array(8).fill(there));
    expect(stale.places.indexOf(true)).toBeGreaterThanOrEqual(WATCH.quietSteps - 1);
    expect(fresh.places.indexOf(true)).toBe(0);
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
  it('tells it from a thing of the same colours by where they lie in it, up close', () => {
    // A mug, teal above white, and a kettle of the same two the other way up: one mean for both.
    const teal = [1, 0, 0, 0.2];
    const white = [0, 1, 0, 0.2];
    function desk(things: { c: number; r: number; top: number[]; bottom: number[] }[]): PatchGrid {
      const data = new Float32Array(60 * 4);
      for (let p = 0; p < 60; p++) data.set([0, 0, 1, 0.1 * (p % 3)], p * 4);
      for (const t of things) {
        data.set(t.top, (t.r * 10 + t.c) * 4);
        data.set(t.bottom, ((t.r + 1) * 10 + t.c) * 4);
      }
      return { cols: 10, rows: 6, dim: 4, data };
    }
    const whole = { x: 0, y: 0, width: 1, height: 1 };
    const cell = (c: number, r: number) => ({ x: c / 10, y: r / 6, width: 0.1, height: 2 / 6 });
    const learned = desk([{ c: 1, r: 1, top: teal, bottom: white }]);
    const mask = new Uint8Array(60);
    mask[11] = mask[21] = 1;
    const thing = { width: 10, height: 6, data: mask };
    const proto = prototypeOf(learned, patchWeights(thing, 10, 6))!;
    const template = patchTemplate(learned, whole, cell(1, 1), thing)!;
    const now = desk([
      { c: 3, r: 3, top: white, bottom: teal },
      { c: 7, r: 2, top: teal, bottom: white },
    ]);
    const places = candidatePlaces(now, [proto], { width: 0.1, height: 2 / 6 });
    const kettle = findByAppearance(now, [proto], { width: 0.1, height: 2 / 6 });
    // The wide search can't choose between them.
    expect(appearanceSure(kettle)).toBe(false);
    const match = closeMatch(
      places.map((box) => ({ box, score: closeScore(template, now, whole, box) })),
    );
    expect(closeSure(match)).toBe(true);
    expect(match!.box.x).toBeCloseTo(0.7);
    // Nothing like it on the desk: nothing sure.
    const empty = desk([{ c: 3, r: 3, top: white, bottom: teal }]);
    const none = closeMatch(
      candidatePlaces(empty, [proto], { width: 0.1, height: 2 / 6 }).map((box) => ({
        box,
        score: closeScore(template, empty, whole, box),
      })),
    );
    expect(closeSure(none)).toBe(false);
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
  it('follows the mug with no tab open, and switches the lamp where it follows it, asking SAM nothing', async () => {
    const s = await setup();
    const segment = (await s.post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
    const selected = (
      await s.post('desk/select', { segmentRunId: segment.id, detectionId: '7' })
    ).json<DeskMemory>();
    await s.post('desk/camera', { fixed: true });
    await s.post('desk/zone', {
      observationId: sighting(selected)!.id,
      rect: { x: 0.5, y: 0.3, width: 0.1, height: 0.12 },
    });
    // Inside to start with: SAM confirms it once, so the next entry is an entry.
    await s.post('desk/verify', {
      observationId: sighting(selected)!.id,
      zoneId: mainZone(await s.memory())!.id,
    });
    expect(placement(await s.memory())).toBe('inside');
    const on = await s.post('watch', { on: true });
    expect(on.statusCode, on.body).toBe(200);
    await s.watcher.idle();
    let view = s.watcher.view();
    expect(view).toMatchObject({ on: true, state: 'watching', appearance: false });
    expect(view.things).toEqual([expect.objectContaining({ kind: 'mug', status: 'following' })]);
    const runs = async () => (await s.app.inject('/api/runs')).json<EvidenceRun[]>();
    const segments = (await runs()).filter((r) => r.kind === 'segment').length;

    // Moving it out of the zone: followed and judged locally, the lamp off; SAM isn't asked,
    // and its sighting stays the remembered one.
    await s.move('right');
    let memory = await s.memory();
    expect(placement(memory)).toBe('outside');
    expect(memory.lastDecision?.output).toMatchObject({
      transition: 'left',
      action: 'confirmed',
      segmentRunId: null,
      lamp: { action: 'off' },
    });
    expect(sighting(memory)!.identity).toBe('manual');
    expect((await runs()).filter((r) => r.kind === 'segment').length).toBe(segments);
    view = s.watcher.view();
    expect(view.checks).toBe(0);

    // Back in: the lamp turns on, again with no SAM call.
    await s.move('centre');
    memory = await s.memory();
    expect(memory.lastDecision?.output).toMatchObject({
      transition: 'entered',
      action: 'confirmed',
    });
    expect((await runs()).filter((r) => r.kind === 'segment').length).toBe(segments);

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
    const here = sighting(await s.memory())!;
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
    // Not opted in: no SAM call was spent on presence.
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

  it('follows a fixture confirmed in the camera, judging its zone where it is followed', async () => {
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
    expect((await s.memory()).rules![0]!.placement).toBe('outside');
    // No SAM call, so the room keeps it where SAM last saw it.
    expect(fixture.track!.status).toBe('seen');
    expect(fixture.at).toEqual(placed);
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
      const near = closeRegion(share, mug.frame);
      const template = patchTemplate(
        await model.embed(centre, near, APPEARANCE.side),
        near,
        share,
        cropMask(maskBits(d, mug.frame, 1), near),
      )!;
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
        // Up close, each of the wide search's best places against the mug's own patches.
        const shot = (await desk.snapshot()).png;
        const scored = [];
        for (const place of candidatePlaces(moved, [proto], intoRegion(share, region))) {
          const box = outOfRegion(place, region);
          const r = closeRegion(box, mug.frame);
          const close = await model.embed(shot, r, APPEARANCE.side);
          scored.push({ box, score: closeScore(template, close, r, box) });
        }
        const close = closeMatch(scored)!;
        const closeRight =
          Math.abs(close.box.x + close.box.width / 2 - want.x) < 0.03 &&
          Math.abs(close.box.y + close.box.height / 2 - want.y) < 0.04;
        if (closeSure(close)) expect(closeRight).toBe(true);
        if (position === 'right') expect(closeSure(close)).toBe(true);
      }
      // Each embedding is a model run; under load the test crosses bun's default.
    }, 30_000);
  },
);

describe('the watch stream', () => {
  it('sends the watcher’s view and what Home Assistant shows on one connection', async () => {
    const { app } = await testApp({ name: 'watch-stream', browseCameras: async () => [] });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    const controller = new AbortController();
    try {
      // The server takes only its own loopback hosts; this one listens on a free port.
      const response = await fetch(`http://127.0.0.1:${port}/api/watch/demo/events`, {
        headers: { host: '127.0.0.1' },
        signal: controller.signal,
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const events = new Map<string, unknown>();
      let rest = '';
      while (events.size < 2) {
        const { value, done } = await reader.read();
        if (done) break;
        rest += decoder.decode(value);
        const parts = rest.split('\n\n');
        rest = parts.pop() ?? '';
        for (const part of parts) {
          const kind = /^event: (\w+)$/m.exec(part)?.[1];
          const data = /^data: (.*)$/m.exec(part)?.[1];
          if (kind && data) events.set(kind, JSON.parse(data));
        }
      }
      expect(events.get('watch')).toMatchObject({ mode: 'demo' });
      expect(events.get('expose')).toHaveProperty('states');
      expect((await app.inject('/api/expose/demo/events')).statusCode).toBe(404);
    } finally {
      controller.abort();
      await app.close();
    }
  });
});
