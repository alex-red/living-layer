import { describe, expect, it } from 'bun:test';
import { tempDir } from './lib/app.js';
import { StatRunner } from '../apps/server/src/stats.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import {
  DEMO_CAMERA,
  ISO_PRESETS,
  promoteBuiltIn,
  fixtureBox,
  followPower,
  followStats,
  defaultFixtureStates,
  monitorItem,
  screenPart,
  frameMean,
  powerLook,
  projectRoom,
  promoteGroup,
  quadBox,
  sampleQuadInto,
  screenInFrame,
  type Fixture,
  type IsoScene,
  type UnitQuad,
} from '@livinglayer/domain';

const office = (): IsoScene => ({ ...ISO_PRESETS.office, kind: 'custom' });
/** The office's monitor made a thing, as _Make it a thing_ makes it. */
function monitor() {
  const made = promoteGroup(office(), 'monitor')!;
  return { scene: made.scene, fixture: { ...made.fixture, state: null } as unknown as Fixture };
}

describe('a screen’s face in the room camera', () => {
  it('finds the panel, the side toward the camera, within the thing’s box', () => {
    const { scene, fixture } = monitor();
    const quad = screenInFrame(fixture, scene, DEMO_CAMERA)!;
    expect(quad).not.toBeNull();
    // Clockwise from the top left as the camera sees it.
    const [tl, tr, br, bl] = quad;
    expect(tl.x).toBeLessThan(tr.x);
    expect(bl.x).toBeLessThan(br.x);
    expect(tl.y).toBeLessThan(bl.y);
    expect(tr.y).toBeLessThan(br.y);
    // Inside what the camera sees of its whole box, and well short of all of it.
    const box = fixtureBox(fixture, scene);
    const { width: W, height: H } = DEMO_CAMERA.frame;
    const seen = [0, 1].flatMap((u) =>
      [0, 1].flatMap((v) =>
        [0, 1].map((t) => {
          const p = projectRoom(DEMO_CAMERA, {
            x: box.at.x + u * box.size.w,
            y: box.at.y + v * box.size.d,
            z: box.at.z + t * box.size.h,
          })!;
          return { x: p.x / W, y: p.y / H };
        }),
      ),
    );
    const around = quadBox(seen as unknown as UnitQuad);
    const face = quadBox(quad);
    expect(face.x).toBeGreaterThanOrEqual(around.x - 1e-6);
    expect(face.y).toBeGreaterThanOrEqual(around.y - 1e-6);
    expect(face.x + face.width).toBeLessThanOrEqual(around.x + around.width + 1e-6);
    expect(face.y + face.height).toBeLessThanOrEqual(around.y + around.height + 1e-6);
    expect(face.width * face.height).toBeLessThan(around.width * around.height * 0.8);
  });

  it('has none for what isn’t a screen, or stands in another room', () => {
    const { scene, fixture } = monitor();
    expect(screenInFrame({ ...fixture, label: 'Bookcase' }, scene, DEMO_CAMERA)).toBeNull();
    // A thing with no thin upright part has no panel to read.
    const block = {
      ...fixture,
      model: {
        label: 'monitor',
        parts: [
          {
            id: 'block',
            shape: 'rbox' as const,
            at: { x: 0, y: 0, z: 0 },
            size: { w: 1, d: 1, h: 1 },
            color: '#222222',
            material: 'matte' as const,
          },
        ],
      },
    } as unknown as Fixture;
    expect(screenInFrame(block, scene, DEMO_CAMERA)).toBeNull();
  });

  it('samples only inside the screen, so the wall round it doesn’t count', () => {
    const W = 200;
    const H = 100;
    // A dark room with a lit, slanted screen: a quad no box fits.
    const quad: UnitQuad = [
      { x: 0.3, y: 0.3 },
      { x: 0.7, y: 0.2 },
      { x: 0.7, y: 0.6 },
      { x: 0.3, y: 0.7 },
    ];
    const data = new Uint8Array(W * H).fill(40);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W;
        const v = (y + 0.5) / H;
        if (u < 0.3 || u > 0.7) continue;
        const k = (u - 0.3) / 0.4;
        if (v >= 0.3 - 0.1 * k && v <= 0.7 - 0.1 * k) data[y * W + x] = 220;
      }
    const frame = { width: W, height: H, data };
    const sample = sampleQuadInto(frame, quad, new Uint8Array(16 * 12), 16, 12);
    expect([...sample].every((v) => v === 220)).toBe(true);
    const look = powerLook(sample, frameMean(data));
    expect(look.contrast).toBe(0);
    expect(look.mean).toBeGreaterThan(1.5);
  });

  it('is where the stat runner reads a screen nobody follows', () => {
    const store = new EvidenceStore(tempDir('screen'));
    const runner = new StatRunner({ mode: 'demo', store, now: () => 1_000_000 });
    const memory = store.memory('demo');
    const input = promoteBuiltIn('office', 'monitor')!;
    const fixture = {
      ...input,
      id: 'screen',
      model: { ...input.model, source: 'demo', segmentRunId: null, swatches: [], updatedAt: '' },
      createdAt: '',
      updatedAt: '',
    } as unknown as Fixture;
    memory.fixtures = [fixture];
    memory.thingStats = { screen: [{ key: 'power' }] };
    store.saveMemory(memory);
    runner.sync();
    const region = runner.current().screen?.power?.region;
    const quad = screenInFrame(fixture, null, DEMO_CAMERA)!;
    expect(region).toEqual(quadBox(quad));
  });
});

describe('a screen showing what its power stat reads', () => {
  const things = [
    { id: 'a', state: null, states: { on: {}, off: {} }, control: { kind: 'none' } },
    // Switched by an entity: that sets its state.
    {
      id: 'b',
      state: null,
      states: { on: {}, off: {} },
      control: { kind: 'switch', entityId: 'switch.desk' },
    },
    // In a state of its own.
    { id: 'c', state: 'sleeping', states: { on: {}, off: {} }, control: { kind: 'none' } },
    { id: 'd', state: null, control: { kind: 'none' } },
  ] as unknown as Fixture[];
  it('reads both from the stats as they stream, occupied and power', () => {
    const shown = followStats(things, {
      a: { power: { value: true } },
      c: { power: { value: false } },
    } as never);
    expect(shown.map((f) => f.state)).toEqual(['on', null, 'sleeping', null]);
    expect(followStats(things, {})).toBe(things);
  });
  it('turns on and off with it, and leaves what it shouldn’t', () => {
    const on = followPower(things, () => true);
    expect(on.map((f) => f.state)).toEqual(['on', null, 'sleeping', null]);
    expect(followPower(on, () => true)).toBe(on);
    // No reading yet: as it is.
    expect(followPower(on, () => null)).toBe(on);
    expect(followPower(on, () => false).map((f) => f.state)).toEqual([
      'off',
      null,
      'sleeping',
      null,
    ]);
  });
});

describe('a screen in a model Spark drew', () => {
  // A monitor as Spark modelled the office's, facing +x: its parts named as it liked.
  const part = (id: string, at: number[], size: number[]) => ({
    id,
    shape: 'rbox' as const,
    at: { x: at[0]!, y: at[1]!, z: at[2]! },
    size: { w: size[0]!, d: size[1]!, h: size[2]! },
    color: '#111111',
    taper: 1,
    material: 'matte' as const,
  });
  const spark = {
    label: 'Monitor',
    parts: [
      part('rbox-4', [0.172, 0, 0.172], [0.028, 1, 0.5625]),
      part('rbox-3', [0.125, 0.2, 0.239], [0.055, 0.6, 0.394]),
      part('rbox-5', [0.197, 0.0125, 0.2], [0.02, 0.975, 0.522]),
      part('rbox-1', [0.031, 0.3125, 0], [0.281, 0.375, 0.023]),
      part('rbox-2', [0.078, 0.461, 0.023], [0.039, 0.078, 0.481]),
    ],
  };
  it('is the front panel, away from its stand, and a named screen is that', () => {
    expect(screenPart(spark)).toBe('rbox-5');
    expect(screenPart(monitorItem())).toBe('screen');
    expect(screenPart({ parts: [spark.parts[3]!] })).toBeNull();
  });
  it('lights in the thing’s own model, which keeps facing its own way', () => {
    const saved = { ...spark, source: 'spark', segmentRunId: null, swatches: [], updatedAt: '' };
    const { states } = defaultFixtureStates({ label: 'Monitor', model: saved as never });
    for (const [state, color] of [
      ['on', '#68b5e8'],
      ['off', '#2c3858'],
    ] as const) {
      const parts = states![state]!.model.parts;
      expect(parts.map((p) => p.id)).toEqual(spark.parts.map((p) => p.id));
      expect(parts.find((p) => p.id === 'rbox-5')!.color).toBe(color);
      expect(parts.find((p) => p.id === 'rbox-4')!.color).toBe('#111111');
    }
  });
});

describe('a monitor’s screen when it is switched', () => {
  /** The office's monitor promoted, with the states it is saved with. */
  function switched() {
    const input = promoteBuiltIn('office', 'monitor')!;
    // Saved as the server saves it, with the fields a save adds.
    const model = {
      ...input.model,
      source: 'demo',
      segmentRunId: null,
      swatches: [],
      updatedAt: '',
    } as Parameters<typeof defaultFixtureStates>[0]['model'];
    const states = defaultFixtureStates({ label: input.label, control: 'switch', model }).states!;
    const id = screenPart(model)!;
    const part = (m: Pick<typeof model, 'parts'>) => m.parts.find((p) => p.id === id)!;
    return { base: part(model), on: part(states.on!.model), off: part(states.off!.model) };
  }

  it('is deep enough to draw when it faces the room, lit or dark', () => {
    const { on, off } = switched();
    expect(on.size.d).toBeGreaterThanOrEqual(0.04);
    expect(off.size.d).toBeGreaterThanOrEqual(0.04);
  });

  it('keeps its face where it was, growing back into the panel', () => {
    const { base, on } = switched();
    expect(on.at.y + on.size.d).toBeCloseTo(base.at.y + base.size.d, 6);
    expect(on.at.y).toBeLessThan(base.at.y);
  });
});
