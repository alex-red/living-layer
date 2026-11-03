import { describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import { item, others } from './lib/mug.js';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { testApp } from './lib/app.js';
import { type Fetcher } from '../apps/server/src/config.js';
import { detectionBits, maskedCrop } from '../apps/server/src/images.js';
import { syntheticStream } from '../apps/server/src/sam.js';
import { pinElevation } from '../apps/server/src/item.js';
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
  upgradeItem,
  upgradeMemory,
  DEMO_CALIBRATION,
  ISO_PRESETS,
  elevationAt,
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
  it('loads the first part shapes as the modern ones, a lid as a cap and a knob', () => {
    const part = (id: string, shape: string, more: object = {}) => ({
      id,
      shape,
      at: { x: 0.1, y: 0.1, z: 0.2 },
      size: { w: 0.5, d: 0.4, h: 0.3 },
      color: '#808080',
      taper: 0.5,
      ...more,
    });
    const old = {
      label: 'Old',
      parts: [
        part('a', 'cylinder', { wall: 0.2 }),
        part('b', 'cone'),
        part('c', 'box'),
        part('d', 'lid', { paint: [{ kind: 'band', from: 0, to: 1, color: '#ff0000' }] }),
        part('e', 'handle', { at: { x: 0.7, y: 0.4, z: 0.2 }, size: { w: 0.2, d: 0.1, h: 0.5 } }),
      ],
    };
    const parsed = isoItemSchema.parse(old);
    expect(parsed.parts.map((p) => `${p.id}:${p.shape}`)).toEqual([
      'a:lathe',
      'b:lathe',
      'c:rbox',
      'd:lathe',
      'd-knob:lathe',
      'e:tube',
    ]);
    expect(parsed.parts[0]).toMatchObject({ wall: 0.2 });
    expect(parsed.parts[3]!.paint).toHaveLength(1);
    expect(parsed.parts[4]!.paint).toBeUndefined();
    // The handle's loop reaches 1.33 times its old box, outward from the item's centre.
    expect(parsed.parts[5]).toMatchObject({ radius: 0.05, at: { x: 0.7 } });
    expect(parsed.parts[5]!.size.w).toBeCloseTo(0.266);
    // A model with nothing old comes back as it was.
    const mug = mugItem();
    expect(upgradeItem(mug)).toBe(mug);
    expect(isoItemSchema.parse(mug)).toEqual(mug);
  });
  it('upgrades the models in saved desk memory, parts being named by id', () => {
    const old = { ...mugItem(), parts: [{ ...mugItem().parts[0]!, shape: 'cylinder' }] };
    const memory = {
      mode: 'demo',
      // Kept the way it was before the mug and other objects were things.
      object: { id: 'm', label: 'Mug', createdAt: '' },
      observation: { id: 'x' },
      item: old,
      others: [{ id: 'o', label: 'Book', concept: 'book', item: old, observation: { id: 'y' } }],
      fixtures: [{ id: 'f', model: old, states: { on: { model: old } }, drafts: [{ model: old }] }],
    } as unknown as DeskMemory;
    const next = upgradeMemory(memory);
    expect(item(next)!.parts[0]!.shape).toBe('lathe');
    expect(others(next)![0]!.item!.parts[0]!.shape).toBe('lathe');
    expect(next.fixtures![0]!.model.parts[0]!.shape).toBe('lathe');
    expect(next.fixtures![0]!.states!.on!.model.parts[0]!.shape).toBe('lathe');
    expect(next.fixtures![0]!.drafts![0]!.model.parts[0]!.shape).toBe('lathe');
    expect(upgradeMemory(next)).toBe(next);
  });
  it('gives repeated part ids a suffix', () => {
    const mug = mugItem();
    const twice = uniqueParts({ ...mug, parts: [...mug.parts, mug.parts[0]!] });
    expect(new Set(twice.parts.map((p) => p.id)).size).toBe(3);
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
    expect(item(drafted.memory)?.segmentRunId).toBe(segment.id);
    // The demo runs the real fitter on the demo mug's own pixels.
    expect(item(drafted.memory)?.parts.map((p) => p.id)).toEqual(['body', 'handle']);
    const fit = item(drafted.memory)!.fit!;
    expect(fit.archetype).toBe('mug');
    expect(fit.iou).toBeGreaterThan(0.85);
    expect(fit.views).toBe(1);
    expect(fit.assists[0]).toContain('Spark: mug');
    const body = item(drafted.memory)!.parts[0]!;
    expect(body.shape).toBe('lathe');
    if (body.shape !== 'lathe') return;
    // Cream body, as rendered. The coffee's colour is what its opening shows, read as its
    // inside: from above the rim a drink and a dark glaze look alike, so none is assumed.
    expect(deltaE(hexLab(body.color), hexLab(DEMO_MUG.color))).toBeLessThan(6);
    expect(deltaE(hexLab(body.inside!.wall), hexLab(DEMO_MUG.coffee))).toBeLessThan(6);
    expect(body.inside!.liquid).toBeNull();
    const crop = await s.app.inject({ method: 'GET', url: '/api/item/crop?mode=demo' });
    expect(crop.statusCode).toBe(200);
    expect(crop.headers['content-type']).toBe('image/png');
    expect(s.fetcher).not.toHaveBeenCalled();

    // A refit keeps a locked part as the person left it.
    const locked = {
      label: item(drafted.memory)!.label,
      parts: item(drafted.memory)!.parts.map((p) =>
        p.id === 'handle' ? { ...p, color: '#3c554a', locked: true } : p,
      ),
    };
    const refit = (await s.post('item/refit', { item: locked })).json<DeskMemory>();
    expect(item(refit)?.parts.find((p) => p.id === 'handle')?.color).toBe('#3c554a');
    expect(item(refit)?.fit?.iou).toBeGreaterThan(0.8);

    const edited = mugItem('#3c554a');
    const saved = (await s.post('item/save', { item: edited })).json<DeskMemory>();
    expect(item(saved)?.parts[0]!.color).toBe('#3c554a');
    expect(item(saved)?.source).toBe('demo');
    // An edit is scored again against the same crop: a green body matches its colour worse.
    expect(item(saved)?.fit?.deltaE).toBeGreaterThan(fit.deltaE);
    const extra = await s.post('item/save', { item: { ...edited, source: 'spark' } });
    expect(extra.statusCode).toBe(400);

    const again = (await s.post('segment', { concept: 'mug', demoPosition: 'right' })).json<
      EvidenceRun<Segmentation>
    >();
    const tracked = (await s.post('desk/track', { segmentRunId: again.id })).json<{
      memory: DeskMemory;
    }>();
    expect(item(tracked.memory)?.parts[0]!.color).toBe('#3c554a');
    // Drafting from the new sighting fuses its shape with the first one.
    const fused = (await s.post('item/draft', { source: 'sampled' })).json<{
      memory: DeskMemory;
    }>();
    expect(item(fused.memory)?.fit?.views).toBe(2);
    expect(item(fused.memory)?.fit?.assists).toContain('Fused with 1 earlier view');
    const reset = (await s.post('desk/reset')).json<DeskMemory>();
    expect(item(reset) ?? null).toBeNull();
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
      'sam:inside of the mug',
      'spark:item_check',
    ]);
    expect(run.output.source).toBe('spark');
    expect(run.usage?.totalTokens).toBe(240);
    expect(run.assets.some((a) => a.endsWith('/item-render.png'))).toBe(true);
    const fit = item(memory)!.fit!;
    expect(fit.archetype).toBe('mug');
    expect(fit.iou).toBeGreaterThan(0.85);
    expect(fit.assists).toEqual([
      'Spark: mug, gloss. A cream mug.',
      'SAM: mug handle not found',
      'SAM: inside of the mug not found',
      expect.stringMatching(/^Spark check \((kept|not kept)\): Slightly taller\.$/),
    ]);
    expect(item(memory)!.parts[0]!.material).toBe('gloss');
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

describe('the camera’s angle a model is drawn at', () => {
  it('is the calibrated camera’s at the pinned desk, not a guess from a desk seen corner on', () => {
    const scene = { ...ISO_PRESETS.office, kind: 'custom' as const, label: 'My office' };
    const desk = scene.surfaces.find((s) => s.id === 'desk:top')!;
    // A desk seen corner on: as deep across the frame as it is wide, which the guess reads as 90°.
    const corners = [
      { x: 480, y: 280 },
      { x: 660, y: 320 },
      { x: 270, y: 550 },
      { x: 100, y: 470 },
    ];
    const memory = {
      mode: 'live',
      lastDecision: null,
      scene,
      surface: { scene: 'custom', surfaceId: desk.id, corners },
    } as unknown as DeskMemory;
    expect(pinElevation(memory, 'live')).toBe(90);
    const centre = {
      x: desk.rect.x + desk.rect.w / 2,
      y: desk.rect.y + desk.rect.d / 2,
      z: desk.z,
    };
    const calibrated = { ...memory, camera: DEMO_CALIBRATION };
    expect(pinElevation(calibrated, 'live')).toBeCloseTo(
      elevationAt(DEMO_CALIBRATION.camera, centre),
      6,
    );
    expect(pinElevation(calibrated, 'live')).toBeLessThan(60);
  });
});
