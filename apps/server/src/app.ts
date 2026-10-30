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
  demoSourceKey,
  DEMO_LIGHTS,
  DEMO_SWITCHES,
  buildScene,
  isoSceneSchema,
  type SceneDraft,
  estimateCost,
  type EvidenceRun,
  type RunKind,
  type RunFailure,
  type Mode,
  type LampResult,
  type Segmentation,
  type DemoPosition,
  DEMO_POSITIONS,
} from '@livinglayer/domain';
import { type Config, type Fetcher, PROJECT_ROOT } from './config.js';
import { EvidenceStore } from './store.js';
import { MetaAdapter, type ProviderResult } from './meta.js';
import { ControlAdapter } from './control.js';
import { fixtureRoutes } from './fixture.js';
import { LabError, parseInput, safeError } from './errors.js';
import { validateImage } from './images.js';
import { deskRoutes } from './desk.js';
import { itemRoutes } from './item.js';
import { photoRoutes } from './photo.js';
import { pinRoutes } from './pin.js';
import { illustrationRoutes } from './illustration.js';
import { listStreams, streamRoutes, type NetworkStream } from './streams.js';
import { Watcher, watchRoutes, type WatcherDeps } from './watcher.js';
import { Appearance } from './appearance.js';
import { DemoSource } from './frames.js';
import { RemoteCamera, remoteRoutes } from './remote.js';
import {
  demoScene,
  demoSceneGuess,
  demoSegmentation,
  demoLamp,
  demoLampFor,
  demoSceneDraft,
} from './demo.js';

const watching = new WeakMap<object, Record<Mode, Watcher>>();
/** The camera watchers of an app `buildApp` made, for tests. */
export const watchersOf = (app: object) => watching.get(app)!;

export async function buildApp(
  config: Config,
  options: {
    fetcher?: Fetcher;
    serveWeb?: boolean;
    browseCameras?: () => Promise<NetworkStream[]>;
    remote?: RemoteCamera;
    /** Frames for the watchers; tests pass their own. */
    frames?: WatcherDeps['source'];
    /** The feature model; tests pass null to leave it out. */
    appearance?: () => Promise<Appearance | null>;
  } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 7_100_000, requestTimeout: 130000 });
  const store = new EvidenceStore(config.dataDir);
  const meta = new MetaAdapter(config, store, options.fetcher);
  const lamp = new ControlAdapter(config, options.fetcher);
  app.addHook('onClose', async () => store.close());
  app.addHook('onRequest', async (request) => {
    const host = request.headers.host ?? '';
    if (!new RegExp(`^(localhost|127\\.0\\.0\\.1)(:${config.port}|:43430|:80)?$`).test(host))
      throw new LabError('host', 'This workbench accepts loopback hosts only.', 403);
    const origin = request.headers.origin;
    if (
      origin &&
      ![
        `http://localhost:${config.port}`,
        `http://127.0.0.1:${config.port}`,
        'http://localhost:43430',
        'http://127.0.0.1:43430',
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
    return {
      meta: {
        configured: Boolean(config.modelApiKey),
        enabled: config.metaEnabled,
        usedToday: store.usedToday(),
        spendLimit: store.spendLimit(config.spendLimitUsd),
        defaultSpendLimit: config.spendLimitUsd,
        sparkModel: config.sparkModel,
        samModel: config.samModel,
        estimates: {
          text: estimateCost('text', history),
          discover: estimateCost('discover', history),
          segment: estimateCost('segment', history),
        },
        spentToday: store.spentToday(),
        note:
          config.modelApiKey && config.metaEnabled
            ? 'Live calls enabled. A call that could take today’s spend past the limit is refused before it is sent.'
            : 'Set MODEL_API_KEY and META_LIVE_ENABLED to make live calls.',
      },
      lamp: {
        configured: Boolean(config.haUrl && config.haToken && config.haEntity),
        lights: config.haLights,
        switches: config.haSwitches,
        enabled: config.haEnabled,
        note:
          config.haEnabled && config.haUrl && config.haToken && config.haEntity
            ? 'One configured light; explicit actions only.'
            : 'Set the HA_* variables and HA_LIVE_ENABLED to control a lamp.',
      },
      liveEvidence: store.liveEvidence(),
    };
  });
  const entities = (mode: Mode) =>
    mode === 'demo'
      ? [...DEMO_LIGHTS, ...DEMO_SWITCHES]
      : [...config.haLights, ...config.haSwitches];
  const tracking = deskRoutes(
    app,
    store,
    async (mode, entityId) =>
      mode === 'demo' ? (entityId ? demoLampFor(entityId) : demoLamp) : lamp.turnOn(entityId),
    entities,
  );
  fixtureRoutes(app, {
    store,
    meta,
    run,
    control: async (mode, entityId, action) =>
      mode === 'demo'
        ? demoLampFor(entityId, action)
        : action === 'on'
          ? lamp.turnOn(entityId)
          : lamp.turnOff(entityId),
    entities,
  });
  const remote = options.remote ?? new RemoteCamera();
  remoteRoutes(app, config, remote);
  streamRoutes(app, config, options.browseCameras, () => remote.streams());
  app.get('/api/runs', async () => store.list());
  app.get('/api/evidence', async (_request, reply) =>
    reply.header('Content-Disposition', 'attachment; filename="livinglayer-evidence.json"').send({
      project: 'LivingLayer',
      exportedAt: new Date().toISOString(),
      notice:
        'Demo runs are synthetic. Physical lamp verification is manual. Latest 200 runs; local source images are excluded.',
      desk: { demo: store.memory('demo'), live: store.memory('live') },
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
  /** Change the daily Meta spending limit; null goes back to the one in `.env`. */
  app.post('/api/settings/spend-limit', async (request) => {
    const { usd } = parseInput(
      z.object({ usd: z.number().positive().max(1000).nullable() }).strict(),
      request.body,
    );
    store.setSpendLimit(usd === null ? null : Math.round(usd * 100) / 100);
    return {
      spendLimit: store.spendLimit(config.spendLimitUsd),
      spentToday: store.spentToday(),
    };
  });
  app.post('/api/text', async (request) => {
    const { mode } = parseInput(z.object({ mode: modeSchema }).strict(), request.body);
    return run('text', mode, async () =>
      mode === 'demo'
        ? { output: { text: 'Demo connection ready. No model request was sent.' } }
        : meta.text(),
    );
  });
  app.post('/api/discover', async (request) => {
    const input = parseInput(imageRequestSchema, request.body);
    return run('discover', input.mode, async (id) => {
      if (input.mode === 'demo') {
        if (input.imageDataUrl)
          throw new LabError('demo_image', 'Demo mode uses only the bundled illustrated desk.');
        return { output: demoScene };
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
      if (input.mode === 'demo') {
        if (input.imageDataUrl)
          throw new LabError('demo_image', 'Demo mode uses only the bundled illustrated desk.');
        return { output: drafted(demoSceneDraft) };
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
      if (input.mode === 'demo') {
        if (input.imageDataUrl)
          throw new LabError('demo_image', 'Demo mode uses only the bundled illustrated desk.');
        return { output: demoSceneGuess };
      }
      const image = await validateImage(input.imageDataUrl);
      const result = await meta.classify(image.dataUrl);
      return { ...result, assets: [store.asset(id, 'source.png', image.bytes)] };
    });
  });
  itemRoutes(app, { store, meta, run });
  photoRoutes(app, { store, meta, run, config });
  pinRoutes(app, { store, meta, run });
  illustrationRoutes(app, { store, meta, run });
  /** One SAM segmentation, recorded and billed as a run: the lab's button, or the watcher. */
  function segment(input: {
    mode: Mode;
    concept: string;
    imageDataUrl?: string;
    demoPosition?: DemoPosition;
  }) {
    return run('segment', input.mode, async (id) => {
      if (input.mode === 'demo') {
        if (input.imageDataUrl)
          throw new LabError('demo_image', 'Demo mode uses only the bundled illustrated desk.');
        const result = await demoSegmentation(input.concept, input.demoPosition);
        return {
          output: { ...result.output, sourceKey: demoSourceKey(input.demoPosition) },
          assets: [store.asset(id, 'synthetic-sam.txt', result.raw)],
        };
      }
      if (input.demoPosition)
        throw new LabError('demo_position', 'Demo positions apply only in demo mode.');
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
    }) as Promise<EvidenceRun<Segmentation>>;
  }
  app.post('/api/segment', async (request) =>
    segment(parseInput(segmentRequestSchema, request.body)),
  );
  app.post('/api/lamp', async (request) => {
    const { mode } = parseInput(z.object({ mode: modeSchema }).strict(), request.body);
    return run('lamp', mode, async () => ({
      output: mode === 'demo' ? demoLamp : await lamp.turnOn(),
    }));
  });
  // The server watches the camera, so rules fire with no tab open.
  let model: Promise<Appearance | null> | null = null;
  const demoPicture = new DemoSource();
  const watcherDeps = (mode: Mode): WatcherDeps => ({
    mode,
    store,
    tracking,
    segment: (m, concept, picture) =>
      segment({
        mode: m,
        concept,
        ...('png' in picture
          ? { imageDataUrl: `data:image/png;base64,${picture.png.toString('base64')}` }
          : { demoPosition: picture.demoPosition }),
      }),
    photoOf: async (segmentRun) => {
      if (segmentRun.mode === 'demo') {
        const key = (segmentRun.output as Segmentation).sourceKey ?? '';
        const position = (key.split('@')[1] ?? 'centre') as DemoPosition;
        demoPicture.position = DEMO_POSITIONS[position] ? position : 'centre';
        return (await demoPicture.snapshot()).png;
      }
      const photo = segmentRun.assets.find((a) => a.endsWith('/source.png'));
      return photo ? store.readAsset(photo) : null;
    },
    appearance: options.appearance ?? (() => (model ??= Appearance.load(config.dataDir))),
    ...(options.frames ? { source: options.frames } : {}),
  });
  const watchers = {
    demo: new Watcher(watcherDeps('demo')),
    live: new Watcher(watcherDeps('live')),
  };
  watchRoutes(app, watchers, {
    store,
    streams: () => listStreams(config, options.browseCameras, () => remote.streams()),
  });
  app.addHook('onReady', async () => {
    for (const mode of ['demo', 'live'] as const)
      if (store.memory(mode).watch?.on) void watchers[mode].start();
  });
  app.addHook('onClose', async () => {
    watchers.demo.stop();
    watchers.live.stop();
  });
  const dist = resolve(PROJECT_ROOT, 'apps/web/dist');
  if (options.serveWeb !== false && existsSync(dist)) {
    await app.register(staticFiles, { root: dist, index: ['index.html'], list: false });
    app.get('/playground', (_request, reply) => reply.sendFile('index.html'));
  }
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: { code: 'not_found', message: 'Route not found.' } });
  });
  watching.set(app, watchers);
  return app;
}
