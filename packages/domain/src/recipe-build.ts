import { clusterColours, deltaE, rgbLab, type Lab } from './color.js';
import type { ProductFacts } from './facts.js';
import type { IsoScene } from './iso.js';
import { archetypeOf, type Archetype } from './iso-archetypes.js';
import {
  cm,
  furnitureSpec,
  ISO_TILE_CM,
  propModel,
  type PropForm,
  type PropPart,
} from './iso-furniture.js';
import {
  groupBounds,
  moveGroup,
  placeRecipe,
  PROP_TEMPLATES,
  ridersOf,
  rotateGroup,
  settleGroup,
} from './iso-templates.js';
import { convexHull, fillRings, newBits, type Bits } from './photo-scene.js';
import { applyRecipeOps, type RecipeOp } from './recipe-ops.js';
import {
  fixtureRecipeSchema,
  MAX_RECIPE_PARTS,
  type FixtureRecipe,
  type RecipePart,
  type RecipeRole,
} from './recipe.js';
import { projectRoom, unprojectRoom, type RoomCamera } from './room-camera.js';
import { floorSolid, renderRoom, sceneSolids, solidsWindow } from './room-render.js';

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

function clampAxis(at: number, sz: number, max: number): { at: number; size: number } {
  const a = Math.max(0, Math.min(Math.round((max - 0.1) * 100) / 100, Math.round(at * 100) / 100));
  const s = Math.max(0.1, Math.min(Math.round(sz * 100) / 100, Math.round((max - a) * 100) / 100));
  const size = a + s > max ? Math.max(0.1, Math.floor((max - a) * 100) / 100) : s;
  return { at: a, size };
}

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
  const modelH = sizeCm.h ?? furnitureSpec(form).heightCm;
  const size = {
    w: cm(sizeCm.w),
    d: cm(sizeCm.d),
    h: cm(modelH),
  };
  const maxCm = { w: sizeCm.w, d: sizeCm.d, h: toCm(size.h) };
  const rawParts = propModel({ form, size, turns: 0 })!;
  const withRoles = rawParts.map((p, i) => ({
    part: p,
    role: guessRole(p, size),
    index: i,
  }));
  let kept = withRoles;
  if (withRoles.length > MAX_RECIPE_PARTS) {
    const structural = withRoles.filter((x) => x.role !== 'body');
    const bodies = withRoles.filter((x) => x.role === 'body');
    const maxBodies = Math.max(0, MAX_RECIPE_PARTS - structural.length);
    const sortedBodies = bodies.slice().sort((a, b) => {
      const va = a.part.size.w * a.part.size.d * a.part.size.h;
      const vb = b.part.size.w * b.part.size.d * b.part.size.h;
      return vb - va;
    });
    const keptBodyIndices = new Set(sortedBodies.slice(0, maxBodies).map((x) => x.index));
    kept = withRoles.filter((x) => x.role !== 'body' || keptBodyIndices.has(x.index));
    if (kept.length > MAX_RECIPE_PARTS) {
      kept = kept.slice(0, MAX_RECIPE_PARTS);
    }
  }
  const count = new Map<RecipeRole, number>();
  const recipeParts: RecipePart[] = kept.map(({ part: p, role }) => {
    const n = (count.get(role) ?? 0) + 1;
    count.set(role, n);
    const cx = clampAxis(toCm(p.at.x), toCm(p.size.w), maxCm.w);
    const cy = clampAxis(toCm(p.at.y), toCm(p.size.d), maxCm.d);
    const cz = clampAxis(toCm(p.at.z), toCm(p.size.h), maxCm.h);
    return {
      name: `${role}-${n}`,
      role,
      shape: p.shape,
      atCm: { x: cx.at, y: cy.at, z: cz.at },
      sizeCm: { w: cx.size, d: cy.size, h: cz.size },
      tone: p.tone,
      ...(p.material ? { material: p.material } : {}),
      ...(p.shape === 'rbox' && p.radius !== undefined ? { radius: Math.min(1, p.radius) } : {}),
      ...(p.shape === 'lathe'
        ? { profile: p.profile, ...(p.wall !== undefined ? { wall: p.wall } : {}) }
        : {}),
      ...(p.shape === 'tube'
        ? { path: p.path, tubeCm: Math.max(0.1, toCm(p.radius ?? cm(1))) }
        : {}),
      ...(p.shape === 'blob' && p.rough !== undefined ? { rough: p.rough } : {}),
    };
  });
  // A top keeps its plain name when there is one, so surfaces and edits can find it.
  for (const p of recipeParts) if (p.name === 'top-1' && count.get('top') === 1) p.name = 'top';
  const tops = recipeParts.filter((p) => p.role === 'top');
  return fixtureRecipeSchema.parse({
    label,
    sizeCm: maxCm,
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
  const addDrawers = (unit || (drawers && form !== 'cabinet')) && under >= 10 && W >= 32 && D >= 10;
  if (addDrawers) {
    const legs = legsOn('right');
    if (legs.length) ops.push({ op: 'remove_part', parts: { names: legs.map((p) => p.name) } });
  }
  if (panel && under > 0) {
    const legs = legsOn('left');
    if (legs.length) ops.push({ op: 'remove_part', parts: { names: legs.map((p) => p.name) } });
  }
  if (addDrawers) {
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
    if (each > 0) {
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
  }
  if (panel && under > 0) {
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

  const addedCount = ops.filter((o) => o.op === 'add_part').length;
  const removedNames = new Set(
    ops.filter((o) => o.op === 'remove_part').flatMap((o) => o.parts.names ?? []),
  );
  const excess = recipe.parts.length - removedNames.size + addedCount - MAX_RECIPE_PARTS;
  if (excess > 0) {
    const bodyParts = recipe.parts
      .filter((p) => p.role === 'body' && !removedNames.has(p.name))
      .sort((a, b) => {
        const va = a.sizeCm.w * a.sizeCm.d * a.sizeCm.h;
        const vb = b.sizeCm.w * b.sizeCm.d * b.sizeCm.h;
        return va - vb;
      });
    const trim = new Set(bodyParts.slice(0, excess).map((p) => p.name));
    recipe = { ...recipe, parts: recipe.parts.filter((p) => !trim.has(p.name)) };
  }

  if (ops.length) {
    const done = applyRecipeOps(recipe, ops);
    if (done.ok) recipe = done.recipe;
  }
  return fixtureRecipeSchema.parse({ ...recipe, sources: facts.sources.slice(0, 8) });
}
/** A form's footprint in cm when nothing says how big the product is: its template's. */
/** Furniture named outright: before the small things, so a "lamp table" is a table. */
const FORM_WORDS: [RegExp, PropForm][] = [
  [/\bdesk\b/, 'desk'],
  [/\btable\b/, 'table'],
  [/\b(chair|stool)\b/, 'chair'],
  [/\b(book ?case|book ?shelf|shelf|shelves)\b/, 'bookcase'],
  [/\b(cabinet|drawers?|dresser|chest)\b/, 'cabinet'],
  [/\b(monitor|screen)\b/, 'monitor'],
  [/\bkeyboard\b/, 'keyboard'],
  // Flat and round: a turned form, so it starts as a disc and not a butter dish's block and lid.
  [/\b(coaster|saucer|plate)s?\b/, 'jar'],
];
/**
 * How thick flat things usually are, in cm, read off a name. From a room's
 * high corner a flat thing's outline is all footprint: the camera can't tell
 * its thickness, and read a coaster as 4 cm tall.
 */
const FLAT_WORDS: [RegExp, number][] = [
  [/\b(coaster|place ?mat|mouse ?pad|mouse ?mat|desk ?mat)s?\b/, 0.5],
  [/\bsaucers?\b/, 1.5],
  [/\bplates?\b/, 2],
];
/** A flat thing's usual thickness in cm from its name, or null for anything else. */
export function flatThicknessOf(name: string): number | null {
  const text = name.toLowerCase();
  return FLAT_WORDS.find(([re]) => re.test(text))?.[1] ?? null;
}
/** The built-in form nearest each kind of small thing; a mouse, a cat or an unknown has none. */
const FORM_OF_ARCHETYPE: Partial<Record<Archetype, PropForm>> = {
  mug: 'jar',
  cup: 'jar',
  can: 'jar',
  bottle: 'bottle',
  plant: 'pot',
  book: 'book',
  box: 'carton',
  lamp: 'lamp-stand',
};
/**
 * The form a new model is built from when the request named none: read off
 * its name, so a mug is a small turned thing rather than a chest of drawers.
 * Null when the name says nothing a form fits.
 */
export function formOfName(name: string): PropForm | null {
  const text = name.toLowerCase();
  return (
    FORM_WORDS.find(([re]) => re.test(text))?.[1] ?? FORM_OF_ARCHETYPE[archetypeOf(text)] ?? null
  );
}

/** The longest side, in cm, of a thing that is a small object rather than furniture. */
const SMALL_CM = 40;
/**
 * The form a new model is built from when nothing named one: a plain block
 * for a small thing the camera measured (a remote), so it isn't
 * drawn as a chest of drawers; a cabinet for anything bigger or unmeasured.
 */
export function fallbackForm(sizeCm: { w: number; d: number; h: number } | null): PropForm {
  return sizeCm && Math.max(sizeCm.w, sizeCm.d, sizeCm.h) <= SMALL_CM ? 'butter' : 'cabinet';
}

/**
 * A new model's footprint when nothing measured it, in cm: the usual size
 * of its form, else the room's template of that name (a monitor's 61 cm),
 * else 40 cm square. A monitor built 40 cm wide could never be shaped past it.
 */
export function defaultSize(form: PropForm): { w: number; d: number } {
  const DEFAULTS: Partial<Record<PropForm, { w: number; d: number }>> = {
    desk: { w: 120, d: 75 },
    table: { w: 90, d: 90 },
    cabinet: { w: 60, d: 40 },
    bookcase: { w: 80, d: 30 },
    chair: { w: 66, d: 66 },
    pot: { w: furnitureSpec('pot').widthCm, d: furnitureSpec('pot').widthCm },
    'lamp-stand': { w: furnitureSpec('lamp-stand').baseCm, d: furnitureSpec('lamp-stand').baseCm },
    book: { w: 15, d: 22 },
    bottle: { w: 8, d: 8 },
    jar: { w: 9, d: 9 },
    carton: { w: 7, d: 7 },
  };
  const template = (PROP_TEMPLATES as Partial<Record<string, { size: { w: number; d: number } }>>)[
    form
  ];
  return (
    DEFAULTS[form] ??
    (template
      ? {
          w: Math.round(template.size.w * ISO_TILE_CM),
          d: Math.round(template.size.d * ISO_TILE_CM),
        }
      : { w: 40, d: 40 })
  );
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

/**
 * How high, in tiles, the thing an outline shows stands: the top of the
 * highest of the room's surfaces its foot (the outline's bottom middle, as
 * `photoBox` takes it) lands on through the camera, else the floor. For a new
 * thing, which has no place in the room to say it stands on the desk; seen
 * from a high corner, a coaster measured as standing on the floor would be
 * a big thing far off.
 */
export function outlineRests(
  camera: RoomCamera,
  scene: Pick<IsoScene, 'surfaces'>,
  mask: Bits,
): number {
  let [x0, x1, y1] = [Infinity, -1, -1];
  for (let i = 0; i < mask.data.length; i++)
    if (mask.data[i]) {
      const x = i % mask.width;
      [x0, x1, y1] = [Math.min(x0, x), Math.max(x1, x), Math.floor(i / mask.width)];
    }
  if (y1 < 0) return 0;
  const foot = { x: (x0 + x1) / 2, y: y1 };
  for (const s of [...scene.surfaces].sort((a, b) => b.z - a.z)) {
    const p = unprojectRoom(camera, foot, s.z);
    if (
      p &&
      p.x >= s.rect.x &&
      p.x <= s.rect.x + s.rect.w &&
      p.y >= s.rect.y &&
      p.y <= s.rect.y + s.rect.d
    )
      return s.z;
  }
  return 0;
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
 * hidden. It stands on the floor, or at `floor` tiles up for a thing
 * standing on something (a monitor on a desk). In cm; its middle in tiles.
 * `cutTop` when the outline reaches the frame's top edge: the thing runs on
 * out of the picture, where a box's drawing costs nothing, so `h` isn't measured.
 */
export function photoBox(
  camera: RoomCamera,
  mask: Bits,
  grid?: IsoScene['grid'],
  {
    floor = 0,
    height,
  }: {
    floor?: number;
    /**
     * Its height in tiles when it is known (a coaster's): only its footprint is fitted. From a
     * high corner a flat thing's outline fits a small, tall box as well as its own.
     */
    height?: number;
  } = {},
): {
  w: number;
  d: number;
  h: number;
  cx: number;
  cy: number;
  iou: number;
  cutTop: boolean;
} | null {
  const W = Math.ceil(mask.width / FIT_SCALE);
  const H = Math.ceil(mask.height / FIT_SCALE);
  const points: { x: number; y: number }[] = [];
  let [x0, x1, y0, y1] = [Infinity, -1, Infinity, -1];
  for (let i = 0; i < mask.data.length; i++)
    if (mask.data[i]) {
      const x = i % mask.width;
      const y = Math.floor(i / mask.width);
      points.push({ x: x / FIT_SCALE, y: y / FIT_SCALE });
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
  if (points.length < 20) return null;
  const target = newBits(W, H);
  fillRings(target, [convexHull(points)]);
  const area = target.data.reduce((a, b) => a + b, 0);
  const start = unprojectRoom(camera, { x: (x0 + x1) / 2, y: y1 }, floor);
  if (!start) return null;
  const score = ([cx, cy, w, d, h]: number[]) => {
    if (w! < 0.05 || d! < 0.05 || h! < Math.min(0.05, height ?? 0.05)) return -1;
    // Nothing stands outside the room's walls.
    if (
      grid &&
      (cx! - w! / 2 < 0 || cy! - d! / 2 < 0 || cx! + w! / 2 > grid.w || cy! + d! / 2 > grid.d)
    )
      return -1;
    const corners: { x: number; y: number }[] = [];
    for (const dx of [-w! / 2, w! / 2])
      for (const dy of [-d! / 2, d! / 2])
        for (const z of [floor, floor + h!]) {
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
  let best = [start.x, start.y, 0.5, 0.5, height ?? 0.5];
  let bestScore = score(best);
  // A known height isn't stepped.
  const steps = [0.5, 0.5, 0.5, 0.5, height === undefined ? 0.5 : 0];
  for (let round = 0; round < 400 && Math.max(...steps) > 0.01; round++) {
    let moved = false;
    for (let k = 0; k < (height === undefined ? 5 : 4); k++)
      for (const sign of [1, -1]) {
        const next = best.slice();
        next[k]! += sign * steps[k]!;
        const s = score(next);
        if (s > bestScore) [best, bestScore, moved] = [next, s, true];
      }
    if (!moved) for (let k = 0; k < 5; k++) steps[k]! /= 2;
  }
  // Nothing standing there fits it: it stands on something else, or is mostly hidden.
  if (bestScore < 0.5) return null;
  const [cx, cy, w, d, h] = best as [number, number, number, number, number];
  return { w: toCm(w), d: toCm(d), h: toCm(h), cx, cy, iou: bestScore, cutTop: y0 <= 1 };
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
/**
 * The scene with the recipe standing at its place as group `g`, what it
 * replaced gone, and what stood on that settled onto the new model's top.
 */
export function sceneWithRecipe(
  scene: IsoScene,
  recipe: FixtureRecipe,
  place: RecipePlace,
  g = 'candidate',
): IsoScene {
  const w = cm(recipe.sizeCm.w);
  const d = cm(recipe.sizeCm.d);
  const riders = place.replaces ? ridersOf(scene, place.replaces) : [];
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
  // Each quarter turn nudges a long model back inside the room, which moved one turned near a
  // wall away from it: it is put back about its middle, kept inside the room once.
  const b = groupBounds(s, g);
  if (b)
    s = moveGroup(s, g, place.cx - (b.at.x + b.size.w / 2), place.cy - (b.at.y + b.size.d / 2));
  for (const r of riders) s = settleGroup(s, r);
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
  /**
   * How far the drawing's colours are from the photo's where both are the
   * thing (mean ΔE), when there is a photo: an open white shelf and a closed
   * wooden one share an outline, not their colours. Null without one.
   */
  deltaE: number | null;
}
/**
 * One number to rank drafts of the same thing by: the outline's match, less
 * a little for each unit of colour difference, so a draft that looks like the
 * photo wins over one that only fills the same outline.
 */
export const draftScore = (c: Pick<RecipeCheck, 'iou' | 'deltaE'>) => c.iou - (c.deltaE ?? 0) / 100;
/** Mean ΔE past which a model's colours plainly aren't the photo's, and its check says so. */
const FAR_COLOUR = 20;
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
  /** The frame's pixels (RGBA, the camera's frame size), to compare colours with. */
  photo?: Uint8Array | Uint8ClampedArray,
): RecipeCheck {
  const s = sceneWithRecipe(scene, recipe, place);
  const solids = sceneSolids(s);
  // Mismatch by side of the outline's box, for the report.
  let [x0, x1, y0, y1] = [Infinity, -1, Infinity, -1];
  for (let i = 0; i < outline.data.length; i++)
    if (outline.data[i]) {
      const x = i % outline.width;
      const y = Math.floor(i / outline.width);
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const { width, height } = outline;
  // Only the pixels the outline or the model can cover are drawn and compared: the rest count
  // for neither, and a small thing's check drew a whole room for a few hundred of them.
  const drawnBox = solidsWindow(
    camera,
    solids.filter((x) => x.id === 'candidate'),
  );
  const win =
    drawnBox && x1 >= 0
      ? {
          x0: Math.min(drawnBox.x0, x0),
          y0: Math.min(drawnBox.y0, y0),
          x1: Math.max(drawnBox.x1, x1 + 1),
          y1: Math.max(drawnBox.y1, y1 + 1),
        }
      : { x0: 0, y0: 0, x1: width, y1: height };
  // Its colours drawn only when there is a photo to compare them with.
  const picture = renderRoom(camera, [floorSolid(s.grid), ...solids], {
    labels: !photo,
    window: win,
  });
  const k = picture.names.indexOf('candidate');
  // Its drawing, and the same with the gaps across each row filled: SAM outlines an open
  // shelf with what stands in it and the wall seen through it, so an open frame is judged
  // by its envelope as well as its parts, whichever matches the outline better.
  const drawnAt = new Uint8Array(outline.data.length);
  const filled = new Uint8Array(outline.data.length);
  // The colours compared, drawn and photographed, for after the loop.
  const pairs: [Lab, Lab][] = [];
  for (let y = win.y0; y < win.y1; y++) {
    let first = -1;
    let last = -1;
    for (let x = win.x0; x < win.x1; x++) {
      const i = y * width + x;
      if (picture.ids[i] !== k) continue;
      drawnAt[i] = 1;
      if (first < 0) first = x;
      last = x;
      if (photo && outline.data[i])
        pairs.push([
          rgbLab([picture.rgba[i * 4]!, picture.rgba[i * 4 + 1]!, picture.rgba[i * 4 + 2]!]),
          rgbLab([photo[i * 4]!, photo[i * 4 + 1]!, photo[i * 4 + 2]!]),
        ]);
    }
    if (first >= 0) filled.fill(1, y * width + first, y * width + last + 1);
  }
  const compare = (mask: Uint8Array) => {
    const sides = { left: [0, 0], right: [0, 0], top: [0, 0], bottom: [0, 0] } as Record<
      string,
      [number, number]
    >;
    let both = 0;
    let drawn = 0;
    let wanted = 0;
    for (let y = win.y0; y < win.y1; y++)
      for (let x = win.x0; x < win.x1; x++) {
        const i = y * width + x;
        const isDrawn = mask[i] === 1;
        const isWanted = outline.data[i] === 1;
        if (isDrawn) drawn++;
        if (isWanted) wanted++;
        if (isDrawn && isWanted) both++;
        if (isDrawn === isWanted) continue;
        const slot = isWanted ? 0 : 1;
        sides[x < mx ? 'left' : 'right']![slot]++;
        sides[y < my ? 'top' : 'bottom']![slot]++;
      }
    return { both, drawn, wanted, sides, iou: both / Math.max(1, drawn + wanted - both) };
  };
  const asDrawn = compare(drawnAt);
  const asFilled = compare(filled);
  const { both, drawn, wanted, sides, iou } = asFilled.iou > asDrawn.iou ? asFilled : asDrawn;
  // A room's camera sees everything darker than the drawing's light: its colours are compared
  // with the drawing's brightness brought to the photo's, so white reads as white in a dim room.
  let colour: number | null = null;
  if (pairs.length) {
    const lift = pairs.reduce((sum, [a, b]) => sum + b[0] - a[0], 0) / pairs.length;
    colour =
      pairs.reduce((sum, [a, b]) => sum + deltaE([a[0] + lift, a[1], a[2]], b), 0) / pairs.length;
  }
  const missing = (wanted - both) / Math.max(1, wanted);
  const extra = (drawn - both) / Math.max(1, wanted);
  const worst = (slot: 0 | 1) =>
    Object.entries(sides).sort((a, b) => b[1][slot] - a[1][slot])[0]![0];
  const report = [
    `The model covers ${Math.round((1 - missing) * 100)}% of the outline (IoU ${iou.toFixed(2)}).`,
    missing > 0.1 ? `Most of the outline it misses is on its ${worst(0)}.` : '',
    extra > 0.1 ? `It is drawn beyond the outline mostly on its ${worst(1)}.` : '',
    colour === null
      ? ''
      : colour > FAR_COLOUR
        ? `Its colours are far from the photo’s (ΔE ${Math.round(colour)}): the camera sees other colours or a pattern it doesn’t have.`
        : `Its colours are ΔE ${Math.round(colour)} from the photo’s.`,
  ]
    .filter(Boolean)
    .join(' ');
  return { iou, missing, extra, report, deltaE: colour };
}

/**
 * A recipe scaled evenly along each axis: every part keeps its share of the
 * whole. Its height ends at its highest part's top, so a thin coaster
 * scaled up isn't a tall box of air.
 */
function scaleRecipe(r: FixtureRecipe, k: { w: number; d: number; h: number }): FixtureRecipe {
  const round = (v: number) => Math.round(v * 100) / 100;
  const parts = r.parts.map((p) => ({
    ...p,
    atCm: { x: round(p.atCm.x * k.w), y: round(p.atCm.y * k.d), z: round(p.atCm.z * k.h) },
    sizeCm: { w: round(p.sizeCm.w * k.w), d: round(p.sizeCm.d * k.d), h: round(p.sizeCm.h * k.h) },
  }));
  const top = Math.max(...parts.map((p) => p.atCm.z + p.sizeCm.h));
  return {
    ...r,
    sizeCm: {
      w: round(r.sizeCm.w * k.w),
      d: round(r.sizeCm.d * k.d),
      h: round(Math.min(r.sizeCm.h * k.h, top)),
    },
    parts,
  };
}

export interface RefitOptions {
  /**
   * Leave the model's height as it is: a flat thing's (a coaster's) is known,
   * and from a high corner its outline fits a thicker, smaller one as well.
   */
  keepHeight?: boolean;
}
/** How far a refit may scale a model along an axis, either way. */
const REFIT_SCALE = 4;
/** How many checks a refit may spend: each draws the room, about 20 ms. */
const REFIT_TRIES = 200;
/**
 * What stretching one axis away from the model's overall size costs, in IoU
 * per unit of log scale. Along a side the camera sees end on (a coaster's
 * width running away from it), stretching hardly changes the outline, so
 * without a cost its size drifts as far as it may; a real gain still pays it.
 */
const REFIT_STRETCH = 0.02;
/**
 * A model's size and footprint fitted to its outline with its own shape: each
 * axis scaled and its middle moved where the camera's drawing of it best
 * matches the outline (IoU), standing at the same height. From a high corner
 * a small thing's outline fits a tall narrow box as well as a wide flat one,
 * so the camera's box can be the wrong one; once a model has a shape (a flat
 * coaster), only one size of it fits. For a size the camera measured, never
 * one looked up or asked for.
 */
export function refitRecipe(
  camera: RoomCamera,
  scene: IsoScene,
  recipe: FixtureRecipe,
  place: RecipePlace,
  outline: Bits,
  { keepHeight = false }: RefitOptions = {},
): { recipe: FixtureRecipe; place: RecipePlace; iou: number } {
  // Log scale along w, d, h, then the middle's move in tiles.
  const at = (v: number[]) => ({
    recipe: scaleRecipe(recipe, { w: Math.exp(v[0]!), d: Math.exp(v[1]!), h: Math.exp(v[2]!) }),
    place: { ...place, cx: place.cx + v[3]!, cy: place.cy + v[4]! },
  });
  let tries = 0;
  const iouOf = (v: number[]) => {
    tries++;
    const c = at(v);
    return checkRecipe(camera, scene, c.recipe, c.place, outline).iou;
  };
  // First its overall size: one scale for every axis, swept, since a model far off its size
  // matches best by stretching one way and moving another, from where no single step leads back.
  let k = 0;
  let iou = iouOf([0, 0, 0, 0, 0]);
  const sweep = Math.log(REFIT_SCALE);
  for (let s = -sweep; s <= sweep + 1e-9; s += sweep / 8) {
    if (Math.abs(s) < 1e-9) continue;
    const next = iouOf([s, s, keepHeight ? 0 : s, 0, 0]);
    if (next > iou) [k, iou] = [s, next];
  }
  // Then each axis and its middle, a step at a time, each axis paying for its stretch from k.
  // The camera's box already stood about there: its middle moves by at most half its width.
  const span = (Math.max(recipe.sizeCm.w, recipe.sizeCm.d) * Math.exp(k)) / ISO_TILE_CM;
  // A height kept is never scaled: its bounds are its own.
  const hk = keepHeight ? 0 : k;
  const hSweep = keepHeight ? 0 : sweep;
  const limit = [sweep, sweep, hSweep, span / 2, span / 2];
  const lo = [-sweep, -sweep, -hSweep, -span / 2, -span / 2];
  const score = (v: number[], fit: number) =>
    fit - REFIT_STRETCH * (Math.abs(v[0]! - k) + Math.abs(v[1]! - k) + Math.abs(v[2]! - hk));
  const step = [0.25, 0.25, 0.25, span / 4, span / 4];
  let best = [k, k, hk, 0, 0];
  let bestScore = score(best, iou);
  // Each round takes the best of every one-axis step, not the first that helps: a model grown
  // wide and moved aside can match about as well as one the right size.
  for (let round = 0; round < 6 && tries < REFIT_TRIES;) {
    let next: [number[], number, number] | null = null;
    for (let i = 0; i < best.length; i++)
      for (const sign of [1, -1]) {
        const v = [...best];
        v[i] = Math.max(lo[i]!, Math.min(limit[i]!, v[i]! + sign * step[i]!));
        if (v[i] === best[i]) continue;
        const fit = iouOf(v);
        const sc = score(v, fit);
        if (sc > (next?.[1] ?? bestScore)) next = [v, sc, fit];
      }
    if (next) [best, bestScore, iou] = next;
    else {
      for (let i = 0; i < step.length; i++) step[i]! /= 2;
      round++;
    }
  }
  return { ...at(best), iou };
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
