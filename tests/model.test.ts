import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { expectGolden } from './lib/golden.js';
import {
  ARCHETYPES,
  applyCheck,
  buildItem,
  defaultFit,
  deltaE,
  fitItem,
  fuseFits,
  hexLab,
  isoItemSchema,
  isoSurface,
  latheProportions,
  paintAt,
  partPrims,
  renderSprite,
  renderView,
  rotateItem,
  syntheticCrop,
  voxelize,
  type IsoItem,
  type ItemPart,
  type LatheFit,
} from '@livinglayer/domain';
import { pinElevation } from '../apps/server/src/item.js';
import type { DeskMemory } from '@livinglayer/domain';

// These tests run the fitter and the sprite renderer: about a second at most
// on a quiet machine, but a busy one (a parallel build, say) stretches them
// several times over, past bun's 5 s default.
setDefaultTimeout(30_000);

const mug = (change: Partial<LatheFit> = {}): LatheFit => ({
  ...(defaultFit('mug', ['#2f5d8c', '#3b2416']) as LatheFit),
  ...change,
});
const occupied = (g: ReturnType<typeof voxelize>, x: number, y: number, z: number) => {
  const ix = Math.floor((x - g.origin[0]) / g.size);
  const iy = Math.floor((y - g.origin[1]) / g.size);
  const iz = Math.floor((z - g.origin[2]) / g.size);
  return g.occ[ix + g.nx * (iy + g.ny * iz)]! > 0;
};

describe('item spec', () => {
  it('asks each new shape for its own numbers and keeps profiles bottom to top', () => {
    const part = buildItem('Mug', mug()).parts[0]!;
    const ok = (p: Partial<ItemPart>) =>
      isoItemSchema.safeParse({ label: 'x', parts: [{ ...part, ...p }] }).success;
    expect(ok({})).toBe(true);
    expect(ok({ profile: undefined })).toBe(false);
    expect(
      ok({
        profile: [
          { r: 1, z: 0.6 },
          { r: 1, z: 0.2 },
        ],
      }),
    ).toBe(false);
    expect(ok({ shape: 'tube', path: undefined })).toBe(false);
    expect(ok({ shape: 'extrude' })).toBe(false);
    const decal = {
      kind: 'decal' as const,
      face: 'around' as const,
      u0: 0.25,
      u1: 0.75,
      v0: 0,
      v1: 1,
      turns: 0,
      w: 2,
      h: 2,
      colors: ['#ff0000'],
      data: '0..0',
    };
    expect(ok({ paint: [decal] })).toBe(true);
    expect(ok({ paint: [{ ...decal, data: '0..' }] })).toBe(false);
    expect(ok({ paint: [{ ...decal, data: '01..' }] })).toBe(false);
  });
  it('turns tubes, outlines and printed surfaces with the item', () => {
    const item = buildItem('Mug', mug());
    const handle = (i: IsoItem) => i.parts.find((p) => p.id === 'handle')!;
    const once = rotateItem(item);
    expect(handle(once).path![0]).toEqual({
      x: 1 - handle(item).path![0]!.y,
      y: handle(item).path![0]!.x,
      z: handle(item).path![0]!.z,
    });
    expect(rotateItem(item, 4)).toEqual(item);
    const printed: IsoItem = {
      label: 'x',
      parts: [
        {
          ...item.parts[0]!,
          paint: [
            {
              kind: 'decal',
              face: 'around',
              u0: 0.25,
              u1: 0.75,
              v0: 0,
              v1: 1,
              turns: 0,
              w: 1,
              h: 1,
              colors: ['#ff0000'],
              data: '0',
            },
          ],
        },
      ],
    };
    const turned = rotateItem(printed).parts[0]!.paint![0]!;
    expect(turned).toMatchObject({ u0: 0.5, u1: 1 });
  });
  it('paints bands and decals where they belong on the surface', () => {
    const body: ItemPart = {
      ...buildItem('Mug', mug()).parts[0]!,
      color: '#000000',
      paint: [
        { kind: 'band', from: 0.4, to: 0.6, color: '#ffffff' },
        {
          kind: 'decal',
          face: 'around',
          u0: 0.25,
          u1: 0.75,
          v0: 0,
          v1: 0.2,
          turns: 0,
          w: 2,
          h: 1,
          colors: ['#ff0000'],
          data: '0.',
        },
      ],
    };
    const c = { x: body.at.x + body.size.w / 2, y: body.at.y + body.size.d / 2 };
    const r = body.size.w / 2;
    const z = (v: number) => body.at.z + v * body.size.h;
    // u = 0.5 faces the viewer, along (1, 1).
    const front = (v: number) =>
      paintAt(body, c.x + r * Math.SQRT1_2, c.y + r * Math.SQRT1_2, z(v), 0);
    expect(front(0.5)).toBe('#ffffff');
    expect(front(0.9)).toBe('#000000');
    // Decal column 0 starts at u0 = 0.25, the viewer's right: world (1, -1).
    expect(paintAt(body, c.x + r * 0.92, c.y - r * 0.38, z(0.1), 0)).toBe('#ff0000');
    expect(paintAt(body, c.x - r * 0.38, c.y + r * 0.92, z(0.1), 0)).toBe('#000000');
  });
});

describe('model kernel', () => {
  it('measures signed distances for boxes, lathes and tubes', () => {
    const [box] = partPrims(
      {
        id: 'b',
        shape: 'rbox',
        at: { x: 0, y: 0, z: 0 },
        size: { w: 1, d: 1, h: 1 },
        color: '#ffffff',
        taper: 1,
        radius: 0,
      },
      0,
    );
    expect(box!.dist(0.5, 0.5, 0.5)).toBeCloseTo(-0.5);
    expect(box!.dist(2, 0.5, 0.5)).toBeCloseTo(1);
    const [lathe] = partPrims(buildItem('Mug', mug({ wall: 0 })).parts[0]!, 0);
    expect(lathe!.dist(0.5, 0.5, 0.3)).toBeLessThan(0);
    expect(lathe!.dist(1.5, 1.5, 0.3)).toBeGreaterThan(0);
  });
  it('voxelizes a mug with a hollow inside and a hole through the handle', () => {
    const item = buildItem('Mug', mug({ level: 0 }));
    const g = voxelize(item.parts, { resolution: 64 });
    const body = item.parts[0]!;
    const top = body.size.h;
    // The middle of the cup, just under the rim, is empty; the wall beside it is solid.
    expect(occupied(g, 0.5, 0.5, top * 0.9)).toBe(false);
    expect(occupied(g, 0.5 + body.size.w / 2 - 0.01, 0.5, top * 0.5)).toBe(true);
    // The handle sticks out to the viewer's right, world (1, -1); its loop has a hole.
    const handle = item.parts.find((p) => p.id === 'handle')!;
    const hc = { x: handle.at.x + handle.size.w / 2, y: handle.at.y + handle.size.d / 2 };
    // Up through the loop's middle: air, the lower arm, the hole, the upper arm, air.
    let column = '';
    for (let z = 0; z < top; z += g.size) column += occupied(g, hc.x, hc.y, z) ? '#' : '.';
    expect(column.replace(/(.)\1+/g, '$1')).toBe('.#.#.');
  });
  it('lights a sprite with darker outlines and keeps props to their palette', () => {
    const g = voxelize(buildItem('Box', defaultFit('box', ['#8a90a8', '#8a90a8'])).parts);
    const s = renderSprite(g, { scale: 1, shadow: false });
    const opaque: number[] = [];
    for (let p = 0; p < s.width * s.height; p++) if (s.rgba[p * 4 + 3] === 255) opaque.push(p);
    expect(opaque.length).toBeGreaterThan(500);
    const lab = (p: number) => {
      const hex = `#${[0, 1, 2].map((k) => s.rgba[p * 4 + k]!.toString(16).padStart(2, '0')).join('')}`;
      return hexLab(hex);
    };
    // The first opaque pixel in a row is an outline: darker than the pixel beside it.
    const row = Math.floor(s.height / 2);
    let x = 0;
    while (s.rgba[(x + row * s.width) * 4 + 3] !== 255) x++;
    expect(lab(x + row * s.width)[0]).toBeLessThan(lab(x + 2 + row * s.width)[0]);
    const palette = ['#202535', '#5b4c3f', '#c9c3b5'];
    const snapped = renderSprite(g, { scale: 1, shadow: false, palette });
    const allowed = new Set(palette);
    for (let p = 0; p < snapped.width * snapped.height; p++) {
      if (!snapped.rgba[p * 4 + 3]) continue;
      const hex = `#${[0, 1, 2].map((k) => snapped.rgba[p * 4 + k]!.toString(16).padStart(2, '0')).join('')}`;
      expect(allowed.has(hex)).toBe(true);
    }
  });
  it('draws the camera view squashed by the elevation', () => {
    const g = voxelize(buildItem('Can', defaultFit('can', ['#c4342c'])).parts, { resolution: 48 });
    const low = renderView(g, { elevation: 10, ppu: 100 });
    const high = renderView(g, { elevation: 60, ppu: 100 });
    // Seen from above, a tall can looks shorter and its top ellipse rounder.
    expect(high.height).toBeLessThan(low.height);
    expect(Math.abs(low.width - high.width)).toBeLessThanOrEqual(2);
  });
});

describe('a turned body’s proportions', () => {
  it('reads height over width at the base, middle and rim from the profile', () => {
    const fit = defaultFit('mug') as LatheFit;
    fit.radius = 0.5;
    fit.height = 1.2;
    fit.profile = [
      { r: 0.8, z: 0 },
      { r: 1, z: 1 },
    ];
    const p = latheProportions(fit);
    expect(p.rim).toBeCloseTo(1.2 / 0.99, 3);
    expect(p.middle).toBeCloseTo(1.2 / 0.9, 3);
    expect(p.base).toBeCloseTo(1.2 / 0.81, 3);
  });
});

describe('fitting a model to a photo', () => {
  const truth = buildItem(
    'Blue mug',
    mug({
      radius: 0.32,
      height: 0.95,
      bands: [{ from: 0.62, to: 0.78, color: '#f2efe6' }],
      colors: { body: '#2f5d8c', inside: '#2a4f78', liquid: '#3b2416', handle: '#2f5d8c' },
      level: 0.85,
    }),
  );
  it('recovers a mug’s proportions, handle, band, coffee and camera angle', () => {
    const crop = syntheticCrop(truth, { elevation: 35, ppu: 160 });
    const out = fitItem({ ...crop, label: 'Blue mug', archetype: 'mug' });
    const fit = out.params as LatheFit;
    expect(out.score.iou).toBeGreaterThan(0.93);
    expect(Math.abs(out.elevation - 35)).toBeLessThan(6);
    // The crop sets the scale, so compare shape, not size.
    expect(fit.height / fit.radius).toBeCloseTo(0.95 / 0.32, 0);
    expect(fit.handle).not.toBeNull();
    expect(fit.bands).toHaveLength(1);
    expect(fit.bands[0]!.from).toBeCloseTo(0.62, 1);
    expect(deltaE(hexLab(fit.bands[0]!.color), hexLab('#f2efe6'))).toBeLessThan(6);
    expect(deltaE(hexLab(fit.colors.body), hexLab('#2f5d8c'))).toBeLessThan(6);
    expect(deltaE(hexLab(fit.colors.liquid!), hexLab('#3b2416'))).toBeLessThan(6);
    expect(isoItemSchema.safeParse(out.item).success).toBe(true);
  });
  it('uses the pinned camera angle and SAM’s handle mask when they are given', () => {
    const crop = syntheticCrop(truth, { elevation: 50, ppu: 140 });
    const handle = new Uint8Array(crop.width * crop.height);
    // The handle is whatever sticks out right of the body's widest point.
    const body = Math.round(crop.width * 0.66);
    for (let y = 0; y < crop.height; y++)
      for (let x = body + 2; x < crop.width; x++)
        if (crop.rgba[(x + y * crop.width) * 4 + 3]) handle[x + y * crop.width] = 1;
    const out = fitItem({
      ...crop,
      label: 'Blue mug',
      archetype: 'mug',
      elevation: 50,
      parts: { handle },
    });
    expect(out.elevation).toBeCloseTo(50, -1);
    expect((out.params as LatheFit).handle).not.toBeNull();
    expect(out.score.iou).toBeGreaterThan(0.9);
  });
  it('unwraps vertical stripes into a decal with straight stripes', () => {
    const striped = buildItem('Striped can', {
      ...(defaultFit('can', ['#e8e2d0']) as LatheFit),
      material: 'matte',
    });
    striped.parts[0]!.paint = [
      { kind: 'stripes', count: 6, angle: 0, width: 0.5, color: '#b0302a' },
    ];
    const out = fitItem({
      ...syntheticCrop(striped, { elevation: 25, ppu: 160, light: 0 }),
      label: 'can',
      archetype: 'can',
    });
    const decal = (out.params as LatheFit).decal!;
    expect(decal).not.toBeNull();
    // Stripes run up the can, so in the middle rows each column keeps its colour.
    let same = 0;
    let total = 0;
    for (let c = 4; c < decal.w - 4; c++)
      for (let r = 8; r < decal.h - 8; r++) {
        total++;
        if (decal.data[r * decal.w + c] === decal.data[(r + 1) * decal.w + c]) same++;
      }
    expect(same / total).toBeGreaterThan(0.9);
  });
  it('fits a book as a box with its cover on top, and an odd shape as a box', () => {
    const book = buildItem('Book', defaultFit('book', ['#3c554a']));
    const out = fitItem({
      ...syntheticCrop(book, { elevation: 40, ppu: 160 }),
      label: 'Book',
      archetype: 'book',
      elevation: 40,
    });
    expect(out.params.family).toBe('box');
    // A box seen face-on can't tell depth from height, so the overlap is looser than a lathe's.
    expect(out.score.iou).toBeGreaterThan(0.8);
    if (out.params.family === 'box')
      expect(deltaE(hexLab(out.params.colors.top), hexLab('#3c554a'))).toBeLessThan(8);
    // A tall block with a low one beside it: nothing turned on a lathe looks like that.
    const block = (id: string, x: number, w: number, h: number): ItemPart => ({
      id,
      shape: 'rbox',
      at: { x, y: 0.3, z: 0 },
      size: { w, d: 0.3, h },
      color: '#8a90a8',
      taper: 1,
      radius: 0.05,
    });
    const wedge: IsoItem = {
      label: 'Stand',
      parts: [block('tall', 0, 0.3, 1), block('low', 0.3, 0.7, 0.25)],
    };
    const odd = fitItem({ ...syntheticCrop(wedge, { elevation: 30, ppu: 120 }), label: 'thing' });
    expect(odd.archetype).toBe('box');
  });
  it('averages sightings and keeps Spark’s nudges small', () => {
    const a = mug({ height: 1, radius: 0.3 });
    const b = mug({ height: 0.8, radius: 0.4 });
    const fused = fuseFits(a, 3, b) as LatheFit;
    expect(fused.height).toBeCloseTo(0.95);
    expect(fused.radius).toBeCloseTo(0.325);
    const nudged = applyCheck(a, {
      height: 3,
      radius: 0.1,
      handleReach: 1,
      body: '#112233',
      note: '',
    }) as LatheFit;
    expect(nudged.height).toBeCloseTo(1.2);
    expect(nudged.radius).toBeCloseTo(0.24);
    expect(nudged.colors.body).toBe('#112233');
  });
  it('reads the camera angle from how squashed the pinned surface looks', () => {
    const memory = {
      surface: {
        scene: 'desk',
        surfaceId: 'desk:top',
        corners: [
          { x: 100, y: 100 },
          { x: 500, y: 100 },
          { x: 500, y: 225 },
          { x: 100, y: 225 },
        ],
        frame: { width: 640, height: 480 },
      },
    } as DeskMemory;
    // A rectangle seen at elevation e looks sin(e) times as deep as it is.
    const { rect } = isoSurface('desk', 'desk:top')!;
    const expected = (Math.asin(125 / 400 / (rect.d / rect.w)) * 180) / Math.PI;
    expect(pinElevation(memory, 'live')).toBeCloseTo(expected, 1);
    expect(pinElevation(memory, 'demo')).toBeNull();
  });
});

/**
 * Reference sprites for every archetype: a change to the look shows up here
 * first. Set UPDATE_GOLDEN=1 to accept a new look; the PNGs double as a
 * review sheet.
 */
describe('reference sprites', () => {
  const colours: Record<string, string[]> = {
    mug: ['#d9cdb4', '#5a3d2b'],
    cup: ['#8a90a8'],
    bottle: ['#7fa08a', '#2f3b33'],
    can: ['#c4342c', '#dddddd'],
    book: ['#3c554a'],
    box: ['#8a90a8', '#b3a796'],
    plant: ['#c06a45', '#4d6a54'],
    lamp: ['#e8dcc0'],
    device: ['#3a3f47', '#4f5560'],
    generic: ['#8a90a8'],
  };
  for (const archetype of ARCHETYPES)
    it(`draws the ${archetype} as before`, async () => {
      const item = buildItem(archetype, defaultFit(archetype, colours[archetype]));
      const s = renderSprite(voxelize(item.parts, { resolution: 32 }), { scale: 1 });
      await expectGolden(archetype, s);
    });
});
