import { describe, expect, it } from 'bun:test';
import type { StatKey } from '@livinglayer/domain';
import {
  CALLOUT_WIDTH,
  clearCorners,
  clearSides,
  cardPx,
  spreadCallouts,
  zoomedCallouts,
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

describe("cards clear of the pane's sides", () => {
  const seen = { minX: -100, maxX: 100, minY: -50, maxY: 50 };
  const cards = [-60, 60].map((x) => ({ id: `c${x}`, label: 'Thing', anchor: { x, y: 0, z: 0 } }));
  it('keeps each column 12 pixels in from its side, however small a unit is drawn', () => {
    // At half a pixel a unit, 12 pixels are 24 units: more than the 4 the layout leaves.
    const placed = clearSides(layoutCallouts(cards, seen).placed, seen, 0.5);
    const left = placed.find((p) => p.side === 'left')!;
    const right = placed.find((p) => p.side === 'right')!;
    expect(left.x).toBe(seen.minX + 24);
    expect(right.x + CALLOUT_WIDTH * right.k).toBe(seen.maxX - 24);
  });
  it('leaves cards already far enough in where they are', () => {
    const placed = layoutCallouts(cards, seen).placed;
    expect(clearSides(placed, seen, 4)).toEqual(placed);
  });
});

describe('cards with buttons', () => {
  const seen = { minX: -100, maxX: 100, minY: -50, maxY: 50 };
  const card = { id: 'monitor', label: 'Monitor', anchor: { x: 0, y: 0, z: 0 } };
  const run = () => {};
  it('gives a switched thing a row for its buttons below what it keeps', () => {
    const stats = ['power'] as const;
    const [plain] = layoutCallouts([{ ...card, stats }], seen).placed;
    const actions = [
      { label: 'On', current: true, run },
      { label: 'Off', run },
    ];
    const [switched] = layoutCallouts([{ ...card, stats, actions }], seen).placed;
    expect(switched!.h).toBe(plain!.h + 11);
  });
  it('draws a switched thing that keeps nothing as its name and buttons alone', () => {
    const [plain] = layoutCallouts([card], seen).placed;
    const [switched] = layoutCallouts([{ ...card, actions: [{ label: 'On', run }] }], seen).placed;
    expect(switched!.h).toBe(plain!.h);
  });
});

describe('cards in a short, wide pane', () => {
  // A room 600 × 300 units, its card columns beside it: a view box 836 wide.
  const room = { w: 600, h: 300 };
  const box = { minX: -418, width: 836 };
  // Things 320 units either side of the middle, level with it.
  const cards = [-5, 5].map((x) => ({ id: `c${x}`, label: 'Thing', anchor: { x, y: -x, z: 0 } }));
  it('draws a card at its fit size in a pane the scene fills', () => {
    // 836 × 300 pixels: one pixel a unit, nothing to spare at the sides.
    expect(cardPx({ w: 836, h: 300 }, room)).toBe(CALLOUT_WIDTH);
  });
  it('grows a card into the sides a short, wide pane leaves bare, to a readable width', () => {
    // Half a pixel a unit, fitted to the height: a 52 pixel card at fit, 120 at most.
    const px = cardPx({ w: 900, h: 150 }, room);
    expect(px).toBeGreaterThan(CALLOUT_WIDTH / 2);
    expect(px).toBeLessThanOrEqual(120);
  });
  it('spreads the columns out to the pane’s sides, grown, and clear of the room', () => {
    // The pane shows 1800 units across at half a pixel a unit.
    const seen = { minX: -900, maxX: 900, minY: -150, maxY: 150 };
    const placed = spreadCallouts(cards, seen, box, 0.5)!;
    const left = placed.find((p) => p.side === 'left')!;
    const right = placed.find((p) => p.side === 'right')!;
    expect(left.k).toBeGreaterThan(1);
    expect(left.x).toBeLessThan(box.minX);
    expect(left.x + CALLOUT_WIDTH * left.k).toBeLessThanOrEqual(-room.w / 2);
    expect(right.x).toBeGreaterThanOrEqual(room.w / 2);
  });
  it('leaves the cards as laid out at fit when no width is spare', () => {
    const seen = { minX: -418, maxX: 418, minY: -150, maxY: 150 };
    expect(spreadCallouts(cards, seen, box, 1)).toBeNull();
  });
});

describe('zoomed cards', () => {
  const seen = { minX: -100, maxX: 100, minY: -100, maxY: 100 };
  // Things 64 units either side of the middle, level with it.
  const cards = [-1, 1].map((x) => ({ id: `c${x}`, label: 'Thing', anchor: { x, y: -x, z: 0 } }));
  it('keeps a card readable in a small pane, though at fit it was drawn smaller', () => {
    // Zoomed twice, half a pixel a unit, in a 500 pixel pane: 26 pixels at fit's size,
    // so it is drawn at the readable 110 (22% of the pane) instead.
    const [small] = zoomedCallouts(cards, seen, 0.5, 500, 2);
    expect(CALLOUT_WIDTH * small!.k * 0.5).toBeCloseTo(110);
  });
  it('keeps its fit size on screen where that is already readable', () => {
    const [card] = zoomedCallouts(cards, seen, 4, 1000, 2);
    expect(card!.k).toBe(0.5);
  });
});
