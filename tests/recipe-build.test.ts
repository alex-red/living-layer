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
  refineRecipe,
  RECIPE_TARGET,
  renderRoom,
  roomMask,
  sceneSolids,
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

  it('gives nothing for a thing that stands on another', () => {
    expect(photoBox(DEMO_CAMERA, roomMask(frame, 'lamp'), DEMO_ROOM.grid)).toBeNull();
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
