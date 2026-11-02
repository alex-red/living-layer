import type { IsoTone } from './iso.js';
import type { PropPart } from './iso-furniture.js';
import type { ItemMaterial } from './iso-item.js';
import { PROP_TONES } from './iso-prop-sprite.js';
import { SCULPT_FORMAT, type Sculpt, type SculptPart } from './item-sculpt.js';
import { guessRole } from './recipe-build.js';
import {
  fixtureRecipeSchema,
  MAX_RECIPE_PARTS,
  recipePartSchema,
  type FixtureRecipe,
  type RecipePart,
} from './recipe.js';

/**
 * The AI brush's model shaped from the camera's picture, as Model with AI
 * shapes a fixture: Spark sees the thing as the room's camera does beside
 * the model drawn through the same camera, and answers with its parts in
 * the sculpt format. A recipe goes out in that format (shares of its
 * footprint's longer side) and comes back in centimetres, inside the same
 * box: the size is what the camera and the lookup measured, the parts are
 * what Spark sees.
 */

/** The most parts a brush model is shaped in: shelves and frames take more than a mug. */
export const BRUSH_SCULPT_PARTS = 24;

const MATERIAL_TONE: Record<ItemMaterial, IsoTone> = {
  wood: 'wood',
  metal: 'steel',
  fabric: 'fabric',
  glass: 'glass',
  gloss: 'appliance',
  matte: 'paper',
};
const longest = (r: FixtureRecipe) => Math.max(r.sizeCm.w, r.sizeCm.d);
const round = (v: number) => Math.round(v * 10) / 10;

/** A recipe's parts as Spark writes them, in shares of its footprint's longer side. */
export function recipeToSculpt(recipe: FixtureRecipe): SculptPart[] {
  const L = longest(recipe);
  return recipe.parts.map((p) => ({
    id: p.name,
    shape: p.shape,
    at: { x: p.atCm.x / L, y: p.atCm.y / L, z: p.atCm.z / L },
    size: { w: p.sizeCm.w / L, d: p.sizeCm.d / L, h: p.sizeCm.h / L },
    color: (p.color ?? PROP_TONES[p.tone]).toLowerCase(),
    material: p.material ?? (p.tone === 'wood' ? 'wood' : 'matte'),
    profile: p.profile ?? null,
    path: p.path ?? null,
    outline: null,
    radius: p.shape === 'tube' ? (p.tubeCm ?? 1) / L : (p.radius ?? null),
    rough: p.rough ?? null,
    bands: null,
  }));
}

/**
 * Spark's parts as the recipe's, in its box: each clamped inside it, named
 * as a part name may be, an extruded outline kept as its box, and a role
 * guessed from where it sits (a thin slab at the top is the top things stand
 * on). Its surfaces follow its parts. Null when no part is usable.
 */
export function recipeFromSculpt(recipe: FixtureRecipe, sculpt: Sculpt): FixtureRecipe | null {
  const L = longest(recipe);
  const box = recipe.sizeCm;
  const names = new Set<string>();
  const parts: RecipePart[] = [];
  for (const s of sculpt.parts.slice(0, MAX_RECIPE_PARTS)) {
    const base = (
      s.id
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'part'
    ).slice(0, 20);
    let name = base;
    for (let n = 2; names.has(name); n++) name = `${base}-${n}`;
    // Kept inside the box: the room left is rounded down, so a part never reaches past it.
    const axis = (at: number, size: number, max: number) => {
      const a = Math.min(
        Math.max(0, round(at * L)),
        Math.max(0, Math.floor((max - 0.5) * 10) / 10),
      );
      return {
        at: a,
        size: Math.max(0.2, Math.min(round(size * L), Math.floor((max - a) * 100) / 100)),
      };
    };
    const x = axis(s.at.x, s.size.w, box.w);
    const y = axis(s.at.y, s.size.d, box.d);
    const z = axis(s.at.z, s.size.h, box.h);
    const shape =
      s.shape === 'lathe' && s.profile && s.profile.length >= 2
        ? 'lathe'
        : s.shape === 'tube' && s.path && s.path.length >= 2
          ? 'tube'
          : s.shape === 'blob'
            ? 'blob'
            : 'rbox';
    const before = recipe.parts.find((p) => p.name === name);
    const atCm = { x: x.at, y: y.at, z: z.at };
    const sizeCm = { w: x.size, d: y.size, h: z.size };
    const asDrawn = { at: atCm, size: { w: sizeCm.w, d: sizeCm.d, h: sizeCm.h } } as PropPart;
    const part = {
      name,
      role: before?.role ?? guessRole(asDrawn, box),
      shape,
      atCm,
      sizeCm,
      tone: before?.tone ?? MATERIAL_TONE[s.material],
      color: s.color,
      material: s.material,
      ...(shape === 'rbox' && s.radius !== null
        ? { radius: Math.min(1, Math.max(0, s.radius)) }
        : {}),
      ...(shape === 'lathe'
        ? { profile: [...s.profile!].sort((a, b) => a.z - b.z).slice(0, 16) }
        : {}),
      ...(shape === 'tube'
        ? {
            path: s.path!.slice(0, 4),
            tubeCm: Math.min(20, Math.max(0.2, round((s.radius ?? 0.01) * L))),
          }
        : {}),
      ...(shape === 'blob' && s.rough !== null ? { rough: Math.min(1, Math.max(0, s.rough)) } : {}),
    } satisfies RecipePart;
    // A part that still isn't a valid one (a profile running downwards) is left out, not the model.
    const ok = recipePartSchema.safeParse(part);
    if (!ok.success) continue;
    names.add(name);
    parts.push(ok.data);
  }
  if (!parts.length) return null;
  // Its surfaces: the ones it had where their parts are still there, else its one top.
  const kept = (recipe.surfaces ?? []).filter((s) => names.has(s.part));
  const tops = parts.filter((p) => p.role === 'top');
  const surfaces = kept.length
    ? kept
    : tops.length === 1
      ? [{ part: tops[0]!.name, label: 'Top' }]
      : [];
  const out = fixtureRecipeSchema.safeParse({
    ...recipe,
    parts,
    ...(surfaces.length ? { surfaces } : { surfaces: undefined }),
  });
  return out.success ? out.data : null;
}

/**
 * What Spark is asked, on each look: the thing as the room's camera sees it,
 * the model drawn through the same camera, and what the person asked for.
 */
export function brushSculptPrompt(
  recipe: FixtureRecipe,
  request: string,
  look: 'first' | 'again',
): string {
  const { w, d, h } = recipe.sizeCm;
  const L = longest(recipe);
  return [
    look === 'first'
      ? `The first image is the ${recipe.label.toLowerCase()} as the room's camera sees it, cut from its frame; other things may stand in front of it or on it. The second image is the current model of it drawn through the same camera and cut the same way, as plain shaded blocks; its parts are given below as JSON. Rebuild the parts so the drawing matches the first image: what it is made of and how (open or closed sides and back, shelves, legs, drawers, doors, frame), its proportions and its colours.`
      : `The first image is the ${recipe.label.toLowerCase()} as the room's camera sees it; the second is your model of it drawn through the same camera, with its parts below as JSON. Correct the parts so the drawing matches the first image better: its structure, proportions, positions and colours.`,
    `The person asked: "${request}". Follow it where the picture allows.`,
    `It measures ${w} × ${d} × ${h} cm: as its footprint's longer side is 1, it is ${(w / L).toFixed(3)} wide, ${(d / L).toFixed(3)} deep and ${(h / L).toFixed(3)} tall. Keep every part inside that box. The camera looks down at it from high in a corner of the room.`,
    `Model only the thing itself, in at most ${BRUSH_SCULPT_PARTS} parts: leave out what stands on it or in it (books, toys, boxes, cables) unless the person asks for them. Name parts with lowercase words and hyphens.`,
    'Posts, legs, rails and frames are thin parts: draw a side or a back as a solid panel only where the picture shows one, not where you can see through it.',
    'Boxes stand straight and cannot lean: anything that leans or slants (a ladder shelf’s rails, splayed legs, braces) is a tube, its box spanning the slant and its path two points from its bottom end to its top end, as shares of that box (a rail leaning back: {x: 0.5, y: 1, z: 0} to {x: 0.5, y: 0, z: 1}), its radius half its thickness. Never draw a leaning rail as a box: a box spanning its slant is a solid panel.',
    ...SCULPT_FORMAT,
    'Say in note what you changed.',
  ].join('\n');
}
