import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { fixtureSegmentation } from '../apps/server/src/fixtures.js';
import { decodeSegmentation, syntheticStream } from '../apps/server/src/sam.js';
import { validateImage } from '../apps/server/src/images.js';
import { buildApp } from '../apps/server/src/app.js';
import { LampAdapter } from '../apps/server/src/lamp.js';
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
const fixture = JSON.parse(readFileSync('fixtures/sam-mug.json', 'utf8')) as { wire: string };

describe('SAM contract and actual public parser', () => {
  it('decodes a split-token mug mask with sparse object ID and source-pixel bounds', async () => {
    const result = await fixtureSegmentation('mug');
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
    expect((await fixtureSegmentation('unicorn')).output.detections).toEqual([]);
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
    await expect(
      decodeSegmentation(syntheticStream(fixture.wire), 'mug', 640, 480),
    ).rejects.toThrow();
    await expect(
      decodeSegmentation(
        syntheticStream(fixture.wire.replace('x2=609', 'x2=1000')),
        'mug',
        960,
        640,
      ),
    ).rejects.toThrow();
  });
  it('rejects malformed payloads and huge mask areas before decoding', async () => {
    await expect(
      decodeSegmentation(
        syntheticStream(fixture.wire.replace('data=64,64,', 'data=64000,64000,')),
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
  it('persists request allowance across restarts and includes failed attempts', () => {
    const path = dir();
    let store = new EvidenceStore(path);
    store.reserveRequest(2);
    store.close();
    store = new EvidenceStore(path);
    store.reserveRequest(2);
    expect(store.usedToday()).toBe(2);
    expect(() => store.reserveRequest(2)).toThrow('allowance');
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
    expect(image.dataUrl).toMatch(/^data:image\/png/);
    await expect(validateImage('https://example.com/image.png')).rejects.toThrow();
    await expect(validateImage('data:image/png;base64,aaaaaaaaaaaaaaaaaaaa')).rejects.toThrow();
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
  it('runs fixture probes, persists evidence, and never calls a provider', async () => {
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
        payload: { mode: 'fixture', ...body },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().mode).toBe('fixture');
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
  it('blocks cross-origin, hostile Host, arbitrary actions, and custom fixture images', async () => {
    const app = await buildApp(config());
    const base = { method: 'POST' as const, url: '/api/lamp', payload: { mode: 'fixture' } };
    expect(
      (await app.inject({ ...base, headers: { origin: 'https://evil.example' } })).statusCode,
    ).toBe(403);
    expect((await app.inject({ ...base, headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect(
      (await app.inject({ ...base, payload: { mode: 'fixture', entity_id: 'light.other' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/discover',
          payload: { mode: 'fixture', imageDataUrl: 'custom' },
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
    const result = await new LampAdapter(haConfig(), fetcher, async () => {}).turnOn();
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
    const result = await new LampAdapter(haConfig(), fetcher, async () => {}).turnOn();
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
      META_MAX_REQUESTS_PER_DAY: '2',
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
    await expect(adapter.text()).rejects.toThrow('allowance');
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    for await (const event of syntheticStream(fixture.wire)) {
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
  it('prices Spark by tokens, SAM per image, and fixture runs at nothing', () => {
    expect(runCost(run('discover', 1_000_000, 0))).toBeCloseTo(1.25);
    expect(runCost(run('discover', 0, 1_000_000))).toBeCloseTo(4.25);
    expect(runCost(run('segment', 5_000, 5_000))).toBe(0.0025);
    expect(runCost({ ...run('discover', 1_000, 1_000), mode: 'fixture' })).toBeNull();
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
    const result = await new LampAdapter(haConfig(), fetcher, async () => {}).turnOn();
    expect(result.accepted).toBe(true);
    expect(result.stateConfirmed).toBe(false);
    expect(result.state).toBe('unknown');
    expect(result.explanation).not.toContain('private HA detail');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
});
