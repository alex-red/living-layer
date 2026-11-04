import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sparkRefiner } from '../apps/server/src/build.js';
import { parseConfig } from '../apps/server/src/config.js';
import { MetaAdapter } from '../apps/server/src/meta.js';
import { BUNDLED_CATALOG, Catalog } from '../apps/server/src/research.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import {
  assembleRecipe,
  checkRecipe,
  cm,
  DEMO_CAMERA,
  DEMO_ROOM,
  demoFrame,
  floorSolid,
  formOfName,
  groupBounds,
  hexLab,
  photoBox,
  photoColor,
  placeOfGroup,
  propModel,
  recipeFromForm,
  defaultSize,
  fallbackForm,
  outlineRests,
  refineRecipe,
  refitRecipe,
  RECIPE_TARGET,
  renderRoom,
  roomMask,
  sceneSolids,
  solidsWindow,
  type FixtureRecipe,
  type RecipeCheck,
} from '@livinglayer/domain';

const frame = demoFrame();
const deskMask = roomMask(frame, 'desk');
const desk = groupBounds(DEMO_ROOM, 'desk')!;
const deskCm = { w: Math.round(desk.size.w * 30), d: Math.round(desk.size.d * 30) };
const place = placeOfGroup(DEMO_ROOM, 'desk')!;
const check = (r: FixtureRecipe) => checkRecipe(DEMO_CAMERA, DEMO_ROOM, r, place, deskMask);
const alexFacts = new Catalog([BUNDLED_CATALOG]).find('IKEA Alex desk')!.facts;

describe('a recipe from a built-in form', () => {
  it('copies the desk with its parts named by role, and draws the same', () => {
    const r = recipeFromForm('desk', deskCm, 'Desk');
    expect(r.parts.map((p) => p.name).sort()).toEqual(['leg-1', 'leg-2', 'leg-3', 'leg-4', 'top']);
    expect(r.surfaces).toEqual([{ part: 'top', label: 'Top' }]);
    expect(r.sizeCm.h).toBeCloseTo(72);
    const size = { w: cm(deskCm.w), d: cm(deskCm.d), h: cm(72) };
    const form = propModel({ form: 'desk', size, turns: 0 })!;
    const copied = propModel({ recipe: r, size, turns: 0 })!;
    expect(copied).toHaveLength(form.length);
    copied.forEach((p, i) => expect(p.size.w).toBeCloseTo(form[i]!.size.w, 3));
  });

  it('checks a recipe through the camera: the desk form matches the desk it is drawn as', () => {
    const c = check(recipeFromForm('desk', deskCm, 'Desk'));
    expect(c.iou).toBeGreaterThan(0.95);
    expect(c.missing).toBeLessThan(0.05);
  });
});

describe('the form a new model is built from, by its name', () => {
  it('builds a mug as a small turned thing, not a chest of drawers', () => {
    expect(formOfName('mug')).toBe('jar');
    expect(formOfName('coffee cup')).toBe('jar');
    expect(formOfName('water bottle')).toBe('bottle');
    expect(formOfName('standing desk')).toBe('desk');
    expect(formOfName('lamp table')).toBe('table');
    expect(formOfName('mouse')).toBeNull();
    // Flat and round, so a turned form: never a butter dish's block and lid.
    expect(formOfName('black coaster')).toBe('jar');
    expect(formOfName('saucer')).toBe('jar');
    const mug = assembleRecipe(formOfName('mug')!, { query: 'mug', name: 'mug', sources: [] });
    expect(mug.parts.some((p) => p.role === 'drawer')).toBe(false);
    expect(Math.max(mug.sizeCm.w, mug.sizeCm.d, mug.sizeCm.h)).toBeLessThan(15);
  });
});

describe('assembling a recipe from facts', () => {
  it('turns a desk into an Alex: a drawer unit right, a panel left, no legs, its colour and finish', () => {
    const r = assembleRecipe('desk', alexFacts);
    const names = r.parts.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'top',
        'drawer-unit',
        'drawer-1',
        'drawer-2',
        'drawer-3',
        'panel-left',
      ]),
    );
    expect(names.some((n) => n.startsWith('leg'))).toBe(false);
    expect(r.sizeCm).toEqual({ w: 131, d: 60, h: 76 });
    expect(new Set(r.parts.map((p) => p.color))).toEqual(new Set(['#e8e6e1']));
    expect(new Set(r.parts.map((p) => p.material))).toEqual(new Set(['matte']));
    const unit = r.parts.find((p) => p.name === 'drawer-unit')!;
    expect(unit.atCm.x + unit.sizeCm.w).toBeCloseTo(131);
    expect(r.sources?.[0]?.kind).toBe('person');
  });

  it("takes the photo's colour over the product's usual one", () => {
    const color = photoColor(frame.rgba, deskMask)!;
    // The demo desk is wood: warm and mid-dark.
    const [L, a, b] = hexLab(color);
    expect(L).toBeLessThan(0.7);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    const r = assembleRecipe('desk', alexFacts, color);
    expect(r.parts.every((p) => p.color === color)).toBe(true);
  });
});

describe("sizing a thing from the camera's outline", () => {
  it('finds a desk and a bookshelf on the floor within a tenth of their size', () => {
    for (const g of ['desk', 'shelf']) {
      const truth = groupBounds(DEMO_ROOM, g)!;
      const box = photoBox(DEMO_CAMERA, roomMask(frame, g), DEMO_ROOM.grid)!;
      expect(Math.abs(box.w / (truth.size.w * 30) - 1)).toBeLessThan(0.1);
      expect(Math.abs(box.h / (truth.size.h * 30) - 1)).toBeLessThan(0.1);
      expect(Math.abs(box.cx - (truth.at.x + truth.size.w / 2))).toBeLessThan(0.2);
    }
  });

  it('says when the thing runs out of the top of the picture, so its height isn’t measured', () => {
    expect(photoBox(DEMO_CAMERA, roomMask(frame, 'shelf'), DEMO_ROOM.grid)!.cutTop).toBe(false);
    // The same camera looking lower: the shelf's top is above the frame.
    const full = roomMask(frame, 'shelf')!;
    let top = 0;
    while (!full.data.subarray(top * full.width, (top + 1) * full.width).includes(1)) top++;
    const lower = { ...DEMO_CAMERA, cy: DEMO_CAMERA.cy - top - 40 };
    const seen = roomMask(
      renderRoom(lower, [floorSolid(DEMO_ROOM.grid), ...sceneSolids(DEMO_ROOM)], { labels: true }),
      'shelf',
    )!;
    const box = photoBox(lower, seen, DEMO_ROOM.grid)!;
    expect(box.cutTop).toBe(true);
  });

  it('gives nothing for a thing that stands on another, unless measured at its height', () => {
    expect(photoBox(DEMO_CAMERA, roomMask(frame, 'lamp'), DEMO_ROOM.grid)).toBeNull();
    const lamp = groupBounds(DEMO_ROOM, 'lamp')!;
    const box = photoBox(DEMO_CAMERA, roomMask(frame, 'lamp'), DEMO_ROOM.grid, {
      floor: lamp.at.z,
    })!;
    expect(Math.abs(box.h / (lamp.size.h * 30) - 1)).toBeLessThan(0.1);
  });

  it('measures a new thing standing on the surface its outline’s foot lands on', () => {
    // The room has no place for a new thing to say it stands on the desk: its outline does.
    const lamp = groupBounds(DEMO_ROOM, 'lamp')!;
    const seen = roomMask(frame, 'lamp')!;
    const rests = outlineRests(DEMO_CAMERA, DEMO_ROOM, seen);
    expect(rests).toBeCloseTo(lamp.at.z);
    const box = photoBox(DEMO_CAMERA, seen, DEMO_ROOM.grid, { floor: rests })!;
    expect(Math.abs(box.h / (lamp.size.h * 30) - 1)).toBeLessThan(0.1);
  });

  it('measures a thing standing on the floor on the floor, not on a surface behind it', () => {
    for (const g of ['desk', 'shelf'])
      expect(outlineRests(DEMO_CAMERA, DEMO_ROOM, roomMask(frame, g)!)).toBe(0);
  });

  it('builds a small unnamed thing as a plain block, not a chest of drawers', () => {
    expect(fallbackForm({ w: 10, d: 10, h: 1 })).toBe('butter');
    expect(fallbackForm({ w: 60, d: 40, h: 72 })).toBe('cabinet');
    expect(fallbackForm(null)).toBe('cabinet');
  });

  it('builds a new model at its template’s size when nothing measured it', () => {
    // Not 40 cm square: a monitor built that small could never be shaped out to the one there is.
    expect(defaultSize('monitor')).toEqual({ w: 61, d: 20 });
    expect(defaultSize('keyboard')).toEqual({ w: 44, d: 14 });
    expect(defaultSize('foliage')).toEqual({ w: 40, d: 40 });
  });
});

describe('refitting a model’s size to its outline', () => {
  it('grows a model built too small back to the size the camera sees, keeping its parts', () => {
    // Its legs and top thicken as it grows, so it never matches as well as one built that size.
    for (const k of [0.6, 0.8]) {
      const small = recipeFromForm('desk', { w: deskCm.w * k, d: deskCm.d * k, h: 72 * k }, 'Desk');
      const fit = refitRecipe(DEMO_CAMERA, DEMO_ROOM, small, place, deskMask);
      expect(fit.iou).toBeGreaterThan(check(small).iou + 0.3);
      expect(Math.abs(fit.recipe.sizeCm.w / deskCm.w - 1)).toBeLessThan(0.1);
      expect(Math.abs(fit.recipe.sizeCm.d / deskCm.d - 1)).toBeLessThan(0.1);
      expect(Math.abs(fit.recipe.sizeCm.h / 72 - 1)).toBeLessThan(0.1);
      expect(fit.recipe.parts.map((p) => p.name)).toEqual(small.parts.map((p) => p.name));
      expect(fit.place.z).toBe(place.z);
    }
  }, 30_000);
});

describe('drawing only part of the room', () => {
  it('draws the window around the monitor as the whole picture does, and nothing outside it', () => {
    const solids = [floorSolid(DEMO_ROOM.grid), ...sceneSolids(DEMO_ROOM)];
    const screen = solidsWindow(
      DEMO_CAMERA,
      solids.filter((x) => x.id === 'monitor'),
    )!;
    expect(screen.x1 - screen.x0).toBeGreaterThan(5);
    const whole = renderRoom(DEMO_CAMERA, solids);
    const part = renderRoom(DEMO_CAMERA, solids, { window: screen });
    let same = 0;
    let outside = 0;
    for (let y = 0; y < whole.height; y++)
      for (let x = 0; x < whole.width; x++) {
        const i = y * whole.width + x;
        const inside = x >= screen.x0 && x < screen.x1 && y >= screen.y0 && y < screen.y1;
        if (!inside) {
          if (part.ids[i] !== -1 || part.rgba[i * 4 + 3] !== 0) outside++;
          continue;
        }
        const rgba = [0, 1, 2, 3].every((k) => part.rgba[i * 4 + k] === whole.rgba[i * 4 + k]);
        if (rgba && part.names[part.ids[i]!] === whole.names[whole.ids[i]!]) same++;
      }
    expect(same).toBe((screen.x1 - screen.x0) * (screen.y1 - screen.y0));
    expect(outside).toBe(0);
  });
});

describe('refitting a coaster the camera saw from its corner', () => {
  it('flattens one built as tall as its box into a disc the coaster’s size', () => {
    // From high in a corner the demo's 10 cm cork coaster has a box as tall as it is wide.
    const z = DEMO_ROOM.surfaces.find((s) => s.id === 'desk:top')!.z;
    const at = { cx: 6.05, cy: 2.45, z, turns: 0, replaces: null };
    const tall = recipeFromForm('jar', { w: 5.6, d: 7.5, h: 3.75 }, 'coaster');
    const fit = refitRecipe(DEMO_CAMERA, DEMO_ROOM, tall, at, roomMask(frame, 'coaster'));
    expect(fit.iou).toBeGreaterThan(0.9);
    expect(fit.recipe.sizeCm.h).toBeLessThan(1.5);
    expect(Math.abs(fit.recipe.sizeCm.w - 10)).toBeLessThan(1);
    expect(Math.abs(fit.recipe.sizeCm.d - 10)).toBeLessThan(1);
  });
});

describe('refining a recipe against the outline', () => {
  // The demo desk is 160 × 80; an Alex drawn there misses it.
  const alex = assembleRecipe('desk', alexFacts);
  const toDesk = async () => [{ op: 'resize' as const, sizeCm: { w: deskCm.w, d: deskCm.d } }];

  it('takes the refiner’s ops while they help, and keeps the best round', async () => {
    const before = check(alex).iou;
    expect(before).toBeLessThan(RECIPE_TARGET.iou);
    const { best, history } = await refineRecipe(alex, check, toDesk);
    expect(history.length).toBeGreaterThan(1);
    expect(best.check.iou).toBeGreaterThan(before);
    expect(best.recipe.sizeCm.w).toBe(deskCm.w);
  });

  it('never returns a round that made it worse, and stops without a refiner', async () => {
    const shrink = async () => [{ op: 'resize' as const, sizeCm: { w: 40 } }];
    const { best } = await refineRecipe(alex, check, shrink);
    expect(best.recipe).toBe(alex);
    expect((await refineRecipe(alex, check, null)).history).toHaveLength(1);
  });
});

describe('Spark as the refiner, against a mocked Meta API', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  it('sends the report and keeps only ops that change the recipe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livinglayer-refine-'));
    dirs.push(dir);
    const config = parseConfig({
      DATA_DIR: dir,
      MODEL_API_KEY: 'test-key',
      META_LIVE_ENABLED: 'true',
    });
    const empty = {
      parts: null,
      color: null,
      material: null,
      sizeCm: null,
      part: null,
      label: null,
      form: null,
      as: null,
      control: null,
      question: null,
      subject: null,
      occupant: null,
      state: null,
    };
    const answer = {
      ops: [
        { ...empty, op: 'resize', sizeCm: { w: 160, d: null, h: null } },
        { ...empty, op: 'create', label: 'Another desk' },
      ],
      product: null,
      needs: [],
      targetDisagrees: null,
    };
    let prompt = '';
    const fetcher = mock(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      prompt = body.input[0].content[0].text;
      return new Response(
        JSON.stringify({
          id: 'resp_refine',
          object: 'response',
          model: 'muse-spark-1.3',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify(answer), annotations: [] }],
            },
          ],
          usage: { input_tokens: 800, output_tokens: 150, total_tokens: 950 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    const refine = sparkRefiner(new MetaAdapter(config, new EvidenceStore(dir), fetcher));
    const report: RecipeCheck = {
      iou: 0.5,
      missing: 0.4,
      extra: 0.1,
      report: 'Misses its right.',
      deltaE: null,
    };
    const ops = await refine(alex(), report);
    expect(prompt).toContain('Misses its right.');
    expect(prompt).toContain('drawer-unit (body)');
    expect(ops).toEqual([{ op: 'resize', sizeCm: { w: 160 } }]);
  });
  const alex = () => assembleRecipe('desk', alexFacts);
});
