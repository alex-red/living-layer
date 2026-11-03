import { describe, expect, it, mock } from 'bun:test';
import {
  actionsColor,
  inTimeWindow,
  ruleActions,
  runSteps,
  stepsWords,
  zoneActionsSchema,
  MAX_ZONE_STEPS,
  type DeskMemory,
  type EvidenceRun,
  type LampResult,
  type LightLook,
  type Segmentation,
  type ZoneStep,
} from '@livinglayer/domain';
import { mug } from './lib/mug.js';
import { testApp } from './lib/app.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { createDesk } from '../apps/server/src/desk.js';
import { demoLamp } from '../apps/server/src/demo.js';

const lamp = (entityId: string, action: 'on' | 'off'): LampResult => ({
  ...demoLamp,
  entityId,
  action,
});
function runner(holds: (c: unknown) => boolean = () => true) {
  const switched: string[] = [];
  const waits: number[] = [];
  const controller = new AbortController();
  return {
    switched,
    waits,
    controller,
    run: {
      signal: controller.signal,
      log: () => {},
      holds,
      switch: async (s: Extract<ZoneStep, { kind: 'switch' }>) => {
        switched.push(`${s.entityId} ${s.to}`);
        return lamp(s.entityId, s.to);
      },
      sleep: async (ms: number): Promise<void> => {
        waits.push(ms);
      },
    },
  };
}

describe('zone steps', () => {
  it('runs switches, waits, branches and repeats in order', async () => {
    const r = runner((c) => (c as { kind: string }).kind === 'occupied');
    const out = await runSteps(
      [
        { kind: 'switch', entityId: 'light.a', to: 'on' },
        { kind: 'wait', seconds: 5 },
        {
          kind: 'if',
          condition: { kind: 'occupied', is: true },
          then: [
            {
              kind: 'repeat',
              times: 2,
              steps: [{ kind: 'switch', entityId: 'switch.b', to: 'on' }],
            },
          ],
          else: [{ kind: 'switch', entityId: 'light.a', to: 'off' }],
        },
        {
          kind: 'if',
          condition: { kind: 'time', from: '00:00', to: '00:01' },
          then: [],
          else: [{ kind: 'switch', entityId: 'light.a', to: 'off' }],
        },
      ],
      r.run,
    );
    expect(r.switched).toEqual(['light.a on', 'switch.b on', 'switch.b on', 'light.a off']);
    expect(r.waits).toEqual([5000]);
    expect(out).toMatchObject({ failed: null, cancelled: false });
    expect(out.lamps).toHaveLength(4);
  });

  it('stops at a failed switch, and when a newer trigger aborts it', async () => {
    const r = runner();
    r.run.switch = async () => {
      throw Object.assign(new Error('Home Assistant is away.'), { code: 'ha_unreachable' });
    };
    const failed = await runSteps(
      [
        { kind: 'switch', entityId: 'light.a', to: 'on' },
        { kind: 'wait', seconds: 1 },
      ],
      r.run,
    );
    expect(failed.failed).toEqual({ code: 'ha_unreachable', message: 'Home Assistant is away.' });
    expect(r.waits).toEqual([]);

    const s = runner();
    s.run.sleep = async () => s.controller.abort();
    const stopped = await runSteps(
      [
        { kind: 'wait', seconds: 60 },
        { kind: 'switch', entityId: 'light.a', to: 'off' },
      ],
      s.run,
    );
    expect(stopped.cancelled).toBe(true);
    expect(s.switched).toEqual([]);
  });

  it('reads an older rule as one switch each way', () => {
    const base = { entityId: 'light.a', look: { kind: 'warm', brightness: 40 } } as const;
    expect(ruleActions({ ...base, offWhenEmpty: true })).toEqual({
      onEnter: [{ kind: 'switch', entityId: 'light.a', to: 'on', look: base.look }],
      onLeave: [{ kind: 'switch', entityId: 'light.a', to: 'off' }],
    });
    expect(ruleActions({ entityId: null })).toEqual({ onEnter: [], onLeave: [] });
    const actions = { onEnter: [{ kind: 'wait', seconds: 1 } as const], onLeave: [] };
    expect(ruleActions({ entityId: null, actions })).toBe(actions);
  });

  it('takes a zone’s colour from the first coloured light it turns on', () => {
    const pink: LightLook = { kind: 'color', rgb: [255, 105, 180], brightness: 80 };
    expect(
      actionsColor({
        onEnter: [
          { kind: 'switch', entityId: 'light.a', to: 'on', look: { kind: 'warm', brightness: 50 } },
          {
            kind: 'repeat',
            times: 2,
            steps: [{ kind: 'switch', entityId: 'light.b', to: 'on', look: pink }],
          },
        ],
        onLeave: [],
      }),
    ).toEqual([255, 105, 180]);
    expect(
      actionsColor({
        onEnter: [],
        onLeave: [{ kind: 'switch', entityId: 'light.a', to: 'on', look: pink }],
      }),
    ).toBeNull();
  });

  it('keeps a zone to a few shallow steps', () => {
    const wait: ZoneStep = { kind: 'wait', seconds: 1 };
    const many = Array.from({ length: MAX_ZONE_STEPS + 1 }, () => wait);
    expect(zoneActionsSchema.safeParse({ onEnter: many, onLeave: [] }).success).toBe(false);
    const nest = (steps: ZoneStep[]): ZoneStep => ({ kind: 'repeat', times: 2, steps });
    expect(
      zoneActionsSchema.safeParse({ onEnter: [nest([nest([wait])])], onLeave: [] }).success,
    ).toBe(true);
    expect(
      zoneActionsSchema.safeParse({ onEnter: [nest([nest([nest([wait])])])], onLeave: [] }).success,
    ).toBe(false);
    expect(
      zoneActionsSchema.safeParse({ onEnter: [{ kind: 'wait', seconds: 7200 }], onLeave: [] })
        .success,
    ).toBe(false);
  });

  it('says steps in words, and reads time windows across midnight', () => {
    expect(
      stepsWords([
        { kind: 'switch', entityId: 'light.a', to: 'on' },
        { kind: 'wait', seconds: 300 },
        {
          kind: 'if',
          condition: { kind: 'occupied', is: false },
          then: [{ kind: 'switch', entityId: 'light.a', to: 'off' }],
          else: [],
        },
      ]),
    ).toBe('turn on light.a, wait 5 min, if empty: turn off light.a');
    const at = (h: number, m = 0) => new Date(2026, 10, 3, h, m);
    expect(inTimeWindow(at(23), '22:00', '06:00')).toBe(true);
    expect(inTimeWindow(at(5, 59), '22:00', '06:00')).toBe(true);
    expect(inTimeWindow(at(12), '22:00', '06:00')).toBe(false);
    expect(inTimeWindow(at(9), '08:00', '17:30')).toBe(true);
  });
});

describe('zone steps on the server', () => {
  async function saved(actions: unknown, entityId: string | null = null) {
    const { app, post, config } = await testApp({ name: 'zone-actions' });
    const segment = (await post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
    const memory = (
      await post('desk/select', { segmentRunId: segment.id, detectionId: '7' })
    ).json<DeskMemory>();
    const res = await post('desk/rules/save', {
      rule: {
        label: 'Coaster',
        objects: [mug(memory)!.id],
        entityId,
        actions,
        rect: { x: 0, y: 0, width: 1, height: 1 },
      },
    });
    return { app, res, config, memory };
  }

  it('saves steps, refusing unknown entities and an entity beside them', async () => {
    const bad = await saved({
      onEnter: [{ kind: 'switch', entityId: 'light.not_here', to: 'on' }],
      onLeave: [],
    });
    expect(bad.res.statusCode).toBe(400);
    await bad.app.close();
    const both = await saved({ onEnter: [], onLeave: [] }, 'light.demo_desk');
    expect(both.res.statusCode).toBe(400);
    await both.app.close();
  });

  it('runs entering’s steps up to a wait, then the rest', async () => {
    const s = await saved({
      onEnter: [
        { kind: 'switch', entityId: 'light.demo_desk', to: 'on' },
        { kind: 'wait', seconds: 600 },
        {
          kind: 'if',
          condition: { kind: 'occupied', is: true },
          then: [{ kind: 'switch', entityId: 'switch.demo_fan', to: 'on' }],
          else: [],
        },
      ],
      onLeave: [{ kind: 'switch', entityId: 'light.demo_desk', to: 'off' }],
    });
    expect(s.res.statusCode).toBe(200);
    await s.app.close();
    const store = new EvidenceStore(s.config.dataDir);
    const action = mock(async (_mode: string, entityId = 'light.demo_desk', act = 'on') =>
      lamp(entityId, act as 'on' | 'off'),
    );
    let wake!: () => void;
    const sleep = mock((_ms: number, signal: AbortSignal) => {
      return new Promise<void>((resolve) => {
        wake = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const { verifyRules } = createDesk(store, action, { sleep });
    const [event] = await verifyRules('demo');
    expect(event!.output).toMatchObject({ transition: 'entered', action: 'pending' });
    expect(action.mock.calls.map((c) => `${c[1]} ${c[2]}`)).toEqual(['light.demo_desk on']);
    expect(sleep.mock.calls[0]![0]).toBe(600_000);
    wake();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(action.mock.calls.map((c) => `${c[1]} ${c[2]}`)).toEqual([
      'light.demo_desk on',
      'switch.demo_fan on',
    ]);
    const rule = store.memory('demo').rules![0]!;
    expect(rule.lastDecision!.output).toMatchObject({ action: 'confirmed' });
    expect(rule.lastDecision!.output.steps).toEqual([
      'Turned on light.demo_desk.',
      'Waiting 10 min…',
      'Asked whether still occupied: yes.',
      'Turned on switch.demo_fan.',
    ]);
    store.close();
  });

  it('stops steps still waiting when the zone is changed', async () => {
    const s = await saved({
      onEnter: [
        { kind: 'wait', seconds: 60 },
        { kind: 'switch', entityId: 'light.demo_desk', to: 'on' },
      ],
      onLeave: [],
    });
    await s.app.close();
    const store = new EvidenceStore(s.config.dataDir);
    const action = mock(async () => lamp('light.demo_desk', 'on'));
    const sleep = (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    const desk = createDesk(store, action, { sleep });
    await desk.verifyRules('demo');
    desk.stopZoneSteps('demo', store.memory('demo').rules![0]!.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(action).not.toHaveBeenCalled();
    expect(store.memory('demo').rules![0]!.lastDecision!.output.steps).toEqual([
      'Waiting 1 min…',
      'Stopped: the zone changed again.',
    ]);
    store.close();
  });
});
