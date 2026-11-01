import { z } from 'zod';
import { ISO_TONES } from './iso-furniture.js';
import { hexColorSchema, ITEM_MATERIALS } from './iso-item.js';

/**
 * A recipe: a model as data, in real centimetres, for things no built-in
 * form covers (an IKEA Alex desk with its drawer unit). The AI brush writes
 * and edits recipes ([plan](../../../docs/plans/ai-brush.md)); a prop that
 * carries one is drawn from it by `propModel`, so the voxel kernel, the
 * camera's silhouettes and the room renderer see it like any other model.
 *
 * Every part has a name and may have a role, which is what an edit picks
 * parts by: "make the drawers white" is every part whose role is `drawer`.
 * Parts are measured from the model's back-left-bottom corner, facing +y
 * (toward the viewer, or away from the wall), like the furniture builders.
 */
export const RECIPE_ROLES = [
  'top',
  'leg',
  'rail',
  'panel',
  'drawer',
  'door',
  'shelf',
  'handle',
  'body',
  'shade',
  'base',
] as const;
export type RecipeRole = (typeof RECIPE_ROLES)[number];
export const MAX_RECIPE_PARTS = 48;

const share = z.number().min(0).max(1);
const vecCm = z.object({ x: z.number(), y: z.number(), z: z.number() }).strict();
const sizeCm = z
  .object({ w: z.number().positive(), d: z.number().positive(), h: z.number().positive() })
  .strict();
const nameSchema = z.string().regex(/^[a-z0-9-]{1,24}$/, 'A part name is lowercase, digits and -.');

export const recipePartSchema = z
  .object({
    name: nameSchema,
    role: z.enum(RECIPE_ROLES).optional(),
    shape: z.enum(['rbox', 'lathe', 'tube', 'blob']),
    atCm: vecCm,
    sizeCm,
    tone: z.enum(ISO_TONES),
    /** A colour of its own instead of the tone's; the tone still sets how it is shaded. */
    color: hexColorSchema.optional(),
    material: z.enum(ITEM_MATERIALS).optional(),
    /** rbox: the corner radius as a share of its smallest side. */
    radius: share.optional(),
    /** Lathe: (radius, height) as shares of the box, bottom to top. */
    profile: z
      .array(z.object({ r: share, z: share }).strict())
      .min(2)
      .max(16)
      .optional(),
    /** Lathe: an open top with walls this thick, as a share of the radius. */
    wall: z.number().min(0).max(0.9).optional(),
    /** Tube: its curve, as shares of the box, and its radius. */
    path: z
      .array(z.object({ x: share, y: share, z: share }).strict())
      .min(2)
      .max(4)
      .optional(),
    tubeCm: z.number().positive().max(20).optional(),
    /** Blob: how lumpy, 0 to 1. */
    rough: share.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.shape === 'lathe' && !p.profile)
      ctx.addIssue({ code: 'custom', message: `${p.name}: a lathe needs a profile.` });
    if (p.profile?.some((q, i) => i > 0 && q.z < p.profile![i - 1]!.z))
      ctx.addIssue({ code: 'custom', message: `${p.name}: a profile runs from bottom to top.` });
    if (p.shape === 'tube' && (!p.path || !p.tubeCm))
      ctx.addIssue({ code: 'custom', message: `${p.name}: a tube needs a path and tubeCm.` });
  });
export type RecipePart = z.infer<typeof recipePartSchema>;

/** Where a number in a recipe came from, so a review can show it. */
export const factSourceSchema = z
  .object({
    kind: z.enum(['web', 'image', 'catalog', 'photo', 'person']),
    title: z.string().min(1).max(120),
    url: z.url().optional(),
  })
  .strict();
export type FactSource = z.infer<typeof factSourceSchema>;

/** Rounding slack for parts measured to the recipe's edge. */
const EDGE_CM = 0.01;
export const fixtureRecipeSchema = z
  .object({
    label: z.string().min(1).max(60),
    /** The whole model's box; a prop drawn from it scales every part to the prop's box. */
    sizeCm: z
      .object({
        w: z.number().min(1).max(600),
        d: z.number().min(1).max(600),
        h: z.number().min(0.5).max(300),
      })
      .strict(),
    parts: z.array(recipePartSchema).min(1).max(MAX_RECIPE_PARTS),
    /** Parts whose tops things can stand on: a desktop, a shelf. */
    surfaces: z
      .array(z.object({ part: nameSchema, label: z.string().min(1).max(60) }).strict())
      .max(4)
      .optional(),
    sources: z.array(factSourceSchema).max(8).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const names = new Set<string>();
    for (const p of r.parts) {
      if (names.has(p.name))
        ctx.addIssue({ code: 'custom', message: `Two parts are called ${p.name}.` });
      names.add(p.name);
      const lo = [p.atCm.x, p.atCm.y, p.atCm.z];
      const hi = [p.atCm.x + p.sizeCm.w, p.atCm.y + p.sizeCm.d, p.atCm.z + p.sizeCm.h];
      const max = [r.sizeCm.w, r.sizeCm.d, r.sizeCm.h];
      if (lo.some((v) => v < -EDGE_CM) || hi.some((v, k) => v > max[k]! + EDGE_CM))
        ctx.addIssue({ code: 'custom', message: `${p.name} reaches outside the recipe's size.` });
    }
    for (const s of r.surfaces ?? [])
      if (!names.has(s.part))
        ctx.addIssue({ code: 'custom', message: `The surface ${s.label} names no part.` });
  });
export type FixtureRecipe = z.infer<typeof fixtureRecipeSchema>;

/** A short, stable key for a recipe's look, for caching its sprite. */
export function recipeKey(recipe: FixtureRecipe): string {
  const text = JSON.stringify(recipe);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
