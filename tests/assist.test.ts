import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { demoIntent } from '../apps/server/src/demo-intent.js';
import { demoPng, demoSegmentation } from '../apps/server/src/demo.js';
import { syntheticStream } from '../apps/server/src/sam.js';
import {
  cm,
  DEMO_CALIBRATION,
  DEMO_FRAME,
  ISO_PRESETS,
  type AssistDraft,
  type DeskMemory,
  type EvidenceRun,
  type SelectionShape,
} from '../packages/domain/src/index.js';

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
/** A rectangle around what the demo's SAM outlines for `concept`, a little larger. */
async function around(concept: string): Promise<SelectionShape> {
  const d = (await demoSegmentation(concept)).output.detections[0]!;
  const t = (v: number, of: number) => Math.round(Math.min(1000, Math.max(0, (v / of) * 1000)));
  const g = 0.1;
  return {
    kind: 'rect',
    box: {
      x1: t(d.box.x - d.box.width * g, DEMO_FRAME.width),
      y1: t(d.box.y - d.box.height * g, DEMO_FRAME.height),
      x2: t(d.box.x + d.box.width * (1 + g), DEMO_FRAME.width),
      y2: t(d.box.y + d.box.height * (1 + g), DEMO_FRAME.height),
    },
  };
}
const HEADLINE =
  'Turn this into its own office desk furniture/fixture - its an Ikea Alex Office Desk';

describe('the AI brush in the demo', () => {
  it('turns the selected desk into an Alex desk from the catalog, checked through the camera', async () => {
    const s = await setup();
    const jobId = crypto.randomUUID();
    const res = await s.assist({ shape: await around('desk'), prompt: HEADLINE, jobId });
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
    expect(run.assets.map((a) => a.split('/')[1])).toEqual([
      'frame.png',
      'outline.png',
      'crop.png',
    ]);
    // Every step ran, and the job is over.
    const job = (await s.app.inject(`/api/jobs/${jobId}`)).json<{
      done: boolean;
      steps: { id: string; state: string }[];
    }>();
    expect(job.done).toBe(true);
    expect(job.steps.map((x) => x.state)).toEqual(Array(6).fill('done'));
  });

  it('follows up on the same selection and model: one reading, nothing looked up again', async () => {
    const s = await setup();
    const first = (await s.assist({ shape: await around('desk'), prompt: HEADLINE })).json<
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
    const shape = await around('desk');
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
    const shape = await around('desk');
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
    const first = (await s.assist({ shape: await around('desk'), prompt: HEADLINE })).json<
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
  async function samEmpty() {
    const events = [];
    for await (const event of syntheticStream(''))
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

  async function live(env: Record<string, string> = {}) {
    const asked: string[] = [];
    const fetcher = mock<Fetcher>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === 'sam-3.1') {
        asked.push('sam');
        return samEmpty();
      }
      const name = body.text.format.name as string;
      asked.push(name);
      if (name === 'edit_intent') return spark(demoIntent(HEADLINE));
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
    return { ...s, asked, imageDataUrl };
  }

  it('reads with Spark, outlines with SAM, finds the product in the catalog, and refines', async () => {
    const s = await live();
    const res = await s.assist(
      { shape: await around('desk'), prompt: HEADLINE, imageDataUrl: s.imageDataUrl },
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

  it('refuses a frame of another size, and a request today’s limit can’t cover', async () => {
    const s = await live({ META_DAILY_SPEND_LIMIT_USD: '0.01' });
    const res = await s.assist(
      { shape: await around('desk'), prompt: HEADLINE, imageDataUrl: s.imageDataUrl },
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
      { shape: await around('desk'), prompt: HEADLINE, imageDataUrl: small },
      'live',
    );
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe('not_calibrated');
  });
});
