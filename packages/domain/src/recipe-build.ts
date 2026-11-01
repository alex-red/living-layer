import { clusterColours, rgbLab, type Lab } from './color.js';
import type { ProductFacts } from './facts.js';
import type { IsoScene } from './iso.js';
import {
  cm,
  furnitureSpec,
  ISO_TILE_CM,
  propModel,
  type PropForm,
  type PropPart,
} from './iso-furniture.js';
import { groupBounds, placeRecipe, rotateGroup } from './iso-templates.js';
import { convexHull, fillRings, newBits, type Bits } from './photo-scene.js';
import { applyRecipeOps, type RecipeOp } from './recipe-ops.js';
import {
  fixtureRecipeSchema,
  type FixtureRecipe,
  type RecipePart,
  type RecipeRole,
} from './recipe.js';
import { projectRoom, unprojectRoom, type RoomCamera } from './room-camera.js';
import { floorSolid, renderRoom, sceneSolids } from './room-render.js';

/**
 * Building a recipe for the thing a person selected
 * ([plan](../../../docs/plans/ai-brush.md#6-building-and-checking)): start
 * from the built-in form it is closest to, shape it by what is known of the
 * product (a drawer unit on the right, a side panel on the left), colour it
 * from the photo, then draw it through the room's camera and compare it with
 * the selection's outline. Below target, a refiner (Spark) suggests ops and
 * the check runs again, at most twice. All of it but the refiner is local.
 */

const toCm = (tiles: number) => Math.round(tiles * ISO_TILE_CM * 100) / 100;

/**
 * What a part of a built-in model is, from its shape alone: a thin slab at
 * the top is the top, a narrow post from the floor a leg, a thin slab lower
 * down a shelf, a thin full-height board a panel; the rest is body.
 */
export function guessRole(p: PropPart, box: { w: number; d: number; h: number }): RecipeRole {
  const top = p.at.z + p.size.h;
  const thin = p.size.h < box.h * 0.15;
  const covers = (p.size.w * p.size.d) / (box.w * box.d);
  if (thin && top >= box.h * 0.95 && covers > 0.5) return 'top';
  if (thin && covers > 0.4) return 'shelf';
  if (p.at.z < 0.01 && p.size.w < box.w * 0.2 && p.size.d < box.d * 0.2 && p.size.h > box.h * 0.5)
    return 'leg';
  if (Math.min(p.size.w, p.size.d) < Math.min(box.w, box.d) * 0.1 && p.size.h > box.h * 0.6)
    return 'panel';
  if (p.size.h < box.h * 0.25 && p.at.z > box.h * 0.4) return 'rail';
  return 'body';
}

/**
 * A built-in form's model copied into a recipe once, in centimetres, each
 * part named by its guessed role: the start for anything close to a desk, a
 * table or a cabinet. Edits then change the recipe, never the form.
 */
export function recipeFromForm(
  form: PropForm,
  sizeCm: { w: number; d: number; h?: number },
  label: string,
): FixtureRecipe {
  const size = {
    w: cm(sizeCm.w),
    d: cm(sizeCm.d),
    h: cm(sizeCm.h ?? furnitureSpec(form).heightCm),
  };
  const parts = propModel({ form, size, turns: 0 })!;
  const count = new Map<RecipeRole, number>();
  const recipeParts: RecipePart[] = parts
    .filter((p) => p.shape !== 'tube' || p.path)
    .map((p) => {
      const role = guessRole(p, size);
      const n = (count.get(role) ?? 0) + 1;
      count.set(role, n);
      return {
        name: `${role}-${n}`,
        role,
        shape: p.shape,
        atCm: { x: toCm(p.at.x), y: toCm(p.at.y), z: toCm(p.at.z) },
        sizeCm: { w: toCm(p.size.w), d: toCm(p.size.d), h: toCm(p.size.h) },
        tone: p.tone,
        ...(p.material ? { material: p.material } : {}),
        ...(p.shape === 'rbox' && p.radius !== undefined ? { radius: Math.min(1, p.radius) } : {}),
        ...(p.profile ? { profile: p.profile } : {}),
        ...(p.wall !== undefined ? { wall: p.wall } : {}),
        ...(p.path ? { path: p.path, tubeCm: Math.max(0.1, toCm(p.radius ?? cm(1))) } : {}),
        ...(p.rough !== undefined ? { rough: p.rough } : {}),
      };
    });
  // A top keeps its plain name when there is one, so surfaces and edits can find it.
  for (const p of recipeParts) if (p.name === 'top-1' && count.get('top') === 1) p.name = 'top';
  const tops = recipeParts.filter((p) => p.role === 'top');
  return fixtureRecipeSchema.parse({
    label,
    sizeCm: { w: sizeCm.w, d: sizeCm.d, h: toCm(size.h) },
    parts: recipeParts,
    ...(tops.length === 1 ? { surfaces: [{ part: tops[0]!.name, label: 'Top' }] } : {}),
  });
}

const words = (p: NonNullable<ProductFacts['parts']>[number]) =>
  `${p.name} ${p.role ?? ''}`.toLowerCase();
/**
 * A recipe shaped by what is known of the product. Starting from `form`
 * at the product's size, a drawer unit the facts name takes the place of
 * the legs on the right, with its drawers on the front; a side panel takes
 * the place of the legs on the left. Colour: the photo's when it has one,
 * else the product's first.
 */
export function assembleRecipe(
  form: PropForm,
  facts: Pick<
    ProductFacts,
    'query' | 'name' | 'sizeCm' | 'parts' | 'colors' | 'materials' | 'sources'
  >,
  photoColor: string | null = null,
): FixtureRecipe {
  const size = facts.sizeCm ?? { ...defaultSize(form), h: furnitureSpec(form).heightCm };
  let recipe = recipeFromForm(form, size, facts.name ?? facts.query);
  const parts = facts.parts ?? [];
  const unit = parts.find(
    (p) => p.role === 'body' || /drawer unit|pedestal|cabinet/.test(words(p)),
  );
  const drawers = parts.find((p) => p.role === 'drawer' || /\bdrawers?\b/.test(words(p)));
  const panel = parts.find((p) => p.role === 'panel' || /side panel|panel/.test(words(p)));
  const top = recipe.parts.find((p) => p.role === 'top');
  const under = top ? top.atCm.z : recipe.sizeCm.h;
  const W = recipe.sizeCm.w;
  const D = recipe.sizeCm.d;
  const legsOn = (side: 'left' | 'right') =>
    recipe.parts.filter(
      (p) => p.role === 'leg' && (side === 'left' ? p.atCm.x < W / 2 : p.atCm.x >= W / 2),
    );
  const ops: RecipeOp[] = [];
  const tone = top?.tone ?? 'wood';
  if (unit || (drawers && form !== 'cabinet')) {
    const legs = legsOn('right');
    if (legs.length) ops.push({ op: 'remove_part', parts: { names: legs.map((p) => p.name) } });
    const uw = Math.min(W * 0.45, Math.max(30, unit?.sizeCm?.w ?? W * 0.28));
    const ud = Math.min(D, unit?.sizeCm?.d ?? D - 2);
    ops.push({
      op: 'add_part',
      part: {
        name: 'drawer-unit',
        role: 'body',
        shape: 'rbox',
        atCm: { x: W - uw, y: 0, z: 0 },
        sizeCm: { w: uw, d: ud, h: under },
        tone,
        radius: 0.04,
      },
    });
    const n = Math.max(1, Math.min(6, drawers?.count ?? 3));
    const gap = 0.5;
    const each = (under - 2.5 - gap * n) / n;
    for (let i = 0; i < n; i++)
      ops.push({
        op: 'add_part',
        part: {
          name: `drawer-${i + 1}`,
          role: 'drawer',
          shape: 'rbox',
          atCm: { x: W - uw + 1, y: Math.min(ud, D - 2), z: under - (i + 1) * (each + gap) },
          sizeCm: { w: uw - 2, d: Math.min(2, D - Math.min(ud, D - 2)), h: each },
          tone,
          radius: 0.1,
        },
      });
  }
  if (panel) {
    const legs = legsOn('left');
    if (legs.length) ops.push({ op: 'remove_part', parts: { names: legs.map((p) => p.name) } });
    ops.push({
      op: 'add_part',
      part: {
        name: 'panel-left',
        role: 'panel',
        shape: 'rbox',
        atCm: { x: 0, y: 0, z: 0 },
        sizeCm: { w: 2.5, d: D, h: under },
        tone,
        radius: 0.2,
      },
    });
  }
  const color = photoColor ?? facts.colors?.[0]?.hex ?? null;
  if (color) ops.push({ op: 'recolor', parts: { except: { materials: ['metal'] } }, color });
  // The product's own finish on everything that isn't metal: a white desk isn't grained wood.
  const material = facts.materials?.find((m) => m !== 'metal');
  if (material)
    ops.push({ op: 'rematerial', parts: { except: { materials: ['metal'] } }, material });
  if (ops.length) {
    const done = applyRecipeOps(recipe, ops);
    if (done.ok) recipe = done.recipe;
  }
  return fixtureRecipeSchema.parse({ ...recipe, sources: facts.sources.slice(0, 8) });
}
/** A form's footprint in cm when nothing says how big the product is: its template's. */
function defaultSize(form: PropForm): { w: number; d: number } {
  const DEFAULTS: Partial<Record<PropForm, { w: number; d: number }>> = {
    desk: { w: 120, d: 75 },
    table: { w: 90, d: 90 },
    cabinet: { w: 60, d: 40 },
    bookcase: { w: 80, d: 30 },
    chair: { w: 66, d: 66 },
  };
  return DEFAULTS[form] ?? { w: 40, d: 40 };
}

/**
 * The selection's main colour in the frame: the largest OKLab cluster of
 * its pixels. Null when there are too few to say.
 */
export function photoColor(rgba: Uint8ClampedArray | Uint8Array, mask: Bits): string | null {
  const pixels: Lab[] = [];
  for (let i = 0; i < mask.data.length; i++)
    if (mask.data[i]) pixels.push(rgbLab([rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!]));
  if (pixels.length < 50) return null;
  return clusterColours(pixels, 4).clusters[0]?.hex ?? null;
}

/** The outline is compared with a box at a quarter of the frame's size: plenty for a size. */
const FIT_SCALE = 4;
/**
 * How big a floor-standing thing is, and where, from its outline and the
 * calibrated camera: the box standing on the floor whose silhouette best
 * matches the outline's convex hull (the hull, so a desk's open underside
 * counts as the box's). A coordinate search from a small box where the
 * outline's bottom meets the floor, kept inside the room's `grid`. Depth
 * is the least sure: from a high corner the back of a thing is mostly
 * hidden. Only for things on the floor, seen whole. In cm; its middle in tiles.
 */
export function photoBox(
  camera: RoomCamera,
  mask: Bits,
  grid?: IsoScene['grid'],
): { w: number; d: number; h: number; cx: number; cy: number; iou: number } | null {
  const W = Math.ceil(mask.width / FIT_SCALE);
  const H = Math.ceil(mask.height / FIT_SCALE);
  const points: { x: number; y: number }[] = [];
  let [x0, x1, y1] = [Infinity, -1, -1];
  for (let i = 0; i < mask.data.length; i++)
    if (mask.data[i]) {
      const x = i % mask.width;
      const y = Math.floor(i / mask.width);
      points.push({ x: x / FIT_SCALE, y: y / FIT_SCALE });
      [x0, x1, y1] = [Math.min(x0, x), Math.max(x1, x), Math.max(y1, y)];
    }
  if (points.length < 20) return null;
  const target = newBits(W, H);
  fillRings(target, [convexHull(points)]);
  const area = target.data.reduce((a, b) => a + b, 0);
  const start = unprojectRoom(camera, { x: (x0 + x1) / 2, y: y1 }, 0);
  if (!start) return null;
  const score = ([cx, cy, w, d, h]: number[]) => {
    if (w! < 0.05 || d! < 0.05 || h! < 0.05) return -1;
    // Nothing stands outside the room's walls.
    if (
      grid &&
      (cx! - w! / 2 < 0 || cy! - d! / 2 < 0 || cx! + w! / 2 > grid.w || cy! + d! / 2 > grid.d)
    )
      return -1;
    const corners: { x: number; y: number }[] = [];
    for (const dx of [-w! / 2, w! / 2])
      for (const dy of [-d! / 2, d! / 2])
        for (const z of [0, h!]) {
          const p = projectRoom(camera, { x: cx! + dx, y: cy! + dy, z });
          if (!p) return -1;
          corners.push({ x: p.x / FIT_SCALE, y: p.y / FIT_SCALE });
        }
    const box = newBits(W, H);
    fillRings(box, [convexHull(corners)]);
    let both = 0;
    let drawn = 0;
    for (let i = 0; i < box.data.length; i++) {
      drawn += box.data[i]!;
      both += box.data[i]! & target.data[i]!;
    }
    return both / (drawn + area - both);
  };
  let best = [start.x, start.y, 0.5, 0.5, 0.5];
  let bestScore = score(best);
  const steps = [0.5, 0.5, 0.5, 0.5, 0.5];
  for (let round = 0; round < 400 && Math.max(...steps) > 0.01; round++) {
    let moved = false;
    for (let k = 0; k < 5; k++)
      for (const sign of [1, -1]) {
        const next = best.slice();
        next[k]! += sign * steps[k]!;
        const s = score(next);
        if (s > bestScore) [best, bestScore, moved] = [next, s, true];
      }
    if (!moved) for (let k = 0; k < 5; k++) steps[k]! /= 2;
  }
  // Nothing on the floor fits it: it stands on something, or is mostly hidden.
  if (bestScore < 0.5) return null;
  const [cx, cy, w, d, h] = best as [number, number, number, number, number];
  return { w: toCm(w), d: toCm(d), h: toCm(h), cx, cy, iou: bestScore };
}

/** Where a new model stands for the check: in place of the selected group, else on the outline's footing. */
export interface RecipePlace {
  /** The middle of its footprint, in tiles. */
  cx: number;
  cy: number;
  z: number;
  turns: number;
  /** The template group it takes the place of, left out of the scene. */
  replaces: string | null;
}
/** A recipe's place when it replaces one of the room's groups: same middle, same turn. */
export function placeOfGroup(scene: IsoScene, group: string): RecipePlace | null {
  const b = groupBounds(scene, group);
  if (!b) return null;
  const main =
    scene.props.find((p) => p.id === group) ?? scene.props.find((p) => p.group === group);
  return {
    cx: b.at.x + b.size.w / 2,
    cy: b.at.y + b.size.d / 2,
    z: b.at.z,
    turns: main?.turns ?? 0,
    replaces: group,
  };
}
/** The scene with the recipe standing at its place as group `candidate`, and what it replaced gone. */
export function sceneWithRecipe(
  scene: IsoScene,
  recipe: FixtureRecipe,
  place: RecipePlace,
): IsoScene {
  const g = 'candidate';
  const w = cm(recipe.sizeCm.w);
  const d = cm(recipe.sizeCm.d);
  let s: IsoScene = {
    ...scene,
    props: scene.props.filter((p) => p.group !== place.replaces),
    surfaces: scene.surfaces.filter(
      (x) => !scene.props.some((p) => p.id === x.propId && p.group === place.replaces),
    ),
  };
  const built = placeRecipe(recipe, g, place.cx - w / 2, place.cy - d / 2, place.z);
  s = { ...s, props: [...s.props, ...built.props], surfaces: [...s.surfaces, ...built.surfaces] };
  for (let t = 0; t < place.turns; t++) s = rotateGroup(s, g);
  return s;
}

export interface RecipeCheck {
  /** The drawn model's pixels against the selection's outline. */
  iou: number;
  /** Outline the model doesn't cover, and model outside the outline, as shares of the outline. */
  missing: number;
  extra: number;
  /** Where most of the mismatch is, in plain words, for the refiner. */
  report: string;
}
/** A recipe at least this close to the outline needs no refining. */
export const RECIPE_TARGET = { iou: 0.75 } as const;

/**
 * Draw the scene with the recipe in place through the room's camera and
 * compare the recipe's pixels with the selection's outline. What stands in
 * front of it hides it, as it does in the photo.
 */
export function checkRecipe(
  camera: RoomCamera,
  scene: IsoScene,
  recipe: FixtureRecipe,
  place: RecipePlace,
  outline: Bits,
): RecipeCheck {
  const s = sceneWithRecipe(scene, recipe, place);
  const picture = renderRoom(camera, [floorSolid(s.grid), ...sceneSolids(s)], { labels: true });
  const k = picture.names.indexOf('candidate');
  let both = 0;
  let drawn = 0;
  let wanted = 0;
  // Mismatch by side of the outline's box, for the report.
  let [x0, x1, y0, y1] = [Infinity, -1, Infinity, -1];
  for (let i = 0; i < outline.data.length; i++)
    if (outline.data[i]) {
      const x = i % outline.width;
      const y = Math.floor(i / outline.width);
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
  const sides = { left: [0, 0], right: [0, 0], top: [0, 0], bottom: [0, 0] } as Record<
    string,
    [number, number]
  >;
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  for (let i = 0; i < outline.data.length; i++) {
    const isDrawn = picture.ids[i] === k;
    const isWanted = outline.data[i] === 1;
    if (isDrawn) drawn++;
    if (isWanted) wanted++;
    if (isDrawn && isWanted) both++;
    if (isDrawn === isWanted) continue;
    const x = i % outline.width;
    const y = Math.floor(i / outline.width);
    const slot = isWanted ? 0 : 1;
    sides[x < mx ? 'left' : 'right']![slot]++;
    sides[y < my ? 'top' : 'bottom']![slot]++;
  }
  const iou = both / Math.max(1, drawn + wanted - both);
  const missing = (wanted - both) / Math.max(1, wanted);
  const extra = (drawn - both) / Math.max(1, wanted);
  const worst = (slot: 0 | 1) =>
    Object.entries(sides).sort((a, b) => b[1][slot] - a[1][slot])[0]![0];
  const report = [
    `The model covers ${Math.round((1 - missing) * 100)}% of the outline (IoU ${iou.toFixed(2)}).`,
    missing > 0.1 ? `Most of the outline it misses is on its ${worst(0)}.` : '',
    extra > 0.1 ? `It is drawn beyond the outline mostly on its ${worst(1)}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { iou, missing, extra, report };
}

/** Suggests ops that bring a recipe closer to its outline: Spark, live. */
export type Refiner = (recipe: FixtureRecipe, check: RecipeCheck) => Promise<RecipeOp[]>;
export interface BuildRound {
  recipe: FixtureRecipe;
  check: RecipeCheck;
  /** The ops that made this round's recipe from the last, empty for the first. */
  ops: RecipeOp[];
}
/**
 * Check a drafted recipe and, below target, ask the refiner for ops and
 * check again, at most `rounds` times. Keeps the best-scoring round, so a
 * refinement that made it worse is never what comes back.
 */
export async function refineRecipe(
  draft: FixtureRecipe,
  check: (r: FixtureRecipe) => RecipeCheck,
  refine: Refiner | null,
  rounds = 2,
): Promise<{ best: BuildRound; history: BuildRound[] }> {
  const history: BuildRound[] = [{ recipe: draft, check: check(draft), ops: [] }];
  for (let i = 0; i < rounds && refine; i++) {
    const last = history.at(-1)!;
    if (last.check.iou >= RECIPE_TARGET.iou) break;
    const ops = await refine(last.recipe, last.check);
    const next = applyRecipeOps(last.recipe, ops);
    if (!ops.length || !next.ok) break;
    history.push({ recipe: next.recipe, check: check(next.recipe), ops });
  }
  const best = history.reduce((a, b) => (b.check.iou > a.check.iou ? b : a));
  return { best, history };
}
