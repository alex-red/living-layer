import { describe, expect, it, mock } from 'bun:test';
import {
  demoEdit,
  fixtureInput,
  mugItem,
  type DeskMemory,
  type IsoItem,
} from '@livinglayer/domain';
import { type Fetcher } from '../apps/server/src/config.js';
import { testApp } from './lib/app.js';
import { fixture } from './lib/fixture-scan.js';

const mug = (): IsoItem => ({ label: 'Mug', parts: mugItem().parts });
/** A new thing in that mode's desk memory: saved without an id, as one placed by hand is. */
async function addThing(post: Awaited<ReturnType<typeof testApp>>['post'], mode: 'demo' | 'live') {
  const { id: _id, ...input } = fixtureInput(
    fixture({ label: 'Desk lamp', control: { kind: 'none' } }),
  );
  const saved = await post('fixtures/save', { mode, fixture: input });
  expect(saved.statusCode, saved.body).toBe(200);
  return saved.json<DeskMemory>().fixtures!.at(-1)!;
}

describe('the demo’s AI edit', () => {
  it('paints the parts a colour names, else every part, and does nothing else', () => {
    const item = mug();
    const handle = demoEdit(item, 'make the handle red')!;
    expect(handle.note).toBe('Painted the handle red.');
    for (const p of handle.item.parts)
      expect(p.color).toBe(
        p.id === 'handle' ? '#c8423b' : item.parts.find((q) => q.id === p.id)!.color,
      );
    const all = demoEdit(item, 'Paint it BLUE')!;
    expect(new Set(all.item.parts.map((p) => p.color))).toEqual(new Set(['#3d6fc4']));
    expect(demoEdit(item, 'add a lid')).toBeNull();
    // A part the person locked keeps its colour.
    const locked = { ...item, parts: item.parts.map((p) => ({ ...p, locked: p.id === 'body' })) };
    const kept = demoEdit(locked, 'paint it green')!;
    expect(kept.item.parts.find((p) => p.id === 'body')!.color).toBe(
      item.parts.find((p) => p.id === 'body')!.color,
    );
  });
});

describe('POST /api/fixtures/edit', () => {
  it('answers the demo with the draft changed and saves nothing', async () => {
    const { post, memory } = await testApp({ name: 'edit-demo' });
    const thing = await addThing(post, 'demo');
    const before = await memory();
    const item = mug();
    const res = await post('fixtures/edit', {
      fixtureId: thing.id,
      prompt: 'make the handle red',
      item,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ item: IsoItem; note: string; run: { output: { edited: string } } }>();
    expect(body.note).toBe('Painted the handle red.');
    expect(body.item.parts.find((p) => p.id === 'handle')!.color).toBe('#c8423b');
    expect(body.run.output.edited).toBe(thing.id);
    expect((await memory()).fixtures).toEqual(before.fixtures);
    const refused = await post('fixtures/edit', { fixtureId: thing.id, prompt: 'add a lid', item });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('edit_demo');
    const gone = await post('fixtures/edit', {
      fixtureId: crypto.randomUUID(),
      prompt: 'make it red',
      item,
    });
    expect(gone.statusCode).toBe(404);
  });

  it('asks Spark live with the model’s parts and render, keeping the parts the person locked', async () => {
    const asked: { text: string; images: number }[] = [];
    const fetcher = mock<Fetcher>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const content = body.input[0].content as { type: string; text?: string }[];
      asked.push({
        text: content.find((c) => c.type === 'input_text')?.text ?? '',
        images: content.filter((c) => c.type === 'input_image').length,
      });
      const parts = mugItem().parts.map((p) => ({
        id: p.id,
        shape: p.shape,
        at: p.at,
        size: p.size,
        color: '#c8423b',
        material: 'gloss',
        profile: p.shape === 'lathe' ? p.profile : null,
        path: p.shape === 'tube' ? p.path : null,
        outline: null,
        radius: p.shape === 'tube' ? (p.radius ?? null) : null,
        rough: null,
        wall: p.shape === 'lathe' ? (p.wall ?? null) : null,
        inside: null,
        bands: null,
        prints: null,
      }));
      return new Response(
        JSON.stringify({
          id: 'resp_spark',
          object: 'response',
          model: 'muse-spark-1.3',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({ note: 'Made it red.', parts }),
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        }),
        { headers: { 'content-type': 'application/json', 'x-request-id': 'req-spark' } },
      );
    });
    const { post, memory } = await testApp({
      name: 'edit-live',
      env: { MODEL_API_KEY: 'test-key', META_LIVE_ENABLED: 'true' },
      fetcher,
    });
    const thing = await addThing(post, 'live');
    const item = mug();
    const locked = {
      ...item,
      parts: item.parts.map((p) => (p.id === 'body' ? { ...p, locked: true } : p)),
    };
    const res = await post('fixtures/edit', {
      mode: 'live',
      fixtureId: thing.id,
      prompt: 'make it red',
      item: locked,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ item: IsoItem; note: string }>();
    expect(body.note).toBe('Made it red.');
    expect(body.item.parts.find((p) => p.id === 'handle')!.color).toBe('#c8423b');
    expect(body.item.parts.find((p) => p.id === 'body')).toEqual(
      locked.parts.find((p) => p.id === 'body'),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]!.images).toBe(1);
    expect(asked[0]!.text).toContain('Change it as the person asks: "make it red"');
    expect(asked[0]!.text).toContain('"id":"handle"');
    // Nothing is saved: the thing keeps its own model.
    const after = (await memory('live')).fixtures!.find((f) => f.id === thing.id)!;
    expect(after.model.parts.map((p) => p.color)).toEqual(thing.model.parts.map((p) => p.color));
  });
});
