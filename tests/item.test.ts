import { describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { testApp } from './lib/app.js';
import { type Fetcher } from '../apps/server/src/config.js';
import { detectionBits, maskedCrop } from '../apps/server/src/images.js';
import { syntheticStream } from '../apps/server/src/sam.js';
import {
  DEMO_MUG,
  deltaE,
  hexLab,
  isoItemSchema,
  mugItem,
  rotateItem,
  clusterColours,
  rgbLab,
  uniqueParts,
  type DeskMemory,
  type EvidenceRun,
  type SavedItem,
  type Segmentation,
} from '@livinglayer/domain';

// These tests run the fitter and the sprite renderer: about a second at most
// on a quiet machine, but a busy one (a parallel build, say) stretches them
// several times over, past bun's 5 s default.
setDefaultTimeout(30_000);

describe('item models', () => {
  it('accepts the mug template and rejects parts outside the contract', () => {
    const mug = mugItem();
    expect(isoItemSchema.safeParse(mug).success).toBe(true);
    const bad = (change: object) =>
      isoItemSchema.safeParse({ ...mug, parts: [{ ...mug.parts[0]!, ...change }] }).success;
    expect(bad({ shape: 'sphere' })).toBe(false);
    expect(bad({ color: 'red' })).toBe(false);
    expect(bad({ size: { w: 0, d: 1, h: 1 } })).toBe(false);
    expect(bad({ at: { x: 4, y: 0, z: 0 } })).toBe(false);
    expect(isoItemSchema.safeParse({ ...mug, parts: [] }).success).toBe(false);
  });
  it('turns four quarters back to where it started, keeping the handle on the far side', () => {
    const mug = mugItem();
    const handle = (i: typeof mug) => i.parts.find((p) => p.id === 'handle')!;
    const once = rotateItem(mug);
    // A quarter turn moves the handle from the right (+x) to the front (+y).
    expect(handle(once).at.y + handle(once).size.d / 2).toBeGreaterThan(0.5);
    expect(handle(once).size.w).toBeCloseTo(handle(mug).size.d);
    const back = rotateItem(mug, 4);
    back.parts.forEach((p, i) => {
      expect(p.at.x).toBeCloseTo(mug.parts[i]!.at.x);
      expect(p.at.y).toBeCloseTo(mug.parts[i]!.at.y);
    });
    expect(rotateItem(mug, -1)).toEqual(rotateItem(mug, 3));
  });
  it('gives repeated part ids a suffix', () => {
    const mug = mugItem();
    const twice = uniqueParts({ ...mug, parts: [...mug.parts, mug.parts[0]!] });
    expect(new Set(twice.parts.map((p) => p.id)).size).toBe(4);
  });
  it('finds the main colours in OKLab, largest first, and stops adding clusters when they stop helping', () => {
    const red = rgbLab([245, 15, 10]);
    const blue = rgbLab([10, 10, 250]);
    const { clusters } = clusterColours([red, red, red, blue, red, red, blue, red]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.hex).toBe('#f50f0a');
    expect(clusters[0]!.share).toBeCloseTo(0.75);
  });
});

describe('masked crop', () => {
  it('keeps the masked pixels of the box and drops the rest', async () => {
    // A red square on blue; the mask covers only the left half of the box.
    const source = await sharp({
      create: { width: 100, height: 80, channels: 3, background: '#0000ff' },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 40, height: 40, channels: 3, background: '#ff0000' },
          })
            .png()
            .toBuffer(),
          left: 20,
          top: 20,
        },
      ])
      .png()
      .toBuffer();
    const crop = await maskedCrop(source, {
      objectId: '1',
      confidence: 0.9,
      box: { x: 20, y: 20, width: 40, height: 40 },
      mask: { width: 10, height: 10, foregroundPixels: 50, svgPath: 'M0 0L5 0L5 10L0 10Z' },
    });
    expect([crop.width, crop.height]).toEqual([40, 40]);
    const opaqueRed = [...Array(40 * 40).keys()].filter(
      (p) =>
        crop.rgba[p * 4 + 3]! >= 128 && crop.rgba[p * 4]! === 255 && crop.rgba[p * 4 + 2]! === 0,
    ).length;
    expect(opaqueRed / (40 * 40)).toBeGreaterThan(0.45);
    const opaque = [...crop.rgba].filter((_, i) => i % 4 === 3 && crop.rgba[i]! >= 128).length;
    expect(opaque / (40 * 40)).toBeCloseTo(0.5, 1);
  });
});

const setup = () => testApp({ name: 'item' });

describe('item routes', () => {
  it('needs a confirmed object before drafting or saving', async () => {
    const s = await setup();
    expect((await s.post('item/draft', { source: 'sampled' })).statusCode).toBe(409);
    expect((await s.post('item/save', { item: mugItem() })).statusCode).toBe(409);
  });
  it('drafts the demo mug offline, saves edits, keeps it across sightings and clears it on reset', async () => {
    const s = await setup();
    const segment = (await s.post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
    await s.post('desk/select', { segmentRunId: segment.id, detectionId: '7' });
    const drafted = (await s.post('item/draft', { source: 'spark' })).json<{
      run: EvidenceRun<SavedItem>;
      memory: DeskMemory;
    }>();
    expect(drafted.run.kind).toBe('item');
    expect(drafted.run.output.source).toBe('demo');
    expect(drafted.memory.item?.segmentRunId).toBe(segment.id);
    // The demo runs the real fitter on the demo mug's own pixels.
    expect(drafted.memory.item?.parts.map((p) => p.id)).toEqual(['body', 'handle']);
    const fit = drafted.memory.item!.fit!;
    expect(fit.archetype).toBe('mug');
    expect(fit.iou).toBeGreaterThan(0.85);
    expect(fit.views).toBe(1);
    expect(fit.assists[0]).toContain('Spark: mug');
    const body = drafted.memory.item!.parts[0]!;
    expect(body.shape).toBe('lathe');
    if (body.shape !== 'lathe') return;
    // Cream body with coffee in it, as rendered.
    expect(deltaE(hexLab(body.color), hexLab(DEMO_MUG.color))).toBeLessThan(6);
    expect(deltaE(hexLab(body.inside!.liquid!), hexLab(DEMO_MUG.coffee))).toBeLessThan(6);
    const crop = await s.app.inject({ method: 'GET', url: '/api/item/crop?mode=demo' });
    expect(crop.statusCode).toBe(200);
    expect(crop.headers['content-type']).toBe('image/png');
    expect(s.fetcher).not.toHaveBeenCalled();

    // A refit keeps a locked part as the person left it.
    const locked = {
      label: drafted.memory.item!.label,
      parts: drafted.memory.item!.parts.map((p) =>
        p.id === 'handle' ? { ...p, color: '#3c554a', locked: true } : p,
      ),
    };
    const refit = (await s.post('item/refit', { item: locked })).json<DeskMemory>();
    expect(refit.item?.parts.find((p) => p.id === 'handle')?.color).toBe('#3c554a');
    expect(refit.item?.fit?.iou).toBeGreaterThan(0.8);

    const edited = mugItem('#3c554a');
    const saved = (await s.post('item/save', { item: edited })).json<DeskMemory>();
    expect(saved.item?.parts[0]!.color).toBe('#3c554a');
    expect(saved.item?.source).toBe('demo');
    // An edit is scored again against the same crop: a green body matches its colour worse.
    expect(saved.item?.fit?.deltaE).toBeGreaterThan(fit.deltaE);
    const extra = await s.post('item/save', { item: { ...edited, source: 'spark' } });
    expect(extra.statusCode).toBe(400);

    const again = (await s.post('segment', { concept: 'mug', demoPosition: 'right' })).json<
      EvidenceRun<Segmentation>
    >();
    const tracked = (await s.post('desk/track', { segmentRunId: again.id })).json<{
      memory: DeskMemory;
    }>();
    expect(tracked.memory.item?.parts[0]!.color).toBe('#3c554a');
    // Drafting from the new sighting fuses its shape with the first one.
    const fused = (await s.post('item/draft', { source: 'sampled' })).json<{
      memory: DeskMemory;
    }>();
    expect(fused.memory.item?.fit?.views).toBe(2);
    expect(fused.memory.item?.fit?.assists).toContain('Fused with 1 earlier view');
    const reset = (await s.post('desk/reset')).json<DeskMemory>();
    expect(reset.item ?? null).toBeNull();
  });
});

describe('live item drafts with Meta’s help', () => {
  const demo = JSON.parse(readFileSync('testdata/sam-mug.json', 'utf8')) as { wire: string };
  /** SAM's event stream for a wire, as the hosted API sends it. */
  async function samResponse(wire: string) {
    const events = [];
    for await (const event of syntheticStream(wire))
      events.push(
        event.type === 'response.completed'
          ? { ...event, response: { id: 'resp_sam', model: 'sam-3.1', status: 'completed' } }
          : event,
      );
    const body =
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') +
      'data: [DONE]\n\n';
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }
  const sparkResponse = (output: object) =>
    new Response(
      JSON.stringify({
        id: 'resp_spark',
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
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      }),
      { headers: { 'content-type': 'application/json', 'x-request-id': 'req-spark' } },
    );

  it('classifies with Spark, asks SAM for parts and keeps Spark’s check only if it holds up', async () => {
    const asked: string[] = [];
    const fetcher = mock<Fetcher>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === 'sam-3.1') {
        const concept = body.input[0].content[0].text as string;
        asked.push(`sam:${concept}`);
        // The whole desk photo shows the mug; inside the crop, no parts are found.
        return samResponse(concept === 'mug' ? demo.wire : '');
      }
      const name = body.text.format.name as string;
      asked.push(`spark:${name}`);
      return sparkResponse(
        name === 'item_class'
          ? { archetype: 'mug', material: 'gloss', description: 'A cream mug.', backside: null }
          : { height: 1.05, radius: 1, handleReach: 1, body: null, note: 'Slightly taller.' },
      );
    });
    const { app } = await testApp({
      name: 'item-live',
      env: { MODEL_API_KEY: 'test-key', META_LIVE_ENABLED: 'true' },
      fetcher,
    });
    const post = (path: string, body: object) =>
      app.inject({ method: 'POST', url: `/api/${path}`, payload: { mode: 'live', ...body } });
    // A live photo: the illustrated desk, rasterized as a camera would deliver it.
    const photo = await sharp(readFileSync('testdata/desk.svg')).png().toBuffer();
    const segment = (
      await post('segment', {
        concept: 'mug',
        imageDataUrl: `data:image/png;base64,${photo.toString('base64')}`,
      })
    ).json<EvidenceRun<Segmentation>>();
    expect(segment.output.detections[0]?.objectId).toBe('7');
    await post('desk/select', { segmentRunId: segment.id, detectionId: '7' });
    const drafted = await post('item/draft', { source: 'spark' });
    expect(drafted.statusCode).toBe(200);
    const { run, memory } = drafted.json<{ run: EvidenceRun<SavedItem>; memory: DeskMemory }>();
    expect(asked).toEqual([
      'sam:mug',
      'spark:item_class',
      'sam:mug handle',
      'sam:coffee',
      'spark:item_check',
    ]);
    expect(run.output.source).toBe('spark');
    expect(run.usage?.totalTokens).toBe(240);
    expect(run.assets.some((a) => a.endsWith('/item-render.png'))).toBe(true);
    const fit = memory.item!.fit!;
    expect(fit.archetype).toBe('mug');
    expect(fit.iou).toBeGreaterThan(0.85);
    expect(fit.assists).toEqual([
      'Spark: mug, gloss. A cream mug.',
      'SAM: mug handle not found',
      'SAM: coffee not found',
      expect.stringMatching(/^Spark check \((kept|not kept)\): Slightly taller\.$/),
    ]);
    expect(memory.item!.parts[0]!.material).toBe('gloss');
    await app.close();
  });
  it('turns SAM part detections into a mask of the crop', async () => {
    const bits = await detectionBits(
      [
        {
          objectId: '1',
          confidence: 0.9,
          box: { x: 10, y: 5, width: 20, height: 10 },
          mask: { width: 2, height: 1, foregroundPixels: 1, svgPath: 'M0 0L1 0L1 1L0 1Z' },
        },
      ],
      40,
      20,
    );
    // The left half of the box: x 10 to 20, y 5 to 15.
    expect(bits![7 * 40 + 15]).toBe(1);
    expect(bits![7 * 40 + 25]).toBe(0);
    expect(bits![2 * 40 + 15]).toBe(0);
    expect(await detectionBits([], 40, 20)).toBeNull();
  });
});
