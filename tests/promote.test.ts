import { describe, expect, it } from 'bun:test';
import { testApp } from './lib/app.js';
import {
  ISO_PRESETS,
  MAX_ITEM_PARTS,
  cm,
  cornerCamera,
  fixtureModel,
  fixtureType,
  groupBounds,
  lightSources,
  projectRoom,
  occupantOf,
  promoteGroup,
  starterFixtureDraft,
  suggestedStats,
  type DeskMemory,
  type FixtureRecipe,
  type IsoBox,
  type IsoScene,
  type PhotoDraft,
} from '@livinglayer/domain';
import { draftCropOf } from '../apps/server/src/fixture/promote.js';

const office = (): IsoScene => ({ ...ISO_PRESETS.office, kind: 'custom' });

/** A floor lamp as a room scan built it: a top bowl, and a side shade on an arm at 90 cm. */
const SCANNED_LAMP: FixtureRecipe = {
  label: 'floor lamp',
  sizeCm: { w: 30.94, d: 15.47, h: 172.5 },
  parts: [
    {
      name: 'base',
      role: 'shelf',
      shape: 'lathe',
      atCm: { x: 4.6, y: 0, z: 0 },
      sizeCm: { w: 15.5, d: 15.47, h: 3.4 },
      tone: 'steel',
      color: '#141417',
      material: 'metal',
      profile: [
        { r: 1, z: 0 },
        { r: 1, z: 0.4 },
        { r: 0.85, z: 1 },
      ],
    },
    {
      name: 'pole',
      role: 'body',
      shape: 'tube',
      atCm: { x: 11.1, y: 6.5, z: 2.8 },
      sizeCm: { w: 2.5, d: 2.5, h: 154.7 },
      tone: 'steel',
      color: '#131316',
      material: 'metal',
      path: [
        { x: 0.5, y: 0.5, z: 0 },
        { x: 0.5, y: 0.5, z: 1 },
      ],
      tubeCm: 0.6,
    },
    {
      name: 'top-shade',
      role: 'top',
      shape: 'lathe',
      atCm: { x: 4.6, y: 0, z: 164.8 },
      sizeCm: { w: 15.5, d: 15.47, h: 7.69 },
      tone: 'glass',
      color: '#f5f5f0',
      material: 'glass',
      profile: [
        { r: 0.28, z: 0 },
        { r: 0.32, z: 0.2 },
        { r: 0.85, z: 0.7 },
        { r: 1, z: 1 },
      ],
    },
    {
      name: 'side-arm',
      role: 'rail',
      shape: 'tube',
      atCm: { x: 12.4, y: 6.5, z: 89.1 },
      sizeCm: { w: 11.8, d: 2.5, h: 5.6 },
      tone: 'steel',
      color: '#131316',
      material: 'metal',
      path: [
        { x: 0.05, y: 0.5, z: 0.2 },
        { x: 0.5, y: 0.5, z: 0.9 },
        { x: 0.95, y: 0.5, z: 0.55 },
      ],
      tubeCm: 0.6,
    },
    {
      name: 'side-shade',
      role: 'rail',
      shape: 'tube',
      atCm: { x: 21.7, y: 5, z: 90.3 },
      sizeCm: { w: 8.7, d: 5.6, h: 5.6 },
      tone: 'paper',
      color: '#f2f2ec',
      material: 'matte',
      path: [
        { x: 0.1, y: 0.5, z: 0.55 },
        { x: 0.9, y: 0.5, z: 0.35 },
      ],
      tubeCm: 2.3,
    },
  ],
};
const scannedLamp = (): IsoScene => ({
  ...office(),
  props: [
    {
      id: 'floor-lamp',
      label: 'floor lamp',
      shape: 'prism',
      at: { x: 0.9, y: 6.4, z: 0 },
      size: { w: cm(30.94), d: cm(15.47), h: cm(172.5) },
      tone: 'steel',
      group: 'floor-lamp',
      recipe: SCANNED_LAMP,
    },
  ],
  surfaces: [],
});

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
    expect(parts.length).toBeLessThanOrEqual(MAX_ITEM_PARTS);
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

  it('keeps a scanned lamp’s shades as light sources, each lit by its own entity', () => {
    const { model } = promoteGroup(scannedLamp(), 'floor-lamp')!.fixture;
    expect(lightSources(model)).toEqual([
      { part: 'shade-top', label: 'Top shade' },
      { part: 'shade-side', label: 'Side shade' },
    ]);
    const lights = [
      { part: 'shade-top', entityId: 'light.light_bulb_color_hue_1' },
      { part: 'shade-side', entityId: 'light.light_bulb_color_hue_2' },
    ];
    const warm = (lit: Record<string, boolean>, id: string) =>
      Boolean(
        fixtureModel({
          model: { ...model, source: 'demo', segmentRunId: null, swatches: [], updatedAt: '' },
          lights,
          lit,
        })
          .parts.find((p) => p.id === id)!
          .paint?.some((b) => 'color' in b && b.color === '#ffe299'),
      );
    expect(warm({ 'shade-side': true }, 'shade-side')).toBe(true);
    expect(warm({ 'shade-side': true }, 'shade-top')).toBe(false);
    expect(warm({ 'shade-top': true }, 'shade-top')).toBe(true);
  });

  it('draws a scanned lamp’s 1 cm pole as thick as a floor lamp’s, so its sprite still shows it', () => {
    const lamp = scannedLamp().props[0]!;
    const { model } = promoteGroup(scannedLamp(), 'floor-lamp')!.fixture;
    const L = Math.max(lamp.size.w, lamp.size.d);
    const tubes = model.parts.filter((p) => p.shape === 'tube');
    expect(tubes).toHaveLength(3);
    for (const t of tubes) expect((t.radius ?? 0) * L).toBeGreaterThanOrEqual(cm(2.5) - 1e-9);
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

describe('making a thing drawn with the room a thing of its own', () => {
  it('stands a preset’s built-in thing in for it, once', async () => {
    const { post } = await testApp({ name: 'promote-built-in', appearance: async () => null });
    const res = await post('fixtures/promote', { scene: 'fridge', group: 'milk' });
    expect(res.statusCode, res.body).toBe(200);
    const made = res.json<{ memory: DeskMemory; fixtureId: string; pictured: boolean }>();
    const milk = made.memory.fixtures!.find((f) => f.id === made.fixtureId)!;
    expect(milk).toMatchObject({ scene: 'fridge', builtIn: 'milk' });
    // A preset's photo isn't kept, so there is nothing to model it from.
    expect(made.pictured).toBe(false);
    const again = await post('fixtures/promote', { scene: 'fridge', group: 'milk' });
    expect(again.statusCode).toBe(409);
  });

  it('takes a group out of the person’s own layout, and refuses one that isn’t there', async () => {
    const { post } = await testApp({ name: 'promote-own', appearance: async () => null });
    expect((await post('scene/save', { scene: office() })).statusCode).toBe(200);
    const res = await post('fixtures/promote', { scene: 'custom', group: 'monitor' });
    expect(res.statusCode, res.body).toBe(200);
    const { memory, fixtureId } = res.json<{ memory: DeskMemory; fixtureId: string }>();
    expect(memory.scene!.props.some((p) => p.group === 'monitor')).toBe(false);
    expect(memory.fixtures!.find((f) => f.id === fixtureId)).toMatchObject({
      scene: 'custom',
      surfaceId: 'desk:top',
    });
    const gone = await post('fixtures/promote', { scene: 'custom', group: 'monitor' });
    expect(gone.statusCode).toBe(422);
  });

  it('pictures it by the room draft’s crop of the thing named like it, where the camera sees it', () => {
    const scene = office();
    const camera = cornerCamera(scene.grid, { frame: { width: 960, height: 640 } });
    const seen = (box: IsoBox) => {
      const pts = [0, 1].flatMap((u) =>
        [0, 1].flatMap((v) =>
          [0, 1].map((t) =>
            projectRoom(camera, {
              x: box.at.x + u * box.size.w,
              y: box.at.y + v * box.size.d,
              z: box.at.z + t * box.size.h,
            })!,
          ),
        ),
      );
      const x = Math.min(...pts.map((p) => p.x));
      const y = Math.min(...pts.map((p) => p.y));
      return {
        x,
        y,
        width: Math.max(...pts.map((p) => p.x)) - x,
        height: Math.max(...pts.map((p) => p.y)) - y,
      };
    };
    const monitor = groupBounds(scene, 'monitor')!;
    // Spark's id isn't the group's, and a plant stands just where the monitor is.
    const things = [
      { id: 'screen', label: 'Black monitor', as: 'monitor' },
      { id: 'plant', label: 'Potted plant', as: 'plant' },
    ];
    const draft = {
      inventory: { things },
      detections: { screen: 'o1', plant: 'o2' },
      crops: { screen: 'run/crop-screen.png', plant: 'run/crop-plant.png' },
      segmentation: {
        frame: camera.frame,
        detections: [
          { objectId: 'o1', box: seen(monitor) },
          { objectId: 'o2', box: seen(monitor) },
        ],
      },
    } as unknown as PhotoDraft;
    const name = { label: 'Monitor', template: 'monitor' };
    expect(draftCropOf(draft, camera, monitor, name)).toBe('run/crop-screen.png');
    // Named like nothing the draft cropped, it has no picture.
    expect(draftCropOf(draft, camera, monitor, { label: 'Bookcase' })).toBeNull();
    // Nor has a thing the camera sees somewhere else.
    const away = { ...monitor, at: { ...monitor.at, x: monitor.at.x + 4 } };
    expect(draftCropOf(draft, camera, away, name)).toBeNull();
  });
});
