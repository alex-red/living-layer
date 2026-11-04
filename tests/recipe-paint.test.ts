import { describe, expect, it } from 'bun:test';
import {
  checkRecipe,
  DEMO_CAMERA,
  DEMO_ROOM,
  floorSolid,
  printFromPhoto,
  recipeFromForm,
  renderRoom,
  roomMask,
  sceneSolids,
  sceneWithRecipe,
  type Decal,
  type FixtureRecipe,
  type RecipePlace,
} from '@livinglayer/domain';

// The demo's coaster stands on the desk here; a 10 cm disc half a centimetre thick.
const z = DEMO_ROOM.surfaces.find((s) => s.id === 'desk:top')!.z;
const at = (turns: number): RecipePlace => ({ cx: 6.05, cy: 2.45, z, turns, replaces: null });
const plain = recipeFromForm('jar', { w: 10, d: 10, h: 0.6 }, 'coaster');

/** Its top half black and half white, split across the room's x, whichever way it is turned. */
const halves = (turns: number): Decal => ({
  kind: 'decal',
  face: 'top',
  u0: 0,
  u1: 1,
  v0: 0,
  v1: 1,
  turns: (4 - turns) % 4,
  w: 8,
  h: 8,
  colors: ['#101010', '#f4f4f4'],
  data: Array.from({ length: 64 }, (_, i) => (i % 8 < 4 ? '0' : '1')).join(''),
});
const painted = (r: FixtureRecipe, d: Decal): FixtureRecipe => ({
  ...r,
  parts: r.parts.map((p) => ({ ...p, decal: d })),
});

/** The room's camera on a coaster that really is printed: its frame and its outline. */
function photographed(truth: FixtureRecipe, place: RecipePlace) {
  const s = sceneWithRecipe(DEMO_ROOM, truth, place);
  const picture = renderRoom(DEMO_CAMERA, [floorSolid(s.grid), ...sceneSolids(s)]);
  return { rgba: picture.rgba, outline: roomMask(picture, 'candidate') };
}

describe('reading a flat thing’s print off the photo', () => {
  for (const turns of [0, 1])
    it(`paints the top so the camera sees the photo’s pattern (turned ${turns})`, () => {
      const place = at(turns);
      const { rgba, outline } = photographed(painted(plain, halves(turns)), place);
      const printed = printFromPhoto(DEMO_CAMERA, DEMO_ROOM, plain, place, outline, rgba)!;
      expect(printed).not.toBeNull();
      const before = checkRecipe(DEMO_CAMERA, DEMO_ROOM, plain, place, outline, rgba).deltaE!;
      const after = checkRecipe(DEMO_CAMERA, DEMO_ROOM, printed.recipe, place, outline, rgba);
      expect(after.deltaE!).toBeLessThan(before / 2);
    });

  it('leaves a top of one colour as it is', () => {
    const place = at(0);
    const one = { ...halves(0), data: '1'.repeat(64) };
    const { rgba, outline } = photographed(painted(plain, one), place);
    expect(printFromPhoto(DEMO_CAMERA, DEMO_ROOM, plain, place, outline, rgba)).toBeNull();
  });

  it('reads nothing off a thing that isn’t flat', () => {
    const place = at(0);
    const jar = recipeFromForm('jar', { w: 10, d: 10, h: 12 }, 'jar');
    const { rgba, outline } = photographed(painted(jar, halves(0)), place);
    expect(printFromPhoto(DEMO_CAMERA, DEMO_ROOM, jar, place, outline, rgba)).toBeNull();
  });
});

describe('the camera check’s colours', () => {
  it('says so when the model’s colours are far from the photo’s', () => {
    const place = at(0);
    const { rgba, outline } = photographed(painted(plain, halves(0)), place);
    const black = { ...plain, parts: plain.parts.map((p) => ({ ...p, color: '#000000' })) };
    const c = checkRecipe(DEMO_CAMERA, DEMO_ROOM, black, place, outline, rgba);
    expect(c.report).toContain('far from the photo’s');
  });
});
