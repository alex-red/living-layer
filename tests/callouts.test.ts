import { describe, expect, it } from 'bun:test';
import type { StatKey } from '@livinglayer/domain';
import {
  CALLOUT_WIDTH,
  clearCorners,
  layoutCallouts,
  sightedCallouts,
  visibleScene,
} from '../apps/web/src/iso/Callouts.js';
import type { IsoObject } from '../apps/web/src/iso/IsoScene.js';

const box = { at: { x: 2, y: 3, z: 1 }, size: { w: 0.4, d: 0.4, h: 0.6 } };
const mug: IsoObject = { id: 'tracked', thingId: 'mug-1', label: 'My desk mug', box };
const mouse: IsoObject = { id: 'mouse-1', label: 'Small purple mouse', box };
const stats: Record<string, StatKey[]> = { 'mug-1': ['lastUsed'] };

describe('cards for things the camera places', () => {
  it('gives a thing with stats a card by its thing id, on the top of its box', () => {
    const [card] = sightedCallouts(
      [mug],
      (id) => stats[id] ?? [],
      () => {},
    );
    expect(card).toMatchObject({
      id: 'mug-1',
      label: 'My desk mug',
      stats: ['lastUsed'],
      anchor: { x: 2.2, y: 3.2, z: 1.6 },
    });
  });
  it('gives no card to a thing that keeps no stats', () => {
    expect(
      sightedCallouts(
        [mouse],
        (id) => stats[id] ?? [],
        () => {},
      ),
    ).toEqual([]);
  });
  it("opens the mug as the outline's main object, another thing by its own id", () => {
    const opened: string[] = [];
    const all = { 'mug-1': ['lastUsed'], 'mouse-1': ['lastUsed'] } as Record<string, StatKey[]>;
    for (const c of sightedCallouts(
      [mug, mouse],
      (id) => all[id] ?? [],
      (id) => opened.push(id),
    ))
      c.onSelect?.();
    expect(opened).toEqual(['main', 'mouse-1']);
  });
});

describe('cards in a zoomed view', () => {
  // A 200 × 100 scene drawn in a 400 × 200 box: 2 pixels a unit, no letterbox.
  const box = { minX: -100, minY: -50, width: 200, height: 100 };
  it('sees the whole scene at fit', () => {
    expect(visibleScene({ s: 1, x: 0, y: 0, w: 400, h: 200 }, box)).toEqual({
      minX: -100,
      maxX: 100,
      minY: -50,
      maxY: 50,
    });
  });
  it('sees the quarter about the middle at twice the zoom, centred', () => {
    expect(visibleScene({ s: 2, x: -200, y: -100, w: 400, h: 200 }, box)).toEqual({
      minX: -50,
      maxX: 50,
      minY: -25,
      maxY: 25,
    });
  });
  it('lays the cards inside what is seen, half their size in scene units at twice the zoom', () => {
    const seen = { minX: -50, maxX: 50, minY: -25, maxY: 25 };
    const cards = [-10, 10].map((x) => ({ id: `c${x}`, label: 'Mug', anchor: { x, y: 0, z: 0 } }));
    const fit = layoutCallouts(cards, seen).placed;
    const zoomed = layoutCallouts(cards, seen, 'full', 2).placed;
    for (const p of zoomed) {
      expect(p.k).toBe(0.5);
      expect(p.x).toBeGreaterThanOrEqual(seen.minX);
      expect(p.x + CALLOUT_WIDTH * p.k).toBeLessThanOrEqual(seen.maxX);
    }
    expect(zoomed[0]!.h).toBe(fit[0]!.h / 2);
  });
});

describe("cards clear of the pane's corners", () => {
  const seen = { minX: -100, maxX: 100, minY: -50, maxY: 50 };
  const cards = [-60, -40, 40, 60].map((x) => ({
    id: `c${x}`,
    label: 'Thing',
    anchor: { x, y: 0, z: 0 },
  }));
  it('moves a column that starts in a top corner down below it, keeping its order and gaps', () => {
    const placed = layoutCallouts(cards, seen).placed;
    // At 2 pixels a unit, the right column starts 36 units below the top.
    const right = clearCorners(placed, seen.minY, 2).filter((p) => p.side === 'right');
    const before = placed.filter((p) => p.side === 'right');
    expect(Math.min(...right.map((p) => p.y))).toBeGreaterThanOrEqual(seen.minY + 36);
    expect(right[1]!.y - right[0]!.y).toBe(before[1]!.y - before[0]!.y);
  });
  it('leaves a column that already starts low enough where it is', () => {
    const low = layoutCallouts(cards, seen).placed.map((p) => ({ ...p, y: p.y + 200 }));
    expect(clearCorners(low, seen.minY, 2)).toEqual(low);
  });
});
