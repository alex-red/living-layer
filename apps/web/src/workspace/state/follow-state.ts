import { useRef, useState } from 'react';
import type { LocalTrack } from '@livinglayer/domain';
import { followHealth, followViewStore } from './follow-store';
import { REANCHOR_GAP_MS } from './helpers';
import { useStableSlice } from './stable';
import type { Dispatch, RefObject, SetStateAction } from 'react';

/** The FollowState slice of the lab's state. */
export function useFollowStateSlice(): FollowStateSlice {
  // Local following: the tracker lives in a ref so the sampling loop never waits on a render.
  const [follow, setFollow] = useState(false);
  const localTrack = useRef<LocalTrack | null>(null);
  const lastCheck = useRef(0);
  const reanchorGap = useRef(REANCHOR_GAP_MS.first);
  const goodSteps = useRef(0);
  /** Bumped when following stops, so an answer for the following before it is dropped. */
  const followGen = useRef(0);
  function stopFollow() {
    followGen.current++;
    localTrack.current = null;
    setFollow(false);
    followViewStore.set(null);
    followHealth.stop();
  }
  return useStableSlice({
    follow,
    followGen,
    goodSteps,
    lastCheck,
    localTrack,
    reanchorGap,
    setFollow,
    stopFollow,
  });
}
/** What the FollowState slice of the lab offers: its state, derived values and actions. */
export interface FollowStateSlice {
  follow: boolean;
  followGen: RefObject<number>;
  goodSteps: RefObject<number>;
  lastCheck: RefObject<number>;
  localTrack: RefObject<LocalTrack | null>;
  reanchorGap: RefObject<number>;
  setFollow: Dispatch<SetStateAction<boolean>>;
  stopFollow: () => void;
}
