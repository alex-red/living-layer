import { describe, expect, test } from 'bun:test';
import {
  cameraAt,
  cameraKeys,
  captionChunks,
  captionRows,
  estimateSeconds,
  joinFilter,
  joinOffsets,
  overlays,
  rampFilter,
  rampsOf,
  retime,
  zoomFilter,
  ZOOM_SECONDS,
  type Beat,
} from '../scripts/lib/demo-shot.js';

const VIEW = { width: 1600, height: 900 };
const OUT = { width: 1920, height: 1080 };

describe('camera', () => {
  test('a focus on a box fills about 90% of the frame and centres on it', () => {
    const box = { x: 400, y: 225, width: 800, height: 450 };
    const [, key] = cameraKeys([{ kind: 'focus', t: 2, box }], VIEW);
    expect(key!.zoom).toBeCloseTo(1.8);
    expect(key!.cx).toBeCloseTo(0.5);
    expect(key!.cy).toBeCloseTo(0.5);
  });

  test('a box larger than the page never zooms out past the whole page', () => {
    const [, key] = cameraKeys(
      [{ kind: 'focus', t: 1, box: { x: -50, y: -50, width: 1800, height: 1000 } }],
      VIEW,
    );
    expect(key!.zoom).toBe(1);
  });

  test('a small box zooms no further than the most a 2× take holds sharply', () => {
    const [, key] = cameraKeys(
      [{ kind: 'focus', t: 1, box: { x: 790, y: 440, width: 20, height: 20 } }],
      VIEW,
    );
    expect(key!.zoom).toBe(2.4);
  });

  test('a box in a corner keeps the view inside the page', () => {
    const [, key] = cameraKeys(
      [{ kind: 'focus', t: 1, box: { x: 0, y: 0, width: 400, height: 225 } }],
      VIEW,
    );
    expect(key!.cx - 0.5 / key!.zoom).toBeCloseTo(0);
    expect(key!.cy - 0.5 / key!.zoom).toBeCloseTo(0);
  });

  test('the camera eases from one target to the next and holds there', () => {
    const beats: Beat[] = [
      { kind: 'focus', t: 1, box: { x: 400, y: 225, width: 800, height: 450 } },
      { kind: 'focus', t: 5, box: null },
    ];
    const keys = cameraKeys(beats, VIEW);
    expect(cameraAt(keys, 0.5).zoom).toBe(1);
    const mid = cameraAt(keys, 1 + ZOOM_SECONDS / 2).zoom;
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(keys[1]!.zoom);
    expect(cameraAt(keys, 3).zoom).toBeCloseTo(keys[1]!.zoom);
    expect(cameraAt(keys, 5 + ZOOM_SECONDS).zoom).toBeCloseTo(1);
  });

  test('a curve that returns to the page never dips below a zoom of 1', () => {
    const beats: Beat[] = [
      { kind: 'focus', t: 1, box: { x: 400, y: 225, width: 800, height: 450 } },
      { kind: 'focus', t: 1.2, box: null },
    ];
    const keys = cameraKeys(beats, VIEW);
    for (let t = 0; t < 4; t += 0.05) expect(cameraAt(keys, t).zoom).toBeGreaterThanOrEqual(1);
  });

  test('the zoom filter samples at fractional pixels, clamps at 1 and has no semicolon to break the chain', () => {
    const keys = cameraKeys(
      [{ kind: 'focus', t: 1, box: { x: 400, y: 225, width: 800, height: 450 } }],
      VIEW,
    );
    const filter = zoomFilter(keys, OUT, 30);
    expect(filter).toStartWith('perspective=');
    expect(filter).toContain('max(1,');
    expect(filter).not.toContain(';');
    expect(filter).toEndWith('scale=1920:1080:flags=lanczos,fps=30');
  });
});

describe('speed', () => {
  const beats: Beat[] = [
    { kind: 'speed', t: 2, speed: 4 },
    { kind: 'speed', t: 6, speed: 1 },
    { kind: 'speed', t: 8, speed: 2 },
  ];

  test('speed beats become stretches, the last one running to the end', () => {
    expect(rampsOf(beats, 10)).toEqual([
      { from: 2, to: 6, speed: 4 },
      { from: 8, to: 10, speed: 2 },
    ]);
  });

  test('a fast stretch shortens the cut by what it saves', () => {
    const ramps = rampsOf(beats, 10);
    expect(retime(1, ramps)).toBe(1);
    expect(retime(4, ramps)).toBeCloseTo(2.5);
    expect(retime(7, ramps)).toBeCloseTo(4);
    expect(retime(10, ramps)).toBeCloseTo(6);
  });

  test('no ramps, no speed filter', () => {
    expect(rampFilter([], 30)).toBeNull();
    expect(rampFilter(rampsOf(beats, 10), 30)).toEndWith(',fps=30');
  });
});

describe('overlays', () => {
  test('a caption that fits is one row; a longer one is two rows of similar length', () => {
    expect(captionRows('Smart homes know switches, not things.')).toBe(
      'Smart homes know switches, not things.',
    );
    const two = captionRows(
      'Move the mug, and the corner camera follows it. No sensor on the mug.',
    ).split('\\N');
    expect(two).toHaveLength(2);
    expect(Math.abs(two[0]!.length - two[1]!.length)).toBeLessThan(12);
  });

  test('a line too long for two rows is shown in sentence chunks that share its time', () => {
    const chunks = captionChunks(
      'One frame from the corner camera. Spark lists what’s in the room. SAM outlines all of it in one call.',
      6,
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(88);
      expect(c.text).toMatch(/\.$/);
    }
    expect(chunks[0]!.from).toBe(0);
    expect(chunks.at(-1)!.to).toBeCloseTo(6);
    chunks.slice(1).forEach((c, i) => expect(c.from).toBeCloseTo(chunks[i]!.to));
  });

  test('a line that fits two rows stays one chunk', () => {
    expect(captionChunks('Tick the mug, save, and it’s tracked.', 2)).toEqual([
      { text: 'Tick the mug, save, and it’s tracked.', from: 0, to: 2 },
    ]);
  });

  test('braces in a caption cannot open an override block', () => {
    expect(captionRows('a {\\b1} b')).toBe('a b1 b');
  });

  test('a line is captioned at its cut time for its voice’s length', () => {
    const ass = overlays(
      [
        { kind: 'speed', t: 0, speed: 2 },
        { kind: 'speed', t: 4, speed: 1 },
        { kind: 'line', t: 6, i: 0, dur: 2 },
      ],
      ['Hello there.'],
      rampsOf(
        [
          { kind: 'speed', t: 0, speed: 2 },
          { kind: 'speed', t: 4, speed: 1 },
        ],
        10,
      ),
      OUT,
    );
    expect(ass).toContain('Dialogue: 3,0:00:04.00,0:00:06.25,Caption');
    expect(ass).toContain('Hello there.');
  });

  test('a lower third and a title each draw their card and text', () => {
    const ass = overlays(
      [
        { kind: 'lower', t: 1, dur: 3, title: 'SAM 3.1', sub: 'outlines everything in one call' },
        { kind: 'title', t: 0, dur: 2, text: 'Living Layer', sub: 'a memory' },
      ],
      [],
      [],
      OUT,
    );
    expect(ass.match(/,Shape,/g)).toHaveLength(3);
    expect(ass).toContain('SAM 3.1');
    expect(ass).toContain('A MEMORY');
  });
});

describe('film', () => {
  test('each join starts a fade before the end of what came before', () => {
    expect(joinOffsets([10, 8, 6], 0.5)).toEqual([9.5, 17]);
  });

  test('joins name every input once and end in v and a', () => {
    const filter = joinFilter([10, 8, 6], 0.5);
    expect(filter).toContain('[1:v]xfade');
    expect(filter).toContain('[2:a]acrossfade');
    expect(filter).toContain('offset=17.000[v]');
    expect(filter).toEndWith('[a]');
  });
});

test('a longer line is given longer to say', () => {
  expect(estimateSeconds('one two three four five six')).toBeGreaterThan(
    estimateSeconds('one two three'),
  );
});
