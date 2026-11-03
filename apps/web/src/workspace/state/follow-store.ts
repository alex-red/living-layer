import { HealthMeter } from '@livinglayer/domain';
import type { LocalTrack, LocalVerdict, TrackHealth } from '@livinglayer/domain';
import { FOLLOW_MS } from './helpers';
import { createStore, useStore } from './store';

/** What local following sees now, ten times a second: the tracker's box and what it wants done. */
interface FollowView {
  track: LocalTrack;
  verdict: LocalVerdict;
}
/** How many local steps and SAM checks following has made since it started. */
interface FollowStats {
  frames: number;
  checks: number;
}

export const followViewStore = createStore<FollowView | null>(null);
export const followStatsStore = createStore<FollowStats>({ frames: 0, checks: 0 });
/** How local following keeps up with the video, for its bar over the camera. */
export const followHealthStore = createStore<TrackHealth | null>(null);

/** The local follower's newest box. Only the components that draw it render at its rate. */
export const useFollowView = () => useStore(followViewStore);
export const useFollowStats = () => useStore(followStatsStore);

/** Late ticks kept: the worst of them is the main thread's drift. */
const DRIFT_TICKS = 20;
let meter: HealthMeter | null = null;
let videoAt = -1;
let tickAt = 0;
let drifts: number[] = [];

/**
 * The local follower's health, measured in its loop: each step's work, and
 * when the video gave a new frame. A tab can't read its CPU, so the main
 * thread's load shows as the share of time on steps and how late ticks run.
 */
export const followHealth = {
  /** Following started: live frames are wanted at the loop's rate; demo ones come a move at a time. */
  start(paced: boolean) {
    meter = new HealthMeter(1000 / FOLLOW_MS, paced);
    videoAt = -1;
    tickAt = 0;
    drifts = [];
    followHealthStore.set(null);
  },
  /** The loop starts again after a pause (a SAM check): the gap isn't a late tick. */
  resume() {
    tickAt = 0;
  },
  /** One step at `at` (ms), `workMs` long, on the video at `videoTime` (live) or a demo move. */
  step(at: number, workMs: number, videoTime?: number) {
    if (!meter) return;
    // A tick that read the same video frame again isn't a new frame: a frozen camera stalls.
    if (videoTime === undefined || videoTime !== videoAt) meter.frame(at, workMs);
    if (videoTime !== undefined) {
      videoAt = videoTime;
      if (tickAt) drifts.push(Math.max(0, at - tickAt - FOLLOW_MS));
      if (drifts.length > DRIFT_TICKS) drifts.shift();
      tickAt = at;
    }
    const view = followViewStore.get();
    followHealthStore.set(
      meter.read(at, {
        driftMs: drifts.length ? Math.round(Math.max(...drifts)) : null,
        looking: view && view.verdict !== 'follow' ? 1 : 0,
        lost: view?.verdict === 'reanchor' ? 1 : 0,
        things: 1,
      }),
    );
  },
  stop() {
    meter = null;
    followHealthStore.set(null);
  },
};
