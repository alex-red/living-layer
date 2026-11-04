import { describe, expect, it, mock } from 'bun:test';
import {
  demoEdit,
  detailResolution,
  editNote,
  editorVoxels,
  editPrompt,
  catItem,
  roomSpriteLook,
  MAX_ITEM_PARTS,
  sculptPartsFor,
  floorLampItem,
  focusItem,
  FOCUS_COLOR,
  starterTemplateModel,
  type SculptPart,
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

const lamp = (): IsoItem => floorLampItem();
/** The lamp's base with its profile's top a sliver narrower: far less than a voxel. */
const sliver = <P extends { id: string; profile?: { r: number; z: number }[] | null }>(
  parts: P[],
) =>
  parts.map((p) =>
    p.id === 'base' && p.profile
      ? {
          ...p,
          profile: p.profile.map((q, i, all) =>
            i === all.length - 1 ? { ...q, r: q.r - 0.001 } : q,
          ),
        }
      : p,
  );

/** Spark answering an edit with the parts `change` makes of the ones it was sent, and what it was asked. */
function sparkAnswers(note: string, change: (parts: SculptPart[]) => SculptPart[]) {
  const asked: { text: string; images: number }[] = [];
  const fetcher = mock<Fetcher>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const content = body.input[0].content as { type: string; text?: string }[];
    const text = content.find((c) => c.type === 'input_text')?.text ?? '';
    asked.push({ text, images: content.filter((c) => c.type === 'input_image').length });
    // The model's parts are the prompt's last line, as Spark's own shape.
    const parts = change(JSON.parse(text.slice(text.lastIndexOf('\n') + 1)) as SculptPart[]);
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
              { type: 'output_text', text: JSON.stringify({ note, parts }), annotations: [] },
            ],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      }),
      { headers: { 'content-type': 'application/json', 'x-request-id': 'req-spark' } },
    );
  });
  return { fetcher, asked };
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

describe('an edit pointed at parts with the brush', () => {
  it('paints the brushed parts in the demo when the request names none', () => {
    const item = mug();
    const answer = demoEdit(item, 'make it red', ['handle'])!;
    expect(answer.note).toBe('Painted the handle red.');
    for (const p of answer.item.parts)
      expect(p.color).toBe(
        p.id === 'handle' ? '#c8423b' : item.parts.find((q) => q.id === p.id)!.color,
      );
  });

  it('paints a part the request names over the brushed ones', () => {
    const answer = demoEdit(mug(), 'make the body blue', ['handle'])!;
    expect(answer.note).toBe('Painted the body blue.');
  });

  it('marks the brushed parts for Spark in one flat colour, every other part in another', () => {
    // A starter mug whose body carries a print, the handle brushed.
    const mug = starterTemplateModel('tim-hortons-mug');
    const marked = focusItem(mug, ['handle']);
    expect(marked.parts.find((p) => p.id === 'handle')!.color).toBe(FOCUS_COLOR);
    const body = marked.parts.find((p) => p.id === 'body')!;
    expect(body.color).not.toBe(FOCUS_COLOR);
    expect(body.paint).toBeUndefined();
  });

  it('tells Spark which parts were brushed, and says nothing of it when none were', () => {
    const voxels = editorVoxels(lamp().parts);
    const size = { w: 1, d: 1, h: 4.85 };
    expect(editPrompt('Floor lamp', size, 'round this', false, voxels, ['base'])).toContain(
      'The person brushed over the "base" part to show what they mean',
    );
    expect(editPrompt('Floor lamp', size, 'round this', false, voxels)).not.toContain('brushed');
  });
});

describe('how a thing is drawn in the room', () => {
  // A cat asleep on its tree: more parts than Spark sculpts as a rule.
  const detailed = [...starterTemplateModel('cat-tree').parts, ...catItem('Cat', 'sleeping').parts];
  it('draws a detailed model twice as fine at fit, the same size in smaller pixels', () => {
    expect(detailed.length).toBeGreaterThan(12);
    expect(roomSpriteLook(lamp().parts, 160, 1)).toEqual({ resolution: 32 });
    expect(roomSpriteLook(detailed, 160, 1)).toEqual({ resolution: 64, pixel: 0.5 });
  });

  it('draws finer still as the view zooms in, a detailed model as far again', () => {
    expect(roomSpriteLook(lamp().parts, 64, 4)).toEqual({ resolution: 64, pixel: 0.25 });
    expect(roomSpriteLook(detailed, 64, 4)).toEqual({ resolution: 128, pixel: 0.125 });
  });
});

describe('how many parts Spark may answer with', () => {
  it('is twelve for a small model, and every part of a bigger one up to the cap', () => {
    const lampParts = lamp().parts;
    expect(sculptPartsFor(mug())).toBe(12);
    expect(sculptPartsFor(null)).toBe(12);
    const big = { parts: Array.from({ length: 16 }, (_, i) => lampParts[i % lampParts.length]!) };
    expect(sculptPartsFor(big)).toBe(16);
    const huge = { parts: Array.from({ length: 40 }, () => lampParts[0]!) };
    expect(sculptPartsFor(huge)).toBe(MAX_ITEM_PARTS);
  });

  it('tells Spark the number in the edit prompt', () => {
    const voxels = editorVoxels(lamp().parts);
    const size = { w: 1, d: 1, h: 4.85 };
    expect(editPrompt('Floor lamp', size, 'x', false, voxels)).toContain('at most 12 parts');
    expect(editPrompt('Floor lamp', size, 'x', false, voxels, [], 16)).toContain(
      'at most 16 parts',
    );
  });
});

describe('how an edit shows', () => {
  it('draws a tall, thin model with more voxels, and a squat one as its preset says', () => {
    expect(detailResolution(lamp().parts, 64)).toBe(192);
    expect(detailResolution(mug().parts, 64)).toBe(64);
  });

  it('says so when an edit changes parts but nothing the editor draws', () => {
    const before = lamp();
    const note = editNote(before, { ...before, parts: sliver(before.parts) }, 'Rounded the base');
    expect(note).toBe(
      'Rounded the base. Nothing changed that shows at this size: ask for a bigger change, or one to a larger part.',
    );
  });

  it('keeps the note of an edit that shows, or of parts given back unchanged', () => {
    const before = lamp();
    const red = before.parts.map((p) => (p.id === 'base' ? { ...p, color: '#c8423b' } : p));
    expect(editNote(before, { ...before, parts: red }, 'Painted the base red.')).toBe(
      'Painted the base red.',
    );
    expect(editNote(before, lamp(), 'It can’t have a drawer.')).toBe('It can’t have a drawer.');
  });

  it('tells Spark how many voxels draw the model', () => {
    const asked = editPrompt(
      'Floor lamp',
      { w: 1, d: 1, h: 4.85 },
      'round the base',
      false,
      editorVoxels(lamp().parts),
    );
    expect(asked).toContain('drawn in voxels, about 40 across its footprint and 192 tall');
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

  it('answers the demo with only the brushed parts changed, dropping ones the model lacks', async () => {
    const { post } = await testApp({ name: 'edit-focus' });
    const thing = await addThing(post, 'demo');
    const item = mug();
    const res = await post('fixtures/edit', {
      fixtureId: thing.id,
      prompt: 'make it red',
      item,
      focus: ['handle', 'lid'],
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ item: IsoItem; run: { output: { focus: string[] } } }>();
    expect(body.item.parts.filter((p) => p.color === '#c8423b').map((p) => p.id)).toEqual([
      'handle',
    ]);
    expect(body.run.output.focus).toEqual(['handle']);
  });

  it('asks Spark live with the model’s parts and render, keeping the parts the person locked', async () => {
    const { fetcher, asked } = sparkAnswers('Made it red.', (parts) =>
      parts.map((p) => ({ ...p, color: '#c8423b' })),
    );
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

  it('says live when Spark’s change doesn’t show at the size it is drawn', async () => {
    const { fetcher, asked } = sparkAnswers('Rounded the base.', sliver);
    const { post } = await testApp({
      name: 'edit-unseen',
      env: { MODEL_API_KEY: 'test-key', META_LIVE_ENABLED: 'true' },
      fetcher,
    });
    const thing = await addThing(post, 'live');
    const res = await post('fixtures/edit', {
      mode: 'live',
      fixtureId: thing.id,
      prompt: 'make the base rounder',
      item: lamp(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ note: string }>().note).toContain('Nothing changed that shows at this size');
    expect(asked[0]!.text).toContain('drawn in voxels');
  });

  it('shows Spark live the brushed parts marked in a second picture', async () => {
    const { fetcher, asked } = sparkAnswers('Rounded the base.', (parts) => parts);
    const { post } = await testApp({
      name: 'edit-marked',
      env: { MODEL_API_KEY: 'test-key', META_LIVE_ENABLED: 'true' },
      fetcher,
    });
    const thing = await addThing(post, 'live');
    const res = await post('fixtures/edit', {
      mode: 'live',
      fixtureId: thing.id,
      prompt: 'make this rounder',
      item: lamp(),
      focus: ['base'],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(asked[0]!.images).toBe(2);
    expect(asked[0]!.text).toContain('The last image is the same view with that part in magenta');
  });
});
