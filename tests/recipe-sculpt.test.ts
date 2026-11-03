import { describe, expect, it } from 'bun:test';
import { uprightTilt } from '../apps/server/src/brush-sculpt.js';
import {
  DEMO_CAMERA,
  brushSculptPrompt,
  placeRecipe,
  propSolids,
  recipeFromForm,
  recipeFromSculpt,
  recipeToSculpt,
  type SculptPart,
} from '@livinglayer/domain';

const shelf = () => recipeFromForm('bookcase', { w: 71.25, d: 39.84, h: 165 }, 'White shelf');
const part = (id: string, at: SculptPart['at'], size: SculptPart['size'], color: string) =>
  ({
    id,
    shape: 'rbox',
    at,
    size,
    color,
    material: 'wood',
    profile: null,
    path: null,
    outline: null,
    radius: 0.05,
    rough: null,
    wall: null,
    inside: null,
    bands: null,
    prints: null,
  }) satisfies SculptPart;

describe('a brush model shaped from the photo', () => {
  it('goes out in shares of its longer side and comes back in centimetres, in its box', () => {
    const r = shelf();
    const out = recipeToSculpt(r);
    expect(out).toHaveLength(r.parts.length);
    expect(Math.max(...out.map((p) => p.at.x + p.size.w))).toBeCloseTo(1, 2);
    // An open frame: two uprights and five white shelves, one reaching past the box.
    const H = 165 / 71.25;
    const parts = [
      part('left-post', { x: 0, y: 0, z: 0 }, { w: 0.04, d: 0.56, h: H }, '#c8a77a'),
      // Flush with the right side, as Spark wrote one: rounding mustn't push it past the box.
      part('right-post', { x: 0.965, y: 0, z: 0 }, { w: 0.035, d: 0.56, h: H + 0.3 }, '#c8a77a'),
      ...[0, 1, 2, 3, 4].map((i) =>
        part(
          `Shelf ${i + 1}`,
          { x: 0.04, y: 0, z: (i * H) / 4.2 },
          { w: 0.92, d: 0.56, h: 0.03 },
          '#f2f0eb',
        ),
      ),
    ];
    const back = recipeFromSculpt(r, { parts, note: 'Open frame' })!;
    expect(back).not.toBeNull();
    expect(back.sizeCm).toEqual(r.sizeCm);
    expect(back.parts.map((p) => p.name)).toEqual([
      'left-post',
      'right-post',
      'shelf-1',
      'shelf-2',
      'shelf-3',
      'shelf-4',
      'shelf-5',
    ]);
    for (const p of back.parts) expect(p.atCm.z + p.sizeCm.h).toBeLessThanOrEqual(165);
    expect(back.parts[2]).toMatchObject({ role: 'shelf', color: '#f2f0eb' });
    expect(back.parts[2]!.sizeCm.w).toBeCloseTo(65.5, 0);
  });

  it('leaves out a part that can’t be one, and gives up only when none is left', () => {
    const r = shelf();
    const bad = { ...part('pot', { x: 0, y: 0, z: 0 }, { w: 0.5, d: 0.5, h: 0.5 }, '#ffffff') };
    const lathe = {
      ...bad,
      shape: 'lathe' as const,
      profile: [
        { r: 1, z: 1 },
        { r: 1, z: 0 },
      ],
    };
    expect(recipeFromSculpt(r, { parts: [lathe, bad], note: '' })!.parts).toHaveLength(2);
    expect(recipeFromSculpt(r, { parts: [], note: '' })).toBeNull();
  });

  it('keeps a leaning rail a tube, which a camera sees as a rail, not the slab its box spans', () => {
    const r = shelf();
    const D = 39.84 / 71.25;
    const H = 165 / 71.25;
    const rail = {
      ...part('left-rail', { x: 0, y: 0, z: 0 }, { w: 0.04, d: D, h: H }, '#c8a77a'),
      shape: 'tube' as const,
      radius: 0.02,
      path: [
        { x: 0.5, y: 1, z: 0 },
        { x: 0.5, y: 0, z: 1 },
      ],
    };
    const back = recipeFromSculpt(r, { parts: [rail], note: '' })!;
    expect(back.parts[0]).toMatchObject({ shape: 'tube', tubeCm: 1.4 });
    const prop = placeRecipe(back, 'shelf', 0, 0).props[0]!;
    const solids = propSolids(prop);
    expect(solids.length).toBeGreaterThan(4);
    // Each piece is a short stretch of the rail, so together they cover a small share of its box.
    const volume = (b: { size: { w: number; d: number; h: number } }) =>
      b.size.w * b.size.d * b.size.h;
    const covered = solids.reduce((s, x) => s + volume(x.box), 0);
    expect(covered / volume(prop)).toBeLessThan(0.25);
  });

  it('asks for the thing itself, in its size, with what the person said', () => {
    const p = brushSculptPrompt(shelf(), 'it is an open shelf with white shelves', 'first');
    expect(p).toContain('The person asked: "it is an open shelf with white shelves"');
    expect(p).toContain('71.25 × 39.84 × 165 cm');
    expect(p).toContain('leave out what stands on it');
    expect(p).toContain('anything that leans or slants');
    expect(p).not.toContain('standing straight up');
  });

  it('says where the camera draws an upright, so a tilted post is not read as leaning', () => {
    const { width } = DEMO_CAMERA.frame;
    const y = DEMO_CAMERA.frame.height / 2;
    // A camera looking down draws uprights spreading apart as they rise: leftwards on the left, rightwards on the right.
    const left = uprightTilt(DEMO_CAMERA, { x: width * 0.1, y });
    const right = uprightTilt(DEMO_CAMERA, { x: width * 0.9, y });
    expect(left).toBeLessThan(-1);
    expect(right).toBeGreaterThan(1);
    const p = brushSculptPrompt(shelf(), 'an open shelf', 'again', right);
    expect(p).toContain(`about ${Math.round(right)}° to the right of the picture's vertical`);
    expect(p).toContain('Posts and sides at that angle stand straight');
    expect(brushSculptPrompt(shelf(), 'x', 'first', 0.3)).toContain('runs straight up the picture');
  });
});
