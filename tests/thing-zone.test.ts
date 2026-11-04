import { describe, expect, it } from 'bun:test';
import {
  DEMO_CALIBRATION,
  DEMO_SURFACE,
  THING_ZONE,
  anchoredZone,
  footInZone,
  isoSurface,
  placeAnchor,
  ruleGate,
  ruleInputSchema,
  ruleObjects,
  sightedThing,
  withoutThings,
  type DeskMemory,
  type DeskObservation,
  type Detection,
  type Fixture,
  type PlacementRule,
} from '@livinglayer/domain';
import { demoSegmentation } from '../apps/server/src/demo.js';
import { testApp } from './lib/app.js';

const MUG = '11111111-1111-4111-8111-111111111111';
const COASTER = '33333333-3333-4333-8333-333333333333';
const NOW = Date.now();
const frame = DEMO_SURFACE.frame;

/** The demo's own masks: the coaster where it lies, the mug at a position. */
const coasterBox = (await demoSegmentation('coaster')).output.detections[0]!.box;
const mugAt = async (p: 'centre' | 'right' | 'front') =>
  (await demoSegmentation('mug', p)).output.detections[0]!.box;

const sighting = (objectId: string, box: Detection['box'], ageMs = 0): DeskObservation => ({
  id: `o-${objectId}-${ageMs}-${box.x}`,
  objectId,
  segmentRunId: 'run',
  detectionId: '1',
  observedAt: new Date(NOW - ageMs).toISOString(),
  sourceKey: 'k',
  frame,
  box,
  identity: 'tracked',
});
function memory(mug: Detection['box'], coaster = sighting(COASTER, coasterBox)): DeskMemory {
  return {
    mode: 'demo',
    surface: DEMO_SURFACE,
    camera: DEMO_CALIBRATION,
    fixtures: [
      sightedThing(
        {},
        { id: MUG, label: 'Mug', concept: 'mug', type: 'mug', observation: sighting(MUG, mug) },
      ),
      sightedThing({}, { id: COASTER, label: 'Coaster', concept: 'coaster', observation: coaster }),
    ],
    lastDecision: null,
  };
}
const anchor = { thingId: COASTER, padCm: THING_ZONE.padCm };
/** The coaster's zone, placed where the coaster is in `m`. */
const rule = (m: DeskMemory, over: Partial<PlacementRule> = {}): PlacementRule =>
  placeAnchor(m, {
    id: 'r',
    label: 'On the coaster',
    objects: 'any',
    entityId: null,
    anchor,
    zone: { sourceKey: 'k', rect: { x: 0, y: 0, width: 0.01, height: 0.01 }, frame },
    ...over,
  });

describe('a zone that is a thing', () => {
  it('is the thing’s footprint on the pinned surface, and holds what stands on it', async () => {
    const m = memory(await mugAt('right'));
    const r = rule(m);
    expect(r.zone.onSurface?.surfaceId).toBe('desk:top');
    expect(r.anchor?.seenAt).toBe(m.fixtures![1]!.track!.observation.observedAt);
    expect(ruleGate(m, r, NOW)).toMatchObject({ decision: 'inside', inside: [MUG] });
    // The mug in the middle of the desk is nowhere near it.
    expect(ruleGate(memory(await mugAt('centre')), r, NOW)).toMatchObject({
      decision: 'outside',
    });
  });
  it('is wider by its margin', async () => {
    const m = memory(await mugAt('right'));
    const tight = anchoredZone(m, { thingId: COASTER, padCm: 0 })!.onSurface!;
    const wide = anchoredZone(m, { thingId: COASTER, padCm: 10 })!.onSurface!;
    expect(wide.b.x - wide.a.x).toBeGreaterThan(tight.b.x - tight.a.x);
  });
  it('stands the thing inside its own zone in the frame, so the watcher sees it cross only once moved', async () => {
    const m = memory(await mugAt('right'));
    expect(footInZone(coasterBox, frame, rule(m).zone.rect)).toBe(true);
    const slid = { ...coasterBox, x: coasterBox.x - 120 };
    expect(footInZone(slid, frame, rule(m).zone.rect)).toBe(false);
  });
  it('never counts the thing it is', async () => {
    const m = memory(await mugAt('right'));
    expect(ruleObjects(m, rule(m))).toEqual([MUG]);
  });
  it('moves with the thing: slid away from a still mug, the mug is off it', async () => {
    const mug = await mugAt('right');
    const before = rule(memory(mug));
    const slid = sighting(COASTER, { ...coasterBox, x: coasterBox.x - 120 }, -1000);
    const after = placeAnchor(memory(mug, slid), before);
    expect(after.zone.onSurface!.a.x).toBeLessThan(before.zone.onSurface!.a.x);
    expect(ruleGate(memory(mug, slid), after, NOW + 2000)).toMatchObject({
      decision: 'outside',
    });
  });
  it('holds its last place while the thing isn’t seen again, as under a mug', async () => {
    const mug = await mugAt('right');
    const r = rule(memory(mug));
    // An older sighting than the one it was placed from doesn't move it.
    const older = sighting(COASTER, { ...coasterBox, x: coasterBox.x - 120 }, 60_000);
    expect(placeAnchor(memory(mug, older), r)).toBe(r);
    // Long unseen, the zone still judges what stands on it.
    const stale = sighting(COASTER, coasterBox, 60 * 60_000);
    const held = rule(memory(mug, stale));
    expect(ruleGate(memory(mug, stale), held, NOW)).toMatchObject({ decision: 'inside' });
  });
  it('goes when the thing is forgotten', async () => {
    const m = memory(await mugAt('right'));
    expect(withoutThings([rule(m)], [COASTER])).toEqual([]);
    expect(withoutThings([rule(m)], [MUG])).toHaveLength(1);
  });
  it('is a placed thing’s footprint where it was put', async () => {
    const m = memory(await mugAt('right'));
    const placed = anchoredZone(m, anchor)!;
    // The same coaster put by hand where the camera saw it.
    const { a, b } = placed.onSurface!;
    const desk = isoSurface('office', 'desk:top')!.rect;
    const tray: Fixture = {
      ...m.fixtures![1]!,
      place: undefined,
      track: undefined,
      scene: 'office',
      surfaceId: 'desk:top',
      at: { x: desk.x + a.x * desk.w, y: desk.y + a.y * desk.d },
      size: { w: (b.x - a.x) * desk.w, d: (b.y - a.y) * desk.d, h: 0.1 },
    };
    const own = { ...m, fixtures: [m.fixtures![0]!, tray] };
    const zone = anchoredZone(own, { thingId: COASTER, padCm: 0 });
    expect(zone?.sourceKey).toBe(`thing:${COASTER}`);
    expect(ruleGate(own, rule(own), NOW)).toMatchObject({ decision: 'inside' });
    // Off the pinned surface, it can't be one.
    expect(anchoredZone({ ...own, fixtures: [{ ...tray, surfaceId: null }] }, anchor)).toBeNull();
  });
  it('is either drawn or a thing, never both, and never stands on itself', () => {
    const base = { label: 'Coaster', objects: 'any' as const, entityId: null };
    const rect = { x: 0, y: 0, width: 0.5, height: 0.5 };
    expect(ruleInputSchema.safeParse({ ...base, anchor }).success).toBe(true);
    expect(ruleInputSchema.safeParse({ ...base, anchor, rect }).success).toBe(false);
    expect(ruleInputSchema.safeParse(base).success).toBe(false);
    expect(
      ruleInputSchema.safeParse({ ...base, anchor, motion: { share: 0.06, quietS: 5 } }).success,
    ).toBe(false);
    expect(ruleInputSchema.safeParse({ ...base, objects: [COASTER], anchor }).success).toBe(false);
    expect(
      ruleInputSchema.safeParse({ ...base, anchor: { ...anchor, padCm: THING_ZONE.maxPadCm + 1 } })
        .success,
    ).toBe(false);
  });
});

describe('the demo coaster as a zone', () => {
  it('fills as the mug is set on it and empties as it leaves', async () => {
    const { app, post } = await testApp({ name: 'thing-zone' });
    const seen = async (concept: string, demoPosition = 'centre') =>
      (await post('segment', { concept, demoPosition })).json<{ id: string }>();
    const pinned = await post('desk/surface', { pin: DEMO_SURFACE });
    expect(pinned.statusCode, pinned.body).toBe(200);
    const mug = await seen('mug');
    await post('desk/select', { segmentRunId: mug.id, detectionId: '7' });
    const coaster = await seen('coaster');
    const { memory: m } = (
      await post('desk/objects/select', {
        segmentRunId: coaster.id,
        detectionId: '1',
        label: 'Coaster',
      })
    ).json<{ memory: DeskMemory }>();
    const thing = m.fixtures!.find((f) => f.label === 'Coaster')!;
    const saved = await post('desk/rules/save', {
      rule: {
        label: 'On the coaster',
        objects: 'any',
        entityId: null,
        actions: {
          onEnter: [{ kind: 'switch', entityId: 'light.demo_shelf', to: 'on' }],
          onLeave: [{ kind: 'switch', entityId: 'light.demo_shelf', to: 'off' }],
        },
        anchor: { thingId: thing.id, padCm: 2 },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const rule = saved.json<DeskMemory>().rules!.find((r) => r.anchor)!;
    expect(rule.zone.onSurface?.surfaceId).toBe('desk:top');
    const moveMug = async (demoPosition: string) => {
      const run = await seen('mug', demoPosition);
      const r = await post('desk/track', { segmentRunId: run.id });
      expect(r.statusCode, r.body).toBe(200);
      const verified = (await post('desk/rules/verify', {})).json<{ memory: DeskMemory }>();
      return verified.memory.rules!.find((x) => x.id === rule.id)!;
    };
    expect((await moveMug('right')).placement).toBe('inside');
    expect((await moveMug('centre')).placement).toBe('outside');
    // The coaster counts nothing, itself included; forgetting it takes its zone.
    const forgot = (await post('desk/objects/forget', { objectId: thing.id })).json<DeskMemory>();
    expect(forgot.rules?.some((r) => r.id === rule.id)).toBe(false);
    await app.close();
  });
});

describe('zones close together', () => {
  /** A drawn zone round the coaster's, `grow` surface units wider each way. */
  const around = (coaster: PlacementRule, grow: number, id = 'wide'): PlacementRule => {
    const { anchor: _, ...drawn } = coaster;
    const s = coaster.zone.onSurface!;
    return {
      ...drawn,
      id,
      objects: [MUG],
      label: `Round it ${id}`,
      zone: {
        ...coaster.zone,
        onSurface: {
          ...s,
          a: { x: s.a.x - grow, y: s.a.y - grow },
          b: { x: s.b.x + grow, y: s.b.y + grow },
        },
      },
    };
  };
  it('give a thing standing in both to the zone it fills most', async () => {
    const m = memory(await mugAt('right'));
    const coaster = rule(m);
    const wide = around(coaster, 0.1);
    m.rules = [coaster, wide];
    expect(ruleGate(m, coaster, NOW)).toMatchObject({ decision: 'inside', inside: [MUG] });
    expect(ruleGate(m, wide, NOW)).toMatchObject({ decision: 'outside', inside: [] });
  });
  it('keep it in a zone with no fuller neighbour', async () => {
    const m = memory(await mugAt('right'));
    const wide = around(rule(m), 0.1);
    m.rules = [wide];
    expect(ruleGate(m, wide, NOW)).toMatchObject({ decision: 'inside', inside: [MUG] });
  });
  it('keep it in both when they are filled alike', async () => {
    const m = memory(await mugAt('right'));
    const a = around(rule(m), 0.1, 'a');
    const b = around(rule(m), 0.1, 'b');
    m.rules = [a, b];
    expect(ruleGate(m, a, NOW).decision).toBe('inside');
    expect(ruleGate(m, b, NOW).decision).toBe('inside');
  });
});
