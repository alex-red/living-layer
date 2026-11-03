import { describe, expect, it } from 'bun:test';
import type { DeskMemory, Fixture, PlacementRule } from '@livinglayer/domain';
import { emptyDesk } from '../apps/web/src/session.js';
import { homeOf, sceneChoices, sceneOutline } from '../apps/web/src/workspace/sceneOutline.js';
import type { WorkScene } from '../apps/web/src/workspace/progress.js';

// What the outline reads of a thing: where it stands, how it is placed, followed and switched.
const mug = {
  id: 'mug-1',
  label: 'Desk mug',
  scene: 'office',
  surfaceId: null,
  control: { kind: 'none' },
  type: 'mug',
  place: 'sightings',
  track: { status: 'seen' },
} as unknown as Fixture;
const fan = {
  id: 'fan-1',
  label: 'Floor fan',
  scene: 'office',
  surfaceId: null,
  control: { kind: 'switch', entityId: 'switch.fan' },
  state: 'off',
} as unknown as Fixture;
const zone = (id: string, onSurface?: object) =>
  ({
    id,
    label: id,
    objects: ['mug-1'],
    entityId: 'light.desk',
    zone: { sourceKey: 'k', rect: {}, frame: {}, ...(onSurface ? { onSurface } : {}) },
    placement: 'inside',
  }) as unknown as PlacementRule;

const demo = (patch: Partial<DeskMemory> = {}): DeskMemory => ({
  ...emptyDesk('demo'),
  fixtures: [mug, fan],
  rules: [zone('Mug zone')],
  ...patch,
});
const outline = (scene: WorkScene, memory = demo()) =>
  sceneOutline({ scene, memory, mode: 'demo', mainLight: 'light.desk', lightsOn: new Set() });

describe('the sidebar, one scene at a time', () => {
  it('offers each room followed by its close view, your own first', () => {
    expect(sceneChoices(demo()).map((c) => [c.scene, c.view])).toEqual([
      ['office', false],
      ['desk', true],
      ['fridge', false],
    ]);
  });

  it('lists what stands on the desk under the desk, pinned first, and nowhere else', () => {
    const desk = outline('desk');
    const top = desk.groups[0]!;
    expect(top).toMatchObject({ key: 'desk:top', pinned: true });
    expect(top.things.map((t) => t.label)).toContain('Desk mug');
    expect(top.things.find((t) => t.id === 'mug-1')).toMatchObject({
      kind: 'followed',
      status: 'seen',
      target: { kind: 'object', id: 'main' },
    });
    // The desk's lamp and book are drawn with it.
    expect(top.things.some((t) => t.lamp && t.kind === 'built-in')).toBe(true);
    expect(desk.followed).toEqual(['mug-1']);
    expect(desk.rules.map((r) => r.id)).toEqual(['Mug zone']);
    expect(desk.view).toBeNull();
  });

  it('lists the room’s own things, and its desk as one row of what it holds', () => {
    const office = outline('office');
    const labels = office.groups.flatMap((g) => g.things.map((t) => t.label));
    expect(labels).toContain('Floor fan');
    expect(labels).not.toContain('Desk mug');
    // The office's lamp stands on the desk, so the desk lists it, not the office.
    expect(office.groups.some((g) => g.things.some((t) => t.lamp))).toBe(false);
    const floor = office.groups.at(-1)!;
    expect(floor).toMatchObject({ key: 'floor', label: 'In the room' });
    expect(floor.things.find((t) => t.id === 'fan-1')).toMatchObject({
      kind: 'placed',
      status: 'still',
      detail: 'switch · off',
    });
    expect(office.view).toMatchObject({ scene: 'desk', rules: 1 });
    expect(office.view!.things).toBeGreaterThan(1);
    expect(office.rules).toEqual([]);
    expect(office.followed).toEqual([]);
  });

  it('puts a zone where it was drawn, and says what it switches and whether it is occupied', () => {
    const memory = demo({
      rules: [
        zone('On the desk', { scene: 'office', surfaceId: 'desk:top' }),
        zone('Fridge', { scene: 'fridge', surfaceId: 'nowhere' }),
      ],
    });
    expect(outline('desk', memory).rules.map((r) => r.id)).toEqual(['On the desk']);
    expect(outline('fridge', memory).rules[0]).toMatchObject({
      id: 'Fridge',
      detail: '→ light.desk · occupied',
      inside: true,
    });
  });

  it('shows a missing thing as missing, and a scene with nothing in it as empty', () => {
    const lost = { ...mug, track: { status: 'missing' } } as unknown as Fixture;
    const row = outline('desk', demo({ fixtures: [lost] })).groups[0]!.things.find(
      (t) => t.id === 'mug-1',
    );
    expect(row).toMatchObject({ status: 'missing', detail: 'missing' });
    expect(homeOf('office', 'desk:top')).toBe('desk');
    expect(homeOf('office', null)).toBe('office');
  });
});
