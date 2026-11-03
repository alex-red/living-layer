import { describe, expect, it } from 'bun:test';
import { mug, others, sighting } from './lib/mug.js';
import { testApp } from './lib/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { ControlAdapter } from '../apps/server/src/control.js';
import { demoSceneDraft } from '../apps/server/src/demo.js';
import {
  ISO_PRESETS,
  addTemplate,
  buildScene,
  closeViewOf,
  closeViewShift,
  cutAway,
  depthOrder,
  groupBounds,
  isoSceneSchema,
  mainDesk,
  moveGroup,
  overlappingGroups,
  placeTemplate,
  removeGroup,
  resizeRoom,
  rotateGroup,
  rotateScene,
  ridersOf,
  sceneDraftSchema,
  settleGroup,
  type DeskMemory,
  type EvidenceRun,
  type IsoScene,
  type PlacementDecision,
  type Segmentation,
} from '@livinglayer/domain';
import { fromAngle } from '../apps/web/src/iso/fridgeAngle.js';

const asCustom = (s: IsoScene): IsoScene => ({ ...s, kind: 'custom' });
function deskWithBook() {
  const desk = placeTemplate('desk', 'desk', 1, 1);
  const book = placeTemplate('book', 'book', 0, 6);
  return asCustom({
    kind: 'custom',
    label: 'Test',
    grid: { w: 8, d: 8 },
    props: [...desk.props, ...book.props],
    surfaces: [...desk.surfaces, ...book.surfaces],
  });
}

describe('scene templates', () => {
  it('builds every preset from templates as a valid custom scene', () => {
    for (const preset of Object.values(ISO_PRESETS)) {
      const result = isoSceneSchema.safeParse(asCustom(preset));
      expect(result.success).toBe(true);
      expect(depthOrder(preset.props)).toHaveLength(preset.props.length);
      expect(overlappingGroups(preset).size).toBe(0);
    }
  });
  it('moves a group with its surfaces and keeps it inside the grid', () => {
    const scene = deskWithBook();
    const moved = moveGroup(scene, 'desk', 1, 0.5);
    expect(groupBounds(moved, 'desk')!.at).toMatchObject({ x: 2, y: 1.5 });
    expect(moved.surfaces[0]!.rect).toMatchObject({ x: 2, y: 1.5 });
    const far = moveGroup(scene, 'desk', 100, 100);
    const b = groupBounds(far, 'desk')!;
    expect(b.at.x + b.size.w).toBeCloseTo(8);
    expect(b.at.y + b.size.d).toBeCloseTo(8);
  });
  it('turns a group a quarter about its centre, four turns back to the start', () => {
    const scene = deskWithBook();
    const once = rotateGroup(scene, 'desk');
    const b0 = groupBounds(scene, 'desk')!;
    const b1 = groupBounds(once, 'desk')!;
    expect(b1.size.w).toBeCloseTo(b0.size.d);
    expect(b1.size.d).toBeCloseTo(b0.size.w);
    expect(once.surfaces[0]!.rect.w).toBeCloseTo(scene.surfaces[0]!.rect.d);
    let back = scene;
    for (let i = 0; i < 4; i++) back = rotateGroup(back, 'desk');
    expect(groupBounds(back, 'desk')!.at.x).toBeCloseTo(b0.at.x);
    expect(groupBounds(back, 'desk')!.at.y).toBeCloseTo(b0.at.y);
  });
  it('moves what stands on a desk with the desk, and leaves the rest', () => {
    const office = asCustom(ISO_PRESETS.office);
    const moved = moveGroup(office, 'desk', 1, 2);
    for (const g of ['desk', 'book', 'bottle', 'keyboard', 'lamp', 'monitor']) {
      expect(groupBounds(moved, g)!.at.x).toBeCloseTo(groupBounds(office, g)!.at.x + 1);
      expect(groupBounds(moved, g)!.at.y).toBeCloseTo(groupBounds(office, g)!.at.y + 2);
    }
    expect(groupBounds(moved, 'chair')).toEqual(groupBounds(office, 'chair'));
    expect(ridersOf(moved, 'desk').sort()).toEqual(ridersOf(office, 'desk').sort());
    // Pushed against the wall, the desk stops there and what is on it stops with it.
    const far = moveGroup(office, 'desk', 50, 0);
    const shift = groupBounds(far, 'desk')!.at.x - groupBounds(office, 'desk')!.at.x;
    expect(groupBounds(far, 'lamp')!.at.x - groupBounds(office, 'lamp')!.at.x).toBeCloseTo(shift);
    // Moving a lamp off the desk takes nothing along.
    const lamp = moveGroup(office, 'lamp', 0, 1);
    expect(groupBounds(lamp, 'monitor')).toEqual(groupBounds(office, 'monitor'));
  });
  it('turns what stands on a desk with the desk, each where it was on it', () => {
    const office = asCustom(ISO_PRESETS.office);
    const riders = ridersOf(office, 'desk').sort();
    expect(riders).toEqual(['book', 'bottle', 'keyboard', 'lamp', 'monitor']);
    const once = rotateGroup(office, 'desk');
    // Still on the desk, all of them, and nothing else came along.
    expect(ridersOf(once, 'desk').sort()).toEqual(riders);
    expect(groupBounds(once, 'chair')).toEqual(groupBounds(office, 'chair'));
    // Each turned about the desk's centre: its offset from it turned a quarter clockwise.
    const centre = (sc: IsoScene, g: string) => {
      const b = groupBounds(sc, g)!;
      return { x: b.at.x + b.size.w / 2, y: b.at.y + b.size.d / 2 };
    };
    const d0 = centre(office, 'desk');
    const d1 = centre(once, 'desk');
    for (const g of riders) {
      const a = centre(office, g);
      const b = centre(once, g);
      expect(b.x - d1.x).toBeCloseTo(-(a.y - d0.y));
      expect(b.y - d1.y).toBeCloseTo(a.x - d0.x);
    }
    let back = office;
    for (let i = 0; i < 4; i++) back = rotateGroup(back, 'desk');
    for (const g of ['desk', ...riders]) expect(centre(back, g).x).toBeCloseTo(centre(office, g).x);
  });
  it('turns the whole room a quarter, its walls staying on the back and left', () => {
    const office = asCustom(ISO_PRESETS.office);
    const once = rotateScene(office);
    expect(once.grid).toEqual({ w: office.grid.d, d: office.grid.w });
    expect(isoSceneSchema.safeParse(once).success).toBe(true);
    expect(overlappingGroups(once)).toEqual(overlappingGroups(office));
    // The walls are still the back and left ones, stretched to the new sides.
    expect(groupBounds(once, 'wall-back')).toMatchObject({
      at: { x: 0, y: 0 },
      size: { w: once.grid.w },
    });
    expect(groupBounds(once, 'wall-left')!.at.x).toBe(0);
    expect(groupBounds(once, 'wall-left')!.size.d).toBeCloseTo(once.grid.d - 0.2);
    // The desk turned with the room: its long side now runs the other way.
    const desk0 = groupBounds(office, 'desk')!;
    const desk1 = groupBounds(once, 'desk')!;
    expect(desk1.size.w).toBeCloseTo(desk0.size.d);
    expect(desk1.size.d).toBeCloseTo(desk0.size.w);
    for (const g of ['desk', 'shelf', 'plant']) {
      const b = groupBounds(once, g)!;
      expect(b.at.x).toBeGreaterThanOrEqual(0.2 - 1e-9);
      expect(b.at.y).toBeGreaterThanOrEqual(0.2 - 1e-9);
      expect(b.at.x + b.size.w).toBeLessThanOrEqual(once.grid.w + 1e-9);
      expect(b.at.y + b.size.d).toBeLessThanOrEqual(once.grid.d + 1e-9);
    }
    let back = office;
    for (let i = 0; i < 4; i++) back = rotateScene(back);
    expect(back.grid).toEqual(office.grid);
    back.props.forEach((p, i) => {
      const q = office.props[i]!;
      expect(p.at.x).toBeCloseTo(q.at.x);
      expect(p.at.y).toBeCloseTo(q.at.y);
      expect(p.size.w).toBeCloseTo(q.size.w);
      expect(p.turns ?? 0).toBe(q.turns ?? 0);
    });
  });
  it('draws both French doors, and cut away leaves the shelves and what is on them', () => {
    const fridge = ISO_PRESETS.fridge;
    const ids = new Set(fridge.props.map((p) => p.id));
    for (const id of [
      'fridge:door',
      'fridge:door-right',
      'fridge:bin-left-1',
      'fridge:bin-right-1',
    ])
      expect(ids.has(id)).toBe(true);
    const cut = cutAway(fridge);
    const kept = new Set(cut.props.map((p) => p.id));
    for (const id of [
      'fridge:door',
      'fridge:door-right',
      'fridge:top',
      'fridge:right',
      'fridge:ice',
    ])
      expect(kept.has(id)).toBe(false);
    for (const id of ['fridge', 'fridge:shelf-1', 'fridge:left', 'fridge:back', 'milk', 'eggs'])
      expect(kept.has(id)).toBe(true);
    expect(cut.surfaces).toEqual(fridge.surfaces);
    expect([...kept].some((id) => id.startsWith('fridge:bin-'))).toBe(false);
    // A sauce in the right door's bottom bin keeps that door's bins, not the door.
    const bin = fridge.props.find((p) => p.id === 'fridge:bin-right-1')!;
    const sauce = placeTemplate(
      'bottle',
      'sauce',
      bin.at.x + 0.05,
      bin.at.y + 0.3,
      bin.at.z + 0.05,
    );
    const withSauce = cutAway({ ...fridge, props: [...fridge.props, ...sauce.props] });
    const shown = withSauce.props.map((p) => p.id);
    expect(shown).toContain('sauce');
    expect(shown).toEqual(expect.arrayContaining(['fridge:bin-right-1', 'fridge:bin-right-3']));
    expect(shown).not.toContain('fridge:bin-left-1');
    expect(shown).not.toContain('fridge:door-right');
    // A fixture there does the same.
    const fixture = cutAway(fridge, [sauce.props[0]!]).props.map((p) => p.id);
    expect(fixture).toContain('fridge:bin-right-2');
  });
  it('sees the fridge from its left corner, its things turned with it', () => {
    const fridge = ISO_PRESETS.fridge;
    const milk = fridge.props.find((p) => p.id === 'milk')!;
    const item = { label: 'Milk', parts: [] };
    const left = fromAngle('left', {
      scene: fridge,
      objects: [],
      fixtures: [{ id: 'milk', label: 'Milk', box: milk, item, glow: false }],
      zones: [],
      trail: [{ x: 0.25, y: 0.75 }],
    });
    // A fixture lands where the turned scene puts the prop in its place.
    const turned = left.scene.props.find((p) => p.id === 'milk')!;
    expect(left.fixtures[0]!.box.at.x).toBeCloseTo(turned.at.x);
    expect(left.fixtures[0]!.box.at.y).toBeCloseTo(turned.at.y);
    expect(left.fixtures[0]!.box.size.w).toBeCloseTo(turned.size.w);
    // The front (+y) faces +x: the back is at the low x, the open doors past the cabinet.
    const at = (id: string) => left.scene.props.find((p) => p.id === id)!;
    expect(at('fridge:back').at.x).toBeLessThan(at('fridge:shelf-1').at.x);
    expect(at('fridge:door-right').at.x).toBeGreaterThan(
      at('fridge:shelf-1').at.x + at('fridge:shelf-1').size.w - 1e-9,
    );
    // A point on a surface turns with the surface it is on.
    expect(left.trail[0]).toEqual({ x: 0.75, y: 0.75 });
  });
  it('resizes the room, its walls stretched and the furniture kept inside', () => {
    const office = asCustom(ISO_PRESETS.office);
    const small = resizeRoom(office, { w: 6, d: 6 });
    expect(small.grid).toEqual({ w: 6, d: 6 });
    expect(isoSceneSchema.safeParse(small).success).toBe(true);
    expect(groupBounds(small, 'wall-back')!.size.w).toBe(6);
    expect(groupBounds(small, 'wall-left')!.size.d).toBeCloseTo(5.8);
    for (const g of ['desk', 'shelf', 'plant']) {
      const b = groupBounds(small, g)!;
      expect(b.at.x + b.size.w).toBeLessThanOrEqual(6 + 1e-9);
      expect(b.at.y + b.size.d).toBeLessThanOrEqual(6 + 1e-9);
    }
    // The desk moved back in, and what stands on it went along.
    const shift = groupBounds(small, 'desk')!.at.x - groupBounds(office, 'desk')!.at.x;
    expect(shift).toBeLessThan(0);
    for (const g of ridersOf(office, 'desk'))
      expect(groupBounds(small, g)!.at.x - groupBounds(office, g)!.at.x).toBeCloseTo(shift);
    // Made bigger, nothing moves.
    const big = resizeRoom(office, { w: 14, d: 10 });
    expect(groupBounds(big, 'wall-back')!.size.w).toBe(14);
    expect(groupBounds(big, 'desk')).toEqual(groupBounds(office, 'desk'));
    expect(groupBounds(big, 'shelf')).toEqual(groupBounds(office, 'shelf'));
  });
  it('settles tabletop things onto the surface under them, and back to the floor', () => {
    let scene = deskWithBook();
    expect(groupBounds(scene, 'book')!.at.z).toBe(0);
    scene = settleGroup(moveGroup(scene, 'book', 1.5, -4.5), 'book');
    expect(groupBounds(scene, 'book')!.at.z).toBeCloseTo(2.4);
    scene = settleGroup(moveGroup(scene, 'book', 5, 0), 'book');
    expect(groupBounds(scene, 'book')!.at.z).toBe(0);
    // A desk is not a tabletop thing: it never leaves the floor.
    expect(groupBounds(settleGroup(scene, 'desk'), 'desk')!.at.z).toBe(0);
  });
  it('adds templates where they fit and removes groups with their surfaces', () => {
    let scene = deskWithBook();
    const lamp = addTemplate(scene, 'lamp');
    expect(lamp.group).toBe('lamp');
    expect(groupBounds(lamp.scene, 'lamp')!.at.z).toBeCloseTo(2.4);
    const second = addTemplate(lamp.scene, 'lamp');
    expect(second.group).toBe('lamp-2');
    expect(overlappingGroups(second.scene).size).toBe(0);
    scene = removeGroup(second.scene, 'desk');
    expect(scene.surfaces).toHaveLength(0);
    expect(scene.props.some((p) => p.group === 'desk')).toBe(false);
  });
  it('flags groups that cut into each other', () => {
    const scene = deskWithBook();
    // Under the desk, on top of its back-left leg.
    const clash = moveGroup(scene, 'book', 1, -5);
    expect([...overlappingGroups(clash)].sort()).toEqual(['book', 'desk']);
  });
  it('rejects scenes outside the grid or with dangling surfaces', () => {
    const scene = deskWithBook();
    expect(isoSceneSchema.safeParse({ ...scene, grid: { w: 3, d: 3 } }).success).toBe(false);
    expect(
      isoSceneSchema.safeParse({
        ...scene,
        surfaces: [{ ...scene.surfaces[0]!, propId: 'nothing' }],
      }).success,
    ).toBe(false);
    expect(
      isoSceneSchema.safeParse({ ...scene, props: [...scene.props, scene.props[0]!] }).success,
    ).toBe(false);
  });
  it('builds a Spark layout with tabletop things on their surfaces', () => {
    expect(sceneDraftSchema.safeParse(demoSceneDraft).success).toBe(true);
    expect(
      sceneDraftSchema.safeParse({
        ...demoSceneDraft,
        items: [{ template: 'spaceship', x: 0, y: 0, turns: 0 }],
      }).success,
    ).toBe(false);
    const scene = buildScene(demoSceneDraft);
    expect(isoSceneSchema.safeParse(scene).success).toBe(true);
    // The editor warns over Spark's summary when props cut into each other.
    expect([...overlappingGroups(scene)]).toEqual([]);
    expect(groupBounds(scene, 'book')!.at.z).toBeCloseTo(2.4);
    expect(groupBounds(scene, 'lamp')!.at.z).toBeCloseTo(2.4);
    const order = depthOrder(scene.props).map((p) => p.id);
    expect(order.indexOf('desk')).toBeLessThan(order.indexOf('book'));
  });
});

async function setup(env: Record<string, string> = {}) {
  const { app, post, fetcher } = await testApp({ name: 'scene', env });
  const segment = async (demoPosition?: string) =>
    (await post('segment', { concept: 'mug', ...(demoPosition ? { demoPosition } : {}) })).json<
      EvidenceRun<Segmentation>
    >();
  return { app, post, segment, fetcher };
}
type Checked = { memory: DeskMemory; events: EvidenceRun<PlacementDecision>[] };

describe('custom scenes and layout drafts', () => {
  it('drafts the demo layout offline, saves it, and pins its surfaces', async () => {
    const s = await setup();
    const run = (await s.post('scene/draft')).json<
      EvidenceRun<{ draft: unknown; scene: IsoScene }>
    >();
    expect(run.kind).toBe('layout');
    expect(run.output.scene.kind).toBe('custom');
    expect(s.fetcher).not.toHaveBeenCalled();
    const saved = (await s.post('scene/save', { scene: run.output.scene })).json<DeskMemory>();
    expect(saved.scene?.props.length).toBe(run.output.scene.props.length);
    const corners = [
      { x: 10, y: 10 },
      { x: 950, y: 10 },
      { x: 950, y: 630 },
      { x: 10, y: 630 },
    ];
    const frame = { width: 960, height: 640 };
    const pin = { scene: 'custom', surfaceId: 'desk:top', corners, frame };
    expect((await s.post('desk/surface', { pin })).statusCode).toBe(200);
    expect(
      (await s.post('desk/surface', { pin: { ...pin, surfaceId: 'fridge:shelf-1' } })).statusCode,
    ).toBe(400);
    // A scene without that surface drops the pin, which would point at nothing.
    const bare = {
      ...run.output.scene,
      props: run.output.scene.props.filter(
        (p) =>
          p.group !== 'desk' &&
          p.template !== 'book' &&
          p.template !== 'lamp' &&
          p.template !== 'bottle',
      ),
      surfaces: run.output.scene.surfaces.filter((x) => x.propId !== 'desk'),
    };
    const dropped = (await s.post('scene/save', { scene: bare })).json<DeskMemory>();
    expect(dropped.surface).toBeNull();
    const reset = (await s.post('desk/reset')).json<DeskMemory>();
    expect(reset.scene?.label).toBe(run.output.scene.label);
  });
  it('refuses a scene that breaks the contract', async () => {
    const s = await setup();
    const scene = asCustom(ISO_PRESETS.desk);
    expect(
      (await s.post('scene/save', { scene: { ...scene, grid: { w: 2, d: 2 } } })).statusCode,
    ).toBe(400);
  });
});

describe('extra rules and lights', () => {
  async function withMug() {
    const s = await setup();
    const first = await s.segment();
    const memory = (
      await s.post('desk/select', { segmentRunId: first.id, detectionId: '7' })
    ).json<DeskMemory>();
    return { ...s, memory, objectId: mug(memory)!.id };
  }
  const whole = { x: 0, y: 0, width: 1, height: 1 };
  const corner = { x: 0, y: 0, width: 0.1, height: 0.1 };

  it('fires a rule’s own light on entering, once, and again only after leaving', async () => {
    const s = await withMug();
    const saved = (
      await s.post('desk/rules/save', {
        rule: { label: 'Desk', objects: [s.objectId], entityId: 'light.demo_shelf', rect: whole },
      })
    ).json<DeskMemory>();
    const rule = saved.rules![0]!;
    const first = (await s.post('desk/rules/verify')).json<Checked>();
    expect(first.events[0]!.output).toMatchObject({
      decision: 'inside',
      transition: 'entered',
      action: 'confirmed',
      ruleId: rule.id,
    });
    expect(first.events[0]!.output.lamp?.entityId).toBe('light.demo_shelf');
    const again = (await s.post('desk/rules/verify')).json<Checked>();
    expect(again.events[0]!.output).toMatchObject({ transition: 'stayed_inside', action: 'none' });
    // Shrink the zone so the mug leaves, then grow it back: a new story, a new entry.
    await s.post('desk/rules/save', {
      rule: {
        id: rule.id,
        label: 'Desk',
        objects: [s.objectId],
        entityId: 'light.demo_shelf',
        rect: corner,
      },
    });
    const out = (await s.post('desk/rules/verify')).json<Checked>();
    expect(out.events[0]!.output.decision).toBe('outside');
    await s.post('desk/rules/save', {
      rule: {
        id: rule.id,
        label: 'Desk',
        objects: [s.objectId],
        entityId: 'light.demo_shelf',
        rect: whole,
      },
    });
    // The same segmentation already acted for this rule: no second attempt.
    const repeat = (await s.post('desk/rules/verify')).json<Checked>();
    expect(repeat.events[0]!.output.decision).toBe('blocked');
    expect(repeat.events[0]!.output.action).toBe('none');
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('counts anything, and switches off again when the zone empties', async () => {
    const s = await withMug();
    await s.post('desk/rules/save', {
      rule: {
        label: 'Tray',
        objects: 'any',
        entityId: 'light.demo_shelf',
        offWhenEmpty: true,
        rect: whole,
      },
    });
    const first = (await s.post('desk/rules/verify')).json<Checked>();
    expect(first.events[0]!.output).toMatchObject({
      decision: 'inside',
      transition: 'entered',
      action: 'confirmed',
      objectId: s.objectId,
    });
    expect(first.memory.rules![0]!.inside).toEqual([s.objectId]);
    // The zone moves off the mug but keeps its story: it empties, and the light goes off.
    const rule = first.memory.rules![0]!;
    await s.post('desk/restore', {
      memory: { ...first.memory, rules: [{ ...rule, zone: { ...rule.zone, rect: corner } }] },
    });
    const left = (await s.post('desk/rules/verify')).json<Checked>();
    expect(left.events[0]!.output).toMatchObject({
      decision: 'outside',
      transition: 'left',
      action: 'confirmed',
    });
    expect(left.events[0]!.output.lamp).toMatchObject({
      entityId: 'light.demo_shelf',
      action: 'off',
    });
    expect(left.memory.rules![0]!.inside).toEqual([]);
    // Nothing to switch off without an entity.
    const none = await s.post('desk/rules/save', {
      rule: { label: 'X', objects: 'any', entityId: null, offWhenEmpty: true, rect: whole },
    });
    expect(none.statusCode).toBe(400);
  });
  it('checks rules on tracking, and keeps the main zone working beside them', async () => {
    const s = await withMug();
    await s.post('desk/camera', { fixed: true });
    await s.post('desk/rules/save', {
      rule: { label: 'Fridge', objects: [s.objectId], entityId: 'light.demo_fridge', rect: whole },
    });
    const next = await s.segment('right');
    const tracked = (await s.post('desk/track', { segmentRunId: next.id })).json<{
      memory: DeskMemory;
      rules: EvidenceRun<PlacementDecision>[];
    }>();
    expect(tracked.rules).toHaveLength(1);
    expect(tracked.rules[0]!.output).toMatchObject({ decision: 'inside', action: 'confirmed' });
    expect(tracked.memory.rules![0]!.placement).toBe('inside');
  });
  it('only accepts configured lights and needs a sighting', async () => {
    const s = await setup();
    const bad = await s.post('desk/rules/save', {
      rule: {
        label: 'X',
        objects: [crypto.randomUUID()],
        entityId: 'light.demo_desk',
        rect: whole,
      },
    });
    expect(bad.statusCode).toBe(409);
    const m = await withMug();
    const wrong = await m.post('desk/rules/save', {
      rule: { label: 'X', objects: [m.objectId], entityId: 'light.kitchen', rect: whole },
    });
    expect(wrong.statusCode).toBe(400);
  });
  it('remembers, tracks and forgets another object with its rules', async () => {
    const s = await withMug();
    const run = await s.segment('front');
    // The mug's current sighting comes from the first run, so this mask is free to name.
    const added = (
      await s.post('desk/objects/select', { segmentRunId: run.id, detectionId: '7', label: 'Cup' })
    ).json<Checked>();
    const cup = others(added.memory)![0]!;
    expect(cup).toMatchObject({ label: 'Cup', concept: 'mug' });
    // Where the cup was: the mug, still at the centre, has the nearer claim to a mug further off.
    const later = await s.segment('front');
    const tracked = (
      await s.post('desk/objects/track', { objectId: cup.id, segmentRunId: later.id })
    ).json<Checked>();
    expect(others(tracked.memory)![0]!.history).toHaveLength(1);
    expect(others(tracked.memory)![0]!.observation!.identity).toBe('tracked');
    await s.post('desk/rules/save', {
      rule: { label: 'Cup zone', objects: [cup.id], entityId: 'light.demo_desk', rect: whole },
    });
    const forgot = (await s.post('desk/objects/forget', { objectId: cup.id })).json<DeskMemory>();
    expect(others(forgot)).toHaveLength(0);
    expect(forgot.rules).toHaveLength(0);
    const draft = await s.post('item/draft', { source: 'sampled', objectId: cup.id });
    expect(draft.statusCode).toBe(409);
  });
  it('refuses the mug’s own mask as another object, and other concepts when tracking', async () => {
    const s = await withMug();
    const same = await s.post('desk/objects/select', {
      segmentRunId: sighting(s.memory)!.segmentRunId,
      detectionId: '7',
      label: 'Again',
    });
    expect(same.statusCode).toBe(409);
  });
});

describe('several lights', () => {
  it('parses extra light entities and needs a main one', () => {
    const c = parseConfig({
      HA_ENTITY_ID: 'light.desk',
      HA_EXTRA_ENTITY_IDS: 'light.shelf, light.fridge',
    });
    expect(c.haLights).toEqual(['light.desk', 'light.shelf', 'light.fridge']);
    expect(() =>
      parseConfig({ HA_ENTITY_ID: 'light.desk', HA_EXTRA_ENTITY_IDS: 'switch.fan' }),
    ).toThrow();
    expect(() => parseConfig({ HA_EXTRA_ENTITY_IDS: 'light.shelf' })).toThrow();
  });
  it('switches only configured lights', async () => {
    const config = parseConfig({
      HA_URL: 'http://ha.local:8123',
      HA_TOKEN: 't',
      HA_ENTITY_ID: 'light.desk',
      HA_EXTRA_ENTITY_IDS: 'light.shelf',
      HA_LIVE_ENABLED: 'true',
    });
    const calls: string[] = [];
    const fetcher: Fetcher = async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response(
        JSON.stringify(
          String(input).endsWith('turn_on')
            ? []
            : { state: 'on', attributes: { supported_color_modes: ['onoff'] } },
        ),
      );
    };
    const lamp = new ControlAdapter(config, fetcher, async () => {});
    const result = await lamp.turnOn('light.shelf');
    expect(result.entityId).toBe('light.shelf');
    expect(calls.some((c) => c.endsWith('/api/states/light.shelf'))).toBe(true);
    await expect(lamp.turnOn('light.kitchen')).rejects.toThrow();
  });
});

describe('close view of a photographed room', () => {
  function office() {
    const desk = placeTemplate('desk', 'desk', 3, 2);
    const top = desk.surfaces[0]!;
    const monitor = placeTemplate('monitor', 'monitor', 4, 2.5, top.z);
    const book = placeTemplate('book', 'book', 0, 6);
    return asCustom({
      kind: 'custom',
      label: 'Den',
      grid: { w: 10, d: 10 },
      props: [...desk.props, ...monitor.props, ...book.props],
      surfaces: [...desk.surfaces, ...monitor.surfaces, ...book.surfaces],
    });
  }

  it('keeps the desk and what stands on it, moved to the corner with its ids', () => {
    const room = office();
    const top = mainDesk(room)!;
    expect(top.propId.startsWith('desk')).toBe(true);
    const view = closeViewOf(room)!;
    expect(view.label).toBe('Office desk');
    expect(new Set(view.props.map((p) => p.group))).toEqual(new Set(['desk', 'monitor']));
    expect(Math.min(...view.props.map((p) => p.at.x))).toBe(1);
    expect(Math.min(...view.props.map((p) => p.at.y))).toBe(1);
    const moved = view.surfaces.find((s) => s.id === top.id)!;
    expect(moved.rect.w).toBe(top.rect.w);
    expect(moved.rect.x - top.rect.x).toBe(-2);
    expect(isoSceneSchema.safeParse(view).success).toBe(true);
    // The shift takes a room point into the close view.
    const shift = closeViewShift(room)!;
    expect(top.rect.x + shift.dx).toBe(moved.rect.x);
    expect(top.rect.y + shift.dy).toBe(moved.rect.y);
  });

  it('has none without a desk or table', () => {
    const shelf = placeTemplate('shelf', 'shelf', 1, 1);
    const room = asCustom({ ...office(), props: shelf.props, surfaces: shelf.surfaces });
    expect(mainDesk(room)).toBeNull();
    expect(closeViewOf(room)).toBeNull();
  });
});
