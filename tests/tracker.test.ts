import { describe, expect, it } from 'bun:test';
import {
  cutTemplate,
  frameMotion,
  matchTemplate,
  startLocalTrack,
  stepLocalTrack,
  toLuma,
  type LocalTrack,
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
/** A noisy desk with a differently textured 20×24 "mug" at (x, y), and optionally a twin. */
function scene(x: number, y: number, mug = true, twin?: { x: number; y: number }): LumaFrame {
  const desk = noise(1);
  const data = new Uint8Array(W * H);
  for (let i = 0; i < data.length; i++) data[i] = 60 + (desk() >> 2);
  for (const at of mug ? [{ x, y }, ...(twin ? [twin] : [])] : []) {
    const texture = noise(7);
    for (let j = 0; j < 24; j++)
      for (let i = 0; i < 20; i++) data[(at.y + j) * W + at.x + i] = 120 + (texture() >> 1);
  }
  return { width: W, height: H, data };
}
/**
 * A ring-shaped mug seen from above, 20×20, on a desk whose right half is a
 * near-white shirt. Half the ring's box is background, which changes under it.
 */
const ring = (i: number, j: number) => {
  const d = Math.hypot(i - 9.5, j - 9.5);
  return d >= 5 && d <= 10;
};
function shirtScene(x: number, y: number): { frame: LumaFrame; mask: Uint8Array } {
  const desk = noise(3);
  const data = new Uint8Array(W * H);
  const mask = new Uint8Array(W * H);
  for (let k = 0; k < data.length; k++)
    data[k] = k % W < 80 ? 60 + (desk() >> 2) : 225 + (desk() >> 5);
  const texture = noise(11);
  for (let j = 0; j < 20; j++)
    for (let i = 0; i < 20; i++) {
      const v = 150 + (texture() >> 2);
      if (!ring(i, j)) continue;
      data[(y + j) * W + x + i] = v;
      mask[(y + j) * W + x + i] = 1;
    }
  return { frame: { width: W, height: H, data }, mask };
}
const ringBox = (x: number, y: number): UnitBox => ({
  x: x / W,
  y: y / H,
  width: 20 / W,
  height: 20 / H,
});
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
      const step = stepLocalTrack(track, scene(65, 45), zone, { settleSteps: 3, quietSteps: 0 });
      track = step.track;
      return step.verdict;
    });
    expect(verdicts).toEqual(['follow', 'follow', 'confirm']);
  });

  it('asks SAM to confirm leaving the zone too', () => {
    const zone = { x: 0, y: 0, width: 0.4, height: 0.9 };
    const track = startLocalTrack(scene(30, 30), box(30, 30), true)!;
    expect(
      stepLocalTrack(track, scene(65, 45), zone, { settleSteps: 1, quietSteps: 0 }).verdict,
    ).toBe('confirm');
  });

  it('asks SAM to re-anchor when the mug disappears', () => {
    let track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
    const verdicts = [1, 2].map(() => {
      const step = stepLocalTrack(track, scene(0, 0, false), null, { lostSteps: 2, quietSteps: 0 });
      track = step.track;
      return step.verdict;
    });
    expect(verdicts).toEqual(['follow', 'reanchor']);
  });

  it('holds the box still while the match is weak', () => {
    const track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
    const step = stepLocalTrack(track, scene(0, 0, false), null);
    expect(step.track.box).toEqual(track.box);
    expect(step.track.lostSteps).toBe(1);
  });

  it('widens the search to find a mug that jumped past it', () => {
    let track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
    const first = stepLocalTrack(track, scene(110, 60), null);
    expect(first.track.lostSteps).toBe(1);
    track = first.track;
    const second = stepLocalTrack(track, scene(110, 60), null);
    expect(second.verdict).toBe('follow');
    expect(second.track.box.x * W).toBeCloseTo(110);
    expect(second.track.lostSteps).toBe(0);
  });

  it('distrusts a look-alike instead of jumping to it', () => {
    // The mug stays put while an identical one sits nearby: two equally good
    // answers, as a white mug beside a white shirt can give.
    const track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
    const twins = scene(30, 30, true, { x: 60, y: 40 });
    const match = matchTemplate(twins, track.template, box(30, 30))!;
    expect(match.score).toBeGreaterThan(0.99);
    expect(match.lead).toBeLessThan(0.1);
    let current = track;
    const verdicts = [1, 2, 3].map(() => {
      const step = stepLocalTrack(current, twins, null, { quietSteps: 0 });
      current = step.track;
      return step.verdict;
    });
    expect(verdicts).toEqual(['follow', 'follow', 'reanchor']);
    expect(current.box).toEqual(track.box);
  });

  it('keeps a clear lead when there is one mug', () => {
    const track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
    expect(matchTemplate(scene(40, 32), track.template, box(30, 30))!.lead).toBeGreaterThan(0.5);
  });

  it('follows a masked mug onto a different background', () => {
    const start = shirtScene(55, 40);
    const moved = shirtScene(85, 45).frame;
    const masked = startLocalTrack(start.frame, ringBox(55, 40), false, start.mask)!;
    const whole = startLocalTrack(start.frame, ringBox(55, 40), false)!;
    expect(masked.template.masked).toBe(true);
    const withMask = matchTemplate(moved, masked.template, ringBox(55, 40))!;
    const withoutMask = matchTemplate(moved, whole.template, ringBox(55, 40))!;
    expect(withMask.score).toBeGreaterThan(0.95);
    expect(withMask.box.x * W).toBeCloseTo(85);
    // The box template still carries the desk it was cut from, so the shirt drags it down.
    expect(withoutMask.score).toBeLessThan(withMask.score - 0.2);
  });

  it('falls back to the whole box when the mask is too plain to match', () => {
    const frame = scene(30, 30);
    const mask = new Uint8Array(W * H);
    // A flat patch inside an otherwise textured box: nothing to lock onto in the mask alone.
    for (let j = 32; j < 40; j++)
      for (let i = 32; i < 40; i++) {
        frame.data[j * W + i] = 200;
        mask[j * W + i] = 1;
      }
    expect(cutTemplate(frame, box(30, 30), mask)!.masked).toBe(false);
  });

  describe('waiting for stillness', () => {
    /** The mug gone, and a "hand" patch of fresh noise where it was, different every frame. */
    function hand(seed: number): LumaFrame {
      const frame = scene(0, 0, false);
      const blur = noise(seed);
      for (let j = 25; j < 60; j++) for (let i = 25; i < 55; i++) frame.data[j * W + i] = blur();
      return frame;
    }
    function run(track: LocalTrack, frames: LumaFrame[], zone: UnitBox | null = null) {
      let current = track;
      return frames.map((frame) => {
        const step = stepLocalTrack(current, frame, zone);
        current = step.track;
        return step;
      });
    }

    it('measures motion only in the region asked about', () => {
      const a = scene(30, 30);
      const b = scene(100, 30);
      expect(frameMotion(a, b, box(30, 30))).toBeGreaterThan(0.5);
      expect(frameMotion(a, b, { x: 0, y: 0.8, width: 1, height: 0.2 })).toBe(0);
    });

    it('does not call SAM while the mug is being picked up', () => {
      const track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
      const steps = run(track, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(hand));
      expect(steps.every((s) => s.verdict === 'follow')).toBe(true);
      expect(steps.at(-1)!.track.lostSteps).toBe(10);
    });

    it('calls SAM once a lost mug has stayed gone and the scene has settled', () => {
      const track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
      const gone = scene(0, 0, false);
      const steps = run(track, [hand(1), hand(2), ...Array.from({ length: 9 }, () => gone)]);
      const first = steps.findIndex((s) => s.verdict === 'reanchor');
      // The hand leaving is itself a change (frame 2); then eight still frames,
      // rather than three frames after the match broke.
      expect(first).toBe(10);
    });

    it('finds the mug again by itself when it is put down', () => {
      const track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
      const steps = run(track, [
        hand(1),
        hand(2),
        hand(3),
        ...Array.from({ length: 10 }, () => scene(95, 50)),
      ]);
      expect(steps.some((s) => s.verdict === 'reanchor')).toBe(false);
      const last = steps.at(-1)!.track;
      expect(last.lostSteps).toBe(0);
      expect(last.box.x * W).toBeCloseTo(95);
    });

    it('confirms a zone crossing only once the mug is set down', () => {
      const zone = { x: 0.4, y: 0.4, width: 0.59, height: 0.59 };
      const track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
      const steps = run(
        track,
        Array.from({ length: 10 }, () => scene(65, 45)),
        zone,
      );
      expect(steps.findIndex((s) => s.verdict === 'confirm')).toBe(8);
    });

    it('ignores motion away from the mug', () => {
      const track = startLocalTrack(scene(30, 30), box(30, 30), false)!;
      const typing = (seed: number) => {
        const frame = scene(30, 30);
        const keys = noise(seed);
        for (let j = 80; j < 100; j++)
          for (let i = 120; i < 160; i++) frame.data[j * W + i] = keys();
        return frame;
      };
      const steps = run(track, [1, 2, 3, 4, 5].map(typing));
      expect(steps.at(-1)!.track.stillSteps).toBe(5);
    });
  });
});
