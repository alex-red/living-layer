import { describe, expect, it, mock } from 'bun:test';
import {
  MOTION_ZONE,
  ALL_STILL,
  STILL,
  nextMotion,
  stepMotionZones,
  ruleInputSchema,
  type DeskMemory,
  type LampResult,
  type MotionState,
  type MotionZone,
} from '@livinglayer/domain';
import { testApp } from './lib/app.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { createDesk } from '../apps/server/src/desk.js';
import { demoLamp } from '../apps/server/src/demo.js';
import { watchersOf } from '../apps/server/src/app.js';

const trigger = { share: 0.06, quietS: 5 };
/** Steps a zone through frames of `share` changed, 100 ms apart, saying what each one did. */
function run(
  shares: number[],
  opts: { whole?: number; settledAt?: number; from?: MotionState } = {},
) {
  let state = opts.from ?? STILL;
  return shares.map((share, i) => {
    const step = nextMotion(state, trigger, {
      share,
      whole: opts.whole ?? 0,
      now: 1000 + i * 100,
      ...(opts.settledAt !== undefined ? { settledAt: opts.settledAt } : {}),
    });
    state = step.state;
    return step.event;
  });
}

describe('motion zones', () => {
  it('start after frames running over the share, not on one noisy frame', () => {
    expect(run([0.1, 0, 0.1, 0])).toEqual([null, null, null, null]);
    expect(run([0.01, 0.1, 0.2])).toEqual([null, null, 'started']);
  });

  it('stop once still for the quiet time, and keep going while it moves', () => {
    const moving: MotionState = { moving: true, streak: 0, lastAt: 1000 };
    const step = (share: number, now: number, from = moving) =>
      nextMotion(from, trigger, { share, whole: 0, now });
    expect(step(0, 5999).event).toBeNull();
    expect(step(0, 6000).event).toBe('stopped');
    const kept = step(0.2, 4000);
    expect(kept).toMatchObject({ event: null, state: { moving: true, lastAt: 4000 } });
    expect(step(0, 8999, kept.state).event).toBeNull();
  });

  it('ignore a light switched across the whole picture, and a light still settling', () => {
    expect(run([0.5, 0.5, 0.5], { whole: MOTION_ZONE.lightShare })).toEqual([null, null, null]);
    expect(run([0.5, 0.5, 0.5, 0.5], { settledAt: 1200 })).toEqual([null, null, null, 'started']);
  });

  it('counts no things, and switches only through its steps', () => {
    const rule = {
      label: 'Pink',
      objects: 'any',
      entityId: null,
      motion: trigger,
      rect: { x: 0.3, y: 0.4, width: 0.05, height: 0.08 },
    };
    expect(ruleInputSchema.safeParse(rule).success).toBe(true);
    expect(ruleInputSchema.safeParse({ ...rule, entityId: 'light.demo_desk' }).success).toBe(false);
    expect(
      ruleInputSchema.safeParse({ ...rule, objects: ['11111111-1111-4111-8111-111111111111'] })
        .success,
    ).toBe(false);
  });
});

/** Three plushies side by side on the office desk, as zoned on its camera. */
const lights = { started: true, stopped: false };
const plushies: MotionZone[] = [
  { id: 'pink', rect: { x: 0.31, y: 0.417, width: 0.041, height: 0.083 }, trigger, steps: lights },
  { id: 'blue', rect: { x: 0.353, y: 0.387, width: 0.039, height: 0.079 }, trigger, steps: lights },
  {
    id: 'yellow',
    rect: { x: 0.394, y: 0.364, width: 0.039, height: 0.075 },
    trigger,
    steps: lights,
  },
];
/** Steps the zones through frames of each one's changed share, 100 ms apart: each frame's events, and whether it settles. */
function runZones(zones: MotionZone[], frames: Record<string, number>[]) {
  let state = ALL_STILL;
  return frames.map((shares, i) => {
    const step = stepMotionZones(zones, state, { shares, whole: 0, now: 1000 + i * 100 });
    state = step.state;
    return { events: step.events.map((e) => `${e.id} ${e.event}`), settle: step.settle };
  });
}
const events = (frames: ReturnType<typeof runZones>) => frames.flatMap((f) => f.events);

describe('motion zones side by side', () => {
  it('start the one a hand reaches, not the neighbour its arm crossed first', () => {
    const arm = { pink: 0.4, blue: 0, yellow: 0 };
    const hand = { pink: 0, blue: 0.5, yellow: 0 };
    const frames = runZones(plushies, [
      arm,
      arm,
      arm,
      hand,
      hand,
      hand,
      hand,
      hand,
      hand,
      hand,
      hand,
    ]);
    expect(events(frames)).toEqual(['blue started']);
    // After the contest's time from when the arm first counted.
    expect(frames.findIndex((f) => f.events.length)).toBe(1 + MOTION_ZONE.contestMs / 100);
  });

  it('start a zone with no neighbour on the frame it qualifies', () => {
    const far: MotionZone = {
      ...plushies[0]!,
      rect: { x: 0.8, y: 0.1, width: 0.04, height: 0.08 },
    };
    const frames = runZones([far, plushies[1]!], [{ pink: 0.3 }, { pink: 0.3 }]);
    expect(frames.map((f) => f.events)).toEqual([[], ['pink started']]);
  });

  it('settle only when the zone runs steps for what it saw', () => {
    const quiet = { ...plushies[1]!, rect: { x: 0.8, y: 0.1, width: 0.04, height: 0.08 } };
    const silent = { ...quiet, steps: { started: false, stopped: false } };
    const moving = [{ blue: 0.3 }, { blue: 0.3 }];
    expect(runZones([quiet], moving)[1]).toEqual({ events: ['blue started'], settle: true });
    expect(runZones([silent], moving)[1]).toEqual({ events: ['blue started'], settle: false });
    // Going still runs nothing here, so it leaves the other zones watching.
    const stopped = runZones([quiet], [...moving, ...Array(trigger.quietS * 10).fill({})]).at(-1)!;
    expect(stopped).toEqual({ events: ['blue stopped'], settle: false });
  });
});

const pink = {
  kind: 'switch',
  entityId: 'light.demo_shelf',
  to: 'on',
  look: { kind: 'color', rgb: [255, 105, 180], brightness: 80 },
} as const;
async function motionZone(
  post: (url: string, body?: object) => Promise<{ json: <T>() => T; statusCode: number }>,
) {
  const res = await post('desk/rules/save', {
    rule: {
      label: 'Pink plushie',
      objects: 'any',
      entityId: null,
      motion: { share: 0.02, quietS: 1 },
      actions: { onEnter: [pink], onLeave: [] },
      // Around where the demo mug starts.
      rect: { x: 0.5, y: 0.3, width: 0.1, height: 0.12 },
    },
  });
  return res;
}

describe('motion zones on the server', () => {
  it('saves one on the calibrated camera’s frame, with no thing seen', async () => {
    const { app, post } = await testApp({ name: 'motion-save' });
    const res = await motionZone(post);
    expect(res.statusCode).toBe(200);
    const rule = res.json<DeskMemory>().rules![0]!;
    expect(rule).toMatchObject({ motion: { share: 0.02, quietS: 1 }, objects: 'any' });
    expect(rule.zone.frame).toEqual({ width: 960, height: 640 });
    // A step can't ask about a thing: a motion zone counts none.
    const asks = await post('desk/rules/save', {
      rule: {
        label: 'Asks',
        objects: 'any',
        entityId: null,
        motion: { share: 0.02, quietS: 1 },
        actions: {
          onEnter: [
            {
              kind: 'if',
              condition: {
                kind: 'inside',
                thingId: '11111111-1111-4111-8111-111111111111',
                is: true,
              },
              then: [],
              else: [],
            },
          ],
          onLeave: [],
        },
        rect: { x: 0, y: 0, width: 0.1, height: 0.1 },
      },
    });
    expect(asks.statusCode).toBe(400);
    // Checking the zones leaves it alone: it isn't judged by things.
    const checked = (await post('desk/rules/verify')).json<{ events: unknown[] }>();
    expect(checked.events).toEqual([]);
    await app.close();
  });

  it('records motion starting and stopping, and runs its steps', async () => {
    const { app, post, config } = await testApp({ name: 'motion-run' });
    await motionZone(post);
    await app.close();
    const store = new EvidenceStore(config.dataDir);
    const action = mock(async (_mode: string, entityId = '', act = 'on'): Promise<LampResult> => ({
      ...demoLamp,
      entityId,
      action: act as 'on' | 'off',
    }));
    const desk = createDesk(store, action);
    const id = store.memory('demo').rules![0]!.id;
    expect(await desk.motionZone('demo', id, 'started')).toBe(true);
    expect(action.mock.calls[0]!.slice(1, 4)).toEqual(['light.demo_shelf', 'on', pink.look]);
    let rule = store.memory('demo').rules![0]!;
    expect(rule.placement).toBe('inside');
    expect(rule.lastDecision!.output).toMatchObject({
      transition: 'entered',
      action: 'confirmed',
      reason: 'Motion in "Pink plushie".',
    });
    // Stopping runs nothing: it has no steps for that.
    expect(await desk.motionZone('demo', id, 'stopped')).toBe(false);
    rule = store.memory('demo').rules![0]!;
    expect(rule.placement).toBe('outside');
    expect(action).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('starts from the watched camera’s own frames', async () => {
    const { app, post, memory } = await testApp({
      name: 'motion-watch',
      appearance: async () => null,
      browseCameras: async () => [],
    });
    const watcher = watchersOf(app).demo;
    expect((await motionZone(post)).statusCode).toBe(200);
    expect((await post('watch', { on: true })).statusCode).toBe(200);
    await watcher.idle();
    // The mug leaving where it stood moves pixels in the zone.
    // This route takes no mode, which `post` adds unless told not to.
    expect((await post('watch/demo', { position: 'right', mode: undefined })).statusCode).toBe(200);
    await watcher.idle();
    const rule = (await memory()).rules![0]!;
    expect(rule.placement).toBe('inside');
    expect(rule.lastDecision!.output).toMatchObject({ transition: 'entered', ruleId: rule.id });
    await app.close();
  });
});
