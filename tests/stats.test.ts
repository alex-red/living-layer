import { describe, expect, it } from 'bun:test';
import { tempDir, testApp } from './lib/app.js';
import { watchersOf } from '../apps/server/src/app.js';
import { StatRunner } from '../apps/server/src/stats.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import {
  STATS,
  activityStep,
  dayOf,
  frameMean,
  mugItem,
  mugOf,
  occupiedStep,
  powerLook,
  powerReading,
  settle,
  settled,
  statWords,
  suggestedStats,
  usedStep,
  type DeskMemory,
  type EvidenceRun,
  type ExposeView,
  type LumaFrame,
  type Segmentation,
  type ThingStatsView,
  type WatchThing,
} from '@livinglayer/domain';

const W = 160;
const H = 100;
/** A desk at `room` grey, with a 20 × 16 screen at (100, 20) at `screen` grey and a little texture. */
function frame(room: number, screen: number): LumaFrame {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inside = x >= 100 && x < 120 && y >= 20 && y < 36;
      data[y * W + x] = Math.min(255, (inside ? screen : room) + ((x * 7 + y * 13) % 9));
    }
  return { width: W, height: H, data };
}

describe('stat detectors', () => {
  it('waits for a new reading to hold before it counts', () => {
    const s = settled<boolean | null>(false);
    expect(settle(s, true, 0)).toBe(false);
    expect(settle(s, true, STATS.dwellMs - 1)).toBe(false);
    // A flicker back resets nothing that counted, and starts the wait over.
    expect(settle(s, false, STATS.dwellMs - 1)).toBe(false);
    expect(settle(s, true, STATS.dwellMs)).toBe(false);
    expect(settle(s, true, 2 * STATS.dwellMs)).toBe(true);
    expect(s).toMatchObject({ value: true, since: STATS.dwellMs });
  });

  it('tells a screen on from off, and the room’s light going on from either', () => {
    const look = (f: LumaFrame) => {
      const sample = new Uint8Array(STATS.sample.width * STATS.sample.height);
      const { width: w, height: h } = STATS.sample;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          sample[y * w + x] =
            f.data[(20 + Math.floor((y * 16) / h)) * W + 100 + Math.floor((x * 20) / w)]!;
      return powerLook(sample, frameMean(f.data));
    };
    const looks = { off: look(frame(80, 20)), on: look(frame(80, 200)) };
    expect(powerReading(look(frame(80, 190)), looks, null)).toMatchObject({ reading: true });
    expect(powerReading(look(frame(80, 25)), looks, null)).toMatchObject({ reading: false });
    // The room twice as bright, the screen still off: off, since it is judged against the room.
    expect(powerReading(look(frame(160, 40)), looks, false).reading).toBe(false);
    // Just past off, it keeps what it was.
    const near = look(frame(80, 55));
    expect(powerReading(near, looks, true).reading).toBe(true);
    expect(powerReading(near, looks, false).reading).toBe(false);
    // Back at off, it goes off.
    expect(powerReading(look(frame(80, 30)), looks, true).reading).toBe(false);
    // Two looks that can't be told apart say nothing.
    expect(powerReading(near, { on: looks.off, off: looks.off }, null).reading).toBeNull();
  });

  it('reads a dark picture as on, though on was shown with a bright one', () => {
    // An office monitor's looks as taught, and its dark wallpaper later: nearer off, but lit.
    const looks = { off: { mean: 0.34, contrast: 0.05 }, on: { mean: 0.89, contrast: 0.42 } };
    const dark = { mean: 0.56, contrast: 0.2 };
    expect(powerReading(dark, looks, false).reading).toBe(true);
  });

  it('rises with motion and falls back as it stops, in steps', () => {
    const a = { level: 0, shown: 0 };
    let told = 0;
    for (let i = 0; i < 600; i++) if (activityStep(a, true, 100)) told++;
    // A minute of it is about two thirds: the level forgets as it goes, with no window to keep.
    expect(a.shown).toBeCloseTo(0.6, 5);
    // A minute of motion tells a handful of steps, not one per frame.
    expect(told).toBeLessThanOrEqual(10);
    for (let i = 0; i < 1800; i++) activityStep(a, false, 100);
    expect(a.shown).toBeLessThan(0.1);
  });

  it('counts a mug picked up and put back, not a hand passing in front of it', () => {
    const spot = { x: 0.5, y: 0.5, width: 0.05, height: 0.08 };
    const u = { spot: null, awaySince: null };
    expect(usedStep(u, { following: true, box: spot, still: true }, 0)).toBe(false);
    // Lost for a second: a hand passing.
    usedStep(u, { following: false, box: spot, still: false }, 1000);
    expect(usedStep(u, { following: true, box: spot, still: true }, 2000)).toBe(false);
    // Lost for five seconds, then back where it was: used.
    usedStep(u, { following: false, box: spot, still: false }, 10_000);
    expect(usedStep(u, { following: true, box: spot, still: true }, 15_000)).toBe(true);
    // Carried to the other end of the desk and set down there: used, and that's its spot now.
    const there = { ...spot, x: 0.7 };
    usedStep(u, { following: true, box: { ...spot, x: 0.6 }, still: false }, 20_000);
    expect(usedStep(u, { following: true, box: there, still: true }, 24_000)).toBe(true);
    expect(u.spot).toMatchObject({ x: 0.7 });
  });

  it('is occupied past the zones’ own gap, after the dwell', () => {
    const s = settled<boolean | null>(false);
    occupiedStep(s, 0.3, 0);
    expect(occupiedStep(s, 0.3, STATS.dwellMs)).toBe(true);
    // Between the two lines it stays occupied.
    expect(occupiedStep(s, 0.08, 3 * STATS.dwellMs)).toBe(false);
    occupiedStep(s, 0.01, 4 * STATS.dwellMs);
    expect(occupiedStep(s, 0.01, 5 * STATS.dwellMs)).toBe(true);
    expect(s.value).toBe(false);
  });

  it('suggests a thing’s usual stats from its type or name', () => {
    expect(suggestedStats({ type: 'monitor', label: 'Screen' })).toEqual(['power']);
    expect(suggestedStats({ label: 'Desk lamp' })).toEqual(['power']);
    expect(suggestedStats({ label: 'Blue mug' })).toEqual(['lastUsed']);
    expect(suggestedStats({ type: 'device', label: 'Mouse' })).toEqual(['activity']);
    expect(suggestedStats({ label: 'Cat tree' })).toEqual(['occupied']);
    expect(suggestedStats({ label: 'Book' })).toEqual([]);
    expect(statWords('lastUsed', 1000, 1000 + 12 * 60_000)).toBe('12 min ago');
  });
});

describe('the stat runner', () => {
  /** A desk memory with one fixture standing where the screen is, seen there. */
  function setup() {
    const store = new EvidenceStore(tempDir('stats'));
    let clock = 1_000_000;
    const runner = new StatRunner({ mode: 'demo', store, now: () => clock });
    const memory = store.memory('demo');
    memory.fixtures = [
      {
        id: 'screen',
        label: 'Monitor',
        scene: 'desk',
        surfaceId: null,
        at: { x: 0, y: 0 },
        turns: 0,
        size: { w: 1, d: 1, h: 1 },
        model: { label: 'mug', parts: mugItem().parts } as never,
        reference: null,
        control: { kind: 'none' },
        track: {
          concept: 'monitor',
          status: 'seen',
          history: [],
          observation: {
            id: 'o',
            objectId: 'screen',
            segmentRunId: 's',
            detectionId: '1',
            observedAt: new Date(clock).toISOString(),
            sourceKey: 'k',
            frame: { width: W, height: H },
            box: { x: 100, y: 20, width: 20, height: 16 },
            identity: 'manual',
          },
        },
        createdAt: '',
        updatedAt: '',
      },
    ];
    memory.thingStats = { screen: [{ key: 'power' }] };
    store.saveMemory(memory);
    runner.sync();
    runner.setWatching(true);
    const none = new Map<string, WatchThing>();
    const feed = (f: LumaFrame, ms: number, every = 1000) => {
      for (let t = 0; t < ms; t += every) {
        clock += every;
        runner.frame(f, none, clock);
      }
    };
    return { store, runner, feed, tick: (ms: number) => (clock += ms), now: () => clock };
  }

  it('needs both looks, then follows the screen and counts the time it is on', async () => {
    const s = setup();
    expect(s.runner.current().screen?.power).toMatchObject({ value: null, needs: ['off', 'on'] });
    s.feed(frame(80, 20), 1000);
    await s.runner.learn('screen', 'power', 'off');
    s.feed(frame(80, 200), 1000);
    await s.runner.learn('screen', 'power', 'on');
    expect(s.runner.current().screen?.power).toMatchObject({ value: true, needs: [] });
    s.feed(frame(80, 20), 5000);
    expect(s.runner.current().screen?.power?.value).toBe(false);
    // The room's light going on doesn't turn the screen on.
    s.feed(frame(160, 40), 5000);
    expect(s.runner.current().screen?.power?.value).toBe(false);
    s.feed(frame(80, 200), 60_000);
    const now = s.runner.current().screen!.power!;
    expect(now.value).toBe(true);
    expect(now.today).toBeGreaterThan(55);
    const view = s.runner.view('screen', 7);
    expect(view.events.map((e) => e.value)).toEqual([false, true, false, true]);
    expect(view.days).toEqual([
      { day: dayOf(s.now()), key: 'power', total: expect.closeTo(now.today, 0) },
    ]);
  });

  it('holds while something moves in front of it, and goes unavailable when the camera moves', async () => {
    const s = setup();
    s.feed(frame(80, 20), 1000);
    await s.runner.learn('screen', 'power', 'off');
    s.feed(frame(80, 200), 1000);
    await s.runner.learn('screen', 'power', 'on');
    // Alternate frames: the region keeps changing, so nothing is judged.
    for (let i = 0; i < 10; i++) s.feed(frame(80, i % 2 ? 200 : 20), 1000);
    expect(s.runner.current().screen?.power?.value).toBe(true);
    s.runner.sync({ ...s.store.memory('demo'), camera: { moved: true } as never });
    s.feed(frame(80, 200), 2000);
    expect(s.runner.current().screen?.power).toMatchObject({
      value: null,
      reason: expect.stringMatching(/camera moved/),
    });
  });

  it('starts again from its last value after a restart, marked stale while nobody watches', async () => {
    const s = setup();
    s.feed(frame(80, 20), 1000);
    await s.runner.learn('screen', 'power', 'off');
    s.feed(frame(80, 200), 1000);
    await s.runner.learn('screen', 'power', 'on');
    s.runner.flush();
    const again = new StatRunner({ mode: 'demo', store: s.store, now: s.now });
    again.sync();
    expect(again.current().screen?.power).toMatchObject({ value: true, needs: [], stale: true });
  });
});

describe('stats on the demo desk', () => {
  it('counts the mug used, follows a lamp’s light, and shows both in Home Assistant', async () => {
    const { app, post, get, memory } = await testApp({
      name: 'stats-demo',
      appearance: async () => null,
      browseCameras: async () => [],
    });
    const watcher = watchersOf(app).demo;
    const segment = (await post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
    const picked = (
      await post('desk/select', { segmentRunId: segment.id, detectionId: '7' })
    ).json<DeskMemory>();
    const mug = mugOf(picked)!.id;
    const on = await post('things/stats', { id: mug, stats: [{ key: 'lastUsed' }] });
    expect(on.statusCode, on.body).toBe(200);
    // A stat for a thing that isn't there is refused.
    expect((await post('things/stats', { id: 'nope', stats: [] })).statusCode).toBe(404);
    await post('watch', { on: true });
    await watcher.idle();
    expect(watcher.view().stats?.[mug]?.lastUsed).toMatchObject({ value: null, today: 0 });
    // Carried to the right and set down there: used once.
    await post('watch/demo', { position: 'right', mode: undefined });
    await watcher.idle();
    const used = watcher.view().stats?.[mug]?.lastUsed;
    expect(used).toMatchObject({ source: 'camera', today: 1 });
    expect(typeof used?.value).toBe('number');

    // A lamp fixture's power comes from its light, with nothing to learn.
    const saved = (
      await post('fixtures/save', {
        fixture: {
          label: 'Desk lamp',
          scene: 'desk',
          surfaceId: 'desk:top',
          at: { x: 1, y: 1 },
          turns: 0,
          size: { w: 0.5, d: 0.5, h: 0.5 },
          model: { label: 'mug', parts: mugItem().parts },
          reference: null,
          control: { kind: 'light', entityId: 'light.demo_shelf' },
        },
      })
    ).json<DeskMemory>();
    const lamp = saved.fixtures!.find((f) => f.label === 'Desk lamp')!.id;
    await post('things/stats', { id: lamp, stats: [{ key: 'power' }] });
    expect(watcher.view().stats?.[lamp]?.power).toMatchObject({ value: null, needs: [] });
    const switched = await post('fixtures/control', { fixtureId: lamp, action: 'on' });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(watcher.view().stats?.[lamp]?.power).toMatchObject({ value: true, source: 'entity' });
    // Learning a look the camera doesn't need, or for a stat that is off, is refused.
    expect(
      (await post('things/learn', { id: lamp, key: 'occupied', look: 'empty' })).statusCode,
    ).toBe(409);

    await post('expose/save', {
      entity: {
        key: 'lamp_power',
        name: 'Lamp power',
        kind: 'binary_sensor',
        source: { kind: 'stat', thingId: lamp, key: 'power' },
      },
    });
    await post('expose/save', {
      entity: {
        key: 'mug_used',
        name: 'Mug last used',
        kind: 'sensor',
        deviceClass: 'timestamp',
        source: { kind: 'stat', thingId: mug, key: 'lastUsed' },
      },
    });
    // A time as on/off makes no sense.
    expect(
      (
        await post('expose/save', {
          entity: {
            key: 'mug_used_binary',
            name: 'Mug used',
            kind: 'binary_sensor',
            source: { kind: 'stat', thingId: mug, key: 'lastUsed' },
          },
        })
      ).statusCode,
    ).toBe(400);
    const states = (await get('expose/demo')).json<ExposeView>().states;
    expect(states.find((x) => x.key === 'lamp_power')).toMatchObject({
      state: 'ON',
      attributes: { source: 'entity' },
    });
    expect(states.find((x) => x.key === 'mug_used')?.state).toMatch(/^\d{4}-\d\d-\d\dT/);

    // The thing's own history: its changes and today's count.
    const history = (await get(`things/demo/${mug}/stats?days=7`)).json<ThingStatsView>();
    expect(history.events.filter((e) => e.key === 'lastUsed')).toHaveLength(1);
    expect(history.days).toEqual([{ day: expect.any(String), key: 'lastUsed', total: 1 }]);
    // Switched off, its stats go from the stream and its entity is unavailable.
    await post('things/stats', { id: lamp, stats: [] });
    expect(watcher.view().stats?.[lamp]).toBeUndefined();
    expect(
      (await get('expose/demo')).json<ExposeView>().states.find((x) => x.key === 'lamp_power'),
    ).toMatchObject({ available: false, reason: expect.stringMatching(/power stat is off/) });
    expect((await memory()).thingStats).toEqual({ [mug]: [{ key: 'lastUsed' }] });
    await app.close();
  });
});
