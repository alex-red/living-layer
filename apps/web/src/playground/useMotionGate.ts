import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

export type Stillness = 'moving' | 'settling' | 'still';

/**
 * The latest sample, kept outside React: it changes 12 times a second, so only
 * the small parts that draw it (`useMotionSample`) render on each one. Its
 * arrays are reused from sample to sample; read them while rendering, don't keep them.
 */
interface MotionSample {
  /** Counts samples, so a reader can tell a new one from the last. */
  seq: number;
  /** Share of sampled pixels that changed since the last sample, 0–100. */
  score: number;
  /** Milliseconds since the last frame above the threshold. */
  stillFor: number;
  /** Recent scores as a ring: `count` of them, the oldest at `start`. */
  history: Float64Array;
  start: number;
  count: number;
  /** Coarse grid of changed regions, row-major (1 for motion), for the optional overlay. */
  cells: Uint8Array;
  columns: number;
  rows: number;
}

/** The gate's state, which the page renders on, and its samples, which only the readouts do. */
export interface MotionGate {
  state: Stillness;
  /** The latest sample, read when it is needed (as a capture does) without rendering on it. */
  read(): MotionSample;
  subscribe(listener: () => void): () => void;
}

const SAMPLE_WIDTH = 64;
const CELL = 4;
const PIXEL_DELTA = 24;
const SAMPLE_MS = 80;
export const HISTORY = 90;

const blank = (): MotionSample => ({
  seq: 0,
  score: 0,
  stillFor: 0,
  history: new Float64Array(HISTORY),
  start: 0,
  count: 0,
  cells: new Uint8Array(0),
  columns: 0,
  rows: 0,
});

/** Each recent score, oldest first. */
export function eachScore(sample: MotionSample, fn: (score: number, i: number) => void) {
  for (let i = 0; i < sample.count; i++) fn(sample.history[(sample.start + i) % HISTORY]!, i);
}

/** The gate's latest sample, rendering the caller on each new one. */
export function useMotionSample(gate: MotionGate): MotionSample {
  useSyncExternalStore(gate.subscribe, () => gate.read().seq);
  return gate.read();
}

/**
 * Cheap local motion detection: downsample each frame to 64 px wide, convert
 * to luma, and count pixels that changed by more than a fixed delta. Nothing
 * leaves the browser. This is the fast half of the two-speed design: the slow
 * models only run on a frame the gate has called still.
 */
export function useMotionGate(
  video: RefObject<HTMLVideoElement | null>,
  active: boolean,
  { threshold, settleMs }: { threshold: number; settleMs: number },
): MotionGate {
  const [state, setState] = useState<Stillness>('settling');
  const options = useRef({ threshold, settleMs });
  options.current = { threshold, settleMs };
  // One sample object and its listeners for the hook's life; only `seq` tells readers it changed.
  const [feed] = useState(() => {
    const sample = blank();
    const listeners = new Set<() => void>();
    return {
      sample,
      read: () => sample,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      publish() {
        sample.seq++;
        for (const listener of [...listeners]) listener();
      },
    };
  });

  useEffect(() => {
    const sample = feed.sample;
    const reset = () => {
      sample.score = 0;
      sample.stillFor = 0;
      sample.start = 0;
      sample.count = 0;
      sample.cells.fill(0);
      sample.columns = 0;
      sample.rows = 0;
      feed.publish();
    };
    if (!active) {
      reset();
      setState('settling');
      return;
    }
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    // Two luma buffers, swapped each sample, and the per-cell counts, all kept while the size holds.
    let luma = new Uint8Array(0);
    let previous = new Uint8Array(0);
    let hasPrevious = false;
    let counts = new Uint16Array(0);
    let lastSample = 0;
    let lastMotion = performance.now();
    let frame = 0;

    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      const el = video.current;
      if (t - lastSample < SAMPLE_MS || !el?.videoWidth) return;
      lastSample = t;
      const width = SAMPLE_WIDTH;
      const height = Math.max(CELL, Math.round((width * el.videoHeight) / el.videoWidth));
      const columns = Math.floor(width / CELL);
      const rows = Math.floor(height / CELL);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        luma = new Uint8Array(width * height);
        previous = new Uint8Array(width * height);
        hasPrevious = false;
        counts = new Uint16Array(columns * rows);
        sample.cells = new Uint8Array(columns * rows);
      }
      context.drawImage(el, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      for (let i = 0; i < luma.length; i++)
        luma[i] = (pixels[i * 4]! * 77 + pixels[i * 4 + 1]! * 150 + pixels[i * 4 + 2]! * 29) >> 8;

      counts.fill(0);
      let changed = 0;
      if (hasPrevious) {
        for (let i = 0; i < luma.length; i++) {
          if (Math.abs(luma[i]! - previous[i]!) <= PIXEL_DELTA) continue;
          changed++;
          const cell =
            Math.floor(Math.floor(i / width) / CELL) * columns + Math.floor((i % width) / CELL);
          if (cell < counts.length) counts[cell]!++;
        }
      }
      [previous, luma] = [luma, previous];
      hasPrevious = true;

      const score = (changed / previous.length) * 100;
      const { threshold: limit, settleMs: settle } = options.current;
      if (score >= limit) lastMotion = t;
      const stillFor = t - lastMotion;
      sample.score = score;
      sample.stillFor = stillFor;
      if (sample.count < HISTORY) sample.history[(sample.start + sample.count++) % HISTORY] = score;
      else {
        sample.history[sample.start] = score;
        sample.start = (sample.start + 1) % HISTORY;
      }
      for (let i = 0; i < counts.length; i++)
        sample.cells[i] = counts[i]! > (CELL * CELL) / 4 ? 1 : 0;
      sample.columns = columns;
      sample.rows = rows;
      feed.publish();
      // The page renders only when this changes.
      setState(score >= limit ? 'moving' : stillFor < settle ? 'settling' : 'still');
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, video, feed]);

  return { state, read: feed.read, subscribe: feed.subscribe };
}
