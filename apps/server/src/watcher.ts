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
  cameraMoved,
  cropMask,
  findByAppearance,
  intoRegion,
  outOfRegion,
  searchRegion,
  frameMotion,
  maskBits,
  missed,
  patchWeights,
  prototypeOf,
  refound,
  startLocalTrack,
  watchStep,
  watchThing,
  zonesIn,
  featureDifference,
  nextOccupied,
  pixelDifference,
  zoneSample,
  OCCUPANCY,
  APPEARANCE,
  LOCAL_TRACK,
  DEMO_POSITIONS,
  type DemoPosition,
  type DeskMemory,
  type DeskObservation,
  type EvidenceRun,
  type EmptyLook,
  type ExposeWatch,
  type ZoneOccupancy,
  type LumaFrame,
  type Mode,
  type Segmentation,
  type UnitBox,
  type WatchCamera,
  type CameraCrop,
  type WatchSubject,
  type WatchThing,
  type WatchKind,
  type WatchView,
  type ZoneRect,
  ruleObjects,
} from '@livinglayer/domain';
import type { Appearance } from './appearance.js';
import type { DeskTracking } from './desk.js';
import { LabError, parseInput, safeError } from './errors.js';
import { DemoSource, FfmpegSource, lumaOf, type FrameSource } from './frames.js';
import type { EvidenceStore } from './store.js';
import type { NetworkStream } from './streams.js';

type Seen = { observation: DeskObservation; kind: WatchKind; label: string; concept: string };

/** Everything the watcher follows in a desk memory, with its last SAM sighting. */
export function watchedThings(memory: DeskMemory): Seen[] {
  const seen: Seen[] = [];
  if (memory.object && memory.observation)
    seen.push({
      observation: memory.observation,
      kind: 'mug',
      label: memory.object.label,
      concept: 'mug',
    });
  for (const o of memory.others ?? [])
    if (o.observation)
      seen.push({ observation: o.observation, kind: 'object', label: o.label, concept: o.concept });
  for (const f of memory.fixtures ?? [])
    if (f.track)
      seen.push({
        observation: f.track.observation,
        kind: 'fixture',
        label: f.label,
        concept: f.track.concept,
      });
  return seen;
}
/** A thing's zones as shares of the frame, each with SAM's last verdict. */
export function zonesOf(memory: DeskMemory, objectId: string): WatchSubject['zones'] {
  const zones: WatchSubject['zones'] = [];
  if (memory.object?.id === objectId && memory.zone)
    zones.push({
      id: memory.zone.id,
      rect: memory.zone.rect,
      inside: memory.placement === 'inside',
    });
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

/**
 * The server watching one mode's camera. Every thing with a SAM sighting is
 * followed frame by frame; SAM is asked one thing at a time, only to confirm
 * a zone crossing or to find a lost thing; its answer goes through the same
 * track paths as the lab's buttons, so rules fire exactly as they do there.
 */
/** How often a live camera's view is checked against its calibration frame. */
const CAMERA_CHECK_MS = 10_000;
export class Watcher {
  private source: FrameSource | null = null;
  private things = new Map<string, WatchThing>();
  /** The sighting each thing was last seeded from, so a person's new confirmation reseeds it. */
  private seededFrom = new Map<string, string>();
  private prototypes = new Map<string, Float32Array[]>();
  private listeners = new Set<(view: WatchView) => void>();
  private checking = false;
  private pending: { id: string; ask: 'confirm' | 'reanchor' }[] = [];
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
  private lastSam = new Map<string, number>();
  private comparing = false;
  private model: Appearance | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  /** The SAM asks in flight; stopping or restarting the watch aborts them. */
  private asking = new AbortController();
  private stats = { frames: 0, checks: 0, refinds: 0 };
  private state: WatchView['state'] = 'off';
  private note = '';
  /** Demo frames arrive one deliberate move at a time, already set down: no settling, no waiting. */
  private pace: { quietSteps?: number; confirmGapMs?: number };
  /** Promises of work in flight, so tests can wait for it. */
  readonly busy = new Set<Promise<unknown>>();
  constructor(private deps: WatcherDeps) {
    this.pace = deps.mode === 'demo' ? { quietSteps: 0, confirmGapMs: 0 } : {};
  }
  get mode() {
    return this.deps.mode;
  }
  private get now() {
    return this.deps.now?.() ?? Date.now();
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
      ...this.stats,
      things: [...this.things.values()].map((t) => ({
        id: t.subject.id,
        kind: t.subject.kind,
        label: t.subject.label,
        status: t.status,
        layer: t.layer,
        box: t.track.box,
        score: Math.round(t.track.score * 100) / 100,
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
    try {
      const raw = this.deps.store.setting(this.emptyKey(zoneId));
      if (!raw) return null;
      const saved = JSON.parse(raw) as {
        method: 'features' | 'pixels';
        cols: number;
        rows: number;
        dim: number;
        width: number;
        height: number;
        data: string;
      };
      const bytes = Buffer.from(saved.data, 'base64');
      return saved.method === 'features'
        ? {
            method: 'features',
            grid: {
              cols: saved.cols,
              rows: saved.rows,
              dim: saved.dim,
              data: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice(),
            },
          }
        : {
            method: 'pixels',
            width: saved.width,
            height: saved.height,
            data: new Uint8Array(bytes),
          };
    } catch {
      return null;
    }
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
    let look: EmptyLook;
    let saved: Record<string, unknown>;
    if (this.model) {
      const grid = await this.zoneFeatures(frame, zone.rect);
      look = { method: 'features', grid };
      saved = {
        method: 'features',
        cols: grid.cols,
        rows: grid.rows,
        dim: grid.dim,
        data: Buffer.from(grid.data.buffer, grid.data.byteOffset, grid.data.byteLength).toString(
          'base64',
        ),
      };
    } else {
      const data = zoneSample(frame, zone.rect);
      look = {
        method: 'pixels',
        width: OCCUPANCY.sample.width,
        height: OCCUPANCY.sample.height,
        data,
      };
      saved = { method: 'pixels', ...OCCUPANCY.sample, data: Buffer.from(data).toString('base64') };
    }
    this.deps.store.setSetting(this.emptyKey(zoneId), JSON.stringify(saved));
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
        if (samConfirm && occupied && next.sam !== 'yes' && due) {
          this.lastSam.set(id, now);
          void this.track(this.askPerson(id, zone.rect));
        }
      }
      this.emit();
    } catch {
      // The next comparison tries again.
    } finally {
      this.comparing = false;
    }
  }
  /** Opted in per entity, billed: one SAM call asking whether a person is in the zone. */
  private async askPerson(zoneId: string, rect: ZoneRect) {
    let answer: ZoneOccupancy['sam'];
    try {
      const shot = await this.source!.snapshot();
      const run = await this.deps.segment(
        this.deps.mode,
        'person',
        this.source instanceof DemoSource
          ? { demoPosition: this.source.position }
          : { png: shot.png },
        this.asking.signal,
      );
      const { frame, detections } = run.output;
      answer = detections.some((d) => {
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
      answer = 'error';
    }
    const current = this.occupancy.get(zoneId);
    if (current?.occupied) this.occupancy.set(zoneId, { ...current, sam: answer });
    this.emit(true);
  }
  subscribe(listener: (view: WatchView) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Tell the lab, at most a few times a second while frames stream in. */
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
    this.emitTimer ??= setTimeout(() => this.emit(true), 200);
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
    const generation = ++this.generation;
    this.asking.abort();
    this.asking = new AbortController();
    this.source?.stop();
    this.things.clear();
    this.pending = [];
    this.stats = { frames: 0, checks: 0, refinds: 0 };
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
    const source =
      this.deps.source?.(camera) ??
      (this.deps.mode === 'demo'
        ? new DemoSource()
        : new FfmpegSource(url!, 'ffmpeg', this.deps.cameraCrop?.(camera!) ?? null));
    this.source = source;
    // Each thing is followed from the photo SAM last saw it in: the camera is fixed.
    for (const seen of watchedThings(memory)) await this.seed(seen, memory);
    if (generation !== this.generation) return;
    try {
      await source.start(
        (frame) => this.frame(frame),
        (error) => {
          if (generation !== this.generation) return;
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
    const count = this.things.size;
    this.say(
      'watching',
      count
        ? `Watching ${count} thing${count === 1 ? '' : 's'}.${memory.fixedCamera ? '' : ' Mark the camera fixed so zones carry over to new frames.'}`
        : 'Watching, but nothing is confirmed yet: confirm the mug or an object first.',
    );
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
        const seen = watchedThings(memory);
        const ids = new Set(seen.map((x) => x.observation.objectId));
        for (const id of [...this.things.keys()]) if (!ids.has(id)) this.things.delete(id);
        for (const x of seen) {
          const id = x.observation.objectId;
          const current = this.things.get(id);
          if (!current || this.seededFrom.get(id) !== x.observation.id) await this.seed(x, memory);
          else this.things.set(id, { ...current, subject: this.subjectOf(x, memory) });
        }
        this.emit(true);
      })(),
    );
  }
  stop() {
    this.generation++;
    this.asking.abort();
    this.asking = new AbortController();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.source?.stop();
    this.source = null;
    this.things.clear();
    this.motionAt.clear();
    this.occupancy.clear();
    this.pending = [];
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
    // A fresh start has asked SAM nothing yet, so a crossing can be confirmed at once.
    this.seededFrom.set(subject.id, seen.observation.id);
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
  /** Add a prototype of how the thing looks, from SAM's mask on its photo. */
  private async learn(
    id: string,
    photo: Buffer,
    detection: Segmentation['detections'][number],
    frame: Segmentation['frame'],
  ) {
    try {
      // A square around the thing, so a small one still spans a few patches.
      const region = appearanceRegion(
        {
          x: detection.box.x / frame.width,
          y: detection.box.y / frame.height,
          width: detection.box.width / frame.width,
          height: detection.box.height / frame.height,
        },
        frame,
      );
      const grid = await this.model!.embed(photo, region);
      const mask = cropMask(maskBits(detection, frame, 1), region);
      const proto = prototypeOf(grid, patchWeights(mask, grid.cols, grid.rows));
      if (!proto) return;
      this.prototypes.set(
        id,
        [proto, ...(this.prototypes.get(id) ?? [])].slice(0, APPEARANCE.maxPrototypes),
      );
    } catch {
      // Without a prototype, a lost thing goes straight to SAM.
    }
  }

  private frame(frame: LumaFrame) {
    const previous = this.lastFrame;
    this.lastFrame = frame;
    this.stats.frames++;
    const now = this.now;
    // Motion in each zone, by the same rule as the stillness gate; it decides nothing here.
    if (previous)
      for (const z of this.zones)
        if (frameMotion(previous, frame, z.rect) > LOCAL_TRACK.motionShare)
          this.motionAt.set(z.id, now);
    for (const [id, thing] of this.things) {
      // A thing being checked holds still until SAM answers.
      if (this.checking && this.pending[0]?.id === id) continue;
      const step = watchStep(thing, frame, now, this.pace);
      this.things.set(id, step.thing);
      if (step.refind) void this.track(this.refind(id));
      if (step.ask && !this.pending.some((p) => p.id === id))
        this.pending.push({ id, ask: step.ask });
    }
    if (this.pending.length && !this.checking) void this.track(this.check());
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
   * longer line up, so every rule is blocked until it is calibrated again.
   */
  private checkCamera(frame: LumaFrame) {
    const calibration = this.deps.store.memory(this.deps.mode).camera;
    if (!calibration?.reference || calibration.moved) return;
    if (!cameraMoved(calibration.reference, cameraEdges(frame)).moved) return;
    this.deps.store.updateMemory(this.deps.mode, (memory) => {
      if (memory.camera) memory.camera = { ...memory.camera, moved: true };
    });
    this.emit(true);
  }
  /** Look for a lost thing by appearance; SAM is asked only if this can't find it. */
  private async refind(id: string) {
    const protos = this.prototypes.get(id);
    if (!this.model || !protos?.length || !this.source) return;
    try {
      const shot = await this.source.snapshot();
      const thing = this.things.get(id);
      if (!thing) return;
      // Looked for around where it was last, at the zoom its prototypes were made at.
      const { region, side } = searchRegion(thing.track.box, shot);
      const grid = await this.model.embed(shot.png, region, side);
      const match = findByAppearance(grid, protos, intoRegion(thing.track.box, region));
      if (!appearanceSure(match)) return;
      this.things.set(id, refound(thing, outOfRegion(match.box, region)));
      this.stats.refinds++;
      this.emit(true);
    } catch {
      // The next loss goes to SAM.
    }
  }
  /** Ask SAM about the things that need it, one at a time. */
  private async check() {
    if (this.checking) return;
    this.checking = true;
    const generation = this.generation;
    try {
      while (this.pending.length && generation === this.generation) {
        const { id, ask } = this.pending[0]!;
        const thing = this.things.get(id);
        if (thing) await this.ask(thing, ask);
        this.pending.shift();
      }
    } finally {
      this.checking = false;
    }
  }
  private async ask(thing: WatchThing, ask: 'confirm' | 'reanchor') {
    const { mode, tracking } = this.deps;
    const id = thing.subject.id;
    this.things.set(id, asked(thing, ask, this.now));
    let picture: Buffer;
    let run: EvidenceRun<Segmentation>;
    try {
      const shot = await this.source!.snapshot();
      picture = shot.png;
      run = await this.deps.segment(
        mode,
        thing.subject.concept,
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
          `${safe.message} Following goes on; no rule can fire until SAM can be asked.`,
        );
      return this.say(
        this.state,
        `SAM couldn’t be asked about the ${thing.subject.label}: ${safe.message}`,
      );
    }
    try {
      if (!run.output.detections.length)
        throw new LabError(
          'track_lost',
          `SAM found no ${thing.subject.concept} in this frame.`,
          409,
        );
      const memory =
        thing.subject.kind === 'mug'
          ? (await tracking.trackMug(mode, run.id)).memory
          : thing.subject.kind === 'object'
            ? (await tracking.trackObject(mode, id, run.id)).memory
            : (await tracking.trackFixture(mode, id, run.id)).memory;
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
      if (this.state === 'paused') this.state = 'watching';
      this.say(
        this.state,
        `${ask === 'confirm' ? 'Zone crossing checked' : 'Found again'} with SAM (${thing.subject.label}).`,
      );
    } catch (error) {
      const safe = safeError(error);
      const current = this.things.get(id) ?? thing;
      if (safe.code === 'track_lost') {
        const next = missed(current);
        this.things.set(id, next);
        if (next.status === 'missing' && thing.subject.kind === 'fixture')
          tracking.loseFixture(mode, id);
        return this.say(
          this.state,
          next.status === 'missing'
            ? `SAM can’t find the ${thing.subject.label}. Marked missing until something moves where it was.`
            : `SAM can’t see the ${thing.subject.label} either. Looking again later.`,
        );
      }
      this.say(this.state, `The ${thing.subject.label} couldn’t be checked: ${safe.message}`);
    }
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
  }: {
    store: EvidenceStore;
    streams: () => Promise<NetworkStream[]>;
    /** A saved camera by its stream id, as desk memory keeps it. */
    saved?: (streamId: string) => WatchCamera | null;
  },
) {
  app.get('/:mode', async (request) => {
    const { mode } = parseInput(modeOnlySchema, request.params);
    return watchers[mode].view();
  });
  app.get('/:mode/events', (request, reply) => {
    const { mode } = parseInput(modeOnlySchema, request.params);
    const watcher = watchers[mode];
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (view: WatchView) => reply.raw.write(`data: ${JSON.stringify(view)}\n\n`);
    send(watcher.view());
    const off = watcher.subscribe(send);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    request.raw.on('close', () => {
      off();
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
