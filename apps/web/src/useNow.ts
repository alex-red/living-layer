import { useSyncExternalStore } from 'react';

/** One clock per period, shared by every component that reads it: N callers, one timer. */
interface Clock {
  now: number;
  listeners: Set<() => void>;
  timer: number | undefined;
  subscribe: (listener: () => void) => () => void;
  read: () => number;
}
const clocks = new Map<number, Clock>();

function clockOf(intervalMs: number): Clock {
  const known = clocks.get(intervalMs);
  if (known) return known;
  const clock: Clock = {
    now: Date.now(),
    listeners: new Set(),
    timer: undefined,
    subscribe(listener) {
      clock.listeners.add(listener);
      if (clock.timer === undefined) {
        clock.timer = window.setInterval(() => {
          clock.now = Date.now();
          for (const l of clock.listeners) l();
        }, intervalMs);
      }
      return () => {
        clock.listeners.delete(listener);
        if (!clock.listeners.size && clock.timer !== undefined) {
          window.clearInterval(clock.timer);
          clock.timer = undefined;
        }
      };
    },
    read() {
      // A clock nobody has watched for a while catches up before its first reader shows it.
      if (clock.timer === undefined && Date.now() - clock.now >= intervalMs) clock.now = Date.now();
      return clock.now;
    },
  };
  clocks.set(intervalMs, clock);
  return clock;
}

/**
 * The time now, updated every `intervalMs`. Call it in the component that shows
 * a time-dependent label, so the tick re-renders that component alone. Every
 * caller with the same period shares one timer and ticks together.
 */
export function useNow(intervalMs = 1000) {
  const clock = clockOf(intervalMs);
  return useSyncExternalStore(clock.subscribe, clock.read, clock.read);
}
