import { describe, expect, test } from 'bun:test';
import { overlays, typedSteps, TYPED_CPS } from '../scripts/lib/demo-shot.js';
import {
  clipFilter,
  clipSeconds,
  sceneBeats,
  timeline,
  type Scene,
} from '../scripts/lib/scenes.js';

const OUT = { width: 1920, height: 1080 };

const scene: Scene = {
  name: 'hook',
  title: '1 · Too much control',
  parts: [
    {
      card: 'Have you ever felt like you had too much control in your life?',
      seconds: 4,
      look: 'typed',
    },
    { clip: 'phone/hook/1.mov', note: 'poke the pink plushie, the lamp turns purple', seconds: 6 },
    { shot: 'draft' },
  ],
  lines: [{ text: 'Yeah. Us neither.', at: 4.5 }],
  lowers: [{ title: 'MOTION ZONE', sub: 'runs on this machine', at: 6 }],
};

describe('timeline', () => {
  test('each part starts where the one before ended', () => {
    expect(timeline([4, 6, 20])).toEqual({ starts: [0, 4, 10], length: 30 });
  });

  test('a clip on screen is its trimmed span at its speed', () => {
    expect(clipSeconds({ clip: 'a', note: '', seconds: 5, from: 2, to: 10, speed: 2 }, 30)).toBe(4);
    expect(clipSeconds({ clip: 'a', note: '', seconds: 5, from: 2 }, 12)).toBe(10);
  });

  test('a trim past the clip’s end stops at its end', () => {
    expect(clipSeconds({ clip: 'a', note: '', seconds: 5, to: 99 }, 7)).toBe(7);
  });
});

describe('scene beats', () => {
  test('a clip not filmed yet becomes a slate saying what to film, for its seconds', () => {
    const beats = sceneBeats(
      scene,
      [
        { length: 4, missing: null },
        { length: 6, missing: 'out/demo-video/phone/hook/1.mov' },
        { length: 20, missing: null },
      ],
      [1.6],
    );
    const slate = beats.find((b) => b.kind === 'card' && b.look === 'slate');
    expect(slate).toMatchObject({
      t: 4,
      dur: 6,
      text: 'TO FILM · poke the pink plushie, the lamp turns purple',
    });
  });

  test('a shot not cut yet becomes a slate naming the command', () => {
    const beats = sceneBeats(
      scene,
      [
        { length: 4, missing: null },
        { length: 6, missing: null },
        { length: 5, missing: 'out/demo-video/draft/cut.mp4' },
      ],
      [1.6],
    );
    expect(beats.some((b) => b.kind === 'card' && b.text === 'TO CUT · bun run shot draft')).toBe(
      true,
    );
  });

  test('cards, lines and lower thirds sit at scene time, in order', () => {
    const beats = sceneBeats(
      scene,
      [
        { length: 4, missing: null },
        { length: 6, missing: null },
        { length: 20, missing: null },
      ],
      [1.6],
    );
    expect(beats.map((b) => [b.kind, b.t])).toEqual([
      ['card', 0],
      ['line', 4.5],
      ['lower', 6],
    ]);
    expect(beats[1]).toMatchObject({ dur: 1.6 });
  });
});

test('a line’s caption gives way to the next line, so two never stack', () => {
  const beats = sceneBeats(
    {
      ...scene,
      lines: [
        { text: 'one', at: 0 },
        { text: 'two', at: 2 },
      ],
    },
    [
      { length: 4, missing: null },
      { length: 6, missing: null },
      { length: 20, missing: null },
    ],
    [5, 1],
  );
  const lines = beats.filter((b) => b.kind === 'line');
  expect(lines[0]!.t + lines[0]!.dur).toBeLessThan(lines[1]!.t);
  expect(lines[1]).toMatchObject({ dur: 1 });
});

test('a short plain card is set as a title, its line under it in capitals', () => {
  const ass = overlays(
    [{ kind: 'card', t: 0, dur: 3, text: 'LIVING LAYER', sub: 'control anything', look: 'plain' }],
    [],
    [],
    OUT,
  );
  expect(ass).toMatch(/,Title,.*LIVING LAYER/);
  expect(ass).toMatch(/,TitleSub,.*CONTROL ANYTHING/);
});

describe('typed cards', () => {
  test('a typed card shows one more letter each step and ends on the whole line', () => {
    const steps = typedSteps('Too much.');
    expect(steps.map((s) => s.chars)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(steps[1]!.at - steps[0]!.at).toBeCloseTo(1 / TYPED_CPS);
  });

  test('typing pauses after a comma', () => {
    const steps = typedSteps('a, b');
    expect(steps[2]!.at - steps[1]!.at).toBeGreaterThan(1 / TYPED_CPS);
  });

  test('each typed step ends when the next begins, so letters never draw twice', () => {
    const ass = overlays(
      [{ kind: 'card', t: 0, dur: 3, text: 'abc', sub: '', look: 'typed' }],
      [],
      [],
      OUT,
    );
    const cards = ass.split('\n').filter((l) => l.includes(',Card,'));
    expect(cards).toHaveLength(3);
    expect(cards[0]).toContain('a{\\alpha&HFF&}bc');
    expect(cards[2]).toMatch(/,0:00:03\.00,Card,/);
  });
});

test('a filmed clip is filled to the frame and sped up when asked', () => {
  expect(clipFilter(OUT, 30, 2)).toBe(
    'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,setpts=PTS/2,fps=30,format=yuv420p',
  );
  expect(clipFilter(OUT, 30)).not.toContain('setpts');
});
