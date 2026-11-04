import sharp from 'sharp';
import { toDataUrl } from './images.js';
import { refitRecipeAsync, renderRoomAsync } from './workers/compute.js';
import {
  BRUSH_SCULPT_PARTS,
  brushSculptPrompt,
  draftScore,
  floorSolid,
  recipeFromSculpt,
  RECIPE_TARGET,
  recipeToSculpt,
  sceneSolids,
  sceneWithRecipe,
  type Bits,
  type FixtureRecipe,
  type IsoScene,
  type RecipeCheck,
  type RecipePlace,
  type RoomCamera,
  type Usage,
  uprightAt,
} from '@livinglayer/domain';
import type { MetaAdapter } from './meta.js';

/** What shaping a brush model from the photo made: the best look, and how each look did. */
export interface Shaped {
  recipe: FixtureRecipe;
  /** Where it stands: moved when its size was refitted. */
  place: RecipePlace;
  check: RecipeCheck;
  /** Spark's note on the look that was kept. */
  note: string;
  /** Each look's check, first to last. */
  looks: RecipeCheck[];
  /** The kept model drawn through the camera, cut as the photo is. */
  render: Buffer;
}
/** A brush model is shaped from the photo alone, then again beside its drawing. */
const LOOKS = ['photo', 'again'] as const;

/**
 * Spark models a brush model from the camera's picture
 * (`brushSculptPrompt`): first from the photo cut around the thing alone, in
 * the model's size, then again from the photo beside its first look drawn
 * through the same camera and cut the same way; once when the first already
 * meets `RECIPE_TARGET`. The model built from its form only gives the size,
 * and stands when no look matches the photo better. Each look is checked against the camera, outline
 * and colours (`draftScore`); the best is kept. Null when no look gave a
 * usable model, so the model built from its form stands. With `refit`, each
 * look's size and footprint are fitted to the outline with its own shape
 * first (`refitRecipe`): for a size the camera measured, which a small
 * thing's outline leaves unsure.
 */
export async function shapeFromPhoto({
  meta,
  camera,
  scene,
  place,
  recipe,
  frame,
  against,
  request,
  check,
  refit = false,
  onCall,
  signal,
}: {
  meta: MetaAdapter;
  camera: RoomCamera;
  scene: IsoScene;
  place: RecipePlace;
  recipe: FixtureRecipe;
  /** The frame the request was made on, as a PNG of the camera's frame size. */
  frame: Buffer;
  /** The thing's outline in the frame, which the photo is cut around. */
  against: Bits;
  request: string;
  check: (r: FixtureRecipe, place: RecipePlace) => RecipeCheck;
  /** Fit each look's size to the outline: only for a size the camera measured. */
  refit?: boolean;
  /** Each billed call's usage and model, for the run. */
  onCall: (r: { usage: Usage | null; model: string; requestId: string | null }) => void;
  signal?: AbortSignal;
}): Promise<Shaped | null> {
  const box = cutAround(against);
  if (!box) return null;
  const photo = await sharp(frame).extract(box).png().toBuffer();
  const upright = uprightTilt(camera, {
    x: box.left + box.width / 2,
    y: box.top + box.height / 2,
  });
  const drawn = async (r: FixtureRecipe, at: RecipePlace) => {
    // The model alone on the floor, so Spark sees its parts and not what stands round it.
    const solids = sceneSolids(sceneWithRecipe(scene, r, at)).filter((s) => s.id === 'candidate');
    // Only the pixels cut out are drawn.
    const pic = await renderRoomAsync(camera, [floorSolid(scene.grid), ...solids], {
      window: { x0: box.left, y0: box.top, x1: box.left + box.width, y1: box.top + box.height },
    });
    return sharp(Buffer.from(pic.rgba), {
      raw: { width: pic.width, height: pic.height, channels: 4 },
    })
      .extract(box)
      .png()
      .toBuffer();
  };
  const url = toDataUrl;
  let current = recipe;
  let at = place;
  // What Spark is shown of the model: nothing on the first look, then its own last look.
  let shown: Buffer | null = null;
  const looks: {
    recipe: FixtureRecipe;
    place: RecipePlace;
    check: RecipeCheck;
    note: string;
    render: Buffer;
  }[] = [];
  for (const look of LOOKS) {
    const answer = await meta.sculpt(
      url(photo),
      shown && url(shown),
      brushSculptPrompt(current, request, look, upright),
      shown && JSON.stringify(recipeToSculpt(current)),
      signal,
      BRUSH_SCULPT_PARTS,
    );
    onCall(answer);
    const next = recipeFromSculpt(current, answer.output);
    if (!next) break;
    current = next;
    if (refit)
      ({ recipe: current, place: at } = await refitRecipeAsync(camera, scene, next, at, against));
    const render = await drawn(current, at);
    shown = render;
    const checked = check(current, at);
    looks.push({ recipe: current, place: at, check: checked, note: answer.output.note, render });
    // A look that already matches the outline isn't asked again: each look is a call of half a
    // minute or more.
    if (checked.iou >= RECIPE_TARGET.iou) break;
  }
  if (!looks.length) return null;
  const best = looks.reduce((a, b) => (draftScore(b.check) > draftScore(a.check) ? b : a));
  return { ...best, looks: looks.map((l) => l.check) };
}

/**
 * How far, in degrees, something standing straight up at `p` runs from the
 * frame's vertical as it rises: positive to the right. A camera tilted down
 * from high in a corner draws uprights slanting, more so towards the frame's
 * edges.
 */
export function uprightTilt(camera: RoomCamera, p: { x: number; y: number }): number {
  const u = uprightAt(camera, p);
  return (Math.atan2(u.x, -u.y) * 180) / Math.PI;
}

/** The outline's box in the frame, grown by 15% each way and kept inside it. */
function cutAround(m: Bits): { left: number; top: number; width: number; height: number } | null {
  let [x0, x1, y0, y1] = [Infinity, -1, Infinity, -1];
  for (let i = 0; i < m.data.length; i++)
    if (m.data[i]) {
      const x = i % m.width;
      const y = Math.floor(i / m.width);
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
  if (x1 < x0 + 4 || y1 < y0 + 4) return null;
  const mx = Math.round((x1 - x0) * 0.15);
  const my = Math.round((y1 - y0) * 0.15);
  const left = Math.max(0, x0 - mx);
  const top = Math.max(0, y0 - my);
  return {
    left,
    top,
    width: Math.min(m.width, x1 + mx + 1) - left,
    height: Math.min(m.height, y1 + my + 1) - top,
  };
}
