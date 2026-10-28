import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  modeSchema,
  imageRequestSchema,
  segmentRequestSchema,
  fixtureSourceKey,
  FIXTURE_LIGHTS,
  buildScene,
  isoSceneSchema,
  type SceneDraft,
  estimateCost,
  runCost,
  type EvidenceRun,
  type RunKind,
  type RunFailure,
  type Mode,
  type LampResult,
  type Segmentation,
} from '@livinglayer/domain';
import { type Config, type Fetcher, PROJECT_ROOT } from './config.js';
import { EvidenceStore } from './store.js';
import { MetaAdapter, type ProviderResult } from './meta.js';
import { LampAdapter } from './lamp.js';
import { LabError, parseInput, safeError } from './errors.js';
import { validateImage } from './images.js';
import { deskRoutes } from './desk.js';
import { itemRoutes } from './item.js';
import { photoRoutes } from './photo.js';
import { streamRoutes, type NetworkStream } from './streams.js';
import {
  fixtureScene,
  fixtureSceneGuess,
  fixtureSegmentation,
  fixtureLamp,
  fixtureLampFor,
  fixtureSceneDraft,
} from './fixtures.js';

export async function buildApp(
  config: Config,
  options: {
    fetcher?: Fetcher;
    serveWeb?: boolean;
    browseCameras?: () => Promise<NetworkStream[]>;
  } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 7_100_000, requestTimeout: 130000 });
  const store = new EvidenceStore(config.dataDir);
  const meta = new MetaAdapter(config, store, options.fetcher);
  const lamp = new LampAdapter(config, options.fetcher);
  app.addHook('onClose', async () => store.close());
  app.addHook('onRequest', async (request) => {
    const host = request.headers.host ?? '';
    if (!new RegExp(`^(localhost|127\\.0\\.0\\.1)(:${config.port}|:5173|:80)?$`).test(host))
      throw new LabError('host', 'This workbench accepts loopback hosts only.', 403);
    const origin = request.headers.origin;
    if (
      origin &&
      ![
        `http://localhost:${config.port}`,
        `http://127.0.0.1:${config.port}`,
        'http://localhost:5173',
        'http://127.0.0.1:5173',
      ].includes(origin)
    ) {
      throw new LabError('origin', 'Requests from this origin are not allowed.', 403);
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500;
    const normalized =
      error instanceof LabError
        ? error
        : new LabError(
            'invalid_request',
            'The request could not be processed.',
            status >= 400 && status < 500 ? status : 500,
          );
    const runId = (error as { runId?: string }).runId;
    void reply.code(normalized.statusCode).send({
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.detail ? { detail: normalized.detail } : {}),
        ...(runId ? { runId } : {}),
      },
    });
  });
  app.get('/api/status', async () => {
    const history = store.list();
    const today = new Date().toISOString().slice(0, 10);
    return {
      meta: {
        configured: Boolean(config.modelApiKey),
        enabled: config.metaEnabled,
        usedToday: store.usedToday(),
        requestLimit: config.maxRequests,
        sparkModel: config.sparkModel,
        samModel: config.samModel,
        estimates: {
          text: estimateCost('text', history),
          discover: estimateCost('discover', history),
          segment: estimateCost('segment', history),
        },
        spentToday: history
          .filter((r) => r.createdAt.startsWith(today))
          .reduce((sum, r) => sum + (runCost(r) ?? 0), 0),
        note:
          config.modelApiKey && config.metaEnabled
            ? 'Live calls enabled. The daily allowance counts attempts, not cost.'
            : 'Set MODEL_API_KEY and META_LIVE_ENABLED to make live calls.',
      },
      lamp: {
        configured: Boolean(config.haUrl && config.haToken && config.haEntity),
        lights: config.haLights,
        enabled: config.haEnabled,
        note:
          config.haEnabled && config.haUrl && config.haToken && config.haEntity
            ? 'One configured light; explicit actions only.'
            : 'Set the HA_* variables and HA_LIVE_ENABLED to control a lamp.',
      },
      liveEvidence: store.liveEvidence(),
    };
  });
  deskRoutes(
    app,
    store,
    async (mode, entityId) =>
      mode === 'fixture'
        ? entityId
          ? fixtureLampFor(entityId)
          : fixtureLamp
        : lamp.turnOn(entityId),
    (mode) => (mode === 'fixture' ? FIXTURE_LIGHTS : config.haLights),
  );
  streamRoutes(app, config, options.browseCameras);
  app.get('/api/runs', async () => store.list());
  app.get('/api/evidence', async (_request, reply) =>
    reply.header('Content-Disposition', 'attachment; filename="livinglayer-evidence.json"').send({
      project: 'LivingLayer',
      exportedAt: new Date().toISOString(),
      notice:
        'Fixture runs are synthetic. Physical lamp verification is manual. Latest 200 runs; local source images are excluded.',
      desk: { fixture: store.memory('fixture'), live: store.memory('live') },
      runs: store.list(),
    }),
  );
  async function run(
    kind: RunKind,
    mode: Mode,
    operation: (
      id: string,
    ) => Promise<Partial<ProviderResult<unknown>> & { output: unknown; assets?: string[] }>,
  ) {
    const start = performance.now();
    const id = randomUUID();
    const base = {
      id,
      kind,
      mode,
      createdAt: new Date().toISOString(),
      promptVersion: `${kind}-v1`,
      assets: [] as string[],
      model: null,
      requestId: null,
      usage: null,
    };
    try {
      const result = await operation(id);
      let status: EvidenceRun['status'] = 'completed';
      if (kind === 'segment' && !(result.output as Segmentation).detections.length)
        status = 'no_match';
      if (kind === 'lamp' && !(result.output as LampResult).stateConfirmed) status = 'unconfirmed';
      const evidence: EvidenceRun = {
        ...base,
        output: result.output,
        assets: result.assets ?? [],
        model: result.model ?? null,
        requestId: result.requestId ?? null,
        usage: result.usage ?? null,
        status,
        durationMs: Math.round(performance.now() - start),
      };
      store.save(evidence);
      return evidence;
    } catch (error) {
      const safe = safeError(error, kind);
      const failure: RunFailure = {
        error: {
          code: safe.code,
          message: safe.message,
          ...(safe.detail ? { detail: safe.detail } : {}),
        },
      };
      store.save({
        ...base,
        // What the provider reported, so a failed call shows its model and cost too.
        model: safe.detail?.model ?? null,
        requestId: safe.detail?.requestId ?? null,
        usage: safe.detail?.usage ?? null,
        status: 'failed',
        durationMs: Math.round(performance.now() - start),
        output: failure,
      });
      // The run id lets the page open the failed run in the inspector.
      throw Object.assign(safe, { runId: id });
    }
  }
  app.post('/api/text', async (request) => {
    const { mode } = parseInput(z.object({ mode: modeSchema }).strict(), request.body);
    return run('text', mode, async () =>
      mode === 'fixture'
        ? { output: { text: 'Fixture connection ready. No model request was sent.' } }
        : meta.text(),
    );
  });
  app.post('/api/discover', async (request) => {
    const input = parseInput(imageRequestSchema, request.body);
    return run('discover', input.mode, async (id) => {
      if (input.mode === 'fixture') {
        if (input.imageDataUrl)
          throw new LabError(
            'fixture_image',
            'Fixture mode uses only the bundled illustrated desk.',
          );
        return { output: fixtureScene };
      }
      const image = await validateImage(input.imageDataUrl);
      const result = await meta.discover(image.dataUrl);
      return { ...result, assets: [store.asset(id, 'source.png', image.bytes)] };
    });
  });
  /**
   * Draft a whole scene from a photo: Spark places templates on a grid, the
   * server builds and checks the geometry. Nothing is saved until the person
   * saves it from the scene editor.
   */
  app.post('/api/scene/draft', async (request) => {
    const input = parseInput(imageRequestSchema, request.body);
    return run('layout', input.mode, async (id) => {
      if (input.mode === 'fixture') {
        if (input.imageDataUrl)
          throw new LabError(
            'fixture_image',
            'Fixture mode uses only the bundled illustrated desk.',
          );
        return { output: drafted(fixtureSceneDraft) };
      }
      const image = await validateImage(input.imageDataUrl);
      const result = await meta.layout(image.dataUrl);
      return {
        ...result,
        output: drafted(result.output),
        assets: [store.asset(id, 'source.png', image.bytes)],
      };
    });
  });
  function drafted(draft: SceneDraft) {
    const scene = buildScene(draft);
    if (!isoSceneSchema.safeParse(scene).success)
      throw new LabError('invalid_scene', 'The drafted layout did not fit its grid.', 502);
    return { draft, scene };
  }
  app.post('/api/scene/classify', async (request) => {
    const input = parseInput(imageRequestSchema, request.body);
    return run('scene', input.mode, async (id) => {
      if (input.mode === 'fixture') {
        if (input.imageDataUrl)
          throw new LabError(
            'fixture_image',
            'Fixture mode uses only the bundled illustrated desk.',
          );
        return { output: fixtureSceneGuess };
      }
      const image = await validateImage(input.imageDataUrl);
      const result = await meta.classify(image.dataUrl);
      return { ...result, assets: [store.asset(id, 'source.png', image.bytes)] };
    });
  });
  itemRoutes(app, { store, meta, run });
  photoRoutes(app, { store, meta, run, config });
  app.post('/api/segment', async (request) => {
    const input = parseInput(segmentRequestSchema, request.body);
    return run('segment', input.mode, async (id) => {
      if (input.mode === 'fixture') {
        if (input.imageDataUrl)
          throw new LabError(
            'fixture_image',
            'Fixture mode uses only the bundled illustrated desk.',
          );
        const result = await fixtureSegmentation(input.concept, input.fixturePosition);
        return {
          output: { ...result.output, sourceKey: fixtureSourceKey(input.fixturePosition) },
          assets: [store.asset(id, 'synthetic-sam.txt', result.raw)],
        };
      }
      if (input.fixturePosition)
        throw new LabError('fixture_position', 'Fixture positions apply only in fixture mode.');
      const image = await validateImage(input.imageDataUrl);
      const result = await meta.segment(image.dataUrl, input.concept, image.width, image.height);
      return {
        ...result,
        output: {
          ...result.output,
          sourceKey: createHash('sha256').update(image.bytes).digest('hex'),
        },
        assets: [
          store.asset(id, 'source.png', image.bytes),
          store.asset(id, 'sam-output.txt', result.raw),
        ],
      };
    });
  });
  app.post('/api/lamp', async (request) => {
    const { mode } = parseInput(z.object({ mode: modeSchema }).strict(), request.body);
    return run('lamp', mode, async () => ({
      output: mode === 'fixture' ? fixtureLamp : await lamp.turnOn(),
    }));
  });
  const dist = resolve(PROJECT_ROOT, 'apps/web/dist');
  if (options.serveWeb !== false && existsSync(dist)) {
    await app.register(staticFiles, { root: dist, index: ['index.html'], list: false });
    app.get('/playground', (_request, reply) => reply.sendFile('index.html'));
  }
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: { code: 'not_found', message: 'Route not found.' } });
  });
  return app;
}
