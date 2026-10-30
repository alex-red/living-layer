import { afterEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MqttClient } from 'mqtt';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import type { MqttConnect } from '../apps/server/src/mqtt.js';
import {
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
    objectId: MUG,
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
  };
  client.publishAsync = async (topic: string, payload: string, opts: { retain?: boolean }) => {
    published.push({ topic, payload, retain: opts?.retain });
  };
  client.subscribe = () => {};
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
        rule: { label: 'Coaster', objectId: picked.object!.id, entityId: null, rect: whole },
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
        objectId: picked.object!.id,
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

  it('refuses a broker URL with credentials in it', () => {
    expect(() => parseConfig({ MQTT_URL: 'mqtt://user:pw@broker:1883' })).toThrow(/MQTT_URL/);
    expect(() => parseConfig({ MQTT_URL: 'http://broker' })).toThrow(/MQTT_URL/);
    expect(parseConfig({ MQTT_URL: 'mqtts://broker:8883' }).mqtt.url).toBe('mqtts://broker:8883');
  });
});
