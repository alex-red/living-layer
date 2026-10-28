import { describe, expect, it } from 'bun:test';
import {
  cutTemplate,
  matchTemplate,
  startLocalTrack,
  stepLocalTrack,
  toLuma,
  type LumaFrame,
  type UnitBox,
} from '@livinglayer/domain';

const W = 160;
const H = 100;
/** Deterministic noise, so every run sees the same pixels. */
function noise(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s >>> 24;
  };
}
/** A noisy desk with a differently textured 20×24 "mug" at (x, y). */
function scene(x: number, y: number, mug = true): LumaFrame {
  const desk = noise(1);
  const data = new Uint8Array(W * H);
  for (let i = 0; i < data.length; i++) data[i] = 60 + (desk() >> 2);
  if (mug) {
    const texture = noise(7);
    for (let j = 0; j < 24; j++)
      for (let i = 0; i < 20; i++) data[(y + j) * W + x + i] = 120 + (texture() >> 1);
  }
  return { width: W, height: H, data };
}
const box = (x: number, y: number): UnitBox => ({
  x: x / W,
  y: y / H,
  width: 20 / W,
  height: 24 / H,
});

describe('local tracker', () => {
  it('converts RGBA to luma', () => {
    const luma = toLuma(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1);
    expect([...luma.data]).toEqual([255, 0]);
  });

  it('refuses a template that is too small or flat', () => {
    expect(cutTemplate(scene(30, 30), { x: 0.2, y: 0.3, width: 2 / W, height: 2 / H })).toBeNull();
    const flat = { width: W, height: H, data: new Uint8Array(W * H).fill(90) };
    expect(cutTemplate(flat, box(30, 30))).toBeNull();
  });

  it('finds the mug after it moves', () => {
    const template = cutTemplate(scene(30, 30), box(30, 30))!;
    const match = matchTemplate(scene(55, 45), template, box(30, 30))!;
    expect(match.score).toBeGreaterThan(0.99);
    expect(match.box.x * W).toBeCloseTo(55);
    expect(match.box.y * H).toBeCloseTo(45);
  });

  it('follows without asking while nothing crosses the zone', () => {
    const track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
    const zone = { x: 0.7, y: 0.5, width: 0.29, height: 0.49 };
    const step = stepLocalTrack(track, scene(40, 32), zone);
    expect(step.verdict).toBe('follow');
    expect(step.track.box.x * W).toBeCloseTo(40);
  });

  it('asks SAM to confirm once the box settles inside the zone', () => {
    let track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
    const zone = { x: 0.4, y: 0.4, width: 0.59, height: 0.59 };
    const verdicts = [1, 2, 3].map(() => {
      const step = stepLocalTrack(track, scene(65, 45), zone, { settleSteps: 3 });
      track = step.track;
      return step.verdict;
    });
    expect(verdicts).toEqual(['follow', 'follow', 'confirm']);
  });

  it('asks SAM to confirm leaving the zone too', () => {
    const zone = { x: 0, y: 0, width: 0.4, height: 0.9 };
    const track = startLocalTrack(scene(30, 30), box(30, 30), true)!;
    expect(stepLocalTrack(track, scene(65, 45), zone, { settleSteps: 1 }).verdict).toBe('confirm');
  });

  it('asks SAM to re-anchor when the mug disappears', () => {
    let track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
    const verdicts = [1, 2].map(() => {
      const step = stepLocalTrack(track, scene(0, 0, false), null, { lostSteps: 2 });
      track = step.track;
      return step.verdict;
    });
    expect(verdicts).toEqual(['follow', 'reanchor']);
  });

  it('loses a mug that jumps beyond the search radius', () => {
    const track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
    expect(stepLocalTrack(track, scene(110, 60), null, { lostSteps: 1 }).verdict).toBe('reanchor');
  });
});
