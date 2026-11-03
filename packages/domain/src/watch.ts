/**
 * Always-on watching: what the server's watcher decides for each followed
 * thing on each frame. A thing whose region didn't change keeps its box and
 * costs microseconds, with a full match once a second in case it crept; a
 * changed one is matched locally (`stepLocalTrack`), a few milliseconds; a thing the local match
 * has lost is looked for by appearance before SAM is asked; and SAM is asked
 * only to find a thing nothing else can: a zone crossing is judged where the
 * local match has it, with no SAM call. Pure
 * code, so the tests drive it with made-up frames and clocks.
 */
import {
  around,
  boxIoU,
  frameMotion,
  stepLocalTrack,
  LOCAL_TRACK,
  type LocalTrack,
  type LumaFrame,
  type UnitBox,
} from './tracker.js';
import { footInZone } from './rules.js';

/** What the watcher follows: the mug, another remembered object, or a tracked fixture. */
export type WatchKind = 'mug' | 'object' | 'fixture';
export interface WatchSubject {
  id: string;
  kind: WatchKind;
  label: string;
  /** What SAM is asked to outline when it is asked to look again. */
  concept: string;
  /** Its zones, each with the last verdict SAM confirmed. */
  zones: { id: string; rect: UnitBox; inside: boolean }[];
}
/**
 * `following`: the local match is good. `unsure`: weak or ambiguous for a few
 * frames, box held still. `missing`: SAM couldn't find it either, several
 * times; only motion where it was wakes it up again.
 */
export type WatchStatus = 'following' | 'unsure' | 'missing';
/** Which layer placed the box last: the local match, the feature model, or SAM. */
type WatchLayer = 'local' | 'appearance' | 'sam';
export interface WatchThing {
  subject: WatchSubject;
  track: LocalTrack;
  status: WatchStatus;
  layer: WatchLayer;
  /** Consecutive matches on the other side of any zone's edge from its verdict. */
  crossingSteps: number;
  /** When it first showed across a zone's edge in this run of crossing frames, ms; for timing. */
  crossedAt: number | null;
  /** The soonest its zones may be judged again, ms. */
  nextPlace: number;
  /** When SAM was last asked about this thing, ms. */
  lastAsk: number;
  /** The wait before asking SAM again while it stays lost; doubles each time. */
  reanchorGap: number;
  /** Re-anchors in a row that found nothing. */
  misses: number;
  /** Good local steps in a row; enough of them resets the back-off. */
  goodSteps: number;
  /** Whether the feature model was already tried since the match was lost. */
  refound: boolean;
}
export const WATCH = {
  /** Frames on the other side of a zone edge before the crossing is judged. */
  settleSteps: 2,
  /** Weak or ambiguous frames before the thing counts as lost. */
  lostSteps: 3,
  /**
   * Frames of stillness around the thing (0.4 s at 10 a second) before its
   * zones are judged or SAM is asked anything: a hand has gone, and a still
   * taken for SAM is newer than the quiet (`STILL_FPS`).
   */
  quietSteps: 4,
  /** Least time between two judgements of one thing's zones, ms. */
  placeGapMs: 500,
  /** After a judgement that was blocked (a moved camera, no zone for this frame), ms. */
  blockedGapMs: 30_000,
  reanchorGapMs: { first: 2000, max: 30_000 },
  /** Good steps in a row (about 3 s at 10 frames a second) before the back-off resets. */
  recoveredSteps: 30,
  /** Re-anchors that find nothing before the thing is marked missing. */
  maxMisses: 3,
  /**
   * A thing that is following and whose region is still keeps its box without
   * a match, except every this many frames (once a second at 10 a second), so
   * one that creeps too slowly to count as motion is still caught. The match
   * is a thousand times the cost of the motion check.
   */
  recheckSteps: 10,
};

export function watchThing(subject: WatchSubject, track: LocalTrack, now: number): WatchThing {
  return {
    subject,
    track,
    status: 'following',
    layer: 'sam',
    crossingSteps: 0,
    crossedAt: null,
    nextPlace: 0,
    lastAsk: now,
    reanchorGap: WATCH.reanchorGapMs.first,
    misses: 0,
    goodSteps: 0,
    refound: false,
  };
}

const WHOLE: UnitBox = { x: 0, y: 0, width: 1, height: 1 };
// Where it stands, as the rules judge it on the frame (`footInZone`): its box's bottom centre.
const inZone = (b: UnitBox, zone: UnitBox) => footInZone(b, { width: 1, height: 1 }, zone);
/**
 * What one frame means for one thing. `place` asks the caller to judge its
 * zones where the local match has it now: it settled across an edge. `ask`
 * is a SAM check due now, to `reanchor` a thing that is lost. `refind` asks the caller
 * to look for it by appearance first; when that finds it, `refound` moves the
 * box there and SAM isn't needed. A missing thing is left alone until its old
 * region moves.
 */
export function watchStep(
  thing: WatchThing,
  frame: LumaFrame,
  now: number,
  { quietSteps = WATCH.quietSteps, placeGapMs = WATCH.placeGapMs, exclude = [] as UnitBox[] } = {},
): { thing: WatchThing; ask: 'reanchor' | null; refind: boolean; place: boolean } {
  if (thing.status === 'missing') {
    const motion = frameMotion(thing.track.previous, frame, around(thing.track.box));
    const track = { ...thing.track, previous: frame, motion };
    if (motion <= LOCAL_TRACK.motionShare)
      return { thing: { ...thing, track }, ask: null, refind: false, place: false };
    // Something moved where it was: look again, from the start of the back-off.
    return {
      thing: {
        ...thing,
        track: { ...track, stillSteps: 0, lostSteps: WATCH.lostSteps },
        status: 'unsure',
        misses: 0,
        refound: false,
        reanchorGap: WATCH.reanchorGapMs.first,
      },
      ask: null,
      refind: false,
      place: false,
    };
  }
  const motion = frameMotion(thing.track.previous, frame, around(thing.track.box));
  const stillSteps = motion > LOCAL_TRACK.motionShare ? 0 : thing.track.stillSteps + 1;
  const quiet =
    thing.status === 'following' &&
    !thing.track.lostSteps &&
    stillSteps > 0 &&
    stillSteps % WATCH.recheckSteps !== 0;
  // Lost, and already searching the whole frame: an unchanged frame can't show it anywhere.
  // Fewer changed pixels than a quarter of the thing is unchanged; a share of the whole
  // frame would miss a mug put back, which covers about 0.2% of it.
  const { width: tw, height: th } = thing.track.template;
  const searchedAll = thing.track.lostSteps >= WATCH.lostSteps;
  const unchanged =
    searchedAll &&
    frameMotion(thing.track.previous, frame, WHOLE) * frame.width * frame.height < (tw * th) / 4;
  const lostSteps = thing.track.lostSteps + 1;
  const step = quiet
    ? {
        track: { ...thing.track, previous: frame, motion, stillSteps },
        verdict: 'follow' as const,
      }
    : unchanged
      ? {
          track: { ...thing.track, previous: frame, motion, stillSteps, lostSteps },
          verdict:
            lostSteps >= WATCH.lostSteps && stillSteps >= quietSteps
              ? ('reanchor' as const)
              : ('follow' as const),
        }
      : stepLocalTrack(thing.track, frame, null, {
          lostSteps: WATCH.lostSteps,
          quietSteps,
          exclude,
        });
  const track = step.track;
  const settled = track.stillSteps >= quietSteps;
  if (track.lostSteps) {
    const next: WatchThing = { ...thing, track, status: 'unsure', crossingSteps: 0, goodSteps: 0 };
    if (step.verdict !== 'reanchor') return { thing: next, ask: null, refind: false, place: false };
    if (!thing.refound)
      return { thing: { ...next, refound: true }, ask: null, refind: true, place: false };
    if (now - thing.lastAsk < thing.reanchorGap)
      return { thing: next, ask: null, refind: false, place: false };
    return { thing: next, ask: 'reanchor', refind: false, place: false };
  }
  const crossed = thing.subject.zones.some((z) => inZone(track.box, z.rect) !== z.inside);
  const goodSteps = thing.goodSteps + 1;
  const next: WatchThing = {
    ...thing,
    track,
    status: 'following',
    layer: thing.status === 'following' ? thing.layer : 'local',
    crossingSteps: crossed ? thing.crossingSteps + 1 : 0,
    crossedAt: crossed ? (thing.crossedAt ?? now) : null,
    goodSteps,
    refound: false,
    misses: 0,
    reanchorGap: goodSteps >= WATCH.recoveredSteps ? WATCH.reanchorGapMs.first : thing.reanchorGap,
  };
  const place = next.crossingSteps >= WATCH.settleSteps && settled && now >= thing.nextPlace;
  return {
    thing: place ? { ...next, nextPlace: now + placeGapMs } : next,
    ask: null,
    refind: false,
    place,
  };
}
/** What one frame means for one thing, from `watchFrame`. */
type WatchStepResult = ReturnType<typeof watchStep>;
/**
 * One frame for every followed thing together. Each one's search skips the
 * others' boxes, so a lost thing can't settle on a look-alike that is already
 * followed (it stays lost and goes on to the feature model and SAM), and two
 * look-alikes side by side aren't each other's runner-up. If two boxes still
 * end up on one place, the thing that came further gives way: it holds its
 * last box and counts as lost for the step, and nothing is judged for it.
 * `hold` is a thing SAM is being asked about: it isn't stepped, but its box
 * is kept clear. Boxes that already overlapped (a phone on a book, two mugs
 * touching) aren't kept off each other.
 */
export function watchFrame(
  things: WatchThing[],
  frame: LumaFrame,
  now: number,
  pace: { quietSteps?: number; placeGapMs?: number } = {},
  hold?: string,
): Map<string, WatchStepResult> {
  const shown = (t: WatchThing) => t.status !== 'missing';
  const apart = (a: WatchThing, b: WatchThing) =>
    boxIoU(a.track.box, b.track.box) < LOCAL_TRACK.claimIoU;
  const steps = new Map<string, WatchStepResult>();
  for (const t of things) {
    if (t.subject.id === hold) continue;
    const exclude = things
      .filter((o) => o !== t && shown(o) && apart(o, t))
      .map((o) => o.track.box);
    steps.set(t.subject.id, watchStep(t, frame, now, { ...pace, exclude }));
  }
  const boxOf = (t: WatchThing) => steps.get(t.subject.id)?.thing.track.box ?? t.track.box;
  const moved = (t: WatchThing) =>
    Math.hypot(boxOf(t).x - t.track.box.x, boxOf(t).y - t.track.box.y);
  for (const a of things)
    for (const b of things) {
      if (a === b || !shown(a) || !shown(b) || !apart(a, b)) continue;
      if (boxIoU(boxOf(a), boxOf(b)) < LOCAL_TRACK.claimIoU) continue;
      const loser = moved(a) >= moved(b) ? a : b;
      const step = steps.get(loser.subject.id);
      if (!step || step.thing.track.lostSteps) continue;
      steps.set(loser.subject.id, {
        thing: {
          ...step.thing,
          track: {
            ...step.thing.track,
            box: loser.track.box,
            lostSteps: loser.track.lostSteps + 1,
            crossingSteps: 0,
          },
          status: 'unsure',
          crossingSteps: 0,
          crossedAt: null,
          goodSteps: 0,
        },
        ask: null,
        refind: false,
        place: false,
      });
    }
  return steps;
}
/**
 * Its zones were judged where it is followed. Blocked, they aren't judged
 * again for a while, rather than on every frame it stays across the edge.
 */
export function placed(thing: WatchThing, now: number, blocked: boolean): WatchThing {
  return blocked
    ? { ...thing, nextPlace: now + WATCH.blockedGapMs }
    : { ...thing, crossingSteps: 0, crossedAt: null };
}

/** The feature model found it: follow from there, with the template SAM's frame gave. */
export function refound(thing: WatchThing, box: UnitBox): WatchThing {
  return {
    ...thing,
    track: { ...thing.track, box, lostSteps: 0 },
    status: 'following',
    layer: 'appearance',
  };
}
/** SAM was asked; whatever it says, the next ask waits. A re-anchor doubles the wait. */
export function asked(thing: WatchThing, ask: 'confirm' | 'reanchor', now: number): WatchThing {
  return {
    ...thing,
    lastAsk: now,
    reanchorGap:
      ask === 'reanchor'
        ? Math.min(WATCH.reanchorGapMs.max, thing.reanchorGap * 2)
        : thing.reanchorGap,
  };
}
/** SAM couldn't find it. After a few misses in a row it is missing until its region moves. */
export function missed(thing: WatchThing): WatchThing {
  const misses = thing.misses + 1;
  return {
    ...thing,
    misses,
    crossingSteps: 0,
    status: misses >= WATCH.maxMisses ? 'missing' : thing.status,
  };
}

/** What the lab shows of the watcher; sent on every change. */
export interface WatchView {
  mode: 'demo' | 'live';
  on: boolean;
  /** `paused`: following goes on, but SAM can't be asked (spending limit, live calls off). */
  state: 'off' | 'starting' | 'watching' | 'paused' | 'camera_lost';
  note: string;
  camera: { id: string; name: string } | null;
  /** Whether the feature model is loaded, so lost things are looked for before SAM is asked. */
  appearance: boolean;
  frames: number;
  checks: number;
  refinds: number;
  things: {
    id: string;
    kind: WatchKind;
    label: string;
    status: WatchStatus;
    layer: WatchLayer;
    box: UnitBox;
    score: number;
  }[];
}
