import { describe, expect, it } from 'bun:test';
import {
  followedSighting,
  movedFrom,
  type DeskObservation,
  type FixtureTrack,
} from '@livinglayer/domain';

const frame = { width: 1000, height: 800 };
const box = (x: number, y: number) => ({ x, y, width: 80, height: 60 });
/** A track whose SAM sighting is at (200, 400), seen at 10:00. */
const track = (followed?: FixtureTrack['followed']): FixtureTrack => ({
  concept: 'mug',
  observation: {
    box: box(200, 400),
    frame,
    observedAt: '2026-11-04T10:00:00.000Z',
  } as DeskObservation,
  history: [],
  status: 'seen',
  ...(followed ? { followed } : {}),
});

describe('where a followed thing is now', () => {
  it('is where SAM saw it until the watcher follows it somewhere new', () => {
    expect(followedSighting(track()).box).toEqual(box(200, 400));
  });

  it('is where the watcher follows it since, keeping the rest of SAM’s sighting', () => {
    const now = followedSighting(
      track({ box: box(600, 300), observedAt: '2026-11-04T10:05:00.000Z' }),
    );
    expect(now).toMatchObject({
      box: box(600, 300),
      frame,
      observedAt: '2026-11-04T10:05:00.000Z',
    });
  });

  it('is SAM’s again when SAM saw it after the watcher last moved it', () => {
    const t = track({ box: box(600, 300), observedAt: '2026-11-04T09:00:00.000Z' });
    expect(followedSighting(t).box).toEqual(box(200, 400));
  });
});

describe('whether a followed thing came to rest somewhere new', () => {
  it('is not for a few pixels’ drift, and is for a move across the desk', () => {
    expect(movedFrom(track(), box(205, 402))).toBe(false);
    expect(movedFrom(track(), box(600, 300))).toBe(true);
  });

  it('is measured from where it was last followed, not where SAM first saw it', () => {
    const t = track({ box: box(600, 300), observedAt: '2026-11-04T10:05:00.000Z' });
    expect(movedFrom(t, box(602, 301))).toBe(false);
    expect(movedFrom(t, box(200, 400))).toBe(true);
  });
});
