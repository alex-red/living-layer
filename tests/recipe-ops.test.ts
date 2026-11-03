import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyRecipeOps,
  fixtureRecipeSchema,
  mirrorRecipe,
  RECIPE_OPS,
  recipeOpSchema,
  selectParts,
  type FixtureRecipe,
  type RecipeOp,
} from '@livinglayer/domain';

const ALEX = fixtureRecipeSchema.parse(
  JSON.parse(readFileSync(join(import.meta.dir, '../testdata/recipes/alex-desk.json'), 'utf8')),
);
const names = (r: FixtureRecipe, s: Parameters<typeof selectParts>[1]) =>
  selectParts(r, s).map((p) => p.name);
const apply = (...ops: RecipeOp[]) => {
  const result = applyRecipeOps(ALEX, ops);
  if (!result.ok) throw new Error(result.reason);
  return result;
};
const part = (r: FixtureRecipe, name: string) => r.parts.find((p) => p.name === name)!;

describe('part selectors', () => {
  it('picks by name, role and material together, then takes the exceptions out', () => {
    expect(names(ALEX, {})).toHaveLength(ALEX.parts.length);
    expect(names(ALEX, { roles: ['drawer'] })).toEqual(['drawer-1', 'drawer-2', 'drawer-3']);
    expect(names(ALEX, { roles: ['drawer'], except: { names: ['drawer-2'] } })).toEqual([
      'drawer-1',
      'drawer-3',
    ]);
    // A part with no material doesn't match a material filter.
    expect(names(ALEX, { materials: ['metal'] })).toEqual([]);
    expect(names(ALEX, { except: { roles: ['drawer', 'body'] } })).toEqual([
      'top',
      'panel-left',
      'back-rail',
    ]);
  });
});

describe('recipe ops', () => {
  it('paints the drawers green and leaves the rest as it was', () => {
    const { recipe, changed } = apply({
      op: 'recolor',
      parts: { roles: ['drawer'] },
      color: '#3f8f4a',
    });
    expect(changed).toEqual(['drawer-1', 'drawer-2', 'drawer-3']);
    expect(part(recipe, 'drawer-2').color).toBe('#3f8f4a');
    expect(part(recipe, 'top').color).toBeUndefined();
  });

  it('makes the frame metal', () => {
    const { recipe } = apply({
      op: 'rematerial',
      parts: { roles: ['panel', 'rail'] },
      material: 'metal',
    });
    expect(part(recipe, 'panel-left').material).toBe('metal');
    expect(names(recipe, { materials: ['metal'] })).toEqual(['panel-left', 'back-rail']);
  });

  it('widens the desk: the top stretches, the drawer unit moves with the right edge, the panel stays', () => {
    const { recipe } = apply({ op: 'resize', sizeCm: { w: 160 } });
    expect(recipe.sizeCm).toEqual({ w: 160, d: 60, h: 76 });
    expect(part(recipe, 'top').sizeCm.w).toBe(160);
    expect(part(recipe, 'drawer-unit').atCm.x).toBe(95 + 29);
    expect(part(recipe, 'drawer-unit').sizeCm.w).toBe(36);
    expect(part(recipe, 'panel-left').sizeCm.w).toBe(2.5);
    // The rail between them reaches the drawer unit still.
    const rail = part(recipe, 'back-rail');
    expect(rail.atCm.x + rail.sizeCm.w).toBe(124);
  });

  it('lowers the desk: the top stays as thick and the drawers keep their faces', () => {
    const { recipe } = apply({ op: 'resize', sizeCm: { h: 72 } });
    expect(part(recipe, 'top').atCm.z).toBe(69.5);
    expect(part(recipe, 'top').sizeCm.h).toBe(2.5);
    expect(part(recipe, 'panel-left').sizeCm.h).toBe(69.5);
    expect(part(recipe, 'drawer-1').sizeCm.h).toBe(23);
  });

  it('scales an axis evenly where stretching would squash a part to nothing', () => {
    // At 60 cm the rail between panel and drawer unit is shorter, but still there.
    expect(part(apply({ op: 'resize', sizeCm: { w: 60 } }).recipe, 'drawer-unit').sizeCm.w).toBe(
      36,
    );
    // At 30 cm it would end before it starts, so everything scales.
    const { recipe } = apply({ op: 'resize', sizeCm: { w: 30 } });
    expect(part(recipe, 'drawer-unit').sizeCm.w).toBeCloseTo((36 * 30) / 131);
    expect(part(recipe, 'top').sizeCm.w).toBeCloseTo(30);
  });

  it('resizes chosen parts against the edge they touch', () => {
    const { recipe } = apply({
      op: 'resize',
      parts: { names: ['drawer-unit'] },
      sizeCm: { w: 40 },
    });
    // It touches the right edge, so it grows to the left.
    expect(part(recipe, 'drawer-unit').atCm.x).toBe(91);
    // A part pushed outside the model is refused, naming the op.
    const out = applyRecipeOps(ALEX, [
      { op: 'rename', label: 'Desk' },
      { op: 'resize', parts: { names: ['top'] }, sizeCm: { h: 10 } },
    ]);
    expect(out).toEqual({ ok: false, at: 1, reason: "top reaches outside the recipe's size." });
  });

  it('adds a part, refusing a name already used', () => {
    const shelf = {
      name: 'shelf',
      role: 'shelf' as const,
      shape: 'rbox' as const,
      atCm: { x: 2.5, y: 0, z: 30 },
      sizeCm: { w: 92.5, d: 30, h: 2 },
      tone: 'paper' as const,
    };
    expect(apply({ op: 'add_part', part: shelf }).recipe.parts).toHaveLength(ALEX.parts.length + 1);
    expect(applyRecipeOps(ALEX, [{ op: 'add_part', part: { ...shelf, name: 'top' } }])).toEqual({
      ok: false,
      at: 0,
      reason: 'There is already a part called top.',
    });
  });

  it('removes parts with their surfaces, but never the whole model', () => {
    const { recipe, changed } = apply({ op: 'remove_part', parts: { names: ['top'] } });
    expect(changed).toEqual(['top']);
    expect(recipe.surfaces).toEqual([]);
    expect(applyRecipeOps(ALEX, [{ op: 'remove_part', parts: {} }])).toMatchObject({ ok: false });
    expect(
      applyRecipeOps(ALEX, [{ op: 'remove_part', parts: { roles: ['shade'] } }]),
    ).toMatchObject({ ok: false, reason: 'No part of the model matches that.' });
  });

  it('checks ops by schema, and has an apply and a line for each kind', () => {
    expect(recipeOpSchema.safeParse({ op: 'recolor', parts: {}, color: 'green' }).success).toBe(
      false,
    );
    expect(recipeOpSchema.safeParse({ op: 'resize', sizeCm: {} }).success).toBe(false);
    expect(recipeOpSchema.safeParse({ op: 'explode' }).success).toBe(false);
    const kinds = recipeOpSchema.options.map((o) => o.shape.op.value);
    expect(Object.keys(RECIPE_OPS).sort()).toEqual([...kinds].sort());
  });
});

describe('a model’s mirror image', () => {
  it('puts the drawer unit on the other side, swaps left and right in names, and undoes itself', () => {
    const m = mirrorRecipe(ALEX);
    expect(fixtureRecipeSchema.safeParse(m).success).toBe(true);
    // 131 cm wide: the unit at 95 to 131 is now at 0 to 36, the left panel the right one.
    expect(part(m, 'drawer-unit').atCm.x).toBe(0);
    expect(part(m, 'panel-right').atCm.x).toBe(128.5);
    expect(m.parts.some((p) => p.name === 'panel-left')).toBe(false);
    expect(m.surfaces).toEqual(ALEX.surfaces);
    expect(mirrorRecipe(m)).toEqual(ALEX);
  });
});
