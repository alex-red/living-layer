import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { demoIntent } from '../apps/server/src/demo-intent.js';
import { demoPng, demoSegmentation } from '../apps/server/src/demo.js';
import {
  fitNewModel,
  keepOutline,
  modelAxes,
  namedOutline,
  samConcept,
} from '../apps/server/src/assist.js';
import { syntheticStream } from '../apps/server/src/sam.js';
import {
  cm,
  DEMO_CALIBRATION,
  fixtureRecipeSchema,
  floorSolid,
  ISO_PRESETS,
  mirrorRecipe,
  photoBox,
  placeOfGroup,
  renderRoom,
  roomMask,
  sceneSolids,
  sceneWithRecipe,
  sizeDisagreement,
  type AssistDraft,
  type DeskMemory,
  type EvidenceRun,
  type FixtureRecipe,
  type RecipePlace,
  type SelectionShape,
} from '../packages/domain/src/index.js';
import { demoRoom, shapeOf } from '../scripts/lib/brush.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function setup(env: Record<string, string> = {}, fetcher?: Fetcher) {
  const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-assist-'));
  dirs.push(dataDir);
  const app = await buildApp(parseConfig({ DATA_DIR: dataDir, ...env }), {
    serveWeb: false,
    ...(fetcher ? { fetcher } : {}),
  });
  const assist = (body: object, mode = 'demo') =>
    app.inject({ method: 'POST', url: '/api/assist', payload: { mode, ...body } });
  return { app, assist, dataDir };
}
/** A rectangle around how the demo room's camera draws a group, a little larger. */
const around = (group: string): SelectionShape => shapeOf({ around: group }, demoRoom());
const HEADLINE =
  'Turn this into its own office desk furniture/fixture - its an Ikea Alex Office Desk';

describe('the AI brush in the demo', () => {
  it('turns the selected desk into an Alex desk from the catalog, checked through the camera', async () => {
    const s = await setup();
    const jobId = crypto.randomUUID();
    const res = await s.assist({ shape: around('desk'), prompt: HEADLINE, jobId });
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json<EvidenceRun<AssistDraft>>();
    expect(run.kind).toBe('assist');
    const d = run.output;
    expect(d.target).toEqual({ kind: 'prop', id: 'desk', label: 'Desk' });
    expect(d.intent.ops[0]).toMatchObject({ op: 'create', form: 'desk' });
    expect(d.facts?.origin.size).toBe('catalog');
    expect(d.recipe?.parts.map((p) => p.name)).toEqual(
      expect.arrayContaining(['top', 'drawer-unit', 'panel-left']),
    );
    // The camera's own measure of the room's desk, and the Alex checked where it stood.
    expect(d.photo.sizeCm!.w).toBeGreaterThan(130);
    expect(d.place).toMatchObject({ replaces: 'desk' });
    expect(d.check!.iou).toBeGreaterThan(0.4);
    expect(d.check!.iou).toBeLessThan(0.75);
    expect(d.rounds).toEqual([]);
    // The demo's desk already stands where its camera draws it, so no place fits clearly better.
    expect(d.fit).toBeNull();
    expect(run.assets.map((a) => a.split('/')[1])).toEqual([
      'frame.png',
      'outline.png',
      'whole.png',
      'crop.png',
    ]);
    // Every step ran, and the job is over.
    const job = (await s.app.inject(`/api/jobs/${jobId}`)).json<{
      done: boolean;
      steps: { id: string; state: string; detail?: string }[];
    }>();
    expect(job.done).toBe(true);
    expect(job.steps.map((x) => x.state)).toEqual(Array(7).fill('done'));
    // The monitor and keyboard on the desk hide its back from the corner camera: its depth isn't judged.
    expect(job.steps.find((x) => x.id === 'lookup')?.detail).toContain('hides its back');
    expect(d.disagreement.map((x) => x.axis)).not.toContain('d');
    // Shaping it from the photo is Spark's, live: the demo keeps the model built from its form.
    expect(job.steps.find((x) => x.id === 'shape')?.detail).toBe(
      'Demo: built from its form, with no model calls',
    );
  });

  it('follows up on the same selection and model: one reading, nothing looked up again', async () => {
    const s = await setup();
    const first = (await s.assist({ shape: around('desk'), prompt: HEADLINE })).json<
      EvidenceRun<AssistDraft>
    >();
    const res = await s.assist({ previous: first.id, prompt: 'Make the drawers green' });
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json<EvidenceRun<AssistDraft>>().output;
    expect(d.previous).toBe(first.id);
    expect(d.shape).toEqual(first.output.shape);
    const colors = new Set(d.recipe!.parts.filter((p) => p.role === 'drawer').map((p) => p.color));
    expect(colors).toEqual(new Set(['#3f8f4a']));
    expect(d.recipe!.parts.find((p) => p.name === 'top')!.color).not.toBe('#3f8f4a');
    // A colour isn't a shape: the last check stands.
    expect(d.check).toEqual(first.output.check);
    // Resizing is: the check runs again, and Spark never undoes a size asked for.
    const wider = (await s.assist({ previous: first.id, prompt: 'It is 160 cm wide' })).json<
      EvidenceRun<AssistDraft>
    >().output;
    expect(wider.recipe!.sizeCm.w).toBe(160);
    expect(wider.check!.iou).toBeGreaterThan(first.output.check!.iou);
  });

  it('asks back when the request is unclear, or there is nothing to edit yet', async () => {
    const s = await setup();
    const shape = around('desk');
    const odd = (await s.assist({ shape, prompt: "what's the weather" })).json<
      EvidenceRun<AssistDraft>
    >().output;
    expect(odd.question).toContain('In the demo I can');
    expect(odd.recipe).toBeNull();
    const early = (await s.assist({ shape, prompt: 'make it green' })).json<
      EvidenceRun<AssistDraft>
    >().output;
    expect(early.question).toBe('There is no model to change yet: make it its own fixture first.');
  });

  it('refuses a follow-up of another kind of run, or of nothing', async () => {
    const s = await setup();
    const res = await s.assist({ previous: crypto.randomUUID(), prompt: 'make it green' });
    expect(res.statusCode).toBe(404);
    expect((await s.assist({ prompt: 'make it green' })).statusCode).toBe(400);
  });
});

describe('saving a draft into the room', () => {
  it('puts the Alex in place of the desk, makes the preset room its own, and edits it next time', async () => {
    const s = await setup();
    const shape = around('desk');
    const first = (await s.assist({ shape, prompt: HEADLINE })).json<EvidenceRun<AssistDraft>>();
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/assist/save',
      payload: { mode: 'demo', runId: first.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { memory, group } = res.json<{ memory: DeskMemory; group: string }>();
    expect(group).toBe('ikea-alex-office-desk');
    expect(memory.camera?.scene).toBe('custom');
    const scene = memory.scene!;
    expect(scene.props.some((p) => p.group === 'desk')).toBe(false);
    const alex = scene.props.find((p) => p.group === group)!;
    expect(alex.recipe?.parts.some((p) => p.name === 'drawer-unit')).toBe(true);
    // The monitor stood on the 72 cm desk; it now stands on the Alex's 76 cm top.
    const monitor = scene.props.find((p) => p.group === 'monitor')!;
    expect(monitor.at.z).toBeCloseTo(cm(76), 2);
    // The next brush on it finds a model to edit.
    const edit = (await s.assist({ shape, prompt: 'make the drawers green' })).json<
      EvidenceRun<AssistDraft>
    >();
    const next = edit.output;
    expect(next.target).toMatchObject({ kind: 'prop', id: group });
    expect(next.question).toBeNull();
    expect(next.recipe!.parts.find((p) => p.name === 'drawer-1')!.color).toBe('#3f8f4a');
    // Saving the edit keeps the model's id, and its top stays the pinned surface.
    const again = await s.app.inject({
      method: 'POST',
      url: '/api/assist/save',
      payload: { mode: 'demo', runId: edit.id },
    });
    expect(again.statusCode, again.body).toBe(200);
    const saved = again.json<{ memory: DeskMemory; group: string }>();
    expect(saved.group).toBe(group);
    expect(saved.memory.surface?.scene).toBe('custom');
    expect(saved.memory.surface?.surfaceId.startsWith(`${group}:`)).toBe(true);
  });

  it('never overwrites a scene of the person’s own on a preset-calibrated room', async () => {
    const s = await setup();
    const first = (await s.assist({ shape: around('desk'), prompt: HEADLINE })).json<
      EvidenceRun<AssistDraft>
    >();
    const restored = await s.app.inject({
      method: 'POST',
      url: '/api/desk/restore',
      payload: {
        mode: 'demo',
        memory: { mode: 'demo', object: null, scene: { ...ISO_PRESETS.desk, kind: 'custom' } },
      },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/assist/save',
      payload: { mode: 'demo', runId: first.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('assist_scene');
  });
});

describe('the AI brush live, against a mocked Meta API', () => {
  async function samEmpty(wire = '') {
    const events = [];
    for await (const event of syntheticStream(wire))
      events.push(
        event.type === 'response.completed'
          ? { ...event, response: { id: 'resp_sam', model: 'sam-3.1', status: 'completed' } }
          : event,
      );
    return new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') +
        'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  const spark = (output: object) =>
    new Response(
      JSON.stringify({
        id: 'resp',
        object: 'response',
        model: 'muse-spark-1.3',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }],
          },
        ],
        usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
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
  };

  async function live(
    env: Record<string, string> = {},
    { samWire = '', refineFails = false }: { samWire?: string; refineFails?: boolean } = {},
  ) {
    const asked: string[] = [];
    const fetcher = mock<Fetcher>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === 'sam-3.1') {
        asked.push('sam');
        return samEmpty(samWire);
      }
      const name = body.text.format.name as string;
      asked.push(name);
      if (name === 'edit_intent') return spark(demoIntent(HEADLINE));
      if (name === 'recipe_refine' && refineFails)
        return new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      if (name === 'recipe_refine')
        return spark({
          ops: [{ ...empty, op: 'resize', sizeCm: { w: 150, d: null, h: null } }],
          product: null,
          needs: [],
          targetDisagrees: null,
        });
      throw new Error(`unexpected ${name}`);
    });
    const s = await setup(
      { MODEL_API_KEY: 'test-key', META_LIVE_ENABLED: 'true', ...env },
      fetcher,
    );
    const restored = await s.app.inject({
      method: 'POST',
      url: '/api/desk/restore',
      payload: { mode: 'live', memory: { mode: 'live', object: null, camera: DEMO_CALIBRATION } },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const imageDataUrl = `data:image/png;base64,${(await demoPng()).toString('base64')}`;
    /** What a job's step said when it finished. */
    const step = async (jobId: string, id: string) =>
      (await s.app.inject({ method: 'GET', url: `/api/jobs/${jobId}` }))
        .json<{ steps: { id: string; detail?: string }[] }>()
        .steps.find((x) => x.id === id)?.detail;
    return { ...s, asked, imageDataUrl, step };
  }

  it('reads with Spark, outlines with SAM, finds the product in the catalog, and refines', async () => {
    const s = await live();
    const res = await s.assist(
      { shape: around('desk'), prompt: HEADLINE, imageDataUrl: s.imageDataUrl },
      'live',
    );
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json<EvidenceRun<AssistDraft>>();
    // The catalog had the product, so the web was never asked.
    expect(s.asked[0]).toBe('sam');
    expect(s.asked[1]).toBe('edit_intent');
    expect(s.asked).not.toContain('product_lookup');
    expect(s.asked.filter((a) => a === 'recipe_refine').length).toBeGreaterThan(0);
    expect(run.output.facts?.origin.size).toBe('catalog');
    expect(run.usage?.inputTokens).toBeGreaterThan(0);
  });

  it('keeps to what the panel showed when SAM outlines something else', async () => {
    const shape = around('desk');
    // SAM answers with a recorded mug mask, which falls on nothing the demo room draws there.
    const mug = JSON.parse(readFileSync('testdata/sam-mug.json', 'utf8')) as { wire: string };
    const s = await live({}, { samWire: mug.wire });
    const jobId = crypto.randomUUID();
    const res = await s.assist(
      { shape, prompt: HEADLINE, imageDataUrl: s.imageDataUrl, jobId },
      'live',
    );
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json<EvidenceRun<AssistDraft>>();
    expect(run.output.target).toMatchObject({ kind: 'prop', id: 'desk' });
    expect(run.output.recipe?.label).toContain('Alex');
    // SAM was asked again by the desk's name and answered the mug again: the room's drawing stands.
    expect(s.asked.filter((a) => a === 'sam')).toHaveLength(2);
    expect(await s.step(jobId, 'select')).toContain('SAM outlined nothing the room has');
  });

  it('keeps the model as built when a refinement fails', async () => {
    const s = await live({}, { refineFails: true });
    const jobId = crypto.randomUUID();
    const res = await s.assist(
      { shape: around('desk'), prompt: HEADLINE, imageDataUrl: s.imageDataUrl, jobId },
      'live',
    );
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json<EvidenceRun<AssistDraft>>();
    expect(run.output.recipe).not.toBeNull();
    expect(run.output.rounds).toEqual([]);
    expect(await s.step(jobId, 'check')).toContain('refinement failed');
  });

  it('refuses a frame of another size, and a request today’s limit can’t cover', async () => {
    const s = await live({ META_DAILY_SPEND_LIMIT_USD: '0.01' });
    const res = await s.assist(
      { shape: around('desk'), prompt: HEADLINE, imageDataUrl: s.imageDataUrl },
      'live',
    );
    expect(res.statusCode).toBe(429);
    expect(s.asked).toEqual([]);
    const t = await live();
    const small = `data:image/png;base64,${(
      await (
        await import('sharp')
      )
        .default(await demoPng())
        .resize(480)
        .png()
        .toBuffer()
    ).toString('base64')}`;
    const wrong = await t.assist(
      { shape: around('desk'), prompt: HEADLINE, imageDataUrl: small },
      'live',
    );
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe('not_calibrated');
  });
});

describe('the outline a live request keeps', () => {
  const room = demoRoom();
  const mask = (group: string) => roomMask(room.picture, group)!;
  const desk = { kind: 'prop' as const, id: 'desk', label: 'Desk' };
  it('keeps SAM’s outline of a thing the room draws too small, not of what stands on it', () => {
    // SAM's outline of the real desk, wider than the room's drawing of it: the room's drawing lies inside it.
    const wider = mask('desk');
    const { width, height } = wider;
    const grown = { ...wider, data: new Uint8Array(wider.data) };
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (wider.data[y * width + x])
          for (let d = -12; d <= 12; d++) {
            const xx = x + d;
            if (xx >= 0 && xx < width) grown.data[y * width + xx] = 1;
          }
    expect(keepOutline(room, around('desk'), desk, grown).samMissed).toBeNull();
    // The keyboard on it: the room's desk mostly lies outside it, so the room's own drawing is used.
    const kept = keepOutline(room, around('desk'), desk, mask('keyboard'));
    expect(kept.samMissed).toBe('Keyboard');
  });
  it('asks SAM for a thing by a short name', () => {
    expect(samConcept('Light wood desk with drawers')).toBe('light wood desk');
    expect(samConcept('White mug with blue inside')).toBe('white mug');
    expect(samConcept('Desk')).toBe('desk');
  });
  it('keeps SAM’s outline found by name where the room drew the thing well off, not a mug on it', async () => {
    const drawn = mask('desk');
    // The room's drawing of the desk 60 pixels left and 30 down of where the camera sees it.
    const off = { ...drawn, data: new Uint8Array(drawn.data.length) };
    for (let y = 0; y + 30 < drawn.height; y++)
      for (let x = 60; x < drawn.width; x++)
        off.data[(y + 30) * drawn.width + x - 60] = drawn.data[y * drawn.width + x]!;
    expect(keepOutline(room, around('desk'), desk, drawn).samMissed).toBeNull();
    const named = namedOutline(
      (await demoSegmentation('desk')).output,
      around('desk'),
      room.frame,
      off,
    );
    expect(named).not.toBeNull();
    let both = 0;
    for (let i = 0; i < drawn.data.length; i++) both += named!.whole.data[i]! & drawn.data[i]!;
    expect(both / drawn.data.reduce((a, v) => a + v, 0)).toBeGreaterThan(0.9);
    // A mug on the desk, answered for “desk”, shares next to nothing of its drawing.
    const mug = await demoSegmentation('mug');
    expect(namedOutline(mug.output, around('desk'), room.frame, off)).toBeNull();
  });
});

describe('where a new model stands', () => {
  const room = demoRoom();
  const alex = fixtureRecipeSchema.parse(
    JSON.parse(readFileSync('testdata/recipes/alex-desk.json', 'utf8')),
  );
  const at = placeOfGroup(room.scene, 'desk')!;
  /** The outline the camera would see of `recipe` standing at `place`. */
  const seen = (recipe: FixtureRecipe, place: RecipePlace) => {
    const s = sceneWithRecipe(room.scene, recipe, place);
    const pic = renderRoom(room.camera, [floorSolid(s.grid), ...sceneSolids(s)], { labels: true });
    return roomMask(pic, 'candidate')!;
  };
  it('mirrors it when the photo has its drawer unit on the other side, never turning it round', () => {
    const fitted = fitNewModel(room, alex, at, seen(mirrorRecipe(alex), at))!;
    expect(fitted.fit).toMatchObject({ mirrored: true, turned: false });
    expect(fitted.place.turns).toBe(at.turns);
    expect(fitted.recipe.parts.find((p) => p.name === 'drawer-unit')!.atCm.x).toBe(0);
  });
  it('keeps it as built when the photo matches it, only moved', () => {
    const fitted = fitNewModel(room, alex, at, seen(alex, { ...at, cx: at.cx + 1 }))!;
    expect(fitted.fit).toMatchObject({ mirrored: false, turned: false });
    expect(fitted.recipe).toBe(alex);
    expect(fitted.place.cx).toBeCloseTo(at.cx + 1, 1);
  });
  it('reads the camera’s size of a thing standing a quarter turned in its own axes', () => {
    const turned = { ...at, turns: (at.turns + 1) % 4 };
    const box = photoBox(room.camera, seen(alex, turned), room.scene.grid)!;
    // Across the room it is 60 wide and 131 deep; as the desk, 131 wide and 60 deep.
    expect(box.d).toBeGreaterThan(box.w);
    const own = modelAxes(box, turned.turns)!;
    expect(sizeDisagreement(alex.sizeCm, { w: own.w }).length).toBe(0);
    expect(modelAxes(box, at.turns + 2)).toBe(box);
  });
});
