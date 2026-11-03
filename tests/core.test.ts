import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { demoSegmentation } from '../apps/server/src/demo.js';
import { decodeSegmentation, syntheticStream } from '../apps/server/src/sam.js';
import { findSource, mediaTypeOf, samDataUrl, validateImage } from '../apps/server/src/images.js';
import { buildApp } from '../apps/server/src/app.js';
import { ControlAdapter } from '../apps/server/src/control.js';
import { MetaAdapter } from '../apps/server/src/meta.js';
import { estimateCost, runCost, sceneSchema, type EvidenceRun } from '@livinglayer/domain';

const dirs: string[] = [];
function dir() {
  const d = mkdtempSync(join(tmpdir(), 'livinglayer-test-'));
  dirs.push(d);
  return d;
}
function config(extra: NodeJS.ProcessEnv = {}) {
  return parseConfig({ DATA_DIR: dir(), ...extra });
}
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const demo = JSON.parse(readFileSync('testdata/sam-mug.json', 'utf8')) as { wire: string };

describe('SAM contract and actual public parser', () => {
  it('decodes a split-token mug mask with sparse object ID and source-pixel bounds', async () => {
    const result = await decodeSegmentation(syntheticStream(demo.wire), 'mug', 960, 640);
    expect(result.output.frame).toEqual({ width: 960, height: 640 });
    const d = result.output.detections[0]!;
    expect(d.objectId).toBe('7');
    expect(d.box).toEqual({ x: 350, y: 180, width: 260, height: 280 });
    expect(d.mask.foregroundPixels).toBeGreaterThan(1000);
    expect(d.mask.svgPath).toMatch(/^M/);
    expect(d.mask.width).toBe(64);
    expect(d.mask.height).toBe(64);
  });
  it('returns no detections for a completed absent-target result', async () => {
    expect(
      (await decodeSegmentation(syntheticStream(''), 'unicorn', 960, 640)).output.detections,
    ).toEqual([]);
    expect((await demoSegmentation('unicorn')).output.detections).toEqual([]);
  });
  it('outlines what the demo camera sees, from the rendered room', async () => {
    const mug = (await demoSegmentation('mug')).output.detections;
    expect(mug.map((d) => d.objectId)).toEqual(['7']);
    expect(mug[0]!.mask.foregroundPixels).toBeGreaterThan(150);
    const right = (await demoSegmentation('mug', 'right')).output.detections[0]!;
    expect(right.box.x).toBeGreaterThan(mug[0]!.box.x);
    // Other concepts name the room's own things.
    for (const concept of ['desk', 'book', 'chair', 'floor', 'bookshelf'])
      expect((await demoSegmentation(concept)).output.detections).toHaveLength(1);
  });
  it('rejects incomplete or non-segmentation output instead of treating it as no-match', async () => {
    await expect(
      decodeSegmentation(syntheticStream('I see a mug.'), 'mug', 960, 640),
    ).rejects.toThrow();
    async function* source() {
      yield { type: 'response.created' };
    }
    await expect(decodeSegmentation(source(), 'mug', 960, 640)).rejects.toThrow();
  });
  it('rejects wrong source dimensions and out-of-frame masks', async () => {
    await expect(decodeSegmentation(syntheticStream(demo.wire), 'mug', 640, 480)).rejects.toThrow();
    await expect(
      decodeSegmentation(syntheticStream(demo.wire.replace('x2=609', 'x2=1000')), 'mug', 960, 640),
    ).rejects.toThrow();
  });
  it('rejects malformed payloads and huge mask areas before decoding', async () => {
    await expect(
      decodeSegmentation(
        syntheticStream(demo.wire.replace('data=64,64,', 'data=64000,64000,')),
        'mug',
        960,
        640,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSegmentation(syntheticStream('<0f>7<|mask;broken|>'), 'mug', 960, 640),
    ).rejects.toThrow();
  });
});

describe('configuration, budget, and images', () => {
  it('rejects invalid configuration without allowing contributor mode or non-light entities', () => {
    expect(() => config({ META_SPARK_MODEL: 'muse-spark-contributor' })).toThrow();
    expect(() => config({ HA_ENTITY_ID: 'switch.desk' })).toThrow();
    expect(() => config({ HA_URL: 'http://user:pass@localhost' })).toThrow();
    expect(() => config({ META_LIVE_ENABLED: 'yes' })).toThrow();
  });
  it('persists attempts, spend and the spending limit across restarts', () => {
    const path = dir();
    let store = new EvidenceStore(path);
    store.countRequest();
    store.addSpend(0.25);
    store.setSpendLimit(3);
    store.close();
    store = new EvidenceStore(path);
    store.countRequest();
    store.addSpend(0.5);
    expect(store.usedToday()).toBe(2);
    expect(store.spentToday()).toBeCloseTo(0.75);
    expect(store.spendLimit(10)).toBe(3);
    store.setSpendLimit(null);
    expect(store.spendLimit(10)).toBe(10);
    store.close();
  });
  it('normalizes supported inline images and rejects remote URLs / broken payloads', async () => {
    const bytes = await sharp({
      create: { width: 32, height: 24, channels: 3, background: '#abcdef' },
    })
      .jpeg()
      .toBuffer();
    const image = await validateImage(`data:image/jpeg;base64,${bytes.toString('base64')}`);
    expect(image.width).toBe(32);
    expect(image.height).toBe(24);
    expect(image.dataUrl).toMatch(/^data:image\/webp/);
    await expect(validateImage('https://example.com/image.png')).rejects.toThrow();
    await expect(validateImage('data:image/png;base64,aaaaaaaaaaaaaaaaaaaa')).rejects.toThrow();
  });
  it('stores frames as lossless WebP whose decoded pixels equal the PNG path', async () => {
    const raw = Buffer.alloc(40 * 30 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 37) % 251;
    const png = await sharp(raw, { raw: { width: 40, height: 30, channels: 3 } })
      .png()
      .toBuffer();
    const image = await validateImage(`data:image/png;base64,${png.toString('base64')}`);
    expect(image.ext).toBe('webp');
    expect(mediaTypeOf(image.bytes)).toBe('image/webp');
    const pixels = (b: Buffer) => sharp(b).removeAlpha().raw().toBuffer();
    expect(Buffer.compare(await pixels(image.bytes), await pixels(png))).toBe(0);
    // SAM is sent a PNG, and old PNG evidence reads as PNG.
    expect((await samDataUrl(image)).startsWith('data:image/png;base64,')).toBe(true);
    expect(mediaTypeOf(png)).toBe('image/png');
    expect(findSource(['a/sam-output.txt', 'a/source.png'])).toBe('a/source.png');
    expect(findSource(['a/source.webp'])).toBe('a/source.webp');
  });
  it('validates bounded scene structure', () => {
    expect(
      sceneSchema.safeParse({
        summary: 'test',
        objects: Array.from({ length: 4 }, () => ({
          label: 'mug',
          category: 'mug',
          appearance: 'cream',
        })),
      }).success,
    ).toBe(false);
    expect(sceneSchema.safeParse({ summary: 'test', objects: [], action: 'turn_on' }).success).toBe(
      false,
    );
  });
});

describe('local API and provenance', () => {
  it('runs demo probes, persists evidence, and never calls a provider', async () => {
    const c = config();
    const fetcher = mock<Fetcher>();
    let app = await buildApp(c, { fetcher });
    for (const [url, body] of [
      ['discover', {}],
      ['segment', { concept: 'mug' }],
      ['segment', { concept: 'unicorn' }],
      ['lamp', {}],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/${url}`,
        payload: { mode: 'demo', ...body },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().mode).toBe('demo');
      if (url === 'segment' && 'concept' in body && body.concept === 'unicorn')
        expect(res.json().status).toBe('no_match');
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect((await app.inject('/api/status')).json().liveEvidence).toEqual({
      text: false,
      discover: false,
      segment: false,
      lamp: false,
    });
    await app.close();
    app = await buildApp(c);
    expect((await app.inject('/api/runs')).json()).toHaveLength(4);
    expect((await app.inject('/api/evidence')).headers['content-disposition']).toContain(
      'attachment',
    );
    await app.close();
  });
  it('blocks cross-origin, hostile Host, arbitrary actions, and custom demo images', async () => {
    const app = await buildApp(config());
    const base = { method: 'POST' as const, url: '/api/lamp', payload: { mode: 'demo' } };
    expect(
      (await app.inject({ ...base, headers: { origin: 'https://evil.example' } })).statusCode,
    ).toBe(403);
    expect((await app.inject({ ...base, headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect(
      (await app.inject({ ...base, payload: { mode: 'demo', entity_id: 'light.other' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/discover',
          payload: { mode: 'demo', imageDataUrl: 'custom' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject('/.env')).statusCode).toBe(404);
    await app.close();
  });
  it('disables live calls and records failure without exposing keys', async () => {
    const fetcher = mock<Fetcher>();
    const app = await buildApp(config({ MODEL_API_KEY: 'never-show-this' }), { fetcher });
    const res = await app.inject({ method: 'POST', url: '/api/text', payload: { mode: 'live' } });
    expect(res.statusCode).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
    const evidence = (await app.inject('/api/evidence')).body;
    expect(evidence).not.toContain('never-show-this');
    expect(evidence).toContain('failed');
    await app.close();
  });
});

const state = (s: string, attributes: Record<string, unknown> = {}) => ({ state: s, attributes });
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const haConfig = () =>
  config({
    HA_URL: 'http://ha.local:8123',
    HA_TOKEN: 'private-token',
    HA_ENTITY_ID: 'light.desk',
    HA_LIVE_ENABLED: 'true',
  });
describe('lamp acceptance vs observation', () => {
  it('sends one capability-aware action then checks matching state, never claiming physical proof', async () => {
    const attrs = {
      supported_color_modes: ['color_temp'],
      min_color_temp_kelvin: 3000,
      max_color_temp_kelvin: 6000,
    };
    const fetcher = mock<Fetcher>()
      .mockResolvedValueOnce(json(state('off', attrs)))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json(state('on', { brightness: 217, color_temp_kelvin: 3000 })));
    const result = await new ControlAdapter(haConfig(), fetcher, async () => {}).turnOn();
    expect(result.stateConfirmed).toBe(true);
    expect(result.physicalEffectVerified).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      entity_id: 'light.desk',
      brightness_pct: 85,
      color_temp_kelvin: 3000,
    });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('keeps an accepted action unconfirmed if the desired state never appears', async () => {
    const fetcher = mock<Fetcher>().mockImplementation(async (_url, init) =>
      init?.method === 'POST' ? json([]) : json(state('off', { supported_color_modes: ['onoff'] })),
    );
    const result = await new ControlAdapter(haConfig(), fetcher, async () => {}).turnOn();
    expect(result.accepted).toBe(true);
    expect(result.stateConfirmed).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      entity_id: 'light.desk',
    });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
});

describe('Meta adapter transport contract', () => {
  const metaConfig = () =>
    config({
      MODEL_API_KEY: 'test-key',
      META_LIVE_ENABLED: 'true',
      META_DAILY_SPEND_LIMIT_USD: '0.05',
    });
  it('uses Responses text.format, validates data, records usage/request ID and counts failures', async () => {
    const c = metaConfig();
    const store = new EvidenceStore(c.dataDir);
    const fetcher = mock<Fetcher>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'resp_test',
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
                    text: JSON.stringify({ summary: 'Desk', objects: [] }),
                    annotations: [],
                  },
                ],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
          }),
          { headers: { 'content-type': 'application/json', 'x-request-id': 'req-test' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"test-key-secret"}}', {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const adapter = new MetaAdapter(c, store, fetcher);
    const result = await adapter.discover('data:image/png;base64,TEST');
    expect(result.output).toEqual({ summary: 'Desk', objects: [] });
    expect(result.requestId).toBe('req-test');
    expect(result.usage?.totalTokens).toBe(30);
    const call = fetcher.mock.calls[0]!;
    expect(String(call[0])).toBe('https://api.meta.ai/v1/responses');
    const payload = JSON.parse(String(call[1]?.body));
    expect(payload.text.format.type).toBe('json_schema');
    expect(payload.response_format).toBeUndefined();
    await expect(adapter.text()).rejects.toThrow();
    expect(store.usedToday()).toBe(2);
    // The discovery's own usage is recorded; the refused call cost nothing.
    expect(store.spentToday()).toBeCloseTo((10 * 1.25 + 20 * 4.25) / 1_000_000, 10);
    // Near the limit, a call whose worst case could pass it is refused before it is sent.
    store.addSpend(0.045);
    await expect(adapter.text()).rejects.toThrow('spending limit');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.usedToday()).toBe(2);
    store.close();
  });
});

describe('stream transport and sanitized failures', () => {
  it('feeds actual SDK SSE events through the official parser', async () => {
    const c = config({
      MODEL_API_KEY: 'test-key',
      META_LIVE_ENABLED: 'true',
    });
    const store = new EvidenceStore(c.dataDir);
    const events = [];
    for await (const event of syntheticStream(demo.wire)) {
      events.push(
        event.type === 'response.completed'
          ? {
              ...event,
              response: {
                id: 'resp_sam',
                model: 'sam-3.1',
                status: 'completed',
                usage: { input_tokens: 50, output_tokens: 100, total_tokens: 150 },
              },
            }
          : event,
      );
    }
    const wire =
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') +
      'data: [DONE]\n\n';
    const fetcher = mock<Fetcher>().mockResolvedValue(
      new Response(wire, {
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'sam-request' },
      }),
    );
    const result = await new MetaAdapter(c, store, fetcher).segment(
      'data:image/png;base64,TEST',
      'mug',
      960,
      640,
    );
    expect(result.output.detections[0]?.objectId).toBe('7');
    expect(result.requestId).toBe('sam-request');
    expect(result.usage?.totalTokens).toBe(150);
    expect(store.usedToday()).toBe(1);
    store.close();
  });
  it('reports and changes the daily spending limit, and goes back to the .env one', async () => {
    const app = await buildApp(config({ META_DAILY_SPEND_LIMIT_USD: '10' }), {
      fetcher: mock<Fetcher>(),
    });
    const status = async () => (await app.inject('/api/status')).json().meta;
    expect(await status()).toMatchObject({ spendLimit: 10, defaultSpendLimit: 10, spentToday: 0 });
    const set = (usd: unknown) =>
      app.inject({ method: 'POST', url: '/api/settings/spend-limit', payload: { usd } });
    expect((await set(2.505)).json()).toMatchObject({ spendLimit: 2.51 });
    expect((await status()).spendLimit).toBe(2.51);
    expect((await set(0)).statusCode).toBe(400);
    expect((await set(5000)).statusCode).toBe(400);
    await set(null);
    expect((await status()).spendLimit).toBe(10);
    await app.close();
  });
  it('keeps billing errors generic in responses and persistent exports', async () => {
    const c = config({
      MODEL_API_KEY: 'sensitive-credential',
      META_LIVE_ENABLED: 'true',
    });
    const fetcher = mock<Fetcher>().mockResolvedValue(
      new Response('{"error":{"message":"sensitive-credential private-image"}}', {
        status: 402,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const app = await buildApp(c, { fetcher });
    const response = await app.inject({
      method: 'POST',
      url: '/api/text',
      payload: { mode: 'live' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('billing');
    const exported = (await app.inject('/api/evidence')).body;
    expect(exported).not.toContain('sensitive-credential');
    expect(exported).not.toContain('private-image');
    expect((await app.inject('/api/status')).json().meta.usedToday).toBe(1);
    await app.close();
  });
});

describe('cost estimates', () => {
  const run = (kind: EvidenceRun['kind'], inputTokens: number, outputTokens: number) =>
    ({
      kind,
      mode: 'live',
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    }) as EvidenceRun;
  it('prices Spark by tokens, SAM per image, and demo runs at nothing', () => {
    expect(runCost(run('discover', 1_000_000, 0))).toBeCloseTo(1.25);
    expect(runCost(run('discover', 0, 1_000_000))).toBeCloseTo(4.25);
    expect(runCost(run('segment', 5_000, 5_000))).toBe(0.0025);
    expect(runCost({ ...run('discover', 1_000, 1_000), mode: 'demo' })).toBeNull();
    expect(runCost({ ...run('discover', 0, 0), usage: null })).toBeNull();
  });
  it('estimates from the median of live runs, falling back to a guess', () => {
    expect(estimateCost('discover', []).basis).toBe('guess');
    const history = [
      run('discover', 1_000, 0),
      run('discover', 3_000, 0),
      run('discover', 100_000, 0),
    ];
    expect(estimateCost('discover', history)).toEqual({
      usd: 0.00375,
      basis: 'history',
      samples: 3,
    });
    expect(estimateCost('segment', history)).toEqual({ usd: 0.0025, basis: 'list', samples: 0 });
  });
});

describe('uncertain physical outcomes', () => {
  it('retains acceptance when state verification disconnects, without retrying the action', async () => {
    const fetcher = mock<Fetcher>()
      .mockResolvedValueOnce(json(state('off', { supported_color_modes: ['onoff'] })))
      .mockResolvedValueOnce(json([]))
      .mockRejectedValueOnce(new Error('private HA detail'));
    const result = await new ControlAdapter(haConfig(), fetcher, async () => {}).turnOn();
    expect(result.accepted).toBe(true);
    expect(result.stateConfirmed).toBe(false);
    expect(result.state).toBe('unknown');
    expect(result.explanation).not.toContain('private HA detail');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
});
