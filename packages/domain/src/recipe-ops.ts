import { z } from 'zod';
import { hexColorSchema, ITEM_MATERIALS } from './iso-item.js';
import {
  fixtureRecipeSchema,
  RECIPE_ROLES,
  recipePartSchema,
  type FixtureRecipe,
  type RecipePart,
} from './recipe.js';

/**
 * Edits to a recipe: a small, closed vocabulary the AI brush picks from
 * ([plan](../../../docs/plans/ai-brush.md#3-edit-operations-a-small-closed-vocabulary)).
 * Each op is checked by its schema and applied by a pure function, so
 * "make the drawers green" never asks a model to redraw geometry: Spark
 * chooses `recolor` with a selector, and this file does the rest. A new
 * ability is one more entry in `RECIPE_OPS`, with its tests.
 */

/**
 * Which parts an op touches. Every filter given must match (roles and
 * materials together mean "wooden drawers"), then the `except` filters
 * take parts back out. No filters at all is the whole model.
 */
export const partSelectorSchema = z
  .object({
    names: z.array(z.string().min(1).max(24)).min(1).max(48).optional(),
    roles: z.array(z.enum(RECIPE_ROLES)).min(1).optional(),
    materials: z.array(z.enum(ITEM_MATERIALS)).min(1).optional(),
    except: z
      .object({
        names: z.array(z.string().min(1).max(24)).min(1).max(48).optional(),
        roles: z.array(z.enum(RECIPE_ROLES)).min(1).optional(),
        materials: z.array(z.enum(ITEM_MATERIALS)).min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PartSelector = z.infer<typeof partSelectorSchema>;

type Filter = Omit<PartSelector, 'except'>;
const matches = (p: RecipePart, f: Filter) =>
  (!f.names || f.names.includes(p.name)) &&
  (!f.roles || (p.role !== undefined && f.roles.includes(p.role))) &&
  (!f.materials || (p.material !== undefined && f.materials.includes(p.material)));
const anyFilter = (f: Filter) => Boolean(f.names || f.roles || f.materials);
/** The parts a selector picks, in the recipe's order. */
export function selectParts(recipe: FixtureRecipe, s: PartSelector): RecipePart[] {
  return recipe.parts.filter(
    (p) => matches(p, s) && !(s.except && anyFilter(s.except) && matches(p, s.except)),
  );
}

const sizeChange = z
  .object({
    w: z.number().min(0.5).max(600).optional(),
    d: z.number().min(0.5).max(600).optional(),
    h: z.number().min(0.5).max(300).optional(),
  })
  .strict()
  .refine((s) => s.w !== undefined || s.d !== undefined || s.h !== undefined, {
    message: 'A resize needs at least one size.',
  });

export const recipeOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('recolor'), parts: partSelectorSchema, color: hexColorSchema }).strict(),
  z
    .object({
      op: z.literal('rematerial'),
      parts: partSelectorSchema,
      material: z.enum(ITEM_MATERIALS),
    })
    .strict(),
  z
    .object({
      op: z.literal('resize'),
      /** Without parts, the whole model; with them, those parts, in cm. */
      parts: partSelectorSchema.optional(),
      sizeCm: sizeChange,
    })
    .strict(),
  z.object({ op: z.literal('add_part'), part: recipePartSchema }).strict(),
  z.object({ op: z.literal('remove_part'), parts: partSelectorSchema }).strict(),
  z.object({ op: z.literal('rename'), label: z.string().min(1).max(60) }).strict(),
]);
export type RecipeOp = z.infer<typeof recipeOpSchema>;
export type RecipeOpKind = RecipeOp['op'];

/** What an op did, for the review: the recipe after it, and the parts it touched. */
export type OpResult =
  { ok: true; recipe: FixtureRecipe; changed: string[] } | { ok: false; reason: string };

const fail = (reason: string): OpResult => ({ ok: false, reason });
/** Parts picked, or a reason the selector found none. */
function picked(recipe: FixtureRecipe, s: PartSelector): RecipePart[] | string {
  const parts = selectParts(recipe, s);
  return parts.length ? parts : 'No part of the model matches that.';
}
/** The recipe with the picked parts changed by `fn`. */
function mapPicked(
  recipe: FixtureRecipe,
  s: PartSelector,
  fn: (p: RecipePart) => RecipePart,
): OpResult {
  const parts = picked(recipe, s);
  if (typeof parts === 'string') return fail(parts);
  const names = new Set(parts.map((p) => p.name));
  return {
    ok: true,
    recipe: { ...recipe, parts: recipe.parts.map((p) => (names.has(p.name) ? fn(p) : p)) },
    changed: [...names],
  };
}

const AXES = [
  { size: 'w', at: 'x' },
  { size: 'd', at: 'y' },
  { size: 'h', at: 'z' },
] as const;
/** Smallest a part may get when a resize stretches it, before the axis is scaled instead. */
const MIN_PART_CM = 0.5;
/**
 * The whole model another size. On each axis that changes, each end of a
 * part moves with the model's edge it is nearer: a desktop stretches, the
 * drawer unit at its right moves with the right edge at its own width, and
 * a side panel stays as thick. Where that would squash a part to nothing,
 * that axis scales evenly instead.
 */
function resizeWhole(recipe: FixtureRecipe, to: z.infer<typeof sizeChange>): FixtureRecipe {
  let parts = recipe.parts;
  const sizeCm = { ...recipe.sizeCm };
  for (const { size, at } of AXES) {
    const from = recipe.sizeCm[size];
    const next = to[size];
    if (next === undefined || next === from) continue;
    const delta = next - from;
    const end = (v: number) => (v > from / 2 ? v + delta : v);
    const stretched = parts.map((p) => {
      const lo = end(p.atCm[at]);
      const hi = end(p.atCm[at] + p.sizeCm[size]);
      return { ...p, atCm: { ...p.atCm, [at]: lo }, sizeCm: { ...p.sizeCm, [size]: hi - lo } };
    });
    const squashed = stretched.some((p, i) => {
      const was = parts[i]!.sizeCm[size];
      return p.sizeCm[size] < Math.min(MIN_PART_CM, was);
    });
    const k = next / from;
    parts = squashed
      ? parts.map((p) => ({
          ...p,
          atCm: { ...p.atCm, [at]: p.atCm[at] * k },
          sizeCm: { ...p.sizeCm, [size]: p.sizeCm[size] * k },
        }))
      : stretched;
    sizeCm[size] = next;
  }
  return { ...recipe, sizeCm, parts };
}
/**
 * Parts another size. Each keeps the model's edge it touches (a drawer
 * front stays on the front), else its middle; heights grow from its bottom.
 */
function resizePart(
  p: RecipePart,
  to: z.infer<typeof sizeChange>,
  box: FixtureRecipe['sizeCm'],
): RecipePart {
  const atCm = { ...p.atCm };
  const sizeCm = { ...p.sizeCm };
  for (const { size, at } of AXES) {
    const next = to[size];
    if (next === undefined) continue;
    const lo = p.atCm[at];
    const hi = lo + p.sizeCm[size];
    if (at === 'z' || lo <= 0.01) atCm[at] = lo;
    else if (hi >= box[size] - 0.01) atCm[at] = hi - next;
    else atCm[at] = (lo + hi) / 2 - next / 2;
    sizeCm[size] = next;
  }
  return { ...p, atCm, sizeCm };
}

/** Every op: what it is for (the parser's prompt lists these) and how it applies. */
export const RECIPE_OPS: {
  [K in RecipeOpKind]: {
    about: string;
    apply: (recipe: FixtureRecipe, op: Extract<RecipeOp, { op: K }>) => OpResult;
  };
} = {
  recolor: {
    about: 'Paint the chosen parts one colour ("make it green", "white drawers").',
    apply: (r, op) => mapPicked(r, op.parts, (p) => ({ ...p, color: op.color })),
  },
  rematerial: {
    about: 'Change how the chosen parts take light ("the legs are metal").',
    apply: (r, op) => mapPicked(r, op.parts, (p) => ({ ...p, material: op.material })),
  },
  resize: {
    about:
      'Set sizes in cm: of the whole model without parts ("it is 140 cm wide"), else of the chosen parts.',
    apply: (r, op) => {
      if (!op.parts)
        return { ok: true, recipe: resizeWhole(r, op.sizeCm), changed: r.parts.map((p) => p.name) };
      return mapPicked(r, op.parts, (p) => resizePart(p, op.sizeCm, r.sizeCm));
    },
  },
  add_part: {
    about: 'Add one part, measured in cm from the back-left-bottom corner, inside the model.',
    apply: (r, op) =>
      r.parts.some((p) => p.name === op.part.name)
        ? fail(`There is already a part called ${op.part.name}.`)
        : { ok: true, recipe: { ...r, parts: [...r.parts, op.part] }, changed: [op.part.name] },
  },
  remove_part: {
    about: 'Remove the chosen parts ("there is no drawer on the left").',
    apply: (r, op) => {
      const parts = picked(r, op.parts);
      if (typeof parts === 'string') return fail(parts);
      if (parts.length === r.parts.length) return fail('That would remove the whole model.');
      const gone = new Set(parts.map((p) => p.name));
      const surfaces = r.surfaces?.filter((s) => !gone.has(s.part));
      return {
        ok: true,
        recipe: {
          ...r,
          parts: r.parts.filter((p) => !gone.has(p.name)),
          ...(surfaces ? { surfaces } : {}),
        },
        changed: [...gone],
      };
    },
  },
  rename: {
    about: 'Give the model another name.',
    apply: (r, op) => ({ ok: true, recipe: { ...r, label: op.label }, changed: [] }),
  },
};

/**
 * Apply ops in order; `changed` names every part touched, removed ones too.
 * Stops at the first that can't apply, or whose result
 * isn't a valid recipe (a part pushed outside the model), and says which.
 */
export function applyRecipeOps(
  recipe: FixtureRecipe,
  ops: RecipeOp[],
):
  | { ok: true; recipe: FixtureRecipe; changed: string[] }
  | { ok: false; at: number; reason: string } {
  let current = recipe;
  const changed = new Set<string>();
  for (const [at, op] of ops.entries()) {
    const apply = RECIPE_OPS[op.op].apply as (r: FixtureRecipe, o: RecipeOp) => OpResult;
    const result = apply(current, op);
    if (!result.ok) return { ok: false, at, reason: result.reason };
    const checked = fixtureRecipeSchema.safeParse(result.recipe);
    if (!checked.success)
      return { ok: false, at, reason: checked.error.issues.map((i) => i.message).join(' ') };
    current = checked.data;
    for (const name of result.changed) changed.add(name);
  }
  return { ok: true, recipe: current, changed: [...changed] };
}
