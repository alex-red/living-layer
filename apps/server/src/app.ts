import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  runOutput,
  DEMO_LIGHTS,
  DEMO_SWITCHES,
  estimateCost,
  type Mode,
  type LightLook,
  type DemoPosition,
  DEMO_POSITIONS,
  savedIdOf,
  controlKindOf,
} from '@livinglayer/domain';
import { type Config, type Fetcher, PROJECT_ROOT } from './config.js';
import { EvidenceStore } from './store.js';
import { closeCompute } from './workers/compute.js';
import { MetaAdapter } from './meta.js';
import { ControlAdapter, type SwitchOptions, type Switched } from './control.js';
import { chosenEntities, haConnection, haRoutes, type OpenSocket } from './ha.js';
import { fixtureRoutes } from './fixture/routes.js';
import { watchRequest } from './request-signal.js';
import { LabError, logError } from './errors.js';
import { findSource, toDataUrl } from './images.js';
import { createDesk, deskRoutes } from './desk.js';
import { settingsRoutes } from './settings.js';
import { savesRoutes } from './saves.js';
import { textRoutes } from './text.js';
import { discoverRoutes } from './discover.js';
import { createSegment, segmentRoutes } from './segment.js';
import { lampRoutes } from './lamp.js';
import { itemRoutes } from './item.js';
import { sceneRoutes } from './scene.js';
import { pinRoutes } from './pin.js';
import { selectRoutes } from './select.js';
import { assistRoutes } from './assist.js';
import { roomRoutes } from './room.js';
import { jobRoutes, Jobs, runningJobs } from './jobs.js';
import { listStreams, streamRoutes, type NetworkStream } from './streams.js';
import { CameraRegistry, cameraRoutes, streamCrop } from './cameras.js';
import type { Relay } from './relay.js';
import { Watcher, setWatching, watchRoutes, type WatcherDeps } from './watcher.js';
import { Appearance } from './appearance.js';
import { DemoSource } from './frames.js';
import { RemoteCamera, remoteRoutes } from './remote.js';
import { reconstruct } from './sam3d.js';
import { createRunner } from './runs.js';
import { Exposer, exposeRoutes } from './expose.js';
import { statRoutes } from './stats.js';
import { MqttLink, type MqttConnect } from './mqtt.js';
import { MqttControl } from './mqtt-control.js';
import { demoLamp, demoLampFor } from './demo.js';

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
    /** Home Assistant's websocket, for signing in; tests pass their own. */
    haSocket?: OpenSocket;
    /** The MQTT client; tests pass their own. */
    mqttConnect?: MqttConnect;
    /** Stills from saved cameras; tests pass their own. */
    snapshots?: Parameters<typeof cameraRoutes>[2]['source'];
    /** Live MJPEG from saved cameras; tests pass their own. */
    previews?: Parameters<typeof cameraRoutes>[2]['preview'];
    /** Relays saved cameras as WebRTC; the server passes one when mediamtx is installed. */
    relay?: Relay | null;
    /** SAM 3D on a crop; tests pass their own, null turns it off. */
    sam3d?: ((crop: Buffer, signal?: AbortSignal) => Promise<Buffer>) | null;
  } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 7_100_000, requestTimeout: 130000 });
  const store = new EvidenceStore(config.dataDir);
  // Long AI jobs the page follows: one set per app, so apps in one process don't share them.
  const jobs = new Jobs();
  const meta = new MetaAdapter(config, store, options.fetcher);
  const run = createRunner(store);
  const lamp = new ControlAdapter(config, options.fetcher, undefined, {
    allowed: () => [...haLights(), ...haSwitches()],
    connection: () => haConnection(config, store),
  });
  const pruneEvidence = () => {
    if (!(config.evidenceRetentionDays > 0)) return;
    try {
      const gone = store.prune(config.evidenceRetentionDays * 86_400_000);
      if (gone.runs || gone.jobs)
        app.log.info(
          `Pruned evidence older than ${config.evidenceRetentionDays} days: ${gone.runs} runs, ${gone.jobs} jobs, ${(gone.bytes / 1e6).toFixed(1)} MB of files.`,
        );
    } catch (error) {
      app.log.warn(`Pruning evidence failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  pruneEvidence();
  const pruneTimer = setInterval(pruneEvidence, 86_400_000);
  pruneTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(pruneTimer);
    closeCompute();
    store.close();
  });
  // MQTT: one install id names our device and entities in Home Assistant across restarts.
  let installId = store.setting('install_id');
  if (!installId) store.setSetting('install_id', (installId = randomUUID().replace(/-/g, '')));
  const exposeDeps = {
    store,
    options: {
      installId,
      discoveryPrefix: config.mqtt.discoveryPrefix,
      baseTopic: config.mqtt.baseTopic,
      version: (
        JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf8')) as {
          version: string;
        }
      ).version,
    },
  };
  const link =
    config.mqtt.url && config.mqtt.enabled
      ? new MqttLink(
          config.mqtt,
          `livinglayer-${installId.slice(0, 12)}`,
          () => exposers.live.sync(true),
          () => exposers.live.emit(),
          options.mqttConnect,
        )
      : null;
  // Lights and switches over MQTT, beside Home Assistant's; with no main light there, the first is.
  const mqttControl = new MqttControl(link, config.mqtt.devices);
  const mqttLights = config.mqtt.devices
    .filter((d) => d.entityId.startsWith('light.'))
    .map((d) => d.entityId);
  const mqttSwitches = config.mqtt.devices
    .filter((d) => d.entityId.startsWith('switch.'))
    .map((d) => d.entityId);
  /** Where Home Assistant is: `.env`'s URL and token, else the lab's sign-in. */
  const ha = () => haConnection(config, store);
  // Home Assistant's: `.env`'s first, then the ones ticked in the lab, kept in `settings`.
  const haChosen = () => chosenEntities(store).filter((e) => !mqttControl.has(e));
  function haLights() {
    return [
      ...new Set([...config.haLights, ...haChosen().filter((e) => controlKindOf(e) === 'light')]),
    ];
  }
  function haSwitches() {
    return [
      ...new Set([
        ...config.haSwitches,
        ...haChosen().filter((e) => controlKindOf(e) === 'switch'),
      ]),
    ];
  }
  const liveLights = () => [...haLights(), ...mqttLights];
  const liveSwitches = () => [...haSwitches(), ...mqttSwitches];
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
  app.setErrorHandler((error, request, reply) => {
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
    if (!(error instanceof LabError) && normalized.statusCode >= 500)
      logError(error, `${request.method} ${request.url}`);
    const runId = (error as { runId?: string }).runId;
    void reply.code(normalized.statusCode).send({
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.detail ? { detail: normalized.detail } : {}),
        ...(normalized.data ? { data: normalized.data } : {}),
        ...(runId ? { runId } : {}),
      },
    });
  });
  // Requests that change something, model calls among them, while they run: with the jobs still
  // running, what `bun run dev` waits for before it restarts this server or reloads the page.
  let changing = 0;
  app.addHook('onRequest', async (request, reply) => {
    watchRequest(request, reply);
    if (request.method === 'GET' || request.method === 'HEAD') return;
    changing++;
    reply.raw.once('close', () => changing--);
  });
  app.get('/api/busy', async () => ({ jobs: runningJobs(), requests: changing }));
  app.get('/api/status', async () => {
    const history = store.costHistory();
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
      tracking: { ai: store.trackingAi() },
      lamp: {
        configured: liveLights().length + liveSwitches().length > 0,
        lights: liveLights(),
        switches: liveSwitches(),
        enabled: config.haEnabled || Boolean(link && config.mqtt.devices.length),
        note: lampNote(),
      },
      ha: {
        connected: Boolean(ha().url),
        url: ha().url,
        via: ha().via,
        user: ha().user,
        enabled: config.haEnabled,
        fromEnv: [...config.haLights, ...config.haSwitches],
        chosen: haChosen(),
        overMqtt: config.mqtt.devices.map((d) => d.entityId),
      },
      mqtt: {
        configured: Boolean(config.mqtt.url),
        enabled: config.mqtt.enabled,
        state: link?.state ?? 'off',
        note: link
          ? link.note
          : 'Set MQTT_URL and MQTT_LIVE_ENABLED to show entities in Home Assistant.',
      },
      liveEvidence: store.liveEvidence(),
      sam3d:
        options.sam3d === null ? null : (config.sam3d?.kind ?? (options.sam3d ? 'local' : null)),
    };
  });
  /** What the lab says about switching, in the order someone sets it up. */
  function lampNote() {
    const count = liveLights().length + liveSwitches().length;
    const devices = `${count} device${count === 1 ? '' : 's'}`;
    const connected = Boolean(ha().url);
    if (link && config.mqtt.devices.length && !connected)
      return `${devices} over MQTT; switched only when a rule or a button asks.`;
    if (!connected)
      return 'Not connected: sign in under Home Assistant → Devices it can switch, in the outline.';
    if (!count)
      return 'Connected. Pick the devices it may switch under Home Assistant in the outline.';
    if (!config.haEnabled)
      return `${devices} chosen, but switching is off: HA_LIVE_ENABLED=false is in .env.`;
    return `${devices} ready; switched only when a rule or a button asks.`;
  }
  const entities = (mode: Mode) =>
    mode === 'demo' ? [...DEMO_LIGHTS, ...DEMO_SWITCHES] : [...liveLights(), ...liveSwitches()];
  /** Switch a live device: over MQTT when it is an MQTT device, else through Home Assistant. */
  const switchLive = (
    entity: string | undefined,
    action: 'on' | 'off',
    look?: LightLook,
    options?: SwitchOptions,
  ): Promise<Switched> => {
    const target = entity ?? liveLights()[0] ?? '';
    if (target && mqttControl.has(target)) return mqttControl.act(target, action);
    return action === 'on' ? lamp.turnOn(target, look, options) : lamp.turnOff(target, options);
  };
  app.register(haRoutes, {
    prefix: '/api/ha',
    config,
    store,
    lamp,
    fixed: () => [...config.haLights, ...config.haSwitches],
    fetcher: options.fetcher,
    openSocket: options.haSocket,
  });
  const desk = createDesk(store, async (mode, entityId, action = 'on', look, options) =>
    mode === 'demo'
      ? demoLampFor(entityId ?? demoLamp.entityId, action, look)
      : switchLive(entityId, action, look, options),
  );
  app.register(deskRoutes, { prefix: '/api/desk', store, desk, entities });
  app.register(fixtureRoutes, {
    prefix: '/api/fixtures',
    store,
    meta,
    run,
    jobs,
    desk,
    control: async (mode, entityId, action) =>
      mode === 'demo' ? demoLampFor(entityId, action) : switchLive(entityId, action),
    entities,
    productsDir: join(config.dataDir, 'products'),
    sam3d:
      options.sam3d !== undefined
        ? options.sam3d
        : config.sam3d
          ? (crop, signal) =>
              reconstruct(config.sam3d!, crop, {
                ...(signal ? { signal } : {}),
                ...(options.fetcher ? { fetcher: options.fetcher } : {}),
              })
          : null,
  });
  const remote = options.remote ?? new RemoteCamera();
  remoteRoutes(app, config, remote);
  const cameras = new CameraRegistry(store, options.relay ?? null);
  remote.crop = cameras.phoneCrop();
  const knownStreams = () => [...remote.streams(), ...cameras.streams()];
  app.get('/api/runs', async () => store.list());
  jobs.keepIn(store);
  app.register((scope) => jobRoutes(scope, jobs, store), { prefix: '/api/jobs' });
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
  app.register(settingsRoutes, { prefix: '/api/settings', store, config });
  app.register(savesRoutes, { prefix: '/api/saves', store });
  app.register(textRoutes, { prefix: '/api/text', meta, run });
  app.register(discoverRoutes, { prefix: '/api/discover', store, meta, run });
  const segment = createSegment({ store, meta, run });
  app.register(segmentRoutes, { prefix: '/api/segment', segment, store });
  app.register(lampRoutes, { prefix: '/api/lamp', run, entities, switchLive });
  app.register(itemRoutes, { prefix: '/api/item', store, meta, run });
  app.register(sceneRoutes, { prefix: '/api/scene', store, meta, run, jobs, config, desk });
  app.register(pinRoutes, { prefix: '/api/desk', store });
  app.register(selectRoutes, { prefix: '/api/select', store });
  app.register(assistRoutes, {
    prefix: '/api/assist',
    store,
    meta,
    run,
    jobs,
    entities,
    productsDir: join(config.dataDir, 'products'),
  });
  app.register(roomRoutes, { prefix: '/api/room', store, meta, run });
  // The server watches the camera, so rules fire with no tab open.
  let model: Promise<Appearance | null> | null = null;
  const demoPicture = new DemoSource();
  const watcherDeps = (mode: Mode): WatcherDeps => ({
    mode,
    store,
    tracking: desk,
    segment: (m, concept, picture, signal) =>
      segment(
        {
          mode: m,
          concept,
          ...('png' in picture
            ? { imageDataUrl: toDataUrl(picture.png) }
            : { demoPosition: picture.demoPosition }),
        },
        signal,
      ),
    photoOf: async (segmentRun) => {
      if (segmentRun.mode === 'demo') {
        const key = runOutput(segmentRun, 'segment')?.sourceKey ?? '';
        const position = (key.split('@')[1] ?? 'centre') as DemoPosition;
        demoPicture.position = DEMO_POSITIONS[position] ? position : 'centre';
        return (await demoPicture.snapshot()).png;
      }
      const photo = findSource(segmentRun.assets);
      return photo ? store.readAsset(photo) : null;
    },
    appearance: options.appearance ?? (() => (model ??= Appearance.load(config.dataDir))),
    ...(options.frames ? { source: options.frames } : {}),
    cameraUrl: (camera) => cameras.urlOf(camera),
    cameraCrop: (camera) => cameras.cropOf(camera),
  });
  const watchers = {
    demo: new Watcher(watcherDeps('demo')),
    live: new Watcher(watcherDeps('live')),
  };
  app.register(
    (scope) =>
      watchRoutes(scope, watchers, {
        store,
        streams: () => listStreams(config, options.browseCameras, knownStreams),
        saved: (streamId) => {
          const id = savedIdOf(streamId);
          return id === null ? null : cameras.watchCamera(id);
        },
        // Made further down; asked for only once a stream opens.
        expose: (mode) => exposers[mode],
      }),
    { prefix: '/api/watch' },
  );
  /**
   * Watching is on by default. When the server starts, the live desk watches the camera
   * it watched before, or else the one saved camera the server can read: turning it off
   * lasts until the next start. A camera saved on a desk that never chose is watched at
   * once. Following is local and cheap; SAM is only asked at a settled zone crossing or
   * a loss nothing local fixes.
   */
  const watchByDefault = async (starting: boolean) => {
    const memory = store.memory('live');
    if (memory.watch?.on || (!starting && memory.watch !== undefined)) return;
    const kept = memory.watch?.camera;
    const readable = cameras.list().filter((c) => /^rtsps?:\/\//.test(c.url));
    const camera =
      kept && cameras.urlOf(kept)
        ? kept
        : readable.length === 1
          ? cameras.watchCamera(readable[0]!.id)
          : null;
    if (camera) await setWatching(store, watchers.live, true, camera).catch(() => {});
  };
  const cameraOptions: Parameters<typeof cameraRoutes>[2] = {
    onSaved: () => void watchByDefault(false),
    // Watching a camera that was just removed stops; choosing another starts it again.
    onRemoved: (streamId) => {
      for (const mode of ['demo', 'live'] as const) {
        const memory = store.memory(mode);
        if (memory.watch?.camera?.id !== streamId) continue;
        memory.watch = { on: false, camera: null };
        store.saveMemory(memory);
        watchers[mode].stop();
      }
    },
    ...(options.snapshots ? { source: options.snapshots } : {}),
    ...(options.previews ? { preview: options.previews } : {}),
  };
  app.register((scope) => cameraRoutes(scope, cameras, cameraOptions), { prefix: '/api/cameras' });
  // A new view is a new frame: watching it starts again, and the phone's next connection is cut to it.
  const cropStream = streamCrop(cameras, (streamId) => {
    if (streamId === 'phone') remote.crop = cameras.phoneCrop();
    for (const mode of ['demo', 'live'] as const) {
      const memory = store.memory(mode);
      if (memory.watch?.on && memory.watch.camera?.id === streamId) void watchers[mode].start();
    }
  });
  app.register(
    (scope) => streamRoutes(scope, config, options.browseCameras, knownStreams, cropStream),
    { prefix: '/api/streams' },
  );
  // Entities shown in Home Assistant, worked out from desk memory and what the watchers see.
  const exposers: Record<Mode, Exposer> = {
    demo: new Exposer({
      ...exposeDeps,
      mode: 'demo',
      link: null,
      watch: () => watchers.demo.exposeWatch(),
    }),
    live: new Exposer({
      ...exposeDeps,
      mode: 'live',
      link,
      watch: () => watchers.live.exposeWatch(),
      // Home Assistant's switch and button do what the lab's own buttons do.
      actions: {
        setWatching: (on) => setWatching(store, watchers.live, on),
        checkRules: () => desk.verifyRules('live'),
      },
    }),
  };
  app.register(
    (scope) =>
      exposeRoutes(scope, exposers, store, (mode, zoneId) => watchers[mode].learnEmpty(zoneId)),
    { prefix: '/api/expose' },
  );
  const statRunners = { demo: watchers.demo.statRunner, live: watchers.live.statRunner };
  app.register((scope) => statRoutes(scope, { store, runners: statRunners }), {
    prefix: '/api/things',
  });
  // Whatever a person changes in a desk, the watchers follow and the entities shown in Home
  // Assistant follow. A root hook, so it covers every plugin's routes.
  app.addHook('onResponse', async (request, reply) => {
    if (request.method !== 'POST' || reply.statusCode >= 400) return;
    if (/^\/api\/(desk|fixtures|scene|item|expose)\//.test(request.url)) {
      void watchers.demo.sync();
      void watchers.live.sync();
    }
    // Stats follow too when nobody is watching: a light switched by hand still counts.
    if (/^\/api\/(desk|fixtures|scene|item|lamp)\b/.test(request.url)) {
      statRunners.demo.sync();
      statRunners.live.sync();
    }
    if (/^\/api\/(desk|fixtures|scene|item|expose|watch|things)\b/.test(request.url)) {
      exposers.demo.sync();
      exposers.live.sync();
    }
  });
  for (const mode of ['demo', 'live'] as const)
    watchers[mode].subscribe(() => exposers[mode].sync());
  // Motion holds run out with no frame to say so.
  const tick = setInterval(() => {
    statRunners.demo.sync();
    statRunners.live.sync();
    exposers.demo.sync();
    exposers.live.sync();
  }, 5000);
  tick.unref?.();
  app.addHook('onReady', async () => {
    for (const mode of ['demo', 'live'] as const) {
      statRunners[mode].sync();
      if (store.memory(mode).watch?.on) void watchers[mode].start();
    }
    link?.start();
  });
  // The relay only once this server holds its port: one that fails to listen must not
  // take the relay from the one that does. Live watching then reads through it.
  app.addHook('onListen', async () => {
    if (options.relay) {
      await cameras.startRelay();
      if (store.memory('live').watch?.on) void watchers.live.start();
    }
    await watchByDefault(true);
  });
  app.addHook('onClose', async () => {
    clearInterval(tick);
    watchers.demo.stop();
    watchers.live.stop();
    statRunners.demo.flush();
    statRunners.live.flush();
    options.relay?.stop();
    await link?.stop();
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
