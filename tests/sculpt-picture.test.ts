import { describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import {
  isFragmented,
  mugOf,
  type DeskMemory,
  type EvidenceRun,
  type FixtureClass,
  type Job,
  type Segmentation,
} from '@livinglayer/domain';
import { type Fetcher } from '../apps/server/src/config.js';
import { demoPng, demoSegmentation } from '../apps/server/src/demo.js';
import { maskedCrop } from '../apps/server/src/images.js';
import { decodeSegmentation, syntheticStream } from '../apps/server/src/sam.js';
import { setup } from './lib/fixture-scan.js';

/** A crop's mask, 1 where it keeps the pixel. */
function bitsOf(rgba: Uint8Array | Buffer) {
  const bits = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < bits.length; i++) bits[i] = rgba[i * 4 + 3]! > 127 ? 1 : 0;
  return bits;
}

describe('a mask that has fallen apart', () => {
  it('is the demo mug’s outline whole, and four like pieces or a sliver of its box broken', async () => {
    const mug = (await demoSegmentation('mug')).output.detections[0]!;
    const crop = await maskedCrop(await demoPng(), mug);
    expect(isFragmented(bitsOf(crop.rgba), crop.width, crop.height)).toBe(false);
    // Four pieces of a 40 × 40 box, none most of it: a room camera's mug once.
    const pieces = new Uint8Array(40 * 40);
    for (const [x0, y0] of [
      [2, 2],
      [24, 4],
      [4, 24],
      [26, 26],
    ])
      for (let y = y0!; y < y0! + 10; y++)
        for (let x = x0!; x < x0! + 10; x++) pieces[y * 40 + x] = 1;
    expect(isFragmented(pieces, 40, 40)).toBe(true);
    // A body and its handle apart is still one thing: the body is most of it.
    const handled = new Uint8Array(40 * 40);
    for (let y = 5; y < 35; y++) for (let x = 5; x < 28; x++) handled[y * 40 + x] = 1;
    for (let y = 12; y < 26; y++) for (let x = 31; x < 36; x++) handled[y * 40 + x] = 1;
    expect(isFragmented(handled, 40, 40)).toBe(false);
    // One piece, but a sliver of its box: the rest of the thing was lost.
    const sliver = new Uint8Array(40 * 40);
    for (let y = 18; y < 22; y++) for (let x = 5; x < 35; x++) sliver[y * 40 + x] = 1;
    expect(isFragmented(sliver, 40, 40)).toBe(true);
    expect(isFragmented(sliver, 40, 40, 0.05)).toBe(false);
  });
});

describe('modelling a sighted thing with AI, with a mocked Meta API', () => {
  const sam = JSON.parse(readFileSync('testdata/sam-mug.json', 'utf8')) as { wire: string };
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
  const mugWire = `<0f>1${sam.wire.replace(/^<0f>7/, '')}`;
  /**
   * The mocked mug's answer for the picture SAM was sent: as recorded for a 960 × 640 frame,
   * else its box over most of the picture, as a crop round the mug shows it.
   */
  async function mugWireFor(dataUrl: string) {
    const { width = 0, height = 0 } = await sharp(
      Buffer.from(dataUrl.split(',')[1]!, 'base64'),
    ).metadata();
    if (width === 960 && height === 640) return mugWire;
    const at = (share: number, size: number) => Math.round(share * size);
    return mugWire.replace(
      /x1=\d+;y1=\d+;x2=\d+;y2=\d+;w=960;h=640/,
      `x1=${at(0.15, width)};y1=${at(0.05, height)};x2=${at(0.85, width)};y2=${at(0.95, height)};w=${width};h=${height}`,
    );
  }
  const mugClass: FixtureClass = {
    label: 'Mug',
    archetype: 'box',
    material: 'gloss',
    control: 'none',
    description: 'A white mug.',
    box: { x1: 300, y1: 200, x2: 700, y2: 800 },
    sizeCm: { w: 12, d: 9, h: 10 },
  };
  const sculpture = {
    note: 'A white mug.',
    parts: [
      {
        id: 'body',
        shape: 'lathe',
        at: { x: 0.1, y: 0.1, z: 0 },
        size: { w: 0.8, d: 0.8, h: 1 },
        color: '#f2ede1',
        material: 'gloss',
        profile: [
          { r: 1, z: 0 },
          { r: 1, z: 1 },
        ],
        path: null,
        outline: null,
        radius: null,
        rough: null,
        wall: null,
        inside: null,
        bands: null,
      },
    ],
  };

  it('models from a close photo when there is one, and cuts a broken outline out again', async () => {
    const calls: string[] = [];
    /** The first picture of each sculpt call: what Spark modelled from. */
    const shown: { width: number; height: number }[] = [];
    const fetcher = mock<Fetcher>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === 'sam-3.1') {
        calls.push('sam');
        return samResponse(await mugWireFor(body.input[0].content[1].image_url));
      }
      const name = body.text.format.name as string;
      calls.push(name);
      if (name === 'sculpt') {
        const url = body.input[0].content[1].image_url as string;
        const { width = 0, height = 0 } = await sharp(
          Buffer.from(url.split(',')[1]!, 'base64'),
        ).metadata();
        shown.push({ width, height });
        return sparkResponse(sculpture);
      }
      return sparkResponse(
        name === 'fixture_class'
          ? mugClass
          : { height: 1, radius: 1, handleReach: 1, body: null, note: 'Close.' },
      );
    });
    const s = await setup({ MODEL_API_KEY: 'test-key', META_LIVE_ENABLED: 'true' }, fetcher);

    // A frame where what the person boxed stands out only as four pieces: its outline falls apart.
    const pieces = [
      [410, 260],
      [500, 270],
      [420, 350],
      [505, 345],
    ].map(([left, top]) => ({
      input: { create: { width: 40, height: 40, channels: 3 as const, background: '#1c1c22' } },
      left: left!,
      top: top!,
    }));
    const frame = await sharp({
      create: { width: 960, height: 640, channels: 3, background: '#9a9a96' },
    })
      .composite(pieces)
      .png()
      .toBuffer();
    const found = (
      await s.post('segment', {
        mode: 'live',
        concept: 'mug',
        imageDataUrl: `data:image/png;base64,${frame.toString('base64')}`,
        shape: { kind: 'rect', box: { x1: 417, y1: 391, x2: 583, y2: 641 } },
      })
    ).json<EvidenceRun<Segmentation>>();
    expect(found.status, JSON.stringify(found)).toBe('completed');
    const detection = found.output.detections[0]!;
    const outlined = await maskedCrop(frame, detection);
    expect(isFragmented(bitsOf(outlined.rgba), outlined.width, outlined.height)).toBe(true);
    const chosen = await s.post('desk/select', {
      mode: 'live',
      segmentRunId: found.id,
      detectionId: detection.objectId,
    });
    expect(chosen.statusCode, chosen.body).toBe(200);
    const mug = mugOf(chosen.json<DeskMemory>())!;
    const sculpt = async (body: object = {}) => {
      calls.length = 0;
      shown.length = 0;
      const jobId = crypto.randomUUID();
      const res = await s.post('fixtures/sculpt', {
        mode: 'live',
        fixtureId: mug.id,
        jobId,
        ...body,
      });
      expect(res.statusCode, res.body).toBe(200);
      const steps = (await s.app.inject(`/api/jobs/${jobId}`)).json<Job>().steps;
      return { res, said: steps[0]!.detail };
    };

    // Its broken outline isn't what Spark sees: SAM cuts it out of the box again, one call.
    const recut = await sculpt();
    expect(recut.said).toBe('Its last sighting, cut out by SAM: its outline had fallen apart');
    expect(calls).toEqual(['sam', 'sculpt', 'sculpt', 'sculpt']);
    const run = recut.res.json<{ run: EvidenceRun }>().run;
    const picture = readFileSync(`${s.dataDir}/evidence/${run.id}/picture.png`);
    const cutBits = await sharp(picture).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(isFragmented(bitsOf(cutBits.data), cutBits.info.width, cutBits.info.height, 0.05)).toBe(
      false,
    );

    // A close photo sent with the request is what Spark models from, cut out by SAM, at its size.
    const close = await demoPng();
    const sent = await sculpt({
      imageDataUrl: `data:image/png;base64,${close.toString('base64')}`,
    });
    expect(sent.said).toBe('The close photo you sent, cut out by SAM');
    expect(calls).toEqual(['sam', 'sculpt', 'sculpt', 'sculpt']);
    const samMug = (await decodeSegmentation(syntheticStream(mugWire), 'mug', 960, 640)).output
      .detections[0]!;
    const sentCrop = await maskedCrop(close, samMug);
    expect(shown).toEqual(Array(3).fill({ width: sentCrop.width, height: sentCrop.height }));
    expect(Math.max(sentCrop.width, sentCrop.height)).toBeGreaterThan(128);

    // A close photo fitted to it (POST /api/fixtures/photo) is kept, and modelled from with no
    // SAM call: the sighting isn't cut out at all.
    const fitted = await s.post('fixtures/photo', {
      mode: 'live',
      fixtureId: mug.id,
      imageDataUrl: `data:image/png;base64,${close.toString('base64')}`,
    });
    expect(fitted.statusCode, fitted.body).toBe(200);
    const stored = await sculpt();
    expect(stored.said).toBe('The close photo its model was fitted to');
    expect(calls).toEqual(['sculpt', 'sculpt', 'sculpt']);
    expect(Math.max(...shown.map((x) => x.width))).toBeGreaterThan(128);

    // A photo SAM finds nothing in is refused before Spark is asked.
    fetcher.mockImplementationOnce(async () => samResponse(''));
    calls.length = 0;
    const empty = await s.post('fixtures/sculpt', {
      mode: 'live',
      fixtureId: mug.id,
      imageDataUrl: `data:image/png;base64,${close.toString('base64')}`,
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json<{ error: { code: string } }>().error.code).toBe('sculpt_photo');
    await s.app.close();
  }, 20_000);
});
