import type { FastifyInstance } from 'fastify';
import {
  STAT_KINDS,
  STATS,
  OCCUPANCY,
  LOCAL_TRACK,
  WATCH,
  activityStep,
  around,
  calibrationOf,
  dayOf,
  featureDifference,
  fixtureEntity,
  fixtureInFrame,
  frameMean,
  frameMotion,
  occupantOf,
  occupiedStep,
  pixelDifference,
  powerLook,
  powerReading,
  quadBox,
  sampleInto,
  sampleQuadInto,
  screenInFrame,
  settle,
  settled,
  usedStep,
  thingsLearnBodySchema,
  thingsUsedBodySchema,
  thingsStatsBodySchema,
  thingStatsQuerySchema,
  type Activity,
  type DeskMemory,
  type EmptyLook,
  type LumaFrame,
  type Mode,
  type PatchGrid,
  type PowerLook,
  type Settled,
  type StatEvent,
  type StatKey,
  type StatLook,
  type UnitQuad,
  type StatNow,
  type StatsNow,
  type ThingStat,
  type ThingStatsView,
  type UnitBox,
  type UseSpot,
  type WatchThing,
} from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import type { EvidenceStore } from './store.js';

/** A thing stats can be kept for: the mug, another object or a fixture. */
interface StatThing {
  id: string;
  label: string;
  /** Where it is in the frame when nobody follows it: its last sighting, or its place seen through the pin. */
  region: UnitBox | null;
  /** A screen's face through the room camera, when nobody follows it: its power is read there alone. */
  screen?: UnitQuad | null;
  /** Its entity's last confirmed state, when it switches one: undefined when it switches none. */
  entity?: boolean | null;
}
/** The mug, the other objects and the fixtures, each with where it stands in the frame. */
function statThings(memory: DeskMemory): StatThing[] {
  const unit = (box: UnitBox, frame: { width: number; height: number }): UnitBox => ({
    x: box.x / frame.width,
    y: box.y / frame.height,
    width: box.width / frame.width,
    height: box.height / frame.height,
  });
  const things: StatThing[] = [];
  const pin = memory.surface ?? null;
  const calibration = calibrationOf(memory);
  for (const f of memory.fixtures ?? []) {
    const seen = f.track?.observation;
    const screen =
      !seen && calibration?.scene === f.scene
        ? screenInFrame(f, memory.scene ?? null, calibration.camera)
        : null;
    const placed = !seen && !screen && pin ? fixtureInFrame(f, pin, memory.scene ?? null) : null;
    const entity = fixtureEntity(f);
    const lit = Object.values(f.lit ?? {});
    things.push({
      id: f.id,
      label: f.label,
      region: seen
        ? unit(seen.box, seen.frame)
        : screen
          ? quadBox(screen)
          : placed && pin
            ? unit(placed, pin.frame)
            : null,
      screen,
      ...(entity || lit.length
        ? {
            entity: lit.some(Boolean)
              ? true
              : f.state === 'on'
                ? true
                : f.state === 'off' || (lit.length && !lit.some(Boolean))
                  ? false
                  : null,
          }
        : {}),
    });
  }
  return things;
}

/** A setting's key for one learned look. */
const lookKey = (mode: Mode, thingId: string, key: StatKey, look: StatLook) =>
  `look:${mode}:${thingId}:${key}:${look}`;
/** An empty look as text for `settings`: feature patches or a grey sample, base64. */
export function lookText(look: EmptyLook): string {
  return JSON.stringify(
    look.method === 'features'
      ? {
          method: 'features',
          cols: look.grid.cols,
          rows: look.grid.rows,
          dim: look.grid.dim,
          data: Buffer.from(
            look.grid.data.buffer,
            look.grid.data.byteOffset,
            look.grid.data.byteLength,
          ).toString('base64'),
        }
      : {
          method: 'pixels',
          width: look.width,
          height: look.height,
          data: Buffer.from(look.data).toString('base64'),
        },
  );
}
/** An empty look read back from `settings`, or null when there is none or it is unreadable. */
export function readLook(raw: string | null): EmptyLook | null {
  if (!raw) return null;
  try {
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
      : { method: 'pixels', width: saved.width, height: saved.height, data: new Uint8Array(bytes) };
  } catch {
    return null;
  }
}

/** One stat switched on for one thing, with its detector's state. */
interface Running {
  thingId: string;
  key: StatKey;
  stat: ThingStat;
  label: string;
  region: UnitBox | null;
  screen?: UnitQuad | null;
  entity?: boolean | null;
  now: StatNow;
  lastRun: number;
  lastCount: number;
  power?: { on: PowerLook | null; off: PowerLook | null; s: Settled<boolean | null> };
  occupied?: {
    empty: EmptyLook | null;
    s: Settled<boolean | null>;
    comparing: boolean;
    asked: number;
    sam: 'yes' | 'no' | 'error' | null;
  };
  activity?: Activity;
  usage?: UseSpot;
}

interface StatRunnerDeps {
  mode: Mode;
  store: EvidenceStore;
  now?: () => number;
}

/**
 * Works out every thing's stats in one mode: fed each of the watcher's grey
 * frames with what it follows, and synced with desk memory for which stats
 * are on and what each entity last did. Each stat runs on its own tick, into
 * buffers kept from one frame to the next; only a change becomes an event,
 * and events and day totals are written together every few seconds.
 */
export class StatRunner {
  private running = new Map<string, Running>();
  private listeners = new Set<() => void>();
  private events: StatEvent[] = [];
  private days = new Map<string, { day: string; thingId: string; key: StatKey; add: number }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrame: LumaFrame | null = null;
  private previous: LumaFrame | null = null;
  /** Where each followed thing is now, from the watcher's last frame. */
  private boxes = new Map<string, UnitBox>();
  private cameraMoved = false;
  private watching = false;
  private seeded = false;
  /** One sample buffer each, reused by every stat on every frame: they run one at a time. */
  private sample = new Uint8Array(STATS.sample.width * STATS.sample.height);
  private emptySample = new Uint8Array(OCCUPANCY.sample.width * OCCUPANCY.sample.height);
  /** The feature model's patches of a region, when it is loaded: occupied compares them. */
  embed: ((frame: LumaFrame, region: UnitBox) => Promise<PatchGrid>) | null = null;
  /** Whether SAM sees `concept` in a region: billed, opt-in per stat, only while tracking may call AI. */
  confirm: ((concept: string, region: UnitBox) => Promise<'yes' | 'no' | 'error'>) | null = null;
  /** Promises of work in flight, so tests can wait for it. */
  readonly busy = new Set<Promise<unknown>>();
  constructor(private deps: StatRunnerDeps) {}
  private get now() {
    return this.deps.now?.() ?? Date.now();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Every thing's stats now. */
  current(): StatsNow {
    const out: StatsNow = {};
    for (const r of this.running.values())
      (out[r.thingId] ??= {})[r.key] = {
        ...r.now,
        ...(!this.watching && r.now.source !== 'entity' ? { stale: true } : {}),
        ...(r.region && !this.boxes.has(r.thingId) ? { region: r.region } : {}),
      };
    return out;
  }

  /**
   * Catch up with desk memory: stats switched on or off, things moved, what
   * each entity last did, whether the camera moved. Cheap enough to run every
   * few seconds and after every change.
   */
  sync(memory: DeskMemory = this.deps.store.memory(this.deps.mode)) {
    const now = this.now;
    this.account(now);
    this.cameraMoved = Boolean(memory.camera?.moved);
    const things = new Map(statThings(memory).map((t) => [t.id, t]));
    const wanted = new Set<string>();
    const last = this.seeded ? null : this.deps.store.lastStats(this.deps.mode);
    this.seeded = true;
    let changed = false;
    for (const [thingId, stats] of Object.entries(memory.thingStats ?? {})) {
      const thing = things.get(thingId);
      if (!thing) continue;
      for (const stat of stats) {
        const id = `${thingId}:${stat.key}`;
        wanted.add(id);
        let r = this.running.get(id);
        if (!r) {
          const before = last?.find((e) => e.thingId === thingId && e.key === stat.key);
          r = this.start(thingId, stat, thing.label, before ?? null, now);
          this.running.set(id, r);
          changed = true;
        }
        r.stat = stat;
        r.label = thing.label;
        r.region = thing.region;
        r.screen = thing.screen ?? null;
        if (r.key === 'power' && thing.entity !== undefined) {
          r.entity = thing.entity;
          if (thing.entity !== null)
            changed = this.set(r, thing.entity, 'entity', 1, now) || changed;
        } else delete r.entity;
        changed = this.check(r) || changed;
      }
    }
    for (const id of [...this.running.keys()])
      if (!wanted.has(id)) (this.running.delete(id), (changed = true));
    if (changed) this.tell();
  }
  /** Watching started or stopped: what the camera says is fresh, or only the last thing it saw. */
  setWatching(on: boolean) {
    if (on === this.watching) return;
    this.account(this.now);
    this.watching = on;
    if (!on) {
      this.lastFrame = this.previous = null;
      this.boxes.clear();
    }
    this.tell();
  }
  private start(
    thingId: string,
    stat: ThingStat,
    label: string,
    before: StatEvent | null,
    now: number,
  ): Running {
    const value = before?.value ?? null;
    const today = this.deps.store
      .statDays(this.deps.mode, thingId, dayOf(now))
      .find((d) => d.key === stat.key)?.total;
    const r: Running = {
      thingId,
      key: stat.key,
      stat,
      label,
      region: null,
      now: {
        value,
        since: before?.at ?? null,
        source: before?.source ?? 'camera',
        confidence: before?.confidence ?? 0,
        needs: [],
        today: today ?? 0,
      },
      lastRun: 0,
      lastCount: now,
    };
    const look = (name: StatLook) =>
      this.deps.store.setting(lookKey(this.deps.mode, thingId, stat.key, name));
    const power = (name: StatLook) => {
      const raw = look(name);
      return raw ? (JSON.parse(raw) as PowerLook) : null;
    };
    if (stat.key === 'power')
      r.power = { on: power('on'), off: power('off'), s: this.settledAt(value, before) };
    if (stat.key === 'occupied')
      r.occupied = {
        empty: readLook(look('empty')),
        s: this.settledAt(value, before),
        comparing: false,
        asked: 0,
        sam: null,
      };
    if (stat.key === 'activity') {
      const level = typeof value === 'number' ? value : 0;
      r.activity = { level, shown: level };
    }
    if (stat.key === 'lastUsed') r.usage = { spot: null, awaySince: null };
    return r;
  }
  private settledAt(value: StatEvent['value'], before: StatEvent | null) {
    const s = settled<boolean | null>(typeof value === 'boolean' ? value : null);
    s.since = before?.at ?? null;
    return s;
  }
  /** What a stat still needs before it can have a value from the camera; true when that changed. */
  private check(r: Running): boolean {
    const was = `${r.now.needs.join()}|${r.now.reason ?? ''}`;
    const needs: StatLook[] = [];
    let reason: string | undefined;
    if (r.power && r.entity === undefined) {
      if (!r.power.off) needs.push('off');
      if (!r.power.on) needs.push('on');
    }
    if (r.occupied && !r.occupied.empty) needs.push('empty');
    const camera = r.entity === undefined;
    if (camera && this.cameraMoved) reason = 'The camera moved: calibrate it again.';
    else if (r.key === 'lastUsed' && !r.region) reason = 'Confirm it in the camera first.';
    else if (camera && !r.region && r.key !== 'lastUsed')
      reason = 'It isn’t in the camera’s view: pin the room or confirm it there.';
    else if (needs.length)
      reason = `Show it ${needs.map((n) => (n === 'empty' ? 'empty' : n)).join(', then ')} once.`;
    r.now = { ...r.now, needs, ...(reason ? { reason } : {}) };
    if (!reason) delete r.now.reason;
    return was !== `${needs.join()}|${reason ?? ''}`;
  }

  /**
   * One of the watcher's frames, with the things it follows. Allocates
   * nothing per frame: a stat that isn't due, or whose region is still, skips.
   */
  frame(
    frame: LumaFrame,
    things: ReadonlyMap<string, WatchThing>,
    now = this.now,
    quietSteps: number = WATCH.quietSteps,
    demo = false,
  ) {
    this.previous = this.lastFrame;
    this.lastFrame = frame;
    this.boxes.clear();
    for (const [id, t] of things) this.boxes.set(id, t.track.box);
    if (!this.running.size) return;
    let changed = false;
    let mean = 0;
    for (const r of this.running.values()) {
      const dt = r.lastRun ? now - r.lastRun : 0;
      const due = demo || now - r.lastRun >= STAT_KINDS[r.key].everyMs;
      if (!due) continue;
      r.lastRun = now;
      if (this.cameraMoved && r.entity === undefined) {
        changed = this.set(r, null, 'camera', 0, now) || changed;
        continue;
      }
      const followed = things.get(r.thingId);
      const region = followed?.track.box ?? r.region;
      switch (r.key) {
        case 'power': {
          const p = r.power!;
          if (r.entity !== undefined || !region || !p.on || !p.off) break;
          // Someone in front of it says nothing about it: hold.
          const motion =
            followed?.track.motion ??
            (this.previous ? frameMotion(this.previous, frame, region) : 0);
          if (motion > LOCAL_TRACK.motionShare) break;
          mean ||= frameMean(frame.data);
          this.samplePower(frame, followed ? null : r.screen, region);
          const { reading, confidence } = powerReading(
            powerLook(this.sample, mean),
            { on: p.on, off: p.off },
            p.s.value,
          );
          if (settle(p.s, reading, now, demo ? 0 : STATS.dwellMs))
            changed = this.set(r, p.s.value, 'camera', confidence, p.s.since ?? now) || changed;
          break;
        }
        case 'activity': {
          if (!region) break;
          const motion =
            followed?.track.motion ??
            (this.previous ? frameMotion(this.previous, frame, around(region)) : 0);
          const active = motion > STATS.activeShare;
          if (active && dt) this.add(r, dt / 1000, now);
          if (activityStep(r.activity!, active, demo ? STATS.activityWindowMs / 4 : dt))
            changed = this.set(r, r.activity!.shown, 'camera', 1, now) || changed;
          break;
        }
        case 'lastUsed': {
          if (!followed) break;
          const used = usedStep(
            r.usage!,
            {
              following: followed.status === 'following' || followed.status === 'entangled',
              box: followed.track.box,
              still: followed.track.stillSteps >= quietSteps,
            },
            now,
            demo ? 0 : STATS.usedAwayMs,
          );
          if (used) {
            this.add(r, 1, now);
            changed = this.set(r, now, 'camera', 1, now, true) || changed;
          }
          break;
        }
        case 'occupied': {
          const o = r.occupied!;
          if (!region || !o.empty || o.comparing) break;
          if (o.empty.method === 'features') {
            if (!this.embed) break;
            o.comparing = true;
            const work = this.embed(frame, region)
              .then((grid) => this.occupiedScore(r, this.featureScore(o.empty!, grid), region))
              .catch(() => {})
              .finally(() => (o.comparing = false));
            this.track(work);
          } else {
            sampleInto(
              frame,
              region,
              this.emptySample,
              OCCUPANCY.sample.width,
              OCCUPANCY.sample.height,
            );
            this.occupiedScore(r, pixelDifference(o.empty.data, this.emptySample), region, demo);
          }
          break;
        }
      }
    }
    this.account(now);
    if (changed) this.tell();
  }
  private featureScore(empty: EmptyLook, grid: PatchGrid) {
    return empty.method === 'features' ? featureDifference(empty.grid, grid) : 1;
  }
  /** Occupied's verdict from a score, and SAM asked once it starts to look occupied, when it may be. */
  private occupiedScore(r: Running, score: number, region: UnitBox, demo = false) {
    const o = r.occupied!;
    const now = this.now;
    const flipped = occupiedStep(o.s, score, now, demo ? 0 : STATS.dwellMs);
    const local = o.s.value === true;
    if (flipped && !local) o.sam = null;
    const ask = r.stat.samConfirm && this.confirm && this.deps.store.trackingAi();
    if (ask && local && o.sam === null && now - o.asked >= OCCUPANCY.samGapMs) {
      o.asked = now;
      const concept = r.stat.concept ?? occupantOf(r.label);
      this.track(
        this.confirm!(concept, region).then((answer) => {
          o.sam = answer;
          if (o.s.value === true && this.set(r, answer === 'yes', 'sam', 1, this.now)) this.tell();
        }),
      );
    }
    const value = r.stat.samConfirm
      ? local
        ? o.sam === 'yes'
          ? true
          : r.now.value
        : false
      : local;
    const confidence = Math.min(
      1,
      Math.abs(score - OCCUPANCY.occupiedShare) / OCCUPANCY.occupiedShare,
    );
    if (this.set(r, value, 'camera', confidence, o.s.since ?? now)) this.tell();
  }
  private track(work: Promise<unknown>) {
    this.busy.add(work);
    void work.finally(() => this.busy.delete(work));
  }
  /** Wait until no comparison or SAM ask is running. */
  async idle() {
    while (this.busy.size) await Promise.allSettled([...this.busy]);
  }

  /** A stat's new value; an event when it changed, or always for a time (each use is one). */
  private set(
    r: Running,
    value: StatNow['value'],
    source: StatNow['source'],
    confidence: number,
    at: number,
    always = false,
  ): boolean {
    if (!always && value === r.now.value) return false;
    this.account(this.now);
    r.now = { ...r.now, value, since: value === null ? null : at, source, confidence };
    this.events.push({ thingId: r.thingId, key: r.key, at, value, source, confidence });
    this.schedule();
    return true;
  }
  /** Add to a stat's total for today. */
  private add(r: Running, amount: number, now: number) {
    const day = dayOf(now);
    const id = `${r.thingId}:${r.key}:${day}`;
    const row = this.days.get(id) ?? { day, thingId: r.thingId, key: r.key, add: 0 };
    row.add += amount;
    this.days.set(id, row);
    r.now = { ...r.now, today: (dayOf(r.lastCount) === day ? r.now.today : 0) + amount };
    r.lastCount = now;
    this.schedule();
  }
  /** Seconds each on/off stat has been on since it was last counted, added to today. */
  private account(now: number) {
    for (const r of this.running.values()) {
      if (STAT_KINDS[r.key].daily !== 'onSeconds') continue;
      const dt = now - r.lastCount;
      if (dt <= 0) continue;
      // What the camera can't see now isn't counted: only an entity's state is known without it.
      const counting = r.now.value === true && (this.watching || r.now.source === 'entity');
      if (counting) this.add(r, dt / 1000, now);
      else {
        if (dayOf(r.lastCount) !== dayOf(now)) r.now = { ...r.now, today: 0 };
        r.lastCount = now;
      }
    }
  }
  private schedule() {
    this.flushTimer ??= setTimeout(() => this.flush(), STATS.flushMs);
    this.flushTimer.unref?.();
  }
  /** Write what changed since the last write, in one transaction. */
  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.account(this.now);
    const events = this.events;
    const days = [...this.days.values()];
    this.events = [];
    this.days.clear();
    try {
      this.deps.store.saveStats(this.deps.mode, events, days);
    } catch {
      // A store that is closing loses the last few seconds, never the history before them.
    }
  }
  private tell() {
    for (const l of this.listeners) l();
  }

  /** A power sample: of a screen's face when there is one, else of the thing's box. */
  private samplePower(frame: LumaFrame, screen: UnitQuad | null | undefined, region: UnitBox) {
    const { width, height } = STATS.sample;
    if (screen) sampleQuadInto(frame, screen, this.sample, width, height);
    else sampleInto(frame, region, this.sample, width, height);
  }
  /**
   * The person says how the thing looks now: off, on or empty. Kept in
   * `settings` (a grey look, or feature patches for empty when the model is
   * loaded), and the stat starts over from it.
   */
  async learn(thingId: string, key: StatKey, look: StatLook): Promise<StatNow> {
    const r = this.running.get(`${thingId}:${key}`);
    if (!r) throw new LabError('stat_off', 'Switch that stat on first.', 409);
    if (!STAT_KINDS[key].learn.includes(look))
      throw new LabError('stat_look', `${STAT_KINDS[key].label} doesn’t learn that look.`, 400);
    const frame = this.lastFrame;
    if (!this.watching || !frame)
      throw new LabError(
        'stat_watch',
        'Turn on watching first, so there is a frame to learn from.',
        409,
      );
    const region = this.boxes.get(thingId) ?? r.region;
    if (!region) throw new LabError('stat_region', 'It isn’t in the camera’s view.', 409);
    const setting = lookKey(this.deps.mode, thingId, key, look);
    if (key === 'power') {
      this.samplePower(frame, this.boxes.has(thingId) ? null : r.screen, region);
      const value = powerLook(this.sample, frameMean(frame.data));
      this.deps.store.setSetting(setting, JSON.stringify(value));
      r.power![look as 'on' | 'off'] = value;
      // It is as shown now: the detector starts from there.
      r.power!.s = settled<boolean | null>(look === 'on');
      this.set(r, look === 'on', 'camera', 1, this.now);
    } else {
      const empty: EmptyLook = this.embed
        ? { method: 'features', grid: await this.embed(frame, region) }
        : {
            method: 'pixels',
            ...OCCUPANCY.sample,
            data: sampleInto(
              frame,
              region,
              new Uint8Array(OCCUPANCY.sample.width * OCCUPANCY.sample.height),
              OCCUPANCY.sample.width,
              OCCUPANCY.sample.height,
            ),
          };
      this.deps.store.setSetting(setting, lookText(empty));
      r.occupied = {
        empty,
        s: settled<boolean | null>(false),
        comparing: false,
        asked: 0,
        sam: null,
      };
      this.set(r, false, 'camera', 1, this.now);
    }
    this.check(r);
    this.tell();
    return r.now;
  }
  /**
   * The person says when a thing was last used: its Last used takes that
   * time, as one use (counted today when it is today). Null when the thing
   * doesn't keep Last used.
   */
  used(thingId: string, at: number): StatNow | null {
    const r = this.running.get(`${thingId}:lastUsed`);
    if (!r) return null;
    this.set(r, at, 'person', 1, at, true);
    if (dayOf(at) === dayOf(this.now)) this.add(r, 1, this.now);
    this.tell();
    return r.now;
  }
  /** A thing's stats now, its last day of changes and its day totals. */
  view(thingId: string, days: number): ThingStatsView {
    this.flush();
    const now = this.now;
    const first = dayOf(now - (days - 1) * 86_400_000);
    const current = this.current()[thingId] ?? {};
    return {
      id: thingId,
      now: current,
      events: this.deps.store.statEvents(this.deps.mode, thingId, now - 86_400_000),
      days: this.deps.store
        .statDays(this.deps.mode, thingId, first)
        .map(({ day, key, total }) => ({ day, key, total })),
    };
  }
}

/** The lab's routes for things' stats. */
export async function statRoutes(
  app: FastifyInstance,
  { store, runners }: { store: EvidenceStore; runners: Record<Mode, StatRunner> },
) {
  app.post('/stats', async (request) => {
    const { mode, id, stats } = parseInput(thingsStatsBodySchema, request.body);
    const memory = store.updateMemory(mode, (memory) => {
      if (!statThings(memory).some((t) => t.id === id))
        throw new LabError('thing_unknown', 'That thing is not in this desk memory.', 404);
      const known = new Set(statThings(memory).map((t) => t.id));
      const kept = Object.entries(memory.thingStats ?? {}).filter(
        ([thing]) => thing !== id && known.has(thing),
      );
      memory.thingStats = Object.fromEntries(stats.length ? [...kept, [id, stats]] : kept);
      return memory;
    });
    runners[mode].sync(memory);
    return { memory, stats: runners[mode].current() };
  });
  app.post('/learn', async (request) => {
    const { mode, id, key, look } = parseInput(thingsLearnBodySchema, request.body);
    return { now: await runners[mode].learn(id, key, look), stats: runners[mode].current() };
  });
  app.post('/used', async (request) => {
    const { mode, id, at } = parseInput(thingsUsedBodySchema, request.body);
    const now = runners[mode].used(id, at);
    if (!now) throw new LabError('stat_off', 'Switch on its Last used stat first.', 409);
    return { now, stats: runners[mode].current() };
  });
  app.get('/:mode/:id/stats', async (request) => {
    const { mode, id, days } = parseInput(thingStatsQuerySchema, {
      ...(request.params as object),
      ...(request.query as object),
    });
    return runners[mode].view(id, days);
  });
}
