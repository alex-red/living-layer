import { afterEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MqttClient } from 'mqtt';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { topicMatches, type MqttConnect } from '../apps/server/src/mqtt.js';
import {
  commandOf,
  featureDifference,
  nextOccupied,
  pixelDifference,
  zoneEvent,
  zoneSample,
  OCCUPANCY,
  discoveryConfig,
  evaluateExposed,
  exposedEntityId,
  exposeMessages,
  exposeProblem,
  keyFromName,
  sensorOptions,
  type DeskMemory,
  type EvidenceRun,
  type ExposedEntity,
  type ExposeView,
  type ExposeWatch,
  type PlacementDecision,
  type PlacementRule,
  type Segmentation,
} from '@livinglayer/domain';

const RULE = '11111111-1111-4111-8111-111111111111';
const MUG = '22222222-2222-4222-8222-222222222222';
const options = {
  installId: 'abc',
  discoveryPrefix: 'homeassistant',
  baseTopic: 'livinglayer',
  version: '0.1.0',
};
const frame = { width: 100, height: 100 };
function memory(over: Partial<DeskMemory> = {}): DeskMemory {
  const rule: PlacementRule = {
    id: RULE,
    label: 'Coaster',
    objects: [MUG],
    inside: [MUG],
    entityId: null,
    zone: { sourceKey: 'k', rect: { x: 0, y: 0, width: 0.5, height: 0.5 }, frame },
    placement: 'inside',
    lastDecision: { createdAt: '2026-10-29T10:00:00Z' } as EvidenceRun<PlacementDecision>,
  };
  return {
    mode: 'demo',
    object: { id: MUG, label: 'Mug', createdAt: '2026-10-29T09:00:00Z' },
    observation: null,
    zone: null,
    lastDecision: null,
    fixedCamera: true,
    rules: [rule],
    ...over,
  };
}
function entity(over: Partial<ExposedEntity> = {}): ExposedEntity {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    key: 'office_presence',
    name: 'Office presence',
    kind: 'binary_sensor',
    source: { kind: 'in_zone', zoneId: RULE },
    ...over,
  };
}
const occupancy = (over = {}) => ({
  occupied: true,
  lastOccupiedAt: 1_000_000,
  score: 0.3,
  method: 'features' as const,
  sam: null,
  ...over,
});
const watching = (over: Partial<ExposeWatch> = {}): ExposeWatch => ({
  state: 'watching',
  things: [],
  motionAt: {},
  ...over,
});

describe('entities shown in Home Assistant', () => {
  it('names entities from a key, one dot, with our prefix', () => {
    expect(keyFromName('Office presence!')).toBe('office_presence');
    expect(keyFromName('  Mug — on the coaster ')).toBe('mug_on_the_coaster');
    expect(exposedEntityId(entity())).toBe('binary_sensor.ll_office_presence');
  });
  it('refuses taken keys, kinds a source can’t be, and parts that are gone', () => {
    const m = memory({ exposed: [entity()] });
    const fresh = { ...entity(), id: undefined };
    expect(exposeProblem(m, fresh)).toMatch(/taken/);
    expect(exposeProblem(m, { ...fresh, key: 'other' })).toBeNull();
    expect(
      exposeProblem(m, {
        ...fresh,
        key: 'where',
        source: { kind: 'zone_of', objectId: MUG },
      }),
    ).toMatch(/sensor/);
    expect(
      exposeProblem(m, { ...fresh, key: 'gone', source: { kind: 'in_zone', zoneId: 'nope' } }),
    ).toMatch(/gone/);
  });
  it('shows a zone’s SAM verdict, marked stale while nobody watches', () => {
    const m = memory({ exposed: [entity()] });
    const [on] = evaluateExposed(m, watching());
    expect(on).toMatchObject({ state: 'ON', available: true });
    expect(on!.attributes).toMatchObject({ source: 'sam', zone: 'Coaster', stale: false });
    const [stale] = evaluateExposed(m, null);
    expect(stale).toMatchObject({ state: 'ON', attributes: { stale: true } });
    const [unknown] = evaluateExposed(
      memory({ rules: [{ ...m.rules![0]!, placement: null }], exposed: [entity()] }),
      null,
    );
    expect(unknown).toMatchObject({ available: false, state: null });
    // Deleting the zone leaves the entity, unavailable, so automations notice.
    const [gone] = evaluateExposed(memory({ rules: [], exposed: [entity()] }), null);
    expect(gone).toMatchObject({ available: false, reason: 'Its zone is gone.' });
  });
  it('turns motion on, holds it, and needs the watcher and a fixed camera', () => {
    const e = entity({ source: { kind: 'motion', zoneId: RULE, holdS: 60 } });
    const m = memory({ exposed: [e] });
    const now = 1_000_000;
    expect(
      evaluateExposed(m, watching({ motionAt: { [RULE]: now - 30_000 } }), now)[0],
    ).toMatchObject({ state: 'ON' });
    expect(
      evaluateExposed(m, watching({ motionAt: { [RULE]: now - 90_000 } }), now)[0],
    ).toMatchObject({ state: 'OFF' });
    expect(evaluateExposed(m, null, now)[0]!.available).toBe(false);
    expect(evaluateExposed({ ...m, fixedCamera: false }, watching(), now)[0]!.reason).toMatch(
      /fixed/,
    );
  });
  it('says where an object is and whether it is missing', () => {
    const where = entity({
      key: 'mug_zone',
      kind: 'sensor',
      source: { kind: 'zone_of', objectId: MUG },
    });
    const missing = entity({
      id: '44444444-4444-4444-8444-444444444444',
      key: 'mug_missing',
      source: { kind: 'status', thingId: MUG },
    });
    const m = memory({ exposed: [where, missing] });
    expect(sensorOptions(m, where)).toEqual(['Coaster', 'none']);
    const states = evaluateExposed(m, watching({ things: [{ id: MUG, status: 'missing' }] }));
    expect(states.map((s) => s.state)).toEqual(['Coaster', 'ON']);
  });
  it('builds discovery configs Home Assistant can read, configs first', () => {
    const m = memory({ exposed: [entity({ deviceClass: 'occupancy' })] });
    const config = discoveryConfig(m, m.exposed![0]!, options);
    expect(config).toMatchObject({
      unique_id: 'livinglayer_abc_33333333-3333-4333-8333-333333333333',
      default_entity_id: 'binary_sensor.ll_office_presence',
      state_topic: 'livinglayer/office_presence/state',
      availability_mode: 'all',
      payload_on: 'ON',
      device_class: 'occupancy',
      device: { identifiers: ['livinglayer_abc'], name: 'Living Layer' },
    });
    expect(config).not.toHaveProperty('object_id');
    const messages = exposeMessages(m, evaluateExposed(m, watching()), options);
    expect(messages.map((x) => x.topic)).toEqual([
      'homeassistant/binary_sensor/ll_office_presence/config',
      'livinglayer/office_presence/availability',
      'livinglayer/office_presence/state',
      'livinglayer/office_presence/attributes',
    ]);
  });
});

describe('the later kinds: occupancy, events, trackers, switches, buttons', () => {
  it('compares a zone with its empty look, with a gap so it doesn’t flicker', () => {
    const grid = (v: number[]) => ({
      cols: v.length,
      rows: 1,
      dim: 2,
      data: new Float32Array(v.flatMap((x) => [x, 1 - x])),
    });
    expect(featureDifference(grid([1, 1, 1, 1]), grid([1, 1, 1, 1]))).toBe(0);
    expect(featureDifference(grid([1, 1, 1, 1]), grid([0, 1, 1, 1]))).toBe(0.25);
    expect(featureDifference(grid([1, 1]), grid([1, 1, 1]))).toBe(1);
    expect(
      pixelDifference(new Uint8Array([10, 10, 10, 10]), new Uint8Array([10, 100, 10, 30])),
    ).toBe(0.25);
    expect(nextOccupied(false, 0.1)).toBe(false);
    expect(nextOccupied(false, OCCUPANCY.occupiedShare)).toBe(true);
    expect(nextOccupied(true, 0.08)).toBe(true);
    expect(nextOccupied(true, 0.05)).toBe(false);
    const frame = { width: 4, height: 2, data: new Uint8Array([0, 0, 200, 200, 0, 0, 200, 200]) };
    const right = zoneSample(frame, { x: 0.5, y: 0, width: 0.5, height: 1 });
    expect(right.every((v) => v === 200)).toBe(true);
  });
  it('shows a zone as occupied locally, held, and with SAM only when opted in', () => {
    const e = entity({ source: { kind: 'occupied', zoneId: RULE, holdS: 30, samConfirm: false } });
    const m = memory({ exposed: [e] });
    const now = 1_010_000;
    expect(evaluateExposed(m, watching(), now)[0]!.reason).toMatch(/empty first/);
    expect(
      evaluateExposed(m, watching({ occupancy: { [RULE]: occupancy() } }), now)[0],
    ).toMatchObject({
      state: 'ON',
      attributes: { source: 'local', method: 'features' },
    });
    // Empty again, but still within the hold.
    const cleared = occupancy({ occupied: false, lastOccupiedAt: now - 20_000 });
    expect(evaluateExposed(m, watching({ occupancy: { [RULE]: cleared } }), now)[0]!.state).toBe(
      'ON',
    );
    const later = occupancy({ occupied: false, lastOccupiedAt: now - 40_000 });
    expect(evaluateExposed(m, watching({ occupancy: { [RULE]: later } }), now)[0]!.state).toBe(
      'OFF',
    );
    const sam = memory({
      exposed: [{ ...e, source: { ...e.source, samConfirm: true } as typeof e.source }],
    });
    const ask = (answer: 'yes' | 'no' | 'error' | null) =>
      evaluateExposed(
        sam,
        watching({ occupancy: { [RULE]: occupancy({ sam: answer }) } }),
        now,
      )[0]!;
    expect(ask(null).state).toBe('OFF');
    expect(ask('no').state).toBe('OFF');
    expect(ask('yes').state).toBe('ON');
    expect(ask('error').available).toBe(false);
  });
  it('sends each entered and left once as an event, never as a retained state', () => {
    const e = entity({ key: 'coaster_events', kind: 'event' });
    const m = memory({ exposed: [e] });
    m.rules![0]!.lastDecision = {
      id: 'run-1',
      createdAt: '2026-10-29T10:00:00Z',
      output: { transition: 'entered' },
    } as EvidenceRun<PlacementDecision>;
    expect(zoneEvent(m, e)).toMatchObject({
      decisionId: 'run-1',
      type: 'entered',
      attributes: { zone: 'Coaster', object: 'Mug' },
    });
    const states = evaluateExposed(m, watching());
    expect(states[0]!.state).toBe('entered');
    const config = discoveryConfig(m, e, options);
    expect(config).toMatchObject({
      event_types: ['entered', 'left'],
      state_topic: 'livinglayer/coaster_events/state',
    });
    expect(config).not.toHaveProperty('json_attributes_topic');
    expect(exposeMessages(m, states, options).map((x) => x.topic)).not.toContain(
      'livinglayer/coaster_events/state',
    );
    m.rules![0]!.lastDecision!.output.transition = 'stayed_inside';
    expect(zoneEvent(m, e)).toBeNull();
  });
  it('tracks an object as a device: its zone, home, or away when missing', () => {
    const e = entity({
      key: 'mug',
      kind: 'device_tracker',
      source: { kind: 'zone_of', objectId: MUG },
    });
    const m = memory({ exposed: [e] });
    expect(evaluateExposed(m, watching())[0]!.state).toBe('Coaster');
    const out = memory({
      rules: [{ ...m.rules![0]!, placement: 'outside', inside: [] }],
      exposed: [e],
    });
    expect(evaluateExposed(out, watching())[0]!.state).toBe('home');
    expect(
      evaluateExposed(out, watching({ things: [{ id: MUG, status: 'missing' }] }))[0]!.state,
    ).toBe('not_home');
    expect(discoveryConfig(m, e, options)).toMatchObject({
      payload_home: 'home',
      payload_not_home: 'not_home',
    });
  });
  it('takes only exact commands for our own switches and buttons', () => {
    const sw = entity({ key: 'watching', kind: 'switch', source: { kind: 'watching' } });
    const button = entity({
      id: '66666666-6666-4666-8666-666666666666',
      key: 'check',
      kind: 'button',
      source: { kind: 'check_rules' },
    });
    const m = memory({ exposed: [sw, button] });
    expect(evaluateExposed(m, watching({ on: true }))[0]!.state).toBe('ON');
    expect(discoveryConfig(m, sw, options)).toMatchObject({
      command_topic: 'livinglayer/watching/set',
    });
    expect(discoveryConfig(m, button, options)).toMatchObject({
      command_topic: 'livinglayer/check/press',
      payload_press: 'PRESS',
    });
    expect(discoveryConfig(m, button, options)).not.toHaveProperty('state_topic');
    expect(commandOf(m, options, 'livinglayer/watching/set', 'ON')).toMatchObject({ action: 'on' });
    expect(commandOf(m, options, 'livinglayer/watching/set', 'on')).toBeNull();
    expect(commandOf(m, options, 'livinglayer/check/press', 'PRESS')).toMatchObject({
      action: 'press',
    });
    expect(commandOf(m, options, 'livinglayer/check/set', 'ON')).toBeNull();
    expect(commandOf(m, options, 'livinglayer/other/press', 'PRESS')).toBeNull();
    expect(commandOf(m, options, 'elsewhere/watching/set', 'ON')).toBeNull();
    expect(topicMatches('livinglayer/+/set', 'livinglayer/watching/set')).toBe(true);
    expect(topicMatches('livinglayer/+/set', 'livinglayer/a/b/set')).toBe(false);
    expect(topicMatches('zigbee2mqtt/#', 'zigbee2mqtt/Desk lamp')).toBe(true);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** A broker that keeps every publish, as an MQTT.js client would send it. */
function fakeBroker() {
  const published: { topic: string; payload: string; retain?: boolean }[] = [];
  const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
  client.publish = (topic: string, payload: string, opts: { retain?: boolean }) => {
    published.push({ topic, payload, retain: opts?.retain });
    // A Zigbee2MQTT-style device reports the state it was set to.
    if (topic.startsWith('zigbee2mqtt/') && topic.endsWith('/set'))
      setTimeout(() => client.emit('message', topic.slice(0, -4), Buffer.from(payload)), 5);
  };
  client.publishAsync = async (topic: string, payload: string, opts: { retain?: boolean }) => {
    published.push({ topic, payload, retain: opts?.retain });
  };
  client.subscribe = () => {};
  client.unsubscribe = () => {};
  client.endAsync = async () => {};
  const seen: { url: string; will?: unknown; username?: string }[] = [];
  const connect: MqttConnect = (url, o) => {
    seen.push({ url, will: o.will, username: o.username });
    return client as unknown as MqttClient;
  };
  return { published, client, connect, seen };
}
async function setup(env: Record<string, string> = {}, mqttConnect?: MqttConnect) {
  const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-expose-'));
  dirs.push(dataDir);
  const app = await buildApp(parseConfig({ DATA_DIR: dataDir, ...env }), {
    fetcher: mock<Fetcher>(),
    serveWeb: false,
    ...(mqttConnect ? { mqttConnect } : {}),
  });
  await app.ready();
  const post = async (path: string, body: object = {}, mode = 'demo') => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/${path}`,
      payload: { mode, ...body },
    });
    // The entities follow in the response hook, just after the reply.
    await new Promise((r) => setTimeout(r, 0));
    return res;
  };
  const view = async (mode = 'demo') =>
    (await app.inject(`/api/expose/${mode}`)).json<ExposeView>();
  return { app, post, view, dataDir };
}
const whole = { x: 0, y: 0, width: 1, height: 1 };

describe('entities over the lab’s routes', () => {
  it('lets a zone tell Home Assistant only, switching nothing', async () => {
    const s = await setup();
    const segment = (await s.post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
    const picked = (
      await s.post('desk/select', { segmentRunId: segment.id, detectionId: '7' })
    ).json<DeskMemory>();
    const saved = (
      await s.post('desk/rules/save', {
        rule: { label: 'Coaster', objects: [picked.object!.id], entityId: null, rect: whole },
      })
    ).json<DeskMemory>();
    expect(saved.rules![0]!.entityId).toBeNull();
    const checked = (await s.post('desk/rules/verify')).json<{
      events: EvidenceRun<PlacementDecision>[];
    }>();
    expect(checked.events[0]!.output).toMatchObject({
      decision: 'inside',
      transition: 'entered',
      action: 'none',
    });
    expect(checked.events[0]!.output.lamp).toBeUndefined();
    // A fixture still needs its entity.
    const fixtureOnly = await s.post('desk/rules/save', {
      rule: {
        label: 'X',
        objects: [picked.object!.id],
        entityId: null,
        fixtureId: '55555555-5555-4555-8555-555555555555',
        rect: whole,
      },
    });
    expect(fixtureOnly.statusCode).toBe(400);

    const ruleId = saved.rules![0]!.id;
    const added = await s.post('expose/save', {
      entity: {
        key: 'coaster',
        name: 'Coaster',
        kind: 'binary_sensor',
        source: { kind: 'in_zone', zoneId: ruleId },
      },
    });
    expect(added.statusCode).toBe(200);
    const view = await s.view();
    expect(view.states[0]).toMatchObject({
      entityId: 'binary_sensor.ll_coaster',
      state: 'ON',
      available: true,
    });
    // Demo never publishes; it logs what it would have sent.
    expect(view.broker.state).toBe('off');
    expect(view.log.map((l) => l.topic)).toContain('homeassistant/binary_sensor/ll_coaster/config');

    const taken = await s.post('expose/save', {
      entity: {
        key: 'coaster',
        name: 'Again',
        kind: 'binary_sensor',
        source: { kind: 'watching' },
      },
    });
    expect(taken.statusCode).toBe(400);

    // Reset clears rules but keeps the entity, now unavailable.
    const reset = (await s.post('desk/reset')).json<DeskMemory>();
    expect(reset.exposed).toHaveLength(1);
    expect((await s.view()).states[0]).toMatchObject({ available: false });

    const id = reset.exposed![0]!.id;
    await s.post('expose/delete', { id });
    const after = await s.view();
    expect(after.states).toEqual([]);
    expect(after.log[0]).toBeDefined();
    expect(
      after.log.find((l) => l.topic === 'homeassistant/binary_sensor/ll_coaster/config')!.payload,
    ).toBe('');
  });

  it('publishes live entities retained, resends when Home Assistant starts, and clears deleted ones', async () => {
    const broker = fakeBroker();
    const s = await setup(
      {
        MQTT_URL: 'mqtt://broker.local:1883',
        MQTT_USERNAME: 'll',
        MQTT_PASSWORD: 'secret',
        MQTT_LIVE_ENABLED: 'true',
      },
      broker.connect,
    );
    expect(broker.seen[0]).toMatchObject({
      url: 'mqtt://broker.local:1883',
      username: 'll',
      will: { topic: 'livinglayer/status', retain: true },
    });
    expect((await s.view('live')).broker.state).toBe('connecting');
    broker.client.emit('connect');
    expect(broker.published[0]).toEqual({
      topic: 'livinglayer/status',
      payload: 'online',
      retain: true,
    });
    expect((await s.view('live')).broker.state).toBe('connected');

    await s.post(
      'expose/save',
      {
        entity: {
          key: 'watching',
          name: 'Watching',
          kind: 'binary_sensor',
          source: { kind: 'watching' },
        },
      },
      'live',
    );
    const config = broker.published.find(
      (p) => p.topic === 'homeassistant/binary_sensor/ll_watching/config',
    );
    expect(config?.retain).toBe(true);
    expect(JSON.parse(config!.payload)).toMatchObject({
      default_entity_id: 'binary_sensor.ll_watching',
    });
    expect(broker.published.find((p) => p.topic === 'livinglayer/watching/state')?.payload).toBe(
      'OFF',
    );
    // Nothing changed: nothing more is sent.
    const count = broker.published.length;
    await s.post('desk/rules/verify', {}, 'live');
    expect(broker.published.length).toBe(count);
    // Home Assistant restarted: everything again.
    broker.client.emit('message', 'homeassistant/status', Buffer.from('online'));
    expect(broker.published.length).toBeGreaterThan(count);

    const memory = (await s.app.inject('/api/desk/live')).json<DeskMemory>();
    await s.post('expose/delete', { id: memory.exposed![0]!.id }, 'live');
    const cleared = broker.published.filter((p) => p.payload === '').map((p) => p.topic);
    expect(cleared).toContain('homeassistant/binary_sensor/ll_watching/config');
    expect(cleared).toContain('livinglayer/watching/state');
    // The broker's password never reaches the lab.
    const status = await s.app.inject('/api/status');
    expect(status.body).not.toContain('secret');
    expect(status.json()).toMatchObject({ mqtt: { state: 'connected', enabled: true } });
    await s.app.close();
    expect(broker.published.at(-1)).toEqual({
      topic: 'livinglayer/status',
      payload: 'offline',
      retain: true,
    });
  });

  it('sends zone events once, and takes Home Assistant’s commands', async () => {
    const broker = fakeBroker();
    const s = await setup(
      { MQTT_URL: 'mqtt://broker:1883', MQTT_LIVE_ENABLED: 'true' },
      broker.connect,
    );
    broker.client.emit('connect');
    // Events, in the demo log: a zone with no entity, then an event entity for it.
    const segment = (await s.post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
    const picked = (
      await s.post('desk/select', { segmentRunId: segment.id, detectionId: '7' })
    ).json<DeskMemory>();
    const saved = (
      await s.post('desk/rules/save', {
        rule: { label: 'Coaster', objects: [picked.object!.id], entityId: null, rect: whole },
      })
    ).json<DeskMemory>();
    await s.post('expose/save', {
      entity: {
        key: 'coaster_events',
        name: 'Coaster events',
        kind: 'event',
        source: { kind: 'in_zone', zoneId: saved.rules![0]!.id },
      },
    });
    await s.post('desk/rules/verify');
    await s.post('desk/rules/verify');
    const events = (await s.view()).log.filter(
      (l) => l.topic === 'livinglayer/coaster_events/state',
    );
    expect(events.map((l) => JSON.parse(l.payload).event_type)).toEqual(['entered']);

    // Commands, live: a button checks the rules; a switch with no camera says why it can't.
    for (const entity of [
      { key: 'check', name: 'Check rules', kind: 'button', source: { kind: 'check_rules' } },
      { key: 'watching', name: 'Watching', kind: 'switch', source: { kind: 'watching' } },
    ])
      expect((await s.post('expose/save', { entity }, 'live')).statusCode).toBe(200);
    const live = broker.published.find((p) => p.topic === 'homeassistant/button/ll_check/config');
    expect(JSON.parse(live!.payload).command_topic).toBe('livinglayer/check/press');
    broker.client.emit('message', 'livinglayer/check/press', Buffer.from('PRESS'));
    broker.client.emit('message', 'livinglayer/watching/set', Buffer.from('ON'));
    broker.client.emit('message', 'livinglayer/watching/set', Buffer.from('maybe'));
    await new Promise((r) => setTimeout(r, 20));
    const commands = (await s.view('live')).commands;
    expect(commands.map((c) => [c.key, c.action])).toEqual([
      ['watching', 'on'],
      ['check', 'press'],
    ]);
    expect(commands[1]!.result).toBe('done');
    expect(commands[0]!.result).toMatch(/camera/);
    await s.app.close();
  });

  it('switches lights over MQTT and waits for the device to say so', async () => {
    const broker = fakeBroker();
    const s = await setup(
      {
        MQTT_URL: 'mqtt://broker:1883',
        MQTT_LIVE_ENABLED: 'true',
        MQTT_DEVICES: 'light.desk_lamp=zigbee2mqtt/Desk lamp,switch.fan=zigbee2mqtt/Fan',
      },
      broker.connect,
    );
    const status = (await s.app.inject('/api/status')).json<{
      lamp: { lights: string[]; switches: string[] };
    }>();
    expect(status.lamp).toMatchObject({ lights: ['light.desk_lamp'], switches: ['switch.fan'] });
    const before = await s.post(
      'fixtures/control',
      { entityId: 'light.desk_lamp', action: 'on' },
      'live',
    );
    expect(before.json()).toMatchObject({ error: { code: 'mqtt_not_ready' } });
    broker.client.emit('connect');
    const on = await s.post(
      'fixtures/control',
      { entityId: 'light.desk_lamp', action: 'on' },
      'live',
    );
    expect(on.statusCode, on.body).toBe(200);
    const sent = broker.published.find((p) => p.topic === 'zigbee2mqtt/Desk lamp/set')!;
    expect(sent.retain).toBe(false);
    expect(JSON.parse(sent.payload)).toEqual({ state: 'ON', brightness: 217 });
    expect(on.json()).toMatchObject({
      event: { output: { stateConfirmed: true, state: 'on', desired: { brightness_pct: 85 } } },
    });
    const off = await s.post('fixtures/control', { entityId: 'switch.fan', action: 'off' }, 'live');
    expect(
      JSON.parse(broker.published.find((p) => p.topic === 'zigbee2mqtt/Fan/set')!.payload),
    ).toEqual({ state: 'OFF' });
    expect(off.json()).toMatchObject({ event: { output: { stateConfirmed: true } } });
    expect(() => parseConfig({ MQTT_DEVICES: 'fan.x=zigbee2mqtt/x' })).toThrow(/MQTT_DEVICES/);
    expect(() => parseConfig({ MQTT_DEVICES: 'light.x=zigbee2mqtt/+' })).toThrow(/MQTT_DEVICES/);
    await s.app.close();
  });

  it('refuses a broker URL with credentials in it', () => {
    expect(() => parseConfig({ MQTT_URL: 'mqtt://user:pw@broker:1883' })).toThrow(/MQTT_URL/);
    expect(() => parseConfig({ MQTT_URL: 'http://broker' })).toThrow(/MQTT_URL/);
    expect(parseConfig({ MQTT_URL: 'mqtts://broker:8883' }).mqtt.url).toBe('mqtts://broker:8883');
  });
});
