import { useRef, useState } from 'react';
import type { LocalTrack } from '@livinglayer/domain';
import { followViewStore } from './follow-store';
import { REANCHOR_GAP_MS } from './helpers';

/** The FollowState slice of the lab's state. */
export function useFollowStateSlice() {
  // Local following: the tracker lives in a ref so the sampling loop never waits on a render.
  const [follow, setFollow] = useState(false);
  const localTrack = useRef<LocalTrack | null>(null);
  const lastCheck = useRef(0);
  const reanchorGap = useRef(REANCHOR_GAP_MS.first);
  const goodSteps = useRef(0);
  function stopFollow() {
    localTrack.current = null;
    setFollow(false);
    followViewStore.set(null);
  }
  return {
    follow,
    goodSteps,
    lastCheck,
    localTrack,
    reanchorGap,
    setFollow,
    stopFollow,
  };
}
export type FollowStateSlice = ReturnType<typeof useFollowStateSlice>;
