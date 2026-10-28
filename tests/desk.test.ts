import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { deskRoutes } from '../apps/server/src/desk.js';
import Fastify from 'fastify';
import {
  boxInZone,
  placementGate,
  type DeskMemory,
  type EvidenceRun,
  type Segmentation,
} from '@livinglayer/domain';
import { fixtureLamp } from '../apps/server/src/fixtures.js';

const dirs: string[] = [];
function config() {
  const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-desk-'));
  dirs.push(dataDir);
  return parseConfig({ DATA_DIR: dataDir });
}
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
async function waitFor(done: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const inside = { x: 0.3, y: 0.2, width: 0.4, height: 0.6 };
const outside = { x: 0, y: 0, width: 0.1, height: 0.1 };

async function setup() {
  const c = config();
  const fetcher = mock<Fetcher>();
  const app = await buildApp(c, { fetcher, serveWeb: false });
  const post = async (path: string, body: object = {}) =>
    app.inject({ method: 'POST', url: `/api/${path}`, payload: { mode: 'fixture', ...body } });
  const segment = (await post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
  const memory = (
    await post('desk/select', { segmentRunId: segment.id, detectionId: '7' })
  ).json<DeskMemory>();
  const zone = async (rect = inside) =>
    (await post('desk/zone', { observationId: memory.observation!.id, rect })).json<DeskMemory>();
  return { app, c, post, memory, segment, zone, fetcher };
}

describe('desk placement', () => {
  it('persists object identity and zone across restart; links selection, decision, and virtual action without provider traffic', async () => {
    const s = await setup();
    const zoned = await s.zone();
    const ids = { observationId: zoned.observation!.id, zoneId: zoned.zone!.id };
    const event = (await s.post('desk/verify', ids)).json();
    expect(event.output).toMatchObject({
      decision: 'inside',
      action: 'confirmed',
      segmentRunId: s.segment.id,
      lamp: { physicalEffectVerified: false, entityId: 'light.fixture_desk' },
    });
    expect(s.fetcher).not.toHaveBeenCalled();
    await s.app.close();
    const app = await buildApp(s.c, { serveWeb: false });
    const restored = (await app.inject('/api/desk/fixture')).json<DeskMemory>();
    expect(restored.object!.id).toBe(s.memory.object!.id);
    expect(restored.zone).toEqual(zoned.zone);
    expect(restored.lastDecision!.id).toBe(event.id);
    const again = await app.inject({
      method: 'POST',
      url: '/api/desk/verify',
      payload: { mode: 'fixture', ...ids },
    });
    expect(again.json().output).toMatchObject({ decision: 'blocked', action: 'none' });
    const exportData = (await app.inject('/api/evidence')).json();
    expect(exportData.runs.map((r: EvidenceRun) => r.kind)).toEqual(
      expect.arrayContaining(['observation', 'zone', 'placement']),
    );
    expect(exportData.desk.fixture.object.id).toBe(s.memory.object!.id);
    expect((await app.inject('/api/status')).json().liveEvidence.lamp).toBe(false);
    await app.close();
  });
  it('rejects cross-mode/unknown selection, mismatched versions and invalid zones; outside never consumes an action', async () => {
    const s = await setup();
    expect(
      (await s.post('desk/select', { mode: 'live', segmentRunId: s.segment.id, detectionId: '7' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await s.post('desk/select', { segmentRunId: s.segment.id, detectionId: '999' })).statusCode,
    ).toBe(400);
    expect(
      (
        await s.post('desk/zone', {
          observationId: s.memory.observation!.id,
          rect: { ...inside, x: 0.9 },
        })
      ).statusCode,
    ).toBe(400);
    const zoned = await s.zone(outside);
    const ids = { observationId: zoned.observation!.id, zoneId: zoned.zone!.id };
    expect((await s.post('desk/verify', { ...ids, zoneId: randomUUID() })).statusCode).toBe(409);
    expect((await s.post('desk/verify', ids)).json().output).toMatchObject({
      decision: 'outside',
      action: 'none',
    });
    const changed = await s.zone();
    expect(
      (await s.post('desk/verify', { ...ids, zoneId: changed.zone!.id })).json().output.action,
    ).toBe('confirmed');
    await s.app.close();
  });
  it('blocks old or superseded observations, including after a no-match or failed segmentation', async () => {
    const s = await setup();
    const z = await s.zone();
    const ids = { observationId: z.observation!.id, zoneId: z.zone!.id };
    spyOn(Date, 'now').mockReturnValue(Date.parse(z.observation!.observedAt) + 300001);
    expect((await s.post('desk/verify', ids)).json().output.reason).toContain('stale');
    mock.restore();
    await s.post('segment', { concept: 'unicorn' });
    expect((await s.post('desk/verify', ids)).json().output).toMatchObject({
      decision: 'blocked',
      action: 'none',
    });
    expect(
      (await s.post('desk/select', { segmentRunId: s.segment.id, detectionId: '7' })).statusCode,
    ).toBe(400);
    await s.app.close();
  });
  it('keeps the stable object ID across fresh manual observations; reset does not re-enable consumed segmentation', async () => {
    const s = await setup();
    const z = await s.zone();
    await s.post('desk/verify', { observationId: z.observation!.id, zoneId: z.zone!.id });
    await s.post('desk/reset');
    const selected = (
      await s.post('desk/select', { segmentRunId: s.segment.id, detectionId: '7' })
    ).json<DeskMemory>();
    const zone = (
      await s.post('desk/zone', { observationId: selected.observation!.id, rect: inside })
    ).json<DeskMemory>();
    expect(
      (
        await s.post('desk/verify', { observationId: zone.observation!.id, zoneId: zone.zone!.id })
      ).json().output.action,
    ).toBe('none');
    const segment = (await s.post('segment', { concept: 'mug' })).json();
    const fresh = (
      await s.post('desk/select', { segmentRunId: segment.id, detectionId: '7' })
    ).json<DeskMemory>();
    expect(fresh.object!.id).toBe(selected.object!.id);
    expect(fresh.observation!.id).not.toBe(selected.observation!.id);
    await s.app.close();
  });
  it('rejects mismatched source images and boundary-crossing boxes', async () => {
    const s = await setup();
    const z = await s.zone();
    expect(placementGate({ ...z, zone: { ...z.zone!, sourceKey: 'different' } }).decision).toBe(
      'blocked',
    );
    expect(
      placementGate({
        ...z,
        zone: { ...z.zone!, rect: { x: 0.4, y: 0.2, width: 0.3, height: 0.6 } },
      }).decision,
    ).toBe('outside');
    await s.app.close();
  });
  it('counts a box touching the zone edge as inside and one crossing it as outside', () => {
    const frame = { width: 200, height: 100 };
    const zone = { x: 0.25, y: 0.2, width: 0.5, height: 0.6 };
    expect(boxInZone({ x: 50, y: 20, width: 100, height: 60 }, frame, zone)).toBe(true);
    expect(boxInZone({ x: 49, y: 20, width: 100, height: 60 }, frame, zone)).toBe(false);
    expect(boxInZone({ x: 60, y: 30, width: 20, height: 71 }, frame, zone)).toBe(false);
  });
  it('reserves before dispatch and suppresses concurrent/restarted retries even when an action fails', async () => {
    const s = await setup();
    const z = await s.zone();
    await s.app.close();
    const store = new EvidenceStore(s.c.dataDir);
    let fail!: (error: Error) => void;
    const action = mock(
      () =>
        new Promise<typeof fixtureLamp>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const app = Fastify();
    deskRoutes(app, store, action);
    const request = {
      method: 'POST' as const,
      url: '/api/desk/verify',
      payload: { mode: 'fixture', observationId: z.observation!.id, zoneId: z.zone!.id },
    };
    const pending = app.inject(request);
    await waitFor(() => action.mock.calls.length === 1);
    expect(store.memory('fixture').lastDecision!.output.action).toBe('pending');
    expect((await app.inject(request)).statusCode).toBe(409);
    fail(new Error('private-token-details'));
    const result = (await pending).json();
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('private-token-details');
    expect((await app.inject(request)).json().output.action).toBe('none');
    expect(action).toHaveBeenCalledTimes(1);
    await app.close();
    store.close();
  });
});
