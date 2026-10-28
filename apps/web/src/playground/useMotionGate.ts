import { useEffect, useRef, useState, type RefObject } from 'react';

export type Stillness = 'moving' | 'settling' | 'still';

export interface MotionReading {
  /** Share of sampled pixels that changed since the last sample, 0–100. */
  score: number;
  state: Stillness;
  /** Milliseconds since the last frame above the threshold. */
  stillFor: number;
  /** Recent scores, oldest first. */
  history: number[];
  /** Coarse grid of changed regions, row-major, for the optional overlay. */
  cells: boolean[];
  columns: number;
  rows: number;
}

const SAMPLE_WIDTH = 64;
const CELL = 4;
const PIXEL_DELTA = 24;
const SAMPLE_MS = 80;
const HISTORY = 90;

const idle: MotionReading = {
  score: 0,
  state: 'settling',
  stillFor: 0,
  history: [],
  cells: [],
  columns: 0,
  rows: 0,
};

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
): MotionReading {
  const [reading, setReading] = useState<MotionReading>(idle);
  const options = useRef({ threshold, settleMs });
  options.current = { threshold, settleMs };

  useEffect(() => {
    if (!active) {
      setReading(idle);
      return;
    }
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    let previous: Uint8Array | null = null;
    let lastSample = 0;
    let lastMotion = performance.now();
    let history: number[] = [];
    let frame = 0;

    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      const el = video.current;
      if (t - lastSample < SAMPLE_MS || !el?.videoWidth) return;
      lastSample = t;
      const width = SAMPLE_WIDTH;
      const height = Math.max(CELL, Math.round((width * el.videoHeight) / el.videoWidth));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        previous = null;
      }
      context.drawImage(el, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      const luma = new Uint8Array(width * height);
      for (let i = 0; i < luma.length; i++)
        luma[i] = (pixels[i * 4]! * 77 + pixels[i * 4 + 1]! * 150 + pixels[i * 4 + 2]! * 29) >> 8;

      const columns = Math.floor(width / CELL);
      const rows = Math.floor(height / CELL);
      const counts = new Array<number>(columns * rows).fill(0);
      let changed = 0;
      if (previous) {
        for (let i = 0; i < luma.length; i++) {
          if (Math.abs(luma[i]! - previous[i]!) <= PIXEL_DELTA) continue;
          changed++;
          const cell =
            Math.floor(Math.floor(i / width) / CELL) * columns + Math.floor((i % width) / CELL);
          if (cell < counts.length) counts[cell]!++;
        }
      }
      previous = luma;

      const score = (changed / luma.length) * 100;
      if (score >= options.current.threshold) lastMotion = t;
      const stillFor = t - lastMotion;
      history = [...history.slice(1 - HISTORY), score];
      setReading({
        score,
        state:
          score >= options.current.threshold
            ? 'moving'
            : stillFor < options.current.settleMs
              ? 'settling'
              : 'still',
        stillFor,
        history,
        cells: counts.map((n) => n > (CELL * CELL) / 4),
        columns,
        rows,
      });
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, video]);

  return reading;
}
