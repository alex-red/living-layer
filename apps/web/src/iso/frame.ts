import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** The latest of many values, handed on at most once a frame. */
interface FrameQueue<T> {
  /** Keep `value`; it is applied on the next animation frame unless a later one replaces it. */
  push(value: T): void;
  /** Apply what is waiting now (a drag that ends must not lose its last move). */
  flush(): void;
  /** Forget what is waiting. */
  cancel(): void;
}

const later =
  typeof requestAnimationFrame === 'function'
    ? (fn: () => void) => requestAnimationFrame(fn)
    : (fn: () => void) => setTimeout(fn, 16) as unknown as number;
const unlater =
  typeof cancelAnimationFrame === 'function'
    ? (id: number) => cancelAnimationFrame(id)
    : (id: number) => clearTimeout(id);

/**
 * Coalesces pointer moves: `apply` runs once a frame with the newest value,
 * so a drag re-renders at the screen's rate rather than the pointer's.
 */
export function useFrameQueue<T>(apply: (value: T) => void): FrameQueue<T> {
  const latest = useRef(apply);
  useLayoutEffect(() => {
    latest.current = apply;
  });
  const [queue] = useState<FrameQueue<T>>(() => {
    let frame: number | null = null;
    let waiting: { value: T } | null = null;
    const run = () => {
      frame = null;
      const w = waiting;
      waiting = null;
      if (w) latest.current(w.value);
    };
    return {
      push(value) {
        waiting = { value };
        if (frame === null) frame = later(run);
      },
      flush() {
        if (frame !== null) unlater(frame);
        run();
      },
      cancel() {
        if (frame !== null) unlater(frame);
        frame = null;
        waiting = null;
      },
    };
  });
  useEffect(() => () => queue.cancel(), [queue]);
  return queue;
}
