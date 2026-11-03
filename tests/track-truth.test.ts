import { describe, expect, it } from 'bun:test';
import type { LumaFrame, UnitBox } from '@livinglayer/domain';
import {
  idf1,
  iou,
  replayClip,
  scoreReplay,
  totalScore,
  type Replay,
  type TrackTruth,
} from '../scripts/lib/track-truth.js';

const W = 96;
const H = 64;
/** Noise, the same every frame, with a checked 10-px square drawn at each box. */
function frameWith(boxes: UnitBox[], seed = 7): LumaFrame {
  const data = new Uint8Array(W * H);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data[i] = 90 + (s % 40);
  }
  for (const b of boxes) {
    const x0 = Math.round(b.x * W);
    const y0 = Math.round(b.y * H);
    for (let y = 0; y < Math.round(b.height * H); y++)
      for (let x = 0; x < Math.round(b.width * W); x++)
        data[(y0 + y) * W + x0 + x] = ((x >> 1) + (y >> 1)) % 2 ? 250 : 10;
  }
  return { width: W, height: H, data };
}
const box = (x: number, y: number): UnitBox => ({
  x: x / W,
  y: y / H,
  width: 10 / W,
  height: 10 / H,
});
const two: TrackTruth['things'] = [
  { id: 'mug-a', label: 'Mug A', concept: 'mug' },
  { id: 'mug-b', label: 'Mug B', concept: 'mug' },
];

describe('identity scores', () => {
  it('counts a thing that ends up sure on its neighbour', () => {
    const truth: TrackTruth = {
      things: two,
      keys: {
        0: { 'mug-a': box(10, 20), 'mug-b': box(60, 20) },
        10: { 'mug-a': box(10, 20), 'mug-b': box(60, 20) },
        20: { 'mug-a': box(10, 20), 'mug-b': box(60, 20) },
      },
    };
    const seen = (a: UnitBox, status: 'following' | 'unsure' = 'following') =>
      new Map([
        ['mug-a', { box: a, status }],
        ['mug-b', { box: box(60, 20), status: 'following' as const }],
      ]);
    const replay: Replay = {
      seen: new Map([
        [0, seen(box(10, 20))],
        [10, seen(box(60, 20))],
        [20, seen(box(40, 40), 'unsure')],
      ]),
      asks: [{ frame: 5, thing: 'mug-a', ask: 'reanchor', took: 'mug-b' }],
      refinds: 0,
      unseeded: [],
    };
    const [a, b] = scoreReplay(truth, replay);
    expect(a).toMatchObject({ keys: 3, tp: 1, fp: 2, fn: 2, switches: 1, falseSure: 1 });
    expect(a).toMatchObject({ honestUnsure: 1, needlessUnsure: 0, asks: 1, wrongPicks: 1 });
    expect(idf1(a!)).toBeCloseTo(2 / 6);
    expect(b).toMatchObject({ tp: 3, fp: 0, fn: 0, switches: 0, falseSure: 0 });
    expect(totalScore([a!, b!])).toMatchObject({ tp: 4, switches: 1, wrongPicks: 1 });
  });
  it('lets a hidden thing be unsure, but not sure on another', () => {
    const truth: TrackTruth = {
      things: two,
      keys: { 0: { 'mug-a': 'hidden', 'mug-b': box(60, 20) } },
    };
    const at = (status: 'following' | 'unsure', b: UnitBox): Replay => ({
      seen: new Map([[0, new Map([['mug-a', { box: b, status }]])]]),
      asks: [],
      refinds: 0,
      unseeded: [],
    });
    expect(scoreReplay(truth, at('unsure', box(10, 20)))[0]).toMatchObject({
      honestUnsure: 1,
      falseSure: 0,
      fn: 0,
    });
    expect(scoreReplay(truth, at('following', box(10, 20)))[0]).toMatchObject({
      falseSure: 0,
      fp: 1,
    });
    expect(scoreReplay(truth, at('following', box(60, 20)))[0]).toMatchObject({ falseSure: 1 });
  });
  it('measures overlap as IoU', () => {
    expect(iou(box(10, 20), box(10, 20))).toBeCloseTo(1);
    expect(iou(box(10, 20), box(15, 20))).toBeCloseTo(50 / 150);
    expect(iou(box(10, 20), box(40, 20))).toBe(0);
  });
});

describe('replaying the watcher over a marked clip', () => {
  it('keeps two still things as themselves without asking SAM', () => {
    const frames = Array.from({ length: 40 }, () => frameWith([box(10, 20), box(60, 20)]));
    const marks = { 'mug-a': box(10, 20), 'mug-b': box(60, 20) };
    const truth: TrackTruth = { things: two, keys: { 0: marks, 10: marks, 20: marks, 30: marks } };
    const replay = replayClip(frames, 10, truth);
    const all = totalScore(scoreReplay(truth, replay));
    expect(replay.unseeded).toEqual([]);
    expect(all).toMatchObject({ keys: 8, tp: 8, switches: 0, falseSure: 0, asks: 0 });
  });
  it('asks SAM on a zone crossing and records whose box it took', () => {
    const xAt = (k: number) => (k < 10 ? 10 : k < 20 ? 10 + (k - 10) * 4 : 50);
    const frames = Array.from({ length: 60 }, (_, k) => frameWith([box(xAt(k), 20)]));
    const keys: TrackTruth['keys'] = {};
    for (let k = 0; k < 60; k += 10) keys[k] = { 'mug-a': box(xAt(k), 20) };
    const truth: TrackTruth = {
      things: [two[0]!],
      zones: [{ id: 'right', rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }],
      keys,
    };
    const replay = replayClip(frames, 10, truth);
    expect(replay.asks).toMatchObject([{ thing: 'mug-a', ask: 'confirm', took: 'mug-a' }]);
    expect(scoreReplay(truth, replay)[0]).toMatchObject({ tp: 6, switches: 0, falseSure: 0 });
  });
  it('catches a lost thing that locks onto its look-alike', () => {
    // Mug A is carried off at frame 10 and put back at frame 20, away from B, which looks
    // the same. As built, A's whole-frame search finds B and follows it, sure: phase 1 of
    // docs/plans/multi-tracking.md is to make that an honest `unsure` instead.
    const frames = Array.from({ length: 50 }, (_, k) =>
      frameWith(
        k < 10 ? [box(10, 20), box(60, 20)] : k < 20 ? [box(60, 20)] : [box(60, 20), box(30, 40)],
      ),
    );
    const keys: TrackTruth['keys'] = {};
    for (let k = 0; k < 50; k += 10)
      keys[k] =
        k < 10
          ? { 'mug-a': box(10, 20), 'mug-b': box(60, 20) }
          : k < 20
            ? { 'mug-a': 'hidden', 'mug-b': box(60, 20) }
            : { 'mug-a': box(30, 40), 'mug-b': box(60, 20) };
    const truth: TrackTruth = { things: two, keys };
    const [a, b] = scoreReplay(truth, replayClip(frames, 10, truth));
    expect(a!.switches).toBe(1);
    expect(a!.falseSure).toBeGreaterThan(0);
    expect(b).toMatchObject({ switches: 0, falseSure: 0, tp: 5 });
  });
});
