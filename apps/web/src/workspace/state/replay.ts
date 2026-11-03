import { useEffect } from 'react';
import { DAY_END, DAY_START } from '../demoDay';
import { createStore, useStore } from './store';

/**
 * The day replay: whether it is open, the minute of the sample day shown, and
 * whether it plays. In a store, since the minute changes many times a second
 * while playing and only the room, the dock and the nudges show it.
 */
interface Replay {
  open: boolean;
  minute: number;
  playing: boolean;
  /** Minutes of the day a second of playing covers. */
  speed: number;
}

export const REPLAY_SPEEDS = [15, 45, 120] as const;

const replayStore = createStore<Replay>({
  open: false,
  minute: 17 * 60 + 30,
  playing: false,
  speed: REPLAY_SPEEDS[1],
});

export function useReplay<S>(select: (r: Replay) => S): S {
  return useStore(replayStore, select);
}

export function setReplay(next: Partial<Replay>) {
  replayStore.set((r) => ({ ...r, ...next }));
}

/** Advance the minute while playing, stopping at the day's end. */
export function useReplayClock() {
  const playing = useReplay((r) => r.open && r.playing);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const r = replayStore.get();
      const minute = Math.min(DAY_END, r.minute + ((now - last) / 1000) * r.speed);
      last = now;
      setReplay({ minute, playing: minute < DAY_END });
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);
}

/** Start from the morning when played at the day's end. */
export function playReplay() {
  const r = replayStore.get();
  setReplay({ playing: true, minute: r.minute >= DAY_END ? DAY_START : r.minute });
}
