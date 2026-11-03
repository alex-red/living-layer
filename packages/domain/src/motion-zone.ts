/**
 * A motion zone: no things to count, only pixels that change between one
 * camera frame and the next. Motion starts once enough of the zone changes
 * for a few frames running, and stops after it has been still a while. A
 * frame where much of the whole picture changes is a light switched or the
 * camera's exposure, not motion, and so is the moment after a zone switched a
 * light itself: either would otherwise set every zone off, and loop.
 */
import { z } from 'zod';

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
