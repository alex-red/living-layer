import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cm,
  depthOrder,
  fixtureRecipeSchema,
  hexLab,
  isoSceneSchema,
  placeRecipe,
  propModel,
  propSolids,
  propSpriteKey,
  renderPropSprite,
  rotateGroup,
  type FixtureRecipe,
  type IsoScene,
} from '../packages/domain/src/index.js';
import { drawProps } from '../scripts/lib/draw.js';
import { expectGolden } from './lib/golden.js';

const EPS = 1e-6;
const ALEX = fixtureRecipeSchema.parse(
  JSON.parse(readFileSync(join(import.meta.dir, '../testdata/recipes/alex-desk.json'), 'utf8')),
);
const scene = (recipe: FixtureRecipe = ALEX): IsoScene => ({
  kind: 'custom',
  label: 'Recipe',
  grid: { w: 12, d: 12 },
  ...placeRecipe(recipe, 'alex', 2, 2),
});
const part = (name: string) => ALEX.parts.find((p) => p.name === name)!;

describe('recipes', () => {
  it('refuses a part outside the recipe, a name used twice, and a surface on no part', () => {
    const issues = (r: unknown) =>
      fixtureRecipeSchema.safeParse(r).error?.issues.map((i) => i.message) ?? [];
    const outside = { ...part('top'), atCm: { x: 10, y: 0, z: 73.5 } };
    expect(issues({ ...ALEX, parts: [...ALEX.parts.slice(1), outside] })).toEqual([
      "top reaches outside the recipe's size.",
    ]);
    expect(issues({ ...ALEX, parts: [...ALEX.parts, part('top')] })).toEqual([
      'Two parts are called top.',
    ]);
    expect(issues({ ...ALEX, surfaces: [{ part: 'shelf', label: 'Shelf' }] })).toEqual([
      'The surface Shelf names no part.',
    ]);
    expect(issues({ ...ALEX, parts: [{ ...part('top'), shape: 'lathe' }] })).toEqual([
      'top: a lathe needs a profile.',
    ]);
  });

  it('places one prop at its real size, with a surface on the part it names', () => {
    const s = scene();
    expect(isoSceneSchema.safeParse(s).success).toBe(true);
    expect(s.props).toHaveLength(1);
    const prop = s.props[0]!;
    expect(prop.size.w).toBeCloseTo(cm(131));
    expect(prop.size.h).toBeCloseTo(cm(76));
    expect(prop.tone).toBe('paper');
    expect(s.surfaces).toHaveLength(1);
    const top = s.surfaces[0]!;
    expect({ id: top.id, label: top.label, propId: top.propId }).toEqual({
      id: 'alex:top',
      label: 'Desktop',
      propId: 'alex',
    });
    expect(top.rect).toEqual({ x: 2, y: 2, w: cm(131), d: cm(60) });
    expect(top.z).toBeCloseTo(cm(76));
  });

  it('keeps every part inside its prop at every quarter turn, and comes back after four', () => {
    let s = scene();
    const before = propModel(s.props[0]!);
    for (let turn = 0; turn < 4; turn++) {
      const p = s.props[0]!;
      expect(p.turns ?? 0).toBe(turn);
      for (const q of propModel(p)!) {
        expect(Math.min(q.at.x, q.at.y, q.at.z)).toBeGreaterThanOrEqual(-EPS);
        expect(q.at.x + q.size.w).toBeLessThanOrEqual(p.size.w + EPS);
        expect(q.at.y + q.size.d).toBeLessThanOrEqual(p.size.d + EPS);
        expect(q.at.z + q.size.h).toBeLessThanOrEqual(p.size.h + EPS);
      }
      s = rotateGroup(s, 'alex');
    }
    expect(propModel(s.props[0]!)).toEqual(before);
  });

  it('scales its parts with the prop, so a wider desk keeps its drawer unit at the same share', () => {
    const wide = placeRecipe(ALEX, 'alex', 0, 0, 0, { w: cm(262), d: cm(60), h: cm(76) });
    const unit = propModel(wide.props[0]!)![ALEX.parts.indexOf(part('drawer-unit'))]!;
    expect(unit.at.x).toBeCloseTo(cm(95) * 2);
    expect(unit.size.w).toBeCloseTo(cm(36) * 2);
    expect(unit.size.h).toBeCloseTo(cm(73.5));
  });

  it('shows a camera its parts, open under the desktop', () => {
    const prop = scene().props[0]!;
    const solids = propSolids(prop);
    expect(solids).toHaveLength(ALEX.parts.length);
    // Knee height in the middle of the desk is under no solid but the top.
    const at = { x: prop.at.x + cm(50), y: prop.at.y + cm(30), z: cm(40) };
    const inside = solids.filter(
      ({ box: b }) =>
        at.x >= b.at.x &&
        at.x <= b.at.x + b.size.w &&
        at.y >= b.at.y &&
        at.y <= b.at.y + b.size.d &&
        at.z >= b.at.z &&
        at.z <= b.at.z + b.size.h,
    );
    expect(inside).toEqual([]);
  });

  it('draws a colour of its own on top of the room palette, and caches by the recipe', () => {
    const green = {
      ...ALEX,
      parts: ALEX.parts.map((p) => ({ ...p, color: '#3f8f4a' })),
    };
    const plain = scene().props[0]!;
    const painted = scene(green).props[0]!;
    expect(propSpriteKey(painted, false)).not.toBe(propSpriteKey(plain, false));
    const s = renderPropSprite(painted, false);
    let greenish = 0;
    let opaque = 0;
    for (let i = 0; i < s.rgba.length; i += 4) {
      if (s.rgba[i + 3]! < 255) continue;
      opaque++;
      const hex = `#${[0, 1, 2].map((k) => s.rgba[i + k]!.toString(16).padStart(2, '0')).join('')}`;
      // OKLab b < 0 and a < 0 is green-ish; none of the room's light tones are.
      const [, a] = hexLab(hex);
      if (a! < -0.04) greenish++;
    }
    expect(greenish / opaque).toBeGreaterThan(0.8);
  });

  it('draws the Alex desk as before', async () => {
    await expectGolden('props/recipe-alex-desk', drawProps(depthOrder(scene().props)));
  });
});
