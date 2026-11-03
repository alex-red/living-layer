import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { demoIntent } from '../apps/server/src/demo-intent.js';
import { demoPng } from '../apps/server/src/demo.js';
import { syntheticStream } from '../apps/server/src/sam.js';
import { DEMO_CALIBRATION, selectionMask, type DeskMemory, type Mode } from '@livinglayer/domain';
import {
  BRUSH_TARGETS,
  brushOverlay,
  demoApp,
  demoRoom,
  runBrush,
  sameTarget,
  seenIn,
  shapeOf,
  targetName,
  type BrushSelect,
} from '../scripts/lib/brush.js';

/**
 * The panel (`/api/select/resolve`) and the request (`/api/assist`) name the
 * same target, for every thing the demo room's camera sees, boxed whole and
 * boxed only in part: a box on part of a desk is how a request once worked
 * on the keyboard while the panel showed the desk.
 */
// Read but not built: with no model yet it asks back, after the target is settled. Building
// every form is the builder's own concern (bookcases and chairs don't build yet).
const PROMPT = 'Make it green';
const groups = seenIn(demoRoom());
const cases: { name: string; select: BrushSelect }[] = groups.flatMap((g) => [
  { name: `${g}, boxed whole`, select: { around: g } },
  { name: `${g}, its middle`, select: { around: g, pad: -0.2 } },
]);

/**
 * SAM outlining a recorded mug whatever is boxed, as it outlined a keyboard
 * for a box on a desk, and Spark reading as the demo does.
 */
const samMug = (JSON.parse(readFileSync('testdata/sam-mug.json', 'utf8')) as { wire: string }).wire;
const mockedMeta: Fetcher = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  if (body.model === 'sam-3.1') {
    const events = [];
    for await (const e of syntheticStream(samMug))
      events.push(
        e.type === 'response.completed'
          ? { ...e, response: { id: 'resp_sam', model: 'sam-3.1', status: 'completed' } }
          : e,
      );
    return new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') +
        'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  const name = body.text.format.name as string;
  const output =
    name === 'edit_intent'
      ? demoIntent(PROMPT)
      : { ops: [], product: null, needs: [], targetDisagrees: null };
  return new Response(
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
};

const apps: Record<Mode, { app: FastifyInstance; dir: string } | null> = { demo: null, live: null };
beforeAll(async () => {
  for (const mode of ['demo', 'live'] as const) {
    const dir = mkdtempSync(join(tmpdir(), `livinglayer-brush-${mode}-`));
    const app = await buildApp(
      parseConfig({
        DATA_DIR: dir,
        ...(mode === 'live' ? { MODEL_API_KEY: 'test-key', META_LIVE_ENABLED: 'true' } : {}),
      }),
      { serveWeb: false, ...(mode === 'live' ? { fetcher: mockedMeta } : {}) },
    );
    if (mode === 'live')
      await app.inject({
        method: 'POST',
        url: '/api/desk/restore',
        payload: { mode, memory: { mode, object: null, camera: DEMO_CALIBRATION } },
      });
    apps[mode] = { app, dir };
  }
});
afterAll(async () => {
  for (const a of Object.values(apps)) {
    await a?.app.close();
    if (a) rmSync(a.dir, { recursive: true, force: true });
  }
});

describe.each(['demo', 'live'] as const)('the panel and the request agree (%s)', (mode) => {
  it.each(cases)('$name', async ({ select }) => {
    const { app, dir } = apps[mode]!;
    const r = await runBrush({
      mode,
      select,
      prompt: PROMPT,
      app,
      appDataDir: dir,
      ...(mode === 'live' ? { frame: await demoPng() } : {}),
    });
    const asked = r.turns[0]!.run.output.target;
    expect(
      sameTarget(asked, r.resolve.target),
      `panel ${targetName(r.resolve.target)}, request ${targetName(asked)}`,
    ).toBe(true);
    expect(r.agrees).toBe(true);
  });
});

describe('boxing a thing whole', () => {
  it('names that thing, for nearly every thing the demo room shows', async () => {
    const room = demoRoom();
    const named = groups.filter(
      (g) => room.resolve(selectionMask(shapeOf({ around: g }, room), room.frame)).target?.id === g,
    );
    expect(named.length / groups.length).toBeGreaterThanOrEqual(BRUSH_TARGETS.wholeNamed);
  });
});

describe('the brush end to end, and putting the demo back', () => {
  it('builds, recolours and saves the Alex, then the demo reset puts the preset back', async () => {
    const { app, dir, close } = await demoApp();
    try {
      const r = await runBrush({
        mode: 'demo',
        select: { around: 'desk' },
        prompt: "It's an IKEA Alex desk: make it its own furniture",
        follow: ['make the drawers green'],
        save: true,
        app,
        appDataDir: dir,
      });
      expect(r.agrees).toBe(true);
      expect(r.turns.map((t) => t.steps.every((s) => s.state === 'done'))).toEqual([true, true]);
      expect(r.turns[1]!.run.output.recipe!.parts.find((p) => p.name === 'drawer-1')!.color).toBe(
        '#3f8f4a',
      );
      expect(r.turns[0]!.outline?.data.some(Boolean)).toBe(true);
      expect(r.saved).toBe('ikea-alex-desk');
      expect((await brushOverlay(r)).length).toBeGreaterThan(1000);
      const reset = await app.inject({ method: 'POST', url: '/api/desk/demo/reset' });
      expect(reset.statusCode, reset.body).toBe(200);
      const memory = (await app.inject('/api/desk/demo')).json<DeskMemory>();
      expect(memory.scene ?? null).toBeNull();
      expect(memory.camera ?? null).toBeNull();
    } finally {
      await close();
    }
  });
});
