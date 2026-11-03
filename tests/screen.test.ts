import { describe, expect, it } from 'bun:test';
import { tempDir } from './lib/app.js';
import { StatRunner } from '../apps/server/src/stats.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import {
  DEMO_CAMERA,
  ISO_PRESETS,
  promoteBuiltIn,
  fixtureBox,
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
