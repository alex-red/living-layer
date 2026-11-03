/**
 * A motion zone: no things to count, only pixels that change between one
 * camera frame and the next. Motion starts once enough of the zone changes
 * for a few frames running, and stops after it has been still a while. A
 * frame where much of the whole picture changes is a light switched or the
 * camera's exposure, not motion, and so is the moment after a zone switched a
 * light itself: either would otherwise set every zone off, and loop.
 *
 * Zones side by side contest a start: an arm reaching for one crosses its
 * neighbour first, so the first to move isn't the one touched. From the
 * first motion among them they gather it a moment, the latest counting most,
 * and only the one moving most by then starts: where the hand got to.
 */
import { z } from 'zod';
import { around, type UnitBox } from './tracker.js';

export interface MotionTrigger {
  /** Share of the zone's pixels that must change between frames, 0–1. */
  share: number;
  /** Seconds without motion before it counts as stopped. */
  quietS: number;
}

export const MOTION_ZONE = {
  /** A new motion zone's share: a hand, not the stream's noise. */
  share: 0.06,
  quietS: 5,
  /** Frames running over the share before motion starts. */
  startFrames: 2,
  /** A frame where this share of the whole picture changed is a lighting change, ignored. */
  lightShare: 0.25,
  /** How long motion is ignored after a motion zone switched something, ms. */
  settleMs: 2500,
  /** How long neighbouring zones gather motion, from the first, before one starts, ms. */
  contestMs: 500,
  /** Gathered motion halves in this long, so the latest counts most, ms. */
  contestHalfLifeMs: 200,
  /** A contest with a zone ready to start ends early once its group has been still this long, ms. */
  contestQuietMs: 200,
  minShare: 0.01,
  maxShare: 0.5,
  maxQuietS: 600,
};

export const motionTriggerSchema = z
  .object({
    share: z.number().min(MOTION_ZONE.minShare).max(MOTION_ZONE.maxShare),
    quietS: z.number().int().min(1).max(MOTION_ZONE.maxQuietS),
  })
  .strict() satisfies z.ZodType<MotionTrigger>;

/** Where a motion zone is: moving or still, and what led there. */
export interface MotionState {
  moving: boolean;
  /** Frames in a row over the share while still. */
  streak: number;
  /** When it last saw motion, ms. */
  lastAt: number;
}
export const STILL: MotionState = { moving: false, streak: 0, lastAt: 0 };

/**
 * One frame's step: the zone's changed share and the whole picture's, at
 * `now`. Says `started` or `stopped` on the frame it changes; frames during a
 * lighting change, or while `settledAt` hasn't come, neither start nor keep
 * motion going.
 */
export function nextMotion(
  state: MotionState,
  trigger: MotionTrigger,
  frame: {
    share: number;
    whole: number;
    now: number;
    settledAt?: number;
    /** Frames running before motion starts; the demo's frames change one move at a time. */
    startFrames?: number;
  },
): { state: MotionState; event: 'started' | 'stopped' | null } {
  const ignored = frame.whole >= MOTION_ZONE.lightShare || frame.now < (frame.settledAt ?? 0);
  const moved = !ignored && frame.share >= trigger.share;
  if (state.moving) {
    if (moved) return { state: { ...state, lastAt: frame.now }, event: null };
    return frame.now - state.lastAt >= trigger.quietS * 1000
      ? { state: { moving: false, streak: 0, lastAt: state.lastAt }, event: 'stopped' }
      : { state, event: null };
  }
  if (!moved) return { state: { ...state, streak: 0 }, event: null };
  const streak = state.streak + 1;
  return streak >= (frame.startFrames ?? MOTION_ZONE.startFrames)
    ? { state: { moving: true, streak: 0, lastAt: frame.now }, event: 'started' }
    : { state: { ...state, streak, lastAt: frame.now }, event: null };
}

export interface MotionZone {
  id: string;
  rect: UnitBox;
  trigger: MotionTrigger;
  /** Whether it has steps to run when motion starts, and when it stops. */
  steps: { started: boolean; stopped: boolean };
}
/** Neighbours deciding which of them starts. */
interface MotionContest {
  /** When the first of them moved, and the last. */
  since: number;
  movedAt: number;
  /** When `sums` were last faded. */
  at: number;
  /** Each one's motion so far, fading. */
  sums: Record<string, number>;
  /** Those that moved long enough to start on their own. */
  ready: string[];
}
/** Every motion zone's state, and the contests open between neighbours (by their first zone). */
export interface MotionZones {
  zones: Record<string, MotionState>;
  contests: Record<string, MotionContest>;
}
export const ALL_STILL: MotionZones = { zones: {}, contests: {} };

const touches = (a: UnitBox, b: UnitBox) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Zones that touch once each is grown by its own size, joined into groups: those reachable past one another. */
function neighbourhoods(zones: readonly MotionZone[]): MotionZone[][] {
  const near = (a: MotionZone, b: MotionZone) =>
    touches(around(a.rect), b.rect) || touches(around(b.rect), a.rect);
  const groups: MotionZone[][] = [];
  const seen = new Set<string>();
  for (const zone of zones) {
    if (seen.has(zone.id)) continue;
    seen.add(zone.id);
    const group = [zone];
    for (let i = 0; i < group.length; i++)
      for (const other of zones)
        if (!seen.has(other.id) && near(group[i]!, other)) {
          seen.add(other.id);
          group.push(other);
        }
    groups.push(group);
  }
  return groups;
}

/**
 * One frame's step for every motion zone, each zone's changed share in
 * `shares`. A zone alone steps as `nextMotion` says. Still zones with
 * neighbours contest a start instead: from the first frame one of them moves,
 * for `contestMs` or until they have been still `contestQuietMs`, each adds
 * up the shares it moves by, fading by half every `contestHalfLifeMs`. Then
 * of those that moved long enough to start, the one with the most starts and
 * the rest stay still. Zones already moving aren't held.
 * `settle` says whether a zone that started or stopped runs steps for it: only
 * then may a light have switched, for every zone to wait out.
 */
export function stepMotionZones(
  zones: readonly MotionZone[],
  was: MotionZones,
  frame: {
    shares: Record<string, number>;
    whole: number;
    now: number;
    settledAt?: number;
    startFrames?: number;
    /** The demo's frames come only when something moves, so it decides on the frame. */
    contestMs?: number;
  },
): {
  state: MotionZones;
  events: { id: string; event: 'started' | 'stopped' }[];
  settle: boolean;
} {
  const { whole, now, settledAt, startFrames } = frame;
  const contestMs = frame.contestMs ?? MOTION_ZONE.contestMs;
  const ignored = whole >= MOTION_ZONE.lightShare || now < (settledAt ?? 0);
  const state: MotionZones = { zones: {}, contests: {} };
  const events: { id: string; event: 'started' | 'stopped' }[] = [];
  for (const group of neighbourhoods(zones)) {
    const key = group[0]!.id;
    const open = was.contests[key];
    const fade = open ? 0.5 ** ((now - open.at) / MOTION_ZONE.contestHalfLifeMs) : 1;
    const sums: Record<string, number> = {};
    for (const [id, sum] of Object.entries(open?.sums ?? {})) sums[id] = sum * fade;
    const ready = new Set(open?.ready);
    let moved = false;
    for (const zone of group) {
      const from = was.zones[zone.id] ?? STILL;
      const share = frame.shares[zone.id] ?? 0;
      const step = nextMotion(from, zone.trigger, {
        share,
        whole,
        now,
        ...(settledAt !== undefined ? { settledAt } : {}),
        ...(startFrames !== undefined ? { startFrames } : {}),
      });
      if (from.moving || group.length === 1) {
        state.zones[zone.id] = step.state;
        if (step.event) events.push({ id: zone.id, event: step.event });
        continue;
      }
      if (!ignored && share >= zone.trigger.share) {
        sums[zone.id] = (sums[zone.id] ?? 0) + share;
        moved = true;
      }
      if (step.event === 'started') ready.add(zone.id);
      state.zones[zone.id] = step.event ? { ...step.state, moving: false } : step.state;
    }
    if (!open && !moved) continue;
    const since = open?.since ?? now;
    const movedAt = moved ? now : open!.movedAt;
    const over =
      now - since >= contestMs || (ready.size > 0 && now - movedAt >= MOTION_ZONE.contestQuietMs);
    if (!over) {
      state.contests[key] = { since, movedAt, at: now, sums, ready: [...ready] };
      continue;
    }
    let winner: MotionZone | null = null;
    for (const zone of group)
      if (ready.has(zone.id) && (sums[zone.id] ?? 0) > (winner ? sums[winner.id]! : 0))
        winner = zone;
    for (const zone of group)
      if (!state.zones[zone.id]!.moving)
        state.zones[zone.id] =
          zone === winner
            ? { moving: true, streak: 0, lastAt: now }
            : { ...state.zones[zone.id]!, streak: 0 };
    if (winner) events.push({ id: winner.id, event: 'started' });
  }
  const settle = events.some((e) => zones.find((z) => z.id === e.id)?.steps[e.event]);
  return { state, events, settle };
}
