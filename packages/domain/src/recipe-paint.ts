import { clusterColours, rgbLab, type Lab } from './color.js';
import type { IsoScene } from './iso.js';
import { propModel } from './iso-furniture.js';
import type { Decal } from './iso-item.js';
import { ridersOf } from './iso-templates.js';
import type { Bits } from './photo-scene.js';
import { sceneWithRecipe, type RecipePlace } from './recipe-build.js';
import { fixtureRecipeSchema, type FixtureRecipe } from './recipe.js';
import { projectRoom, type RoomCamera } from './room-camera.js';

/** A thing at most this tall for its width is flat: what shows of it is its top. */
const FLAT = 0.35;
/** Decal pixels along each side of the top: about what the room draws a small thing with. */
const SIDE = 24;
/** Frame samples along each side of a decal pixel, averaged. */
const SUB = 3;
/** Colours a print is read in: a coaster's two or three, not the photo's noise. */
const MAX_COLOURS = 4;
/** A top this much one colour has no print to paint. */
const PLAIN = 0.92;

interface PhotoPrint {
  recipe: FixtureRecipe;
  /** The parts painted. */
  parts: string[];
  colours: number;
}

/**
 * A flat thing's print read off the room's photo: each top the room sees
 * from above is read where the calibrated camera sees it, and the colours
 * become a top decal on that part (a coaster's yin-yang, a book's cover).
 * It is only as true as the model's place and height: a coaster built 2 cm
 * thick has its top drawn above the photo's. Only what the outline shows is
 * read; a top hidden in the frame, one plain colour, or a thing that isn't
 * flat or carries something on it, gives null.
 */
export function printFromPhoto(
  camera: RoomCamera,
  scene: IsoScene,
  recipe: FixtureRecipe,
  place: RecipePlace,
  outline: Bits,
  rgba: Uint8Array | Uint8ClampedArray,
): PhotoPrint | null {
  const { w, d, h } = recipe.sizeCm;
  if (h > FLAT * Math.min(w, d)) return null;
  const s = sceneWithRecipe(scene, recipe, place);
  const prop = s.props.find((p) => p.group === 'candidate');
  if (!prop || ridersOf(s, 'candidate').length) return null;
  const model = propModel(prop) ?? [];
  // What shows from above: every part covering at least half the footprint. A thin top part is
  // thinner than a voxel at room size, so the part under it is painted too.
  const area0 = prop.size.w * prop.size.d;
  const tops = model.filter(
    (q) => q.shape !== 'tube' && q.name && q.size.w * q.size.d >= area0 / 2,
  );
  if (!tops.length) return null;
  // Each top read where the camera sees it, so the drawing of it lines up with the photo pixel
  // for pixel: a cell's samples inside the outline, averaged; a cell mostly outside it is hidden
  // or off the thing, and left the part's own colour.
  const { width, height } = outline;
  const cells: { part: number; cell: number }[] = [];
  const labs: Lab[] = [];
  let seen = 0;
  let shown = 0;
  tops.forEach((q, part) => {
    const round = q.shape === 'lathe';
    const z = prop.at.z + q.at.z + q.size.h;
    for (let row = 0; row < SIDE; row++)
      for (let col = 0; col < SIDE; col++) {
        // A turned part's top is an ellipse in its box: its corners aren't it.
        if (round && ((col + 0.5) / SIDE - 0.5) ** 2 + ((row + 0.5) / SIDE - 0.5) ** 2 > 0.25)
          continue;
        shown++;
        let n = 0;
        const sum: Lab = [0, 0, 0];
        for (let a = 0; a < SUB; a++)
          for (let b = 0; b < SUB; b++) {
            const p = projectRoom(camera, {
              x: prop.at.x + q.at.x + ((col + (a + 0.5) / SUB) / SIDE) * q.size.w,
              y: prop.at.y + q.at.y + ((row + (b + 0.5) / SUB) / SIDE) * q.size.d,
              z,
            });
            if (!p) continue;
            const px = Math.floor(p.x);
            const py = Math.floor(p.y);
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const i = py * width + px;
            if (!outline.data[i]) continue;
            const lab = rgbLab([rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!]);
            sum[0] += lab[0];
            sum[1] += lab[1];
            sum[2] += lab[2];
            n++;
          }
        if (n * 2 < SUB * SUB) continue;
        seen++;
        cells.push({ part, cell: row * SIDE + col });
        labs.push([sum[0] / n, sum[1] / n, sum[2] / n]);
      }
  });
  // Mostly hidden in the frame: there is too little of it to read.
  if (seen < shown * 0.3) return null;
  // One palette for every top, so the parts painted agree.
  const { clusters, labels } = clusterColours(labs, MAX_COLOURS);
  if (clusters.length < 2 || clusters[0]!.share > PLAIN) return null;
  const colors = clusters.map((c) => c.hex);
  const data = tops.map(() => new Array<string>(SIDE * SIDE).fill('.'));
  cells.forEach(({ part, cell }, k) => (data[part]![cell] = '0123456789abcdef'[labels[k]!]!));
  // Read in the room's axes; each part is drawn turned by the prop's turns, which this undoes.
  const turns = (4 - ((prop.turns ?? 0) % 4)) % 4;
  const decals = new Map<string, Decal>(
    tops.map((q, part) => [
      q.name!,
      {
        kind: 'decal',
        face: 'top',
        u0: 0,
        u1: 1,
        v0: 0,
        v1: 1,
        turns,
        w: SIDE,
        h: SIDE,
        colors,
        data: data[part]!.join(''),
      },
    ]),
  );
  const painted = fixtureRecipeSchema.safeParse({
    ...recipe,
    parts: recipe.parts.map((p) => {
      const decal = decals.get(p.name);
      // A printed top is opaque: glass (a jar's, which a coaster is built from) would show through it.
      if (!decal) return p;
      return p.material === 'glass' ? { ...p, decal, material: 'matte' as const } : { ...p, decal };
    }),
  });
  return painted.success
    ? { recipe: painted.data, parts: [...decals.keys()], colours: clusters.length }
    : null;
}
