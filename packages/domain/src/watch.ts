/**
 * Always-on watching: what the server's watcher decides for each followed
 * thing on each frame. A thing whose region didn't change keeps its box and
 * costs microseconds, with a full match once a second in case it crept; a
 * changed one is matched locally (`stepLocalTrack`), a few milliseconds; a
 * thing the local match has lost is looked for by appearance, then over the
 * whole frame (or by SAM, when tracking may call it); a zone crossing is
 * judged where the local match has it. Two look-alikes carried close together
 * are `entangled` until their looks tell them apart again. Pure code, so the
 * tests drive it with made-up frames and clocks.
 */
import type { StatsNow } from './stats.js';
import { assignTracks, MULTI } from './assign.js';
import {
  around,
  boxIoU,
  frameMotion,
  matchTemplate,
  recutTemplate,
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
 * frames, box held still. `entangled`: followed, but it came close to a
 * look-alike while one of them moved, so which is which isn't sure; its zones
 * wait. `missing`: nothing could find it, several times; motion where it was,
 * or a match over the whole frame after the view changed, wakes it up again.
 */
export type WatchStatus = 'following' | 'unsure' | 'entangled' | 'missing';
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
  /** When it was last looked for past the local match (SAM, or the whole-frame search), ms. */
  lastAsk: number;
  /** The wait before asking SAM again while it stays lost; doubles each time. */
  reanchorGap: number;
  /** Re-anchors in a row that found nothing. */
  misses: number;
  /** Good local steps in a row; enough of them resets the back-off. */
  goodSteps: number;
  /** Whether the feature model was already tried since the match was lost. */
  refound: boolean;
  /** The look-alike it is entangled with, or null. */
  partner: string | null;
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
  /** A missing thing is matched over the whole frame again, when the view changed, at most this often, ms. */
  missingLookMs: 10_000,
  /** Two look-alikes entangle when their boxes come within this many box widths while one moves. */
  nearWidths: 1,
  /** A step counts as moving the box when it moved this share of its width or more. */
  movedShare: 0.25,
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
    partner: null,
  };
}

const WHOLE: UnitBox = { x: 0, y: 0, width: 1, height: 1 };
// Where it stands, as the rules judge it on the frame (`footInZone`): near its box's bottom centre.
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
    if (motion <= LOCAL_TRACK.motionShare) {
      // Put back somewhere else while nobody was near where it was: look over the
      // whole frame now and then, once the view has changed, with no model call.
      const { width: tw, height: th } = thing.track.template;
      const changed =
        frameMotion(thing.track.previous, frame, WHOLE) * frame.width * frame.height >=
        (tw * th) / 4;
      if (!changed || now - thing.lastAsk < WATCH.missingLookMs)
        return { thing: { ...thing, track }, ask: null, refind: false, place: false };
      const match = matchTemplate(frame, thing.track.template, thing.track.box, 1, exclude);
      const found =
        match && match.score >= LOCAL_TRACK.lostScore && match.lead >= LOCAL_TRACK.minLead;
      if (!found)
        return { thing: { ...thing, track, lastAsk: now }, ask: null, refind: false, place: false };
      return {
        thing: {
          ...thing,
          track: { ...track, box: match.box, score: match.score, lead: match.lead, lostSteps: 0 },
          status: 'following',
          layer: 'local',
          lastAsk: now,
          misses: 0,
          refound: false,
          reanchorGap: WATCH.reanchorGapMs.first,
        },
        ask: null,
        refind: false,
        place: false,
      };
    }
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
    (thing.status === 'following' || thing.status === 'entangled') &&
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
        track: { ...thing.track, previous: frame, motion, stillSteps, velocity: { x: 0, y: 0 } },
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
    layer: thing.status === 'unsure' ? 'local' : thing.layer,
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
const sameConcept = (a: WatchThing, b: WatchThing) =>
  a.subject.concept.trim().toLowerCase() === b.subject.concept.trim().toLowerCase();
/** Whether two boxes are within `WATCH.nearWidths` box widths of each other. */
function near(a: UnitBox, b: UnitBox) {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy) < WATCH.nearWidths * Math.max(a.width, b.width);
}
/**
 * One frame for every followed thing together. Each one's search skips the
 * others' boxes, so a lost thing can't settle on a look-alike that is already
 * followed (it stays lost and goes on to the feature model and SAM), and two
 * look-alikes side by side aren't each other's runner-up. If two boxes still
 * end up on one place, the thing that came further gives way: it holds its
 * last box and counts as lost for the step, and nothing is judged for it.
 * `hold` are things SAM is being asked about: they aren't stepped, but their
 * boxes are kept clear. Boxes that already overlapped (a phone on a book, two mugs
 * touching) aren't kept off each other.
 *
 * Two things of one concept that come close while either moves are
 * entangled: both are followed, but neither's zones are judged. Once they
 * are apart and still, each one's template is scored on both places and the
 * two are assigned jointly (`assignTracks`); with a margin of `MULTI.minMargin`
 * they are sure again (swapped, if that is what their looks say), else they
 * stay entangled until a person confirms one.
 */
export function watchFrame(
  things: WatchThing[],
  frame: LumaFrame,
  now: number,
  pace: { quietSteps?: number; placeGapMs?: number } = {},
  hold: ReadonlySet<string> = new Set(),
): Map<string, WatchStepResult> {
  const shown = (t: WatchThing) => t.status !== 'missing';
  const apart = (a: WatchThing, b: WatchThing) =>
    boxIoU(a.track.box, b.track.box) < LOCAL_TRACK.claimIoU;
  const steps = new Map<string, WatchStepResult>();
  for (const t of things) {
    if (hold.has(t.subject.id)) continue;
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
  entangle(things, steps, frame, pace.quietSteps ?? WATCH.quietSteps);
  return steps;
}

/** Entangles look-alikes that came close while moving, and lets go of pairs whose looks tell them apart. */
function entangle(
  things: WatchThing[],
  steps: Map<string, WatchStepResult>,
  frame: LumaFrame,
  quietSteps: number,
) {
  const after = (t: WatchThing) => steps.get(t.subject.id)?.thing ?? t;
  const partner = new Map(things.map((t) => [t.subject.id, t.partner]));
  const stepped = things.filter((t) => steps.has(t.subject.id) && t.status !== 'missing');
  for (let i = 0; i < stepped.length; i++)
    for (let j = i + 1; j < stepped.length; j++) {
      const a = stepped[i]!;
      const b = stepped[j]!;
      if (!sameConcept(a, b)) continue;
      const [na, nb] = [after(a).track.box, after(b).track.box];
      const moving = (t: WatchThing, n: UnitBox) =>
        Math.hypot(n.x - t.track.box.x, n.y - t.track.box.y) >= WATCH.movedShare * n.width;
      if (near(na, nb) && (moving(a, na) || moving(b, nb))) {
        partner.set(a.subject.id, b.subject.id);
        partner.set(b.subject.id, a.subject.id);
      }
    }
  // A partner forgotten, or entangled with another since, lets this one go.
  for (const [id, p] of partner)
    if (p !== null && partner.get(p) !== id && steps.has(id)) partner.set(id, null);
  for (const a of stepped) {
    const p = partner.get(a.subject.id);
    const b = stepped.find((t) => t.subject.id === p);
    if (!b || a.subject.id > b.subject.id) continue;
    const [ta, tb] = [after(a), after(b)];
    const ready = (t: WatchThing) => !t.track.lostSteps && t.track.stillSteps >= quietSteps;
    if (!ready(ta) || !ready(tb) || near(ta.track.box, tb.track.box)) continue;
    // Each one's look, scored where each of them is now.
    const score = (t: WatchThing, at: UnitBox) =>
      matchTemplate(frame, t.track.template, at, 0)?.score ?? -1;
    const { pick, margins } = assignTracks([
      [1 - score(ta, ta.track.box), 1 - score(ta, tb.track.box)],
      [1 - score(tb, ta.track.box), 1 - score(tb, tb.track.box)],
    ]);
    if (pick[0] === null || pick[1] === null) continue;
    if (Math.min(margins[0] ?? 0, margins[1] ?? 0) < MULTI.minMargin) continue;
    if (pick[0] === 1) {
      // Their looks say they swapped: each takes the other's place.
      const [ba, bb] = [ta.track.box, tb.track.box];
      steps.set(a.subject.id, {
        ...steps.get(a.subject.id)!,
        thing: { ...ta, track: { ...ta.track, box: bb } },
      });
      steps.set(b.subject.id, {
        ...steps.get(b.subject.id)!,
        thing: { ...tb, track: { ...tb.track, box: ba } },
      });
    }
    partner.set(a.subject.id, null);
    partner.set(b.subject.id, null);
  }
  for (const [id, step] of steps) {
    const p = partner.get(id) ?? null;
    if (p === null) {
      if (step.thing.partner !== null)
        steps.set(id, { ...step, thing: { ...step.thing, partner: null } });
      continue;
    }
    const lost = step.thing.track.lostSteps > 0;
    steps.set(id, {
      ...step,
      thing: {
        ...step.thing,
        partner: p,
        status: lost ? 'unsure' : 'entangled',
        crossingSteps: 0,
        crossedAt: null,
      },
      place: false,
    });
  }
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

/**
 * The feature model found it: follow from there. On `frame` (the grey frame
 * it was found in), its template's pixels are read again where it is now, so
 * it isn't matched against the desk it stood on before, and found only once
 * all was still, its zones are judged at the next still step.
 */
export function refound(thing: WatchThing, box: UnitBox, frame?: LumaFrame): WatchThing {
  const template = frame && recutTemplate(thing.track.template, frame, box);
  const crossed = thing.subject.zones.some((z) => inZone(box, z.rect) !== z.inside);
  return {
    ...thing,
    track: {
      ...thing.track,
      box,
      lostSteps: 0,
      ...(template
        ? {
            template,
            previous: frame,
            stillSteps: WATCH.quietSteps,
            velocity: { x: 0, y: 0 },
          }
        : {}),
    },
    status: 'following',
    layer: 'appearance',
    crossingSteps: template && crossed ? WATCH.settleSteps - 1 : 0,
    crossedAt: null,
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
  /** `paused`: following goes on, but SAM can't be asked though tracking may call it (spending limit, live calls off). */
  state: 'off' | 'starting' | 'watching' | 'paused' | 'camera_lost';
  note: string;
  camera: { id: string; name: string } | null;
  /** Whether the feature model is loaded, so lost things are looked for before SAM is asked. */
  appearance: boolean;
  /** Whether tracking may call SAM; without it a lost thing is looked for on this machine only. */
  ai: boolean;
  frames: number;
  checks: number;
  refinds: number;
  /** Each thing's stats now, by thing id; only changes make a new message. */
  stats?: StatsNow;
  things: {
    id: string;
    kind: WatchKind;
    label: string;
    status: WatchStatus;
    layer: WatchLayer;
    box: UnitBox;
    score: number;
    /** Followed from the whole shape drawn round it, not an outline (`Detection.boxOnly`). */
    boxOnly?: true;
  }[];
}
