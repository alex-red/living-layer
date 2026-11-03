import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import {
  runOutput,
  modeOnlySchema,
  watchBodySchema,
  watchDemoBodySchema,
  appearanceSure,
  asked,
  appearanceRegion,
  cameraEdges,
  cameraKept,
  cameraMoved,
  cropMask,
  findByAppearance,
  intoRegion,
  outOfRegion,
  searchRegion,
  frameMotion,
  maskBits,
  missed,
  placed,
  patchWeights,
  patchTemplate,
  candidatePlaces,
  closeMatch,
  closeRegion,
  closeFit,
  closeSure,
  prototypeOf,
  refound,
  startLocalTrack,
  watchFrame,
  watchThing,
  zonesIn,
  featureDifference,
  nextOccupied,
  pixelDifference,
  zoneSample,
  boxIoU,
  OCCUPANCY,
  APPEARANCE,
  LOCAL_TRACK,
  MULTI,
  WATCH,
  DEMO_POSITIONS,
  type DemoPosition,
  type DeskMemory,
  type ExposeView,
  type HaView,
  type DeskObservation,
  type EvidenceRun,
  type EmptyLook,
  type ExposeWatch,
  type ZoneOccupancy,
  type LumaFrame,
  type Mode,
  type Segmentation,
  type UnitBox,
  type PatchTemplate,
  type WatchCamera,
  type CameraCrop,
  type WatchSubject,
  type WatchThing,
  type WatchKind,
  type WatchView,
  type ZoneRect,
  ruleObjects,
  followedThings,
  mugOf,
  followOccupied,
} from '@livinglayer/domain';
import type { Appearance } from './appearance.js';
import type { DeskTracking } from './desk.js';
import { LabError, parseInput, safeError } from './errors.js';
import { DemoSource, FfmpegSource, LUMA_FPS, lumaOf, type FrameSource } from './frames.js';
import { StatRunner, lookText, readLook } from './stats.js';
import type { EvidenceStore } from './store.js';
import type { NetworkStream } from './streams.js';

type Seen = { observation: DeskObservation; kind: WatchKind; label: string; concept: string };

/** Everything the watcher follows in a desk memory, with its last SAM sighting. */
export function watchedThings(memory: DeskMemory): Seen[] {
  const mug = mugOf(memory);
  return followedThings(memory).map((f) => ({
    observation: f.track.observation,
    kind: f === mug ? 'mug' : f.place === 'sightings' ? 'object' : 'fixture',
    label: f.label,
    concept: f.track.concept,
  }));
}
/** A thing's zones as shares of the frame, each with SAM's last verdict. */
function zonesOf(memory: DeskMemory, objectId: string): WatchSubject['zones'] {
  const zones: WatchSubject['zones'] = [];
  // A zone counting several things is crossed by each on its own.
  for (const r of memory.rules ?? [])
    if (ruleObjects(memory, r).includes(objectId))
      zones.push({ id: r.id, rect: r.zone.rect, inside: r.inside?.includes(objectId) ?? false });
  return zones;
}
const unit = (o: Pick<DeskObservation, 'box' | 'frame'>): UnitBox => ({
  x: o.box.x / o.frame.width,
  y: o.box.y / o.frame.height,
  width: o.box.width / o.frame.width,
  height: o.box.height / o.frame.height,
});

export interface WatcherDeps {
  mode: Mode;
  store: EvidenceStore;
  tracking: DeskTracking;
  /** One SAM call through the lab's own segment path, recorded and billed like any other. */
  segment: (
    mode: Mode,
    concept: string,
    picture: { png: Buffer } | { demoPosition: DemoPosition },
    signal?: AbortSignal,
  ) => Promise<EvidenceRun<Segmentation>>;
  /** The photo behind a segmentation, to cut templates and prototypes from. */
  photoOf: (run: EvidenceRun) => Promise<Buffer | null>;
  appearance: () => Promise<Appearance | null>;
  /** Frames for a camera; tests pass their own. */
  source?: (camera: WatchCamera | null) => FrameSource;
  /** The URL to read a camera from: a saved camera's is kept apart, with its credentials. Null when it's gone. */
  cameraUrl?: (camera: WatchCamera) => string | null;
  /** The zoomed view a camera's frames are cut to, or null for the whole frame. */
  cameraCrop?: (camera: WatchCamera) => CameraCrop | null;
  now?: () => number;
}

const WHOLE: UnitBox = { x: 0, y: 0, width: 1, height: 1 };
/** How long a close look's finding stands in for another before a zone judgement, ms. */
const CLOSE_FRESH_MS = 3000;
/** The smallest box holding all of these. */
function unionOf(boxes: UnitBox[]): UnitBox {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}
const alike = (a: WatchThing, b: WatchThing) =>
  a.subject.concept.trim().toLowerCase() === b.subject.concept.trim().toLowerCase();

/**
 * The server watching one mode's camera. Every confirmed thing is followed
 * frame by frame, on this machine. A thing that settles across a zone's
 * edge has its zones judged where it is followed (`placeLocally`). A lost
 * thing is looked for by appearance, every lost one in one embedding; when
 * that fails, tracking that may call AI asks SAM, once per concept for every
 * thing of it that needs one, and the answer goes through the same track
 * paths as the lab's buttons. Without AI it is looked for over the whole
 * frame instead, and marked missing when that fails too.
 */
/** How often a live camera's view is checked against its calibration frame. */
const CAMERA_CHECK_MS = 10_000;
/** How many checks in a row must disagree with what desk memory says before it changes. */
const CAMERA_CHECKS = 3;
export class Watcher {
  private source: FrameSource | null = null;
  private things = new Map<string, WatchThing>();
  /** The sighting each thing was last seeded from, so a person's new confirmation reseeds it. */
  private seededFrom = new Map<string, string>();
  /** Things last seeded from a whole drawn box, not an outline: learned with their background. */
  private boxOnly = new Set<string>();
  private prototypes = new Map<string, Float32Array[]>();
  /** Each thing's own patches up close, from the same sightings: what a candidate place is checked against. */
  private templates = new Map<string, PatchTemplate[]>();
  /** Where a close look last found each thing, and when. */
  private closeSeen = new Map<string, { box: UnitBox; at: number }>();
  private listeners = new Set<(view: WatchView) => void>();
  private checking = false;
  private pending: { id: string; ask: 'reanchor' }[] = [];
  /** The things SAM or the whole-frame search is looking for now, held still meanwhile. */
  private held = new Set<string>();
  /** Lost things waiting for the next appearance search, done for all of them at once. */
  private refinding = new Set<string>();
  /** Zone judgements, one at a time: each may switch a light. */
  private placing: Promise<void> = Promise.resolve();
  /** Things with a judgement queued or running: one each, judged from where it is then. */
  private judging = new Set<string>();
  private lastFrame: LumaFrame | null = null;
  /** Every zone in desk memory, the main one as `main`, watched for motion. */
  private zones: { id: string; rect: ZoneRect }[] = [];
  /** When pixels last changed in each zone. */
  private motionAt = new Map<string, number>();
  /** Zones some entity asks to be compared with their empty look, and whether SAM may confirm. */
  private occupancyZones = new Map<string, { samConfirm: boolean }>();
  private empty = new Map<string, EmptyLook>();
  private occupancy = new Map<string, ZoneOccupancy>();
  private lastOccupancyCheck = 0;
  private lastCameraCheck = 0;
  /** Camera checks in a row that disagreed with desk memory's `moved`. */
  private cameraDisagrees = 0;
  private lastSam = new Map<string, number>();
  private comparing = false;
  private model: Appearance | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  /** The SAM asks in flight; stopping or restarting the watch aborts them. */
  private asking = new AbortController();
  private stats = { frames: 0, checks: 0, refinds: 0, places: 0 };
  /** How the live camera's frames are arriving, logged when they stop (`bun run runs --streams`). */
  private run: {
    camera: string;
    startedAt: number;
    openMs: number | null;
    firstFrameAt: number;
    lastFrameAt: number;
    maxGapMs: number;
  } | null = null;
  private state: WatchView['state'] = 'off';
  private note = '';
  /** Demo frames arrive one deliberate move at a time, already set down: no settling, no waiting. */
  private pace: { quietSteps?: number; placeGapMs?: number };
  /** Promises of work in flight, so tests can wait for it. */
  readonly busy = new Set<Promise<unknown>>();
  /** Each thing's stats, fed this watcher's frames. */
  readonly statRunner: StatRunner;
  constructor(private deps: WatcherDeps) {
    this.pace = deps.mode === 'demo' ? { quietSteps: 0, placeGapMs: 0 } : {};
    this.statRunner = new StatRunner({
      mode: deps.mode,
      store: deps.store,
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.statRunner.confirm = (concept, region) => this.askSeen(concept, region);
    this.statRunner.subscribe(() => {
      this.emit();
      this.followVariants();
    });
  }
  /** Things with an occupied variant show it while their occupied stat is on (`followOccupied`). */
  private followVariants() {
    const now = this.statRunner.current();
    const occupied = (id: string) => {
      const v = now[id]?.occupied?.value;
      return typeof v === 'boolean' ? v : null;
    };
    const fixtures = this.memory().fixtures ?? [];
    if (followOccupied(fixtures, occupied) === fixtures) return;
    this.deps.store.updateMemory(this.deps.mode, (m) => {
      if (m.fixtures) m.fixtures = followOccupied(m.fixtures, occupied);
    });
  }
  get mode() {
    return this.deps.mode;
  }
  private get now() {
    return this.deps.now?.() ?? Date.now();
  }
  /** Whether tracking may call SAM: off unless someone turned it on in the lab's settings. */
  private get ai() {
    return this.deps.store.trackingAi();
  }
  private memory() {
    return this.deps.store.memory(this.deps.mode);
  }
  view(): WatchView {
    const memory = this.memory();
    const camera = memory.watch?.camera;
    return {
      mode: this.deps.mode,
      on: Boolean(memory.watch?.on),
      state: this.state,
      note: this.note,
      camera: camera ? { id: camera.id, name: camera.name } : null,
      appearance: Boolean(this.model),
      ai: this.ai,
      ...this.stats,
      stats: this.statRunner.current(),
      things: [...this.things.values()].map((t) => ({
        id: t.subject.id,
        kind: t.subject.kind,
        label: t.subject.label,
        status: t.status,
        layer: t.layer,
        box: t.track.box,
        score: Math.round(t.track.score * 100) / 100,
        ...(this.boxOnly.has(t.subject.id) ? { boxOnly: true as const } : {}),
      })),
    };
  }
  /** What entities shown in Home Assistant need: the state, each thing's status, zone motion. */
  exposeWatch(): ExposeWatch {
    return {
      state: this.state,
      things: [...this.things.values()].map((t) => ({ id: t.subject.id, status: t.status })),
      motionAt: Object.fromEntries(this.motionAt),
      on: Boolean(this.memory().watch?.on),
      occupancy: Object.fromEntries(this.occupancy),
      stats: this.statRunner.current(),
    };
  }
  private watchZones(memory: DeskMemory) {
    this.zones = zonesIn(memory).map((z) => ({ id: z.id, rect: z.rect }));
    this.occupancyZones.clear();
    for (const e of memory.exposed ?? [])
      if (e.source.kind === 'occupied') {
        const was = this.occupancyZones.get(e.source.zoneId)?.samConfirm ?? false;
        this.occupancyZones.set(e.source.zoneId, { samConfirm: was || e.source.samConfirm });
      }
    for (const id of this.occupancyZones.keys())
      if (!this.empty.has(id)) {
        const look = this.loadEmpty(id);
        if (look) this.empty.set(id, look);
      }
    for (const id of [...this.occupancy.keys()])
      if (!this.occupancyZones.has(id)) this.occupancy.delete(id);
  }

  private emptyKey(zoneId: string) {
    return `empty:${this.deps.mode}:${zoneId}`;
  }
  private loadEmpty(zoneId: string): EmptyLook | null {
    return readLook(this.deps.store.setting(this.emptyKey(zoneId)));
  }
  /** The zone as the feature model sees it, from a grey frame: patches of just the zone. */
  private async zoneFeatures(frame: LumaFrame, rect: ZoneRect) {
    const png = await sharp(Buffer.from(frame.data), {
      raw: { width: frame.width, height: frame.height, channels: 1 },
    })
      .png()
      .toBuffer();
    return this.model!.embed(png, rect);
  }
  /**
   * Remember how a zone looks now, as how it looks empty: the person says
   * nobody is there. Feature patches when the model is loaded, else grey levels.
   */
  async learnEmpty(zoneId: string): Promise<EmptyLook['method']> {
    const frame = this.lastFrame;
    const zone = this.zones.find((z) => z.id === zoneId);
    if (this.state !== 'watching' && this.state !== 'paused')
      throw new LabError(
        'occupancy_watch',
        'Turn on watching first, so there is a frame to learn from.',
        409,
      );
    if (!frame || !zone) throw new LabError('occupancy_zone', 'That zone isn’t in view.', 409);
    const look: EmptyLook = this.model
      ? { method: 'features', grid: await this.zoneFeatures(frame, zone.rect) }
      : {
          method: 'pixels',
          width: OCCUPANCY.sample.width,
          height: OCCUPANCY.sample.height,
          data: zoneSample(frame, zone.rect),
        };
    this.deps.store.setSetting(this.emptyKey(zoneId), lookText(look));
    this.empty.set(zoneId, look);
    this.occupancy.set(zoneId, {
      occupied: false,
      lastOccupiedAt: null,
      score: 0,
      method: look.method,
      sam: null,
    });
    this.emit(true);
    return look.method;
  }
  /** Compare each zone that has an empty look with how it looks now. */
  private async compareZones(frame: LumaFrame) {
    if (this.comparing) return;
    this.comparing = true;
    try {
      const now = this.now;
      for (const [id, { samConfirm }] of this.occupancyZones) {
        const look = this.empty.get(id);
        const zone = this.zones.find((z) => z.id === id);
        if (!look || !zone) continue;
        // A look learned with the model can't be compared without it.
        if (look.method === 'features' && !this.model) continue;
        const score =
          look.method === 'features'
            ? featureDifference(look.grid, await this.zoneFeatures(frame, zone.rect))
            : pixelDifference(look.data, zoneSample(frame, zone.rect));
        const was = this.occupancy.get(id);
        const occupied = nextOccupied(was?.occupied ?? false, score);
        const next: ZoneOccupancy = {
          occupied,
          lastOccupiedAt: occupied ? now : (was?.lastOccupiedAt ?? null),
          score,
          method: look.method,
          // A clear zone forgets SAM's answer; the next time it looks occupied, SAM is asked again.
          sam: occupied ? (was?.sam ?? null) : null,
        };
        this.occupancy.set(id, next);
        const due = now - (this.lastSam.get(id) ?? 0) >= OCCUPANCY.samGapMs;
        if (samConfirm && this.ai && occupied && next.sam !== 'yes' && due) {
          this.lastSam.set(id, now);
          void this.track(
            this.askSeen('person', zone.rect).then((answer) => {
              const current = this.occupancy.get(id);
              if (current?.occupied) this.occupancy.set(id, { ...current, sam: answer });
              this.emit(true);
            }),
          );
        }
      }
      this.emit();
    } catch {
      // The next comparison tries again.
    } finally {
      this.comparing = false;
    }
  }
  /** Opted in per entity or stat, billed: one SAM call asking whether `concept` is in the region. */
  private async askSeen(concept: string, rect: ZoneRect): Promise<'yes' | 'no' | 'error'> {
    try {
      const shot = await this.source!.snapshot();
      const run = await this.deps.segment(
        this.deps.mode,
        concept,
        this.source instanceof DemoSource
          ? { demoPosition: this.source.position }
          : { png: shot.png },
        this.asking.signal,
      );
      const { frame, detections } = run.output;
      return detections.some((d) => {
        const b = d.box;
        const x = b.x / frame.width;
        const y = b.y / frame.height;
        return (
          x < rect.x + rect.width &&
          x + b.width / frame.width > rect.x &&
          y < rect.y + rect.height &&
          y + b.height / frame.height > rect.y
        );
      })
        ? 'yes'
        : 'no';
    } catch {
      return 'error';
    }
  }
  subscribe(listener: (view: WatchView) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Tell the lab, at most once a frame (10 a second) while frames stream in. */
  private emit(now = false) {
    if (now) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      if (!this.listeners.size) return;
      const view = this.view();
      for (const l of this.listeners) l(view);
      return;
    }
    if (!this.listeners.size) return;
    this.emitTimer ??= setTimeout(() => this.emit(true), 1000 / LUMA_FPS);
  }
  private say(state: WatchView['state'], note: string) {
    this.state = state;
    this.note = note;
    this.emit(true);
  }
  private track<T>(work: Promise<T>) {
    this.busy.add(work);
    void work.finally(() => this.busy.delete(work));
    return work;
  }
  /** Wait until no check, refind or start is running. */
  async idle() {
    while (this.busy.size) await Promise.allSettled([...this.busy]);
  }

  /** Start watching with the camera in desk memory; the lab turned it on, or the server restarted. */
  start() {
    return this.track(this.begin());
  }
  private async begin() {
    this.noteRun('restarted');
    const generation = ++this.generation;
    this.asking.abort();
    this.asking = new AbortController();
    this.source?.stop();
    this.things.clear();
    this.pending = [];
    this.held.clear();
    this.refinding.clear();
    this.stats = { frames: 0, checks: 0, refinds: 0, places: 0 };
    this.say('starting', 'Starting…');
    const memory = this.memory();
    this.watchZones(memory);
    this.motionAt.clear();
    const camera = memory.watch?.camera ?? null;
    if (this.deps.mode === 'live' && !camera)
      return this.say('camera_lost', 'Choose a camera the server can read (RTSP) to watch.');
    const url = camera && (this.deps.cameraUrl ? this.deps.cameraUrl(camera) : camera.url);
    if (this.deps.mode === 'live' && !url)
      return this.say(
        'camera_lost',
        `${camera!.name} was removed. Choose another camera to watch.`,
      );
    this.model ??= await this.deps.appearance();
    this.statRunner.embed = this.model ? (frame, rect) => this.zoneFeatures(frame, rect) : null;
    const source =
      this.deps.source?.(camera) ??
      (this.deps.mode === 'demo'
        ? new DemoSource()
        : new FfmpegSource(url!, 'ffmpeg', this.deps.cameraCrop?.(camera!) ?? null));
    this.source = source;
    // Each thing is followed from the photo SAM last saw it in: the camera is fixed.
    for (const seen of watchedThings(memory)) await this.seed(seen, memory);
    if (generation !== this.generation) return;
    const run = (this.run = {
      camera: camera?.id ?? this.deps.mode,
      startedAt: this.now,
      openMs: null as number | null,
      firstFrameAt: 0,
      lastFrameAt: 0,
      maxGapMs: 0,
    });
    try {
      await source.start(
        (frame) => this.frame(frame),
        (error) => {
          if (generation !== this.generation) return;
          this.noteRun('lost');
          this.say(
            'camera_lost',
            `${error?.message ?? 'The camera stopped.'} Trying again shortly.`,
          );
          setTimeout(() => {
            if (generation === this.generation && this.memory().watch?.on) void this.start();
          }, 5000);
        },
      );
    } catch (error) {
      if (generation !== this.generation) return;
      return this.say(
        'camera_lost',
        error instanceof Error ? error.message : 'The camera could not be opened.',
      );
    }
    if (generation !== this.generation) return;
    run.openMs = this.now - run.startedAt;
    this.statRunner.setWatching(true);
    this.statRunner.sync(memory);
    this.say('watching', this.watchingNote(memory));
  }
  private watchingNote(memory: DeskMemory) {
    const count = this.things.size;
    return count
      ? `Watching ${count} thing${count === 1 ? '' : 's'}${this.ai ? '' : ', on this machine only'}.${memory.fixedCamera ? '' : ' Mark the camera fixed so zones carry over to new frames.'}`
      : 'Watching, but nothing is confirmed yet: confirm the mug or an object first.';
  }
  /**
   * Catch up with desk memory after a person changed it: things confirmed or
   * forgotten, new sightings, zones drawn or moved. Things that didn't change
   * keep their tracks.
   */
  sync() {
    if (this.state !== 'watching' && this.state !== 'paused') return;
    return this.track(
      (async () => {
        const memory = this.memory();
        this.watchZones(memory);
        this.statRunner.sync(memory);
        const seen = watchedThings(memory);
        const ids = new Set(seen.map((x) => x.observation.objectId));
        for (const id of [...this.things.keys()]) if (!ids.has(id)) this.things.delete(id);
        for (const x of seen) {
          const id = x.observation.objectId;
          const current = this.things.get(id);
          if (!current || this.seededFrom.get(id) !== x.observation.id) await this.seed(x, memory);
          else this.things.set(id, { ...current, subject: this.subjectOf(x, memory) });
        }
        // The count it started with is stale once things are confirmed or forgotten.
        if (this.note.startsWith('Watching')) this.note = this.watchingNote(memory);
        this.emit(true);
      })(),
    );
  }
  stop() {
    this.noteRun('stopped');
    this.generation++;
    this.asking.abort();
    this.asking = new AbortController();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.source?.stop();
    this.source = null;
    this.things.clear();
    this.boxOnly.clear();
    this.closeSeen.clear();
    this.motionAt.clear();
    this.occupancy.clear();
    this.pending = [];
    this.held.clear();
    this.refinding.clear();
    this.statRunner.setWatching(false);
    this.statRunner.flush();
    this.say('off', '');
  }
  /** The demo camera: the mug was moved. */
  async showDemo(position: DemoPosition) {
    if (!(this.source instanceof DemoSource)) return;
    // Enough frames of it standing there for a crossing or a loss to count.
    await this.source.show(position, 4);
  }

  /** The thing's subject, from desk memory as it is now. */
  private subjectOf(seen: Seen, memory: DeskMemory): WatchSubject {
    return {
      id: seen.observation.objectId,
      kind: seen.kind,
      label: seen.label,
      concept: seen.concept,
      zones: zonesOf(memory, seen.observation.objectId),
    };
  }
  /** A fresh local track from a SAM sighting, on the picture SAM saw, and a prototype from its mask. */
  private async seed(seen: Seen, memory: DeskMemory, picture?: Buffer, keep?: WatchThing) {
    const run = this.deps.store.getRun(seen.observation.segmentRunId);
    const photo = picture ?? (run ? await this.deps.photoOf(run) : null);
    const detection = runOutput(run, 'segment')?.detections.find(
      (d) => d.objectId === seen.observation.detectionId,
    );
    const subject = this.subjectOf(seen, memory);
    if (!photo) return;
    const height = this.lastFrame?.height;
    const luma = await lumaOf(photo, height);
    const mask =
      detection &&
      maskBits(detection, seen.observation.frame, luma.width / seen.observation.frame.width);
    const fits = mask && mask.width === luma.width && mask.height === luma.height;
    const track = startLocalTrack(
      luma,
      unit(seen.observation),
      subject.zones.length > 0,
      fits ? mask.data : undefined,
    );
    if (!track) return;
    // A fresh start has asked SAM nothing yet, so a lost thing can be looked for at once.
    this.seededFrom.set(subject.id, seen.observation.id);
    if (detection?.boxOnly) this.boxOnly.add(subject.id);
    else this.boxOnly.delete(subject.id);
    const next = watchThing(subject, track, keep?.lastAsk ?? 0);
    const fixture = memory.fixtures?.find((f) => f.id === subject.id);
    this.things.set(subject.id, {
      ...next,
      ...(keep ? { reanchorGap: keep.reanchorGap } : {}),
      status: fixture?.track?.status === 'missing' && !picture ? 'missing' : 'following',
    });
    if (this.model && detection)
      void this.track(this.learn(subject.id, photo, detection, seen.observation.frame));
  }
  /** Add a prototype of how the thing looks, and its close template, from SAM's mask on its photo. */
  private async learn(
    id: string,
    photo: Buffer,
    detection: Segmentation['detections'][number],
    frame: Segmentation['frame'],
  ) {
    const box = {
      x: detection.box.x / frame.width,
      y: detection.box.y / frame.height,
      width: detection.box.width / frame.width,
      height: detection.box.height / frame.height,
    };
    const bits = maskBits(detection, frame, 1);
    try {
      // A square around the thing, so a small one still spans a few patches.
      const region = appearanceRegion(box, frame);
      const grid = await this.model!.embed(photo, region);
      const mask = cropMask(bits, region);
      const proto = prototypeOf(grid, patchWeights(mask, grid.cols, grid.rows));
      if (!proto) return;
      this.prototypes.set(
        id,
        [proto, ...(this.prototypes.get(id) ?? [])].slice(0, APPEARANCE.maxPrototypes),
      );
      const near = closeRegion(box, frame);
      const close = await this.model!.embed(photo, near, APPEARANCE.side);
      const template = patchTemplate(close, near, box, cropMask(bits, near));
      if (template)
        this.templates.set(
          id,
          [template, ...(this.templates.get(id) ?? [])].slice(0, APPEARANCE.maxPrototypes),
        );
    } catch {
      // Without a prototype, a lost thing goes straight to SAM or the whole-frame search.
    }
  }

  /**
   * Logs how the live camera's frames came: how long the source took to open
   * and to give a first frame, the rate, and the longest gap. Demo frames are
   * made here, so they say nothing about streaming.
   */
  private noteRun(outcome: 'stopped' | 'lost' | 'restarted') {
    const run = this.run;
    this.run = null;
    if (!run || this.deps.mode !== 'live') return;
    const frames = this.stats.frames;
    const span = run.lastFrameAt - run.firstFrameAt;
    this.deps.store.appendStreamStats({
      source: 'watcher',
      camera: run.camera,
      outcome,
      openMs: run.openMs,
      firstFrameMs: run.firstFrameAt ? run.firstFrameAt - run.startedAt : null,
      durationMs: this.now - run.startedAt,
      frames,
      fps: frames > 1 && span > 0 ? Math.round(((frames - 1) * 10_000) / span) / 10 : null,
      maxGapMs: run.maxGapMs,
    });
  }
  private frame(frame: LumaFrame) {
    const previous = this.lastFrame;
    this.lastFrame = frame;
    this.stats.frames++;
    const now = this.now;
    const run = this.run;
    if (run) {
      if (run.firstFrameAt) run.maxGapMs = Math.max(run.maxGapMs, now - run.lastFrameAt);
      else run.firstFrameAt = now;
      run.lastFrameAt = now;
    }
    // Motion in each zone, by the same rule as the stillness gate; it decides nothing here.
    if (previous)
      for (const z of this.zones)
        if (frameMotion(previous, frame, z.rect) > LOCAL_TRACK.motionShare)
          this.motionAt.set(z.id, now);
    // Together, so no two things settle on one place. Things being looked for hold still meanwhile.
    for (const [id, step] of watchFrame(
      [...this.things.values()],
      frame,
      now,
      this.pace,
      this.held,
    )) {
      this.found(this.things.get(id), step.thing);
      this.things.set(id, step.thing);
      if (step.refind) this.refind(id);
      if (step.place) this.place(id);
      if (step.ask && !this.pending.some((p) => p.id === id))
        this.pending.push({ id, ask: step.ask });
    }
    if (this.pending.length && !this.checking) void this.track(this.check());
    this.statRunner.frame(
      frame,
      this.things,
      now,
      this.pace.quietSteps ?? WATCH.quietSteps,
      this.deps.mode === 'demo',
    );
    // Demo frames come one deliberate move at a time, so each is compared.
    const every = this.deps.mode === 'demo' ? 0 : OCCUPANCY.everyMs;
    if (now - this.lastCameraCheck >= CAMERA_CHECK_MS) {
      this.lastCameraCheck = now;
      this.checkCamera(frame);
    }
    if (this.occupancyZones.size && now - this.lastOccupancyCheck >= every) {
      this.lastOccupancyCheck = now;
      void this.track(this.compareZones(frame));
    }
    this.emit();
  }
  /**
   * Whether the camera moved since it was calibrated. Once it has, zones no
   * longer line up, so every rule is blocked until it is calibrated again or
   * its view lines up with the calibration frame again. Either takes
   * `CAMERA_CHECKS` checks in a row agreeing: one odd frame (the stream
   * opening, a light switched, someone close to the lens) neither blocks the
   * rules nor frees them.
   */
  private checkCamera(frame: LumaFrame) {
    const calibration = this.deps.store.memory(this.deps.mode).camera;
    if (!calibration?.reference) return;
    const moved = cameraMoved(calibration.reference, cameraEdges(frame)).moved;
    if (moved === Boolean(calibration.moved)) return void (this.cameraDisagrees = 0);
    if (++this.cameraDisagrees < CAMERA_CHECKS) return;
    this.cameraDisagrees = 0;
    this.deps.store.updateMemory(this.deps.mode, (memory) => {
      if (!memory.camera?.reference) return;
      if (moved) memory.camera = { ...memory.camera, moved: true };
      else Object.assign(memory, cameraKept(memory, memory.camera.reference));
    });
    this.statRunner.sync();
    this.emit(true);
  }
  /** Look for a lost thing by appearance, with every other one lost by then: one embedding. */
  private refind(id: string) {
    if (this.refinding.size) return void this.refinding.add(id);
    this.refinding.add(id);
    void this.track(
      Promise.resolve().then(async () => {
        const ids = [...this.refinding];
        this.refinding.clear();
        await this.lookByAppearance(ids, false);
      }),
    );
  }
  /**
   * A close look at `box` in `shot`: how like the thing it is there (its best
   * template), and its box lined up with that template, finer than the box given.
   */
  private async closeLook(
    shot: { png: Buffer; width: number; height: number },
    box: UnitBox,
    templates: PatchTemplate[],
  ) {
    const near = closeRegion(box, shot);
    const close = await this.model!.embed(shot.png, near, APPEARANCE.side);
    const fits = templates.map((t) => closeFit(t, close, near, box));
    return fits.reduce((a, b) => (b.score > a.score ? b : a));
  }
  /**
   * Look for lost things by how they look: around where each was last
   * (`searchRegion`), all in one embedding of the region holding them, or the
   * whole frame (`whole`, when nothing else may look). Followed things' boxes
   * are left out, and lost look-alikes are each other's rivals; two that
   * settle on one place both stay lost. Returns the ids found.
   */
  private async lookByAppearance(ids: string[], whole: boolean): Promise<Set<string>> {
    const found = new Set<string>();
    const model = this.model;
    if (!model || !this.source) return found;
    try {
      const shot = await this.source.snapshot();
      const wanted = ids.flatMap((id) => {
        const thing = this.things.get(id);
        const protos = this.prototypes.get(id);
        return thing && protos?.length ? [{ id, thing, protos }] : [];
      });
      if (!wanted.length) return found;
      const searches = wanted.map((w) => searchRegion(w.thing.track.box, shot));
      const one = !whole && searches.length === 1 ? searches[0]! : null;
      const region = one?.region ?? (whole ? WHOLE : unionOf(searches.map((r) => r.region)));
      // Several at once, or the whole frame: at the largest side the search embeds at.
      const side = one?.side ?? 2 * APPEARANCE.side;
      const grid = await model.embed(shot.png, region, side);
      const followed = [...this.things.values()]
        .filter((t) => t.status === 'following' || t.status === 'entangled')
        .map((t) => intoRegion(t.track.box, region));
      const matches: { id: string; box: UnitBox | null }[] = [];
      for (const w of wanted) {
        const size = intoRegion(w.thing.track.box, region);
        const templates = this.templates.get(w.id);
        if (templates?.length) {
          // The wide search's best few places, each looked at closely against the thing's own patches.
          const scored = [];
          // Each at the thing's own size: the wide search's windows are whole patches.
          const { width, height } = w.thing.track.box;
          for (const place of candidatePlaces(grid, w.protos, size, followed))
            scored.push(
              await this.closeLook(
                shot,
                { ...outOfRegion(place, region), width, height },
                templates,
              ),
            );
          const match = closeMatch(scored);
          matches.push({ id: w.id, box: closeSure(match) ? match.box : null });
          continue;
        }
        const match = findByAppearance(grid, w.protos, size, {
          exclude: followed,
          rivals: wanted.filter((o) => o !== w && alike(o.thing, w.thing)).flatMap((o) => o.protos),
        });
        matches.push({
          id: w.id,
          box: appearanceSure(match) ? outOfRegion(match.box, region) : null,
        });
      }
      // The grey frame of the still it was found in, not the newest: picked up meanwhile, the
      // newest would give it a template of the empty desk, matched perfectly from then on.
      const seen = matches.some((m) => m.box)
        ? await lumaOf(shot.png, this.lastFrame?.height)
        : undefined;
      for (const { id, box } of matches) {
        if (!box) continue;
        const clash = matches.some(
          (o) => o.id !== id && o.box && boxIoU(o.box, box) >= LOCAL_TRACK.claimIoU,
        );
        const thing = this.things.get(id);
        if (clash || !thing) continue;
        const next = refound(thing, box, seen);
        this.found(thing, next);
        this.things.set(id, next);
        this.closeSeen.set(id, { box, at: this.now });
        found.add(id);
      }
      this.stats.refinds += found.size;
      if (found.size) this.emit(true);
    } catch {
      // Whatever it didn't find goes on to SAM or the whole-frame search.
    }
    return found;
  }
  /**
   * Look for the things that need more than the local match, a batch at a
   * time: by SAM when tracking may call it, once per concept, else over the
   * whole frame on this machine.
   */
  private async check() {
    if (this.checking) return;
    this.checking = true;
    const generation = this.generation;
    try {
      while (this.pending.length && generation === this.generation) {
        const first = this.things.get(this.pending[0]!.id);
        const batch = this.pending.filter((p) => {
          const t = this.things.get(p.id);
          return t && first && (!this.ai || alike(t, first));
        });
        const things = batch.map((p) => this.things.get(p.id)!);
        for (const t of things) this.held.add(t.subject.id);
        try {
          if (!things.length) this.pending.shift();
          else if (this.ai) await this.ask(things);
          else await this.relocate(things);
        } finally {
          for (const t of things) this.held.delete(t.subject.id);
        }
        this.pending = this.pending.filter((p) => !batch.includes(p));
      }
    } finally {
      this.checking = false;
    }
  }
  /** Without AI: look over the whole frame by appearance; what isn't found counts a miss. */
  private async relocate(things: WatchThing[]) {
    for (const t of things) this.things.set(t.subject.id, asked(t, 'reanchor', this.now));
    const found = await this.lookByAppearance(
      things.map((t) => t.subject.id),
      true,
    );
    const lost = things.filter((t) => !found.has(t.subject.id));
    for (const t of lost) this.miss(t, 'Nothing on this machine');
    if (found.size && !lost.length)
      this.say(this.state, `Found again by how it looks (${things[0]!.subject.label}).`);
  }
  /** Nothing found it: a miss, and after enough of them it is missing. */
  private miss(thing: WatchThing, who: string) {
    const id = thing.subject.id;
    const next = missed(this.things.get(id) ?? thing);
    this.things.set(id, next);
    if (next.status === 'missing' && thing.subject.kind === 'fixture')
      this.deps.tracking.loseFixture(this.deps.mode, id);
    this.say(
      this.state,
      next.status === 'missing'
        ? `${who} can find the ${thing.subject.label}. Marked missing until something moves where it was, or it shows up elsewhere.`
        : `${who} can see the ${thing.subject.label} either. Looking again later.`,
    );
  }
  /**
   * Followed again with no SAM call (its old place matched, or it was found by
   * how it looks): a fixture the room drew as missing is seen again. Only SAM
   * moves it in the room, so it stays where SAM last saw it.
   */
  private found(before: WatchThing | undefined, after: WatchThing) {
    if (after.subject.kind !== 'fixture' || after.status !== 'following') return;
    if (before?.status === 'following') return;
    this.deps.tracking.findFixture(this.deps.mode, after.subject.id);
  }
  /** Judge a thing's zones where it is followed now, after any judgement still running. */
  private place(id: string) {
    if (this.judging.has(id)) return;
    this.judging.add(id);
    const generation = this.generation;
    this.placing = this.placing
      .then(() => (generation === this.generation ? this.judge(id) : undefined))
      .finally(() => this.judging.delete(id));
    void this.track(this.placing);
  }
  /**
   * Where a thing about to have its zones judged really stands: its followed
   * box, lined up by a close look with its own patches when the feature model
   * has them. Null when that look says it isn't there (the grey match drifted
   * onto the desk): it counts as lost, and is looked for again.
   */
  private async closeCheck(id: string, thing: WatchThing): Promise<UnitBox | null> {
    const templates = this.templates.get(id);
    if (!this.model || !this.source || !templates?.length) return thing.track.box;
    // Just found there by a close look: no second one.
    const seen = this.closeSeen.get(id);
    if (seen && this.now - seen.at < CLOSE_FRESH_MS && boxIoU(seen.box, thing.track.box) >= 0.8)
      return thing.track.box;
    const shot = await this.source.snapshot();
    const look = await this.closeLook(shot, thing.track.box, templates);
    if (look.score >= APPEARANCE.closeMinScore) {
      this.closeSeen.set(id, { box: look.box, at: this.now });
      const now = this.things.get(id);
      if (now) this.things.set(id, { ...now, track: { ...now.track, box: look.box } });
      return look.box;
    }
    const now = this.things.get(id);
    if (now)
      this.things.set(id, {
        ...now,
        status: 'unsure',
        crossingSteps: 0,
        track: { ...now.track, lostSteps: WATCH.lostSteps },
      });
    this.refind(id);
    return null;
  }
  private async judge(id: string) {
    const thing = this.things.get(id);
    if (!thing) return;
    const { mode, tracking } = this.deps;
    const start = this.now;
    try {
      const box = await this.closeCheck(id, thing);
      if (!box) return;
      const { memory, event, rules } = await tracking.placeLocally(mode, id, box);
      const decisions = [...(event ? [event] : []), ...rules].map((e) => e.output);
      const blocked = decisions.every((d) => d.decision === 'blocked');
      this.stats.places++;
      this.watchZones(memory);
      for (const [other, t] of this.things)
        this.things.set(other, {
          ...(other === id ? placed(t, this.now, blocked) : t),
          subject: { ...t.subject, zones: zonesOf(memory, other) },
        });
      // How long from first showing across the edge to the lights being switched.
      if (decisions.some((d) => d.transition === 'entered' || d.transition === 'left'))
        console.info(
          `[watch ${mode}] ${new Date().toISOString()} ${thing.subject.label}: across the edge ${
            thing.crossedAt === null ? '?' : start - thing.crossedAt
          } ms before it was judged, judged and switched in ${this.now - start} ms; no SAM call`,
        );
      if (blocked && decisions[0])
        this.say(this.state, `The ${thing.subject.label}'s zones: ${decisions[0].reason}`);
    } catch (error) {
      // A check by hand running, or the thing just forgotten: the next settled frame tries again.
      this.say(
        this.state,
        `The ${thing.subject.label}'s zones couldn’t be judged: ${safeError(error).message}`,
      );
    }
  }
  /**
   * One SAM call for things of one concept, on one snapshot, each followed
   * into it through the lab's own track path, which assigns its detections to
   * every look-alike at once. A thing whose pick barely beats the other way
   * round is entangled with its nearest look-alike rather than trusted.
   */
  private async ask(things: WatchThing[]) {
    const { mode, tracking } = this.deps;
    const first = things[0]!;
    for (const t of things) this.things.set(t.subject.id, asked(t, 'reanchor', this.now));
    let picture: Buffer;
    let run: EvidenceRun<Segmentation>;
    try {
      const shot = await this.source!.snapshot();
      picture = shot.png;
      run = await this.deps.segment(
        mode,
        first.subject.concept,
        this.source instanceof DemoSource
          ? { demoPosition: this.source.position }
          : { png: picture },
        this.asking.signal,
      );
    } catch (error) {
      const safe = safeError(error);
      if (['spend_limit', 'meta_not_ready'].includes(safe.code))
        return this.say(
          'paused',
          `${safe.message} Following and local zone judgements go on; a lost thing waits until SAM can be asked.`,
        );
      return this.say(
        this.state,
        `SAM couldn’t be asked about the ${first.subject.label}: ${safe.message}`,
      );
    }
    for (const thing of things) {
      const id = thing.subject.id;
      try {
        if (!run.output.detections.length)
          throw new LabError(
            'track_lost',
            `SAM found no ${thing.subject.concept} in this frame.`,
            409,
          );
        const result =
          thing.subject.kind === 'mug'
            ? await tracking.trackMug(mode, run.id)
            : thing.subject.kind === 'object'
              ? await tracking.trackObject(mode, id, run.id)
              : await tracking.trackFixture(mode, id, run.id);
        const memory = result.memory;
        this.stats.checks++;
        this.watchZones(memory);
        const seen = watchedThings(memory).find((s) => s.observation.objectId === id);
        const before = this.things.get(id) ?? thing;
        if (seen) await this.seed(seen, memory, picture, before);
        // Other things' zone verdicts may have changed with it.
        for (const [other, t] of this.things)
          if (other !== id)
            this.things.set(other, {
              ...t,
              subject: { ...t.subject, zones: zonesOf(memory, other) },
            });
        if (result.margin < MULTI.minMargin) this.entangleNearest(id);
        if (this.state === 'paused') this.state = 'watching';
        this.say(this.state, `Found again with SAM (${thing.subject.label}).`);
      } catch (error) {
        const safe = safeError(error);
        if (safe.code === 'track_lost') this.miss(thing, 'SAM can’t');
        else
          this.say(this.state, `The ${thing.subject.label} couldn’t be checked: ${safe.message}`);
      }
    }
  }
  /** SAM's pick for it was about as good either way: it and its nearest look-alike wait to be told apart. */
  private entangleNearest(id: string) {
    const thing = this.things.get(id);
    if (!thing) return;
    const centre = (b: UnitBox) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    const c = centre(thing.track.box);
    const other = [...this.things.values()]
      .filter((t) => t !== thing && t.status !== 'missing' && alike(t, thing))
      .sort((a, b) => {
        const [p, q] = [centre(a.track.box), centre(b.track.box)];
        return Math.hypot(p.x - c.x, p.y - c.y) - Math.hypot(q.x - c.x, q.y - c.y);
      })[0];
    if (!other) return;
    this.things.set(id, { ...thing, status: 'entangled', partner: other.subject.id });
    this.things.set(other.subject.id, {
      ...other,
      status: 'entangled',
      partner: id,
    });
  }
}

/** Turn watching on or off with a camera already chosen, kept in desk memory. */
export async function setWatching(
  store: EvidenceStore,
  watcher: Watcher,
  on: boolean,
  camera = store.memory(watcher.mode).watch?.camera ?? null,
) {
  const memory = store.memory(watcher.mode);
  if (on && watcher.mode === 'live' && !camera)
    throw new LabError('watch_camera', 'Choose a network camera to watch.', 409);
  memory.watch = { on, camera };
  store.saveMemory(memory);
  if (on) await watcher.start();
  else watcher.stop();
  return watcher.view();
}

/**
 * The watchers' routes: the view and its event stream, turning watching on
 * or off with a camera the server can read, and the demo's moves.
 */
export async function watchRoutes(
  app: FastifyInstance,
  watchers: Record<Mode, Watcher>,
  {
    store,
    streams,
    saved = () => null,
    expose,
    ha,
  }: {
    store: EvidenceStore;
    streams: () => Promise<NetworkStream[]>;
    /** A saved camera by its stream id, as desk memory keeps it. */
    saved?: (streamId: string) => WatchCamera | null;
    /** What the mode shows in Home Assistant, sent on the same stream. */
    expose?: (mode: Mode) => {
      view(): ExposeView;
      subscribe(listener: (view: ExposeView) => void): () => void;
    };
    /** The devices' states in Home Assistant, in live mode, sent on the same stream. */
    ha?: (mode: Mode) =>
      | {
          view(): HaView;
          subscribe(listener: (view: HaView) => void): () => void;
        }
      | undefined;
  },
) {
  app.get('/:mode', async (request) => {
    const { mode } = parseInput(modeOnlySchema, request.params);
    return watchers[mode].view();
  });
  /**
   * The watcher's view (`watch` events), what the mode shows in Home
   * Assistant (`expose` events) and, live, its devices' states there (`ha`
   * events) on one stream: a tab holds one connection for all, of the six a
   * browser opens to a host. Each is sent as it is on connecting, so a reload
   * starts from the states as they are.
   */
  app.get('/:mode/events', (request, reply) => {
    const { mode } = parseInput(modeOnlySchema, request.params);
    const watcher = watchers[mode];
    const exposer = expose?.(mode);
    const devices = ha?.(mode);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (event: 'watch' | 'expose' | 'ha') => (view: WatchView | ExposeView | HaView) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(view)}\n\n`);
    send('watch')(watcher.view());
    if (exposer) send('expose')(exposer.view());
    if (devices) send('ha')(devices.view());
    const offs = [
      watcher.subscribe(send('watch')),
      exposer?.subscribe(send('expose')),
      devices?.subscribe(send('ha')),
    ];
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    request.raw.on('close', () => {
      for (const off of offs) off?.();
      clearInterval(ping);
    });
  });
  app.post('', async (request) => {
    const { mode, on, streamId } = parseInput(watchBodySchema, request.body);
    const memory = store.memory(mode);
    let camera = memory.watch?.camera ?? null;
    if (on && mode === 'live') {
      // Only a camera the lab found, saved or was configured with, never a URL in this request.
      const stream = streamId ? (await streams()).find((s) => s.id === streamId) : undefined;
      if (streamId && !stream)
        throw new LabError('watch_camera', 'That camera isn’t on the network any more.', 409);
      if (stream && !stream.rtsp)
        throw new LabError(
          'watch_camera',
          'The server can only watch a camera that offers RTSP, such as one shared with scripts/share-camera.sh or added by its stream URL. This one can be followed in the tab.',
          409,
        );
      if (stream)
        camera = saved(stream.id) ?? { id: stream.id, name: stream.name, url: stream.rtsp! };
      if (!camera) throw new LabError('watch_camera', 'Choose a network camera to watch.', 409);
    }
    return setWatching(store, watchers[mode], on, camera);
  });
  app.post('/demo', async (request) => {
    const { position } = parseInput(watchDemoBodySchema, request.body);
    await watchers.demo.showDemo(position);
    return { position, label: DEMO_POSITIONS[position].label };
  });
}
