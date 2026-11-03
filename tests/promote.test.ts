import { describe, expect, it } from 'bun:test';
import { testApp } from './lib/app.js';
import {
  ISO_PRESETS,
  fixtureType,
  occupantOf,
  promoteGroup,
  starterFixtureDraft,
  suggestedStats,
  type DeskMemory,
  type IsoScene,
} from '@livinglayer/domain';

const office = (): IsoScene => ({ ...ISO_PRESETS.office, kind: 'custom' });

describe('making a prop a thing', () => {
  it('takes a chair out of the layout as a fixture drawn the same, on the floor', () => {
    const scene = office();
    const chair = scene.props.find((p) => p.group === 'chair')!;
    const made = promoteGroup(scene, 'chair')!;
    expect(made.scene.props.some((p) => p.group === 'chair')).toBe(false);
    expect(made.scene.props).toHaveLength(scene.props.length - 1);
    expect(made.fixture).toMatchObject({
      label: chair.label,
      scene: 'custom',
      surfaceId: null,
      at: { x: chair.at.x, y: chair.at.y },
      control: { kind: 'none' },
    });
    for (const k of ['w', 'd', 'h'] as const)
      expect(made.fixture.size[k]).toBeCloseTo(chair.size[k], 6);
    // The chair's own model, in item units: its footprint's longer side is one.
    const parts = made.fixture.model.parts;
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.length).toBeLessThanOrEqual(12);
    const top = Math.max(...parts.map((p) => p.at.z + p.size.h));
    expect(top).toBeCloseTo(chair.size.h / Math.max(chair.size.w, chair.size.d), 1);
  });

  it('stands what was on the desk on the desk, keeps the layout’s other surfaces, and refuses a group that isn’t there', () => {
    const scene = office();
    const made = promoteGroup(scene, 'monitor')!;
    expect(made.fixture.surfaceId).toBe('desk:top');
    expect(made.scene.surfaces).toEqual(scene.surfaces);
    // A lamp and its shade are one group, and one thing.
    const lamp = promoteGroup(scene, 'lamp')!;
    expect(lamp.scene.props.some((p) => p.group === 'lamp')).toBe(false);
    expect(promoteGroup(scene, 'nothing')).toBeNull();
  });

  it('saves as the room without it and a fixture in its place, which can keep stats', async () => {
    const { post } = await testApp({ name: 'promote', appearance: async () => null });
    const made = promoteGroup(office(), 'chair')!;
    const saved = await post('scene/save', { scene: made.scene });
    expect(saved.statusCode, saved.body).toBe(200);
    const res = await post('fixtures/save', { fixture: made.fixture });
    expect(res.statusCode, res.body).toBe(200);
    const thing = res.json<DeskMemory>().fixtures!.at(-1)!;
    expect(thing.label).toBe(made.fixture.label);
    const stats = await post('things/stats', { id: thing.id, stats: [{ key: 'occupied' }] });
    expect(stats.statusCode, stats.body).toBe(200);
  });

  it('has a cat tree to start from, which keeps whether the cat is on it', () => {
    const tree = starterFixtureDraft('cat-tree');
    expect(tree.label).toBe('Cat tree');
    // 50 × 50 × 120 cm, a tile being 30 cm.
    expect(tree.size).toEqual({ w: 1.67, d: 1.67, h: 4 });
    expect(fixtureType({ model: tree.model })).toBe('cat-tree');
    expect(suggestedStats({ type: 'cat-tree', label: tree.label })).toEqual(['occupied']);
    expect(occupantOf(tree.label)).toBe('cat');
  });
});
