/**
 * Where each followed thing really is in a recorded clip, marked by hand on
 * keyframes, and how well the watcher keeps each one's identity over it. A
 * clip's marks are `<clip>.tracks.json` beside its frames in `.data/clips/`
 * (local only, like the clip).
 *
 * The watcher is replayed over the clip with SAM answered from the marks: an
 * ask gets every marked box of the thing's concept on the nearest keyframe,
 * without their ids, as a real SAM answer comes. So the answer is a perfect
 * SAM's, and what is judged is how the watcher follows and which detection it
 * takes, not SAM. Only marked keyframes are scored: mark only what the frame
 * shows, and a thing out of sight as `hidden`.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  asked,
  boxIoU,
  footInZone,
  missed,
  pickTracked,
  placed,
  startLocalTrack,
  watchFrame,
  watchStep,
  watchThing,
  type Detection,
  type LumaFrame,
  type UnitBox,
  type WatchStatus,
  type WatchThing,
} from '@livinglayer/domain';

export interface TrackTruth {
  things: { id: string; label: string; concept: string }[];
  /** Zones every thing is judged against, so crossings ask SAM as the watcher would. */
  zones?: { id: string; rect: UnitBox }[];
  /** Keyframe index → each marked thing's box as a share of the frame, or `hidden`. */
  keys: Record<string, Record<string, UnitBox | 'hidden'>>;
}
export interface ClipInfo {
  width: number;
  height: number;
  fps: number;
  frames: number;
  camera: string;
  takenAt: string;
  /** How long the full-size still took, when it was recorded. */
  snapshotMs?: number;
}
/** A recorded clip by name, or the newest one: its grey frames and the full-size still. */
export function loadClip(dir: string, name?: string) {
  const all = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.tracks.json'))
        .sort()
    : [];
  const file = name ? `${name}.json` : all.at(-1);
  if (!file || !existsSync(join(dir, file)))
    throw new Error('No clip. Record one with `bun run bench:track capture`.');
  const base = file.slice(0, -5);
  const info = JSON.parse(readFileSync(join(dir, file), 'utf8')) as ClipInfo;
  const raw = readFileSync(join(dir, `${base}.luma`));
  const size = info.width * info.height;
  const frames: LumaFrame[] = [];
  for (let k = 0; k + size <= raw.length; k += size)
    frames.push({
      width: info.width,
      height: info.height,
      data: new Uint8Array(raw.subarray(k, k + size)),
    });
  return { base, info, frames, still: readFileSync(join(dir, `${base}.png`)) };
}

export const truthFile = (dir: string, clip: string) => join(dir, `${clip}.tracks.json`);
export function truthOf(dir: string, clip: string): TrackTruth | null {
  const file = truthFile(dir, clip);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as TrackTruth) : null;
}
export function saveTruth(dir: string, clip: string, truth: TrackTruth) {
  const keys = Object.fromEntries(
    Object.entries(truth.keys)
      .filter(([, marks]) => Object.keys(marks).length)
      .sort(([a], [b]) => Number(a) - Number(b)),
  );
  writeFileSync(truthFile(dir, clip), `${JSON.stringify({ ...truth, keys }, null, 1)}\n`);
}
export const keyFrames = (truth: TrackTruth) =>
  Object.keys(truth.keys)
    .map(Number)
    .sort((a, b) => a - b);

export const iou = boxIoU;

export const TRACK_SCORE = {
  /** A box is on a thing when it overlaps the thing's marked box at least this much. */
  onIoU: 0.5,
  /** SAM is answered from the nearest keyframe at most this many frames away; else it finds nothing. */
  answerWithin: 10,
};

/** What the replay saw of one thing on one keyframe. */
export interface Seen {
  box: UnitBox;
  status: WatchStatus;
}
export interface Ask {
  frame: number;
  thing: string;
  ask: 'confirm' | 'reanchor';
  /** Whose marked box the chosen detection was; null when SAM had nothing to give. */
  took: string | null;
}
/** A zone judgement the watcher made from a local box, with no SAM call. */
export interface Place {
  frame: number;
  thing: string;
  box: UnitBox;
}
export interface Replay {
  /** Keyframe → thing → what the watcher had. */
  seen: Map<number, Map<string, Seen>>;
  asks: Ask[];
  places: Place[];
  refinds: number;
  /** Things whose first marked box had too little texture to follow. */
  unseeded: string[];
}

/**
 * The watcher's own steps over a clip, as `Watcher.frame` and `Watcher.ask`
 * take them, with SAM answered from the marks and no feature model. A thing
 * starts on the first keyframe it is marked visible, as if a person confirmed
 * it there, and after each answer starts again from the box `pickTracked`
 * chose, as `Watcher.seed` does. A zone judgement (`place`) is recorded and
 * taken as made, so the thing's zones flip to where its box stands.
 * `alone` steps each thing on its own, as the watcher did before
 * `watchFrame`, to compare against.
 */
export function replayClip(
  frames: LumaFrame[],
  fps: number,
  truth: TrackTruth,
  { alone = false } = {},
): Replay {
  const keys = keyFrames(truth);
  const zones = truth.zones ?? [];
  const frameSize = { width: frames[0]?.width ?? 1, height: frames[0]?.height ?? 1 };
  const px = (b: UnitBox) => ({
    x: b.x * frameSize.width,
    y: b.y * frameSize.height,
    width: b.width * frameSize.width,
    height: b.height * frameSize.height,
  });
  const inside = (b: UnitBox, rect: UnitBox) => footInZone(px(b), frameSize, rect);
  const subject = (t: TrackTruth['things'][number], box: UnitBox) => ({
    id: t.id,
    kind: 'object' as const,
    label: t.label,
    concept: t.concept,
    zones: zones.map((z) => ({ id: z.id, rect: z.rect, inside: inside(box, z.rect) })),
  });
  const firstSeen = new Map<string, number>();
  for (const k of keys)
    for (const [id, mark] of Object.entries(truth.keys[k]!))
      if (mark !== 'hidden' && !firstSeen.has(id)) firstSeen.set(id, k);
  const things = new Map<string, WatchThing>();
  // The last box SAM confirmed per thing, which `pickTracked` compares against.
  const sighting = new Map<string, UnitBox>();
  const replay: Replay = { seen: new Map(), asks: [], places: [], refinds: 0, unseeded: [] };
  const start = (
    t: TrackTruth['things'][number],
    frame: LumaFrame,
    box: UnitBox,
    keep?: WatchThing,
  ) => {
    const track = startLocalTrack(frame, box, zones.length > 0);
    if (!track) return false;
    sighting.set(t.id, box);
    things.set(t.id, {
      ...watchThing(subject(t, box), track, keep?.lastAsk ?? 0),
      ...(keep ? { reanchorGap: keep.reanchorGap } : {}),
    });
    return true;
  };
  const answer = (concept: string, k: number) => {
    const near = nearestKey(truth, k);
    if (near === null) return [];
    return truth.things.flatMap((t) => {
      const mark = truth.keys[near]![t.id];
      return t.concept === concept && mark && mark !== 'hidden' ? [{ id: t.id, box: mark }] : [];
    });
  };
  frames.forEach((frame, k) => {
    const now = k * (1000 / fps);
    for (const t of truth.things)
      if (firstSeen.get(t.id) === k && !things.has(t.id)) {
        const mark = truth.keys[k]![t.id] as UnitBox;
        if (!start(t, frame, mark)) replay.unseeded.push(t.id);
      }
    const steps = alone
      ? new Map([...things].map(([id, th]) => [id, watchStep(th, frame, now)]))
      : watchFrame([...things.values()], frame, now);
    for (const t of truth.things) {
      const step = steps.get(t.id);
      if (!step) continue;
      if (step.refind) replay.refinds++;
      if (step.place) {
        const box = step.thing.track.box;
        replay.places.push({ frame: k, thing: t.id, box });
        const judged = placed(step.thing, now, false);
        things.set(t.id, {
          ...judged,
          subject: {
            ...judged.subject,
            zones: judged.subject.zones.map((z) => ({ ...z, inside: inside(box, z.rect) })),
          },
        });
      } else things.set(t.id, step.thing);
      if (!step.ask) continue;
      const waited = asked(step.thing, step.ask, now);
      const found = answer(t.concept, k);
      const detections: Detection[] = found.map((f) => ({
        objectId: f.id,
        confidence: null,
        box: px(f.box),
        mask: { width: 0, height: 0, foregroundPixels: 0, svgPath: '' },
      }));
      // Assigned with its look-alikes' last sightings, as the server's track paths do.
      const others = truth.things
        .filter((o) => o.id !== t.id && o.concept === t.concept && sighting.has(o.id))
        .map((o) => ({ box: px(sighting.get(o.id)!), frame: frameSize }));
      const pick = pickTracked(
        detections,
        frameSize,
        { box: px(sighting.get(t.id)!), frame: frameSize },
        others,
      );
      replay.asks.push({
        frame: k,
        thing: t.id,
        ask: step.ask,
        took: pick?.detection.objectId ?? null,
      });
      const box = pick && found.find((f) => f.id === pick.detection.objectId)!.box;
      if (!box || !start(t, frame, box, waited)) things.set(t.id, missed(waited));
    }
    if (truth.keys[k])
      replay.seen.set(
        k,
        new Map([...things].map(([id, th]) => [id, { box: th.track.box, status: th.status }])),
      );
  });
  return replay;
}

/** The keyframe nearest frame `k`, within `TRACK_SCORE.answerWithin`. */
export function nearestKey(truth: TrackTruth, k: number): number | null {
  let near: number | null = null;
  for (const key of keyFrames(truth))
    if (
      Math.abs(key - k) <= TRACK_SCORE.answerWithin &&
      (near === null || Math.abs(key - k) < Math.abs(near - k))
    )
      near = key;
  return near;
}
/** Whose marked box `box` sits on, at keyframe `k`: `own` first, then the best other. */
function onWhom(marks: TrackTruth['keys'][string], box: UnitBox, own: string): string | null {
  const mine = marks[own];
  if (mine && mine !== 'hidden' && iou(box, mine) >= TRACK_SCORE.onIoU) return own;
  let on: string | null = null;
  let best = TRACK_SCORE.onIoU;
  for (const [other, mark] of Object.entries(marks))
    if (other !== own && mark !== 'hidden' && iou(box, mark) >= best) {
      best = iou(box, mark);
      on = other;
    }
  return on;
}

export interface ThingScore {
  id: string;
  /** Keyframes it was marked on after it started. */
  keys: number;
  /** On its own marked box (IDTP), its box elsewhere (IDFP), its marked box not covered (IDFN). */
  tp: number;
  fp: number;
  fn: number;
  /** Times the thing it was on changed: onto another thing, or back. */
  switches: number;
  /** Keyframes it said `following` while on another thing or off its own visible one. */
  falseSure: number;
  /** Keyframes it said `unsure` or `missing` and really wasn't on itself. */
  honestUnsure: number;
  /** Keyframes it said `unsure` or `missing` while it was right. */
  needlessUnsure: number;
  /** SAM asks, and those whose chosen detection was another thing's. */
  asks: number;
  wrongPicks: number;
  /** Zone judgements from its local box, and those made while on another thing (they switch lights). */
  places: number;
  wrongPlaces: number;
}
export const idf1 = (s: Pick<ThingScore, 'tp' | 'fp' | 'fn'>) =>
  s.tp + s.fp + s.fn ? (2 * s.tp) / (2 * s.tp + s.fp + s.fn) : 1;

/** Each thing's identity scores over the replay's keyframes. */
export function scoreReplay(truth: TrackTruth, replay: Replay): ThingScore[] {
  return truth.things.map((t) => {
    const s: ThingScore = {
      id: t.id,
      keys: 0,
      tp: 0,
      fp: 0,
      fn: 0,
      switches: 0,
      falseSure: 0,
      honestUnsure: 0,
      needlessUnsure: 0,
      asks: 0,
      wrongPicks: 0,
      places: 0,
      wrongPlaces: 0,
    };
    let lastOn: string | null = null;
    for (const [k, seen] of replay.seen) {
      const mine = seen.get(t.id);
      const marks = truth.keys[k] ?? {};
      const own = marks[t.id];
      if (!mine || own === undefined) continue;
      s.keys++;
      const present = mine.status !== 'missing';
      const on = onWhom(marks, mine.box, t.id);
      const right = on === t.id;
      if (present && right) s.tp++;
      if (present && !right) s.fp++;
      if (own !== 'hidden' && !(present && right)) s.fn++;
      if (on && lastOn && on !== lastOn) s.switches++;
      if (on) lastOn = on;
      if (mine.status === 'following') {
        if ((on && on !== t.id) || (own !== 'hidden' && !right)) s.falseSure++;
      } else if (right) s.needlessUnsure++;
      else s.honestUnsure++;
    }
    for (const a of replay.asks)
      if (a.thing === t.id) {
        s.asks++;
        if (a.took && a.took !== t.id) s.wrongPicks++;
      }
    for (const p of replay.places)
      if (p.thing === t.id) {
        s.places++;
        const near = nearestKey(truth, p.frame);
        const on = near === null ? null : onWhom(truth.keys[near]!, p.box, t.id);
        if (on && on !== t.id) s.wrongPlaces++;
      }
    return s;
  });
}

/** All things' scores added up, with IDF1 over the sums. */
export function totalScore(scores: ThingScore[]): ThingScore {
  const sum = (key: keyof Omit<ThingScore, 'id'>) => scores.reduce((n, s) => n + s[key], 0);
  return {
    id: 'all',
    keys: sum('keys'),
    tp: sum('tp'),
    fp: sum('fp'),
    fn: sum('fn'),
    switches: sum('switches'),
    falseSure: sum('falseSure'),
    honestUnsure: sum('honestUnsure'),
    needlessUnsure: sum('needlessUnsure'),
    asks: sum('asks'),
    wrongPicks: sum('wrongPicks'),
    places: sum('places'),
    wrongPlaces: sum('wrongPlaces'),
  };
}

/** What the clips should meet (phase 0 of docs/plans/multi-tracking.md); shared with the tests. */
export const TRACK_TARGETS = {
  /** Never sure of the wrong thing. */
  falseSure: 0,
  /** No identity changes on the swap and crossing clips. */
  switches: 0,
  /** SAM never hands a thing another's detection. */
  wrongPicks: 0,
  /** No zone judged from a box on another thing. */
  wrongPlaces: 0,
};
