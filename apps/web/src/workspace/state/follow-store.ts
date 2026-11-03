import type { LocalTrack, LocalVerdict } from '@livinglayer/domain';
import { createStore, useStore } from './store';

/** What local following sees now, ten times a second: the tracker's box and what it wants done. */
export interface FollowView {
  track: LocalTrack;
  verdict: LocalVerdict;
}
/** How many local steps and SAM checks following has made since it started. */
export interface FollowStats {
  frames: number;
  checks: number;
}

export const followViewStore = createStore<FollowView | null>(null);
export const followStatsStore = createStore<FollowStats>({ frames: 0, checks: 0 });

/** The local follower's newest box. Only the components that draw it render at its rate. */
export const useFollowView = () => useStore(followViewStore);
export const useFollowStats = () => useStore(followStatsStore);
