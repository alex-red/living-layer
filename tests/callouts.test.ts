import { describe, expect, it } from 'bun:test';
import type { StatKey } from '@livinglayer/domain';
import { sightedCallouts } from '../apps/web/src/iso/Callouts.js';
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
