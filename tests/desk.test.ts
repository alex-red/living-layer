import { describe, expect, it, mock, spyOn } from 'bun:test';
import { history, mainZone, mug, sighting } from './lib/mug.js';
import { randomUUID } from 'node:crypto';
import { testApp } from './lib/app.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { createDesk, deskRoutes } from '../apps/server/src/desk.js';
import Fastify from 'fastify';
import {
  DEMO_CALIBRATION,
  DEMO_SURFACE,
  footInZone,
  surfaceMap,
  zoneFromSurface,
  pickTracked,
  placementGate,
  type Detection,
  type DeskMemory,
  type EvidenceRun,
  type PlacementDecision,
  type Segmentation,
  MAIN_RULE,
  upgradeMemory,
  type PlacementRule,
} from '@livinglayer/domain';
import { demoLamp } from '../apps/server/src/demo.js';

async function waitFor(done: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
// Around the demo mug where it starts, and clear of where it moves to.
const inside = { x: 0.5, y: 0.3, width: 0.1, height: 0.12 };
const outside = { x: 0, y: 0, width: 0.1, height: 0.1 };

async function setup() {
  const { app, post, fetcher, config: c } = await testApp({ name: 'desk' });
  const segment = (await post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
  const memory = (
    await post('desk/select', { segmentRunId: segment.id, detectionId: '7' })
  ).json<DeskMemory>();
  const zone = async (rect = inside) =>
    (await post('desk/zone', { observationId: sighting(memory)!.id, rect })).json<DeskMemory>();
  return { app, c, post, memory, segment, zone, fetcher };
}

describe('desk placement', () => {
  it('persists object identity and zone across restart; links selection, decision, and virtual action without provider traffic', async () => {
    const s = await setup();
    const zoned = await s.zone();
    const ids = { observationId: sighting(zoned)!.id, zoneId: mainZone(zoned)!.id };
    const event = (await s.post('desk/verify', ids)).json();
    expect(event.output).toMatchObject({
      decision: 'inside',
      action: 'confirmed',
      segmentRunId: s.segment.id,
      lamp: { physicalEffectVerified: false, entityId: 'light.demo_desk' },
    });
    expect(s.fetcher).not.toHaveBeenCalled();
    await s.app.close();
    const { app } = await testApp({ env: { DATA_DIR: s.c.dataDir } });
    const restored = (await app.inject('/api/desk/demo')).json<DeskMemory>();
    expect(mug(restored)!.id).toBe(mug(s.memory)!.id);
    expect(mainZone(restored)).toEqual(mainZone(zoned));
    expect(restored.lastDecision!.id).toBe(event.id);
    const again = await app.inject({
      method: 'POST',
      url: '/api/desk/verify',
      payload: { mode: 'demo', ...ids },
    });
    // Still inside: the lamp fires only on entering, so a repeat check does nothing.
    expect(again.json().output).toMatchObject({
      decision: 'inside',
      transition: 'stayed_inside',
      action: 'none',
    });
    const exportData = (await app.inject('/api/evidence')).json();
    expect(exportData.runs.map((r: EvidenceRun) => r.kind)).toEqual(
      expect.arrayContaining(['observation', 'zone', 'placement']),
    );
    expect(mug(exportData.desk.demo)!.id).toBe(mug(s.memory)!.id);
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
          observationId: sighting(s.memory)!.id,
          rect: { ...inside, x: 0.95 },
        })
      ).statusCode,
    ).toBe(400);
    const zoned = await s.zone(outside);
    const ids = { observationId: sighting(zoned)!.id, zoneId: mainZone(zoned)!.id };
    expect((await s.post('desk/verify', { ...ids, zoneId: randomUUID() })).statusCode).toBe(409);
    expect((await s.post('desk/verify', ids)).json().output).toMatchObject({
      decision: 'outside',
      action: 'none',
    });
    const changed = await s.zone();
    expect(
      (await s.post('desk/verify', { ...ids, zoneId: mainZone(changed)!.id })).json().output.action,
    ).toBe('confirmed');
    await s.app.close();
  });
  it('blocks old or superseded observations, including after a no-match or failed segmentation', async () => {
    const s = await setup();
    const z = await s.zone();
    const ids = { observationId: sighting(z)!.id, zoneId: mainZone(z)!.id };
    spyOn(Date, 'now').mockReturnValue(Date.parse(sighting(z)!.observedAt) + 300001);
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
    await s.post('desk/verify', { observationId: sighting(z)!.id, zoneId: mainZone(z)!.id });
    await s.post('desk/reset');
    const selected = (
      await s.post('desk/select', { segmentRunId: s.segment.id, detectionId: '7' })
    ).json<DeskMemory>();
    const zone = (
      await s.post('desk/zone', { observationId: sighting(selected)!.id, rect: inside })
    ).json<DeskMemory>();
    expect(
      (
        await s.post('desk/verify', {
          observationId: sighting(zone)!.id,
          zoneId: mainZone(zone)!.id,
        })
      ).json().output.action,
    ).toBe('none');
    const segment = (await s.post('segment', { concept: 'mug' })).json();
    const fresh = (
      await s.post('desk/select', { segmentRunId: segment.id, detectionId: '7' })
    ).json<DeskMemory>();
    expect(mug(fresh)!.id).toBe(mug(selected)!.id);
    expect(sighting(fresh)!.id).not.toBe(sighting(selected)!.id);
    await s.app.close();
  });
  it('rejects mismatched source images and boundary-crossing boxes', async () => {
    const s = await setup();
    const z = await s.zone();
    // The main zone, drawn on another image, or somewhere else.
    const moved = (zone: Partial<PlacementRule['zone']>): DeskMemory => ({
      ...z,
      rules: z.rules!.map((r) => (r.id === MAIN_RULE ? { ...r, zone: { ...r.zone, ...zone } } : r)),
    });
    expect(placementGate(moved({ sourceKey: 'different' })).decision).toBe('blocked');
    expect(
      placementGate(moved({ rect: { x: 0.56, y: 0.3, width: 0.1, height: 0.12 } })).decision,
    ).toBe('outside');
    await s.app.close();
  });
  it('counts a thing as inside where it stands: near its bottom centre, even when taller than the zone', () => {
    const frame = { width: 200, height: 100 };
    const zone = { x: 0.25, y: 0.2, width: 0.5, height: 0.6 };
    // Touching down on the zone's bottom edge, its top far above the zone.
    expect(footInZone({ x: 60, y: 0, width: 20, height: 80 }, frame, zone)).toBe(true);
    // Its box crosses the side, but it stands inside.
    expect(footInZone({ x: 40, y: 30, width: 40, height: 40 }, frame, zone)).toBe(true);
    // A strip of shadow under it reaches past the edge: it still stands inside.
    expect(footInZone({ x: 60, y: 30, width: 20, height: 51 }, frame, zone)).toBe(true);
    // Standing below the zone.
    expect(footInZone({ x: 60, y: 45, width: 20, height: 48 }, frame, zone)).toBe(false);
    expect(footInZone({ x: 140, y: 30, width: 22, height: 40 }, frame, zone)).toBe(false);
  });
  it('reserves before dispatch and suppresses concurrent/restarted retries even when an action fails', async () => {
    const s = await setup();
    const z = await s.zone();
    await s.app.close();
    const store = new EvidenceStore(s.c.dataDir);
    let fail!: (error: Error) => void;
    const action = mock(
      () =>
        new Promise<typeof demoLamp>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const app = Fastify();
    void app.register(deskRoutes, {
      prefix: '/api/desk',
      store,
      desk: createDesk(store, action),
      entities: () => [],
    });
    const request = {
      method: 'POST' as const,
      url: '/api/desk/verify',
      payload: { mode: 'demo', observationId: sighting(z)!.id, zoneId: mainZone(z)!.id },
    };
    const pending = app.inject(request);
    await waitFor(() => action.mock.calls.length === 1);
    expect(store.memory('demo').lastDecision!.output.action).toBe('pending');
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

describe('desk memory during a slow lamp call', () => {
  it('keeps what was saved while a rule waited on the lamp', async () => {
    const s = await setup();
    const rule = (
      await s.post('desk/rules/save', {
        rule: {
          label: 'Coaster',
          objects: [mug(s.memory)!.id],
          entityId: 'light.demo_desk',
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
      })
    ).json<DeskMemory>();
    expect(rule.rules).toHaveLength(1);
    await s.app.close();
    const store = new EvidenceStore(s.c.dataDir);
    let finish!: () => void;
    const action = mock(
      () =>
        new Promise<typeof demoLamp>((resolve) => {
          finish = () => resolve(demoLamp);
        }),
    );
    const { verifyRules } = createDesk(store, action);
    const pending = verifyRules('demo');
    await waitFor(() => action.mock.calls.length === 1);
    // Another route saves a second rule while the first waits on the lamp.
    store.updateMemory('demo', (m) => {
      m.rules = [
        ...(m.rules ?? []),
        { ...m.rules![0]!, id: randomUUID(), label: 'Saved meanwhile' },
      ];
    });
    finish();
    const events = await pending;
    expect(events[0]!.output.action).not.toBe('pending');
    const after = store.memory('demo');
    expect(after.rules!.map((r) => r.label)).toEqual(['Coaster', 'Saved meanwhile']);
    expect(after.rules![0]!.lastDecision!.id).toBe(events[0]!.id);
    store.close();
  });
});

describe('desk restore', () => {
  it('puts back a whole saved desk, and refuses another mode or a pin without its surface', async () => {
    const s = await setup();
    const saved = await s.zone();
    await s.post('desk/reset');
    const restored = await s.post('desk/restore', { memory: saved });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<DeskMemory>()).toEqual(saved);
    expect((await s.app.inject({ url: '/api/desk/demo' })).json<DeskMemory>()).toEqual(saved);
    const other = await s.post('desk/restore', { memory: { ...saved, mode: 'live' } });
    expect(other.statusCode).toBe(400);
    const pin = {
      scene: 'custom',
      surfaceId: 'nowhere',
      corners: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      frame: { width: 10, height: 10 },
    };
    expect((await s.post('desk/restore', { memory: { ...saved, surface: pin } })).statusCode).toBe(
      400,
    );
  });
});

describe('desk tracking', () => {
  type Tracked = { memory: DeskMemory; event: EvidenceRun<PlacementDecision> };
  async function track(s: Awaited<ReturnType<typeof setup>>, demoPosition: string) {
    const seg = (await s.post('segment', { concept: 'mug', demoPosition })).json<EvidenceRun>();
    return s.post('desk/track', { segmentRunId: seg.id });
  }
  it('applies a zone drawn in the room to every frame of the calibrated camera', async () => {
    const s = await setup();
    // Around the mug on the desk top, in the surface's own unit square.
    const a = { x: 0.6, y: 0.2 };
    const b = { x: 0.78, y: 0.65 };
    const map = surfaceMap(DEMO_SURFACE, DEMO_SURFACE.frame)!;
    const rect = zoneFromSurface(a, b, DEMO_SURFACE.frame, map.toFrame)!;
    const saved = await s.post('desk/zone', {
      observationId: sighting(s.memory)!.id,
      rect,
      onSurface: { scene: 'office', surfaceId: 'desk:top', a, b },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    // No fixed-camera assumption: the demo camera is calibrated.
    const steps: Tracked[] = [];
    for (const spot of ['right', 'centre']) steps.push((await track(s, spot)).json<Tracked>());
    expect(steps.map((t) => t.event.output.transition)).toEqual(['stayed_outside', 'entered']);
    expect(steps.every((t) => !t.event.output.assumedFixedCamera)).toBe(true);
    const wrong = await s.post('desk/zone', {
      observationId: sighting(steps.at(-1)!.memory)!.id,
      rect,
      onSurface: { scene: 'office', surfaceId: 'nowhere', a, b },
    });
    expect(wrong.statusCode).toBe(400);
    await s.app.close();
  });
  it('blocks every decision once the camera has moved', () => {
    // Kept the way it was before the mug was a thing; the upgrade makes it one.
    const memory = upgradeMemory({
      mode: 'live',
      object: { id: 'o', label: 'Mug', createdAt: new Date().toISOString() },
      observation: {
        id: 'b',
        objectId: 'o',
        segmentRunId: 's',
        detectionId: '7',
        observedAt: new Date().toISOString(),
        sourceKey: 'k',
        frame: { width: 960, height: 640 },
        box: { x: 500, y: 200, width: 20, height: 20 },
        identity: 'manual',
      },
      zone: { id: 'z', sourceKey: 'k', rect: inside, frame: { width: 960, height: 640 } },
      lastDecision: null,
      camera: { ...DEMO_CALIBRATION, moved: true },
    } as unknown as DeskMemory);
    expect(placementGate(memory)).toMatchObject({ decision: 'blocked' });
    expect(placementGate({ ...memory, camera: DEMO_CALIBRATION }).decision).toBe('inside');
  });
  it('carries the zone on a fixed camera, turns the lamp on entering and off leaving', async () => {
    const s = await setup();
    await s.zone();
    await s.post('desk/camera', { fixed: true });
    const steps: Tracked[] = [];
    for (const spot of ['right', 'centre', 'centre', 'front', 'centre'])
      steps.push((await track(s, spot)).json<Tracked>());
    expect(
      steps.map((t) => [
        t.event.output.transition,
        t.event.output.action,
        t.event.output.lamp?.action,
      ]),
    ).toEqual([
      ['stayed_outside', 'none', undefined],
      ['entered', 'confirmed', 'on'],
      ['stayed_inside', 'none', undefined],
      ['left', 'confirmed', 'off'],
      ['entered', 'confirmed', 'on'],
    ]);
    // Told to keep the light on, leaving switches nothing.
    expect((await s.post('desk/zone/options', { offWhenEmpty: false })).statusCode).toBe(200);
    const kept = (await track(s, 'front')).json<Tracked>();
    expect([kept.event.output.transition, kept.event.output.action]).toEqual(['left', 'none']);
    // A colour for the zone: the light comes on in it.
    const look = { kind: 'color', rgb: [255, 0, 0], brightness: 60 } as const;
    expect((await s.post('desk/zone/options', { look })).statusCode).toBe(200);
    const red = (await track(s, 'centre')).json<Tracked>();
    expect(red.event.output).toMatchObject({
      transition: 'entered',
      lamp: { action: 'on', desired: { rgb_color: [255, 0, 0], brightness_pct: 60 } },
    });
    expect(mainZone(red.memory)).toMatchObject({ look, offWhenEmpty: false });
    expect(steps[0]!.event.output.assumedFixedCamera).toBe(true);
    const last = steps.at(-1)!.memory;
    expect(sighting(last)).toMatchObject({ identity: 'tracked' });
    expect(history(last)).toHaveLength(5);
    expect(history(last)![0]!.box.y).toBe(178);
    expect(s.fetcher).not.toHaveBeenCalled();
    await s.app.close();
  });
  it('drops the zone on a new image unless the camera is marked fixed', async () => {
    const s = await setup();
    await s.zone();
    const moved = (await track(s, 'right')).json<Tracked>();
    expect(mainZone(moved.memory)).toBeNull();
    expect(moved.event.output).toMatchObject({ decision: 'blocked', action: 'none' });
    expect(moved.event.output.transition).toBeUndefined();
    await s.app.close();
  });
  it('needs one manual confirmation before tracking, and changes nothing on an empty frame', async () => {
    const s = await setup();
    await s.post('desk/reset');
    expect((await track(s, 'centre')).json().error.code).toBe('track_identity');
    await s.post('desk/select', {
      segmentRunId: (await s.post('segment', { concept: 'mug' })).json().id,
      detectionId: '7',
    });
    const before = (await s.app.inject('/api/desk/demo')).json<DeskMemory>();
    const empty = (await s.post('segment', { concept: 'unicorn' })).json<EvidenceRun>();
    const lost = await s.post('desk/track', { segmentRunId: empty.id });
    expect(lost.statusCode).toBe(400);
    const after = (await s.app.inject('/api/desk/demo')).json<DeskMemory>();
    expect(sighting(after)!.id).toBe(sighting(before)!.id);
    await s.app.close();
  });
  it('matches the detection overlapping the last box, and refuses to guess between several', () => {
    const frame = { width: 100, height: 100 };
    const det = (objectId: string, x: number): Detection => ({
      objectId,
      confidence: 0.9,
      box: { x, y: 10, width: 20, height: 20 },
      mask: { width: 1, height: 1, foregroundPixels: 1, svgPath: 'M0 0Z' },
    });
    const two = [det('a', 10), det('b', 60)];
    expect(pickTracked(two, frame)).toBeNull();
    expect(pickTracked([two[0]!], frame)?.detection.objectId).toBe('a');
    const previous = { box: { x: 55, y: 10, width: 20, height: 20 }, frame };
    expect(pickTracked(two, frame, previous)?.detection.objectId).toBe('b');
    const far = { box: { x: 90, y: 80, width: 5, height: 5 }, frame };
    expect(pickTracked(two, frame, far)).toMatchObject({
      detection: { objectId: 'b' },
      overlap: 0,
    });
  });
});
