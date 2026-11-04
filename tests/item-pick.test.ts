import { describe, expect, it } from 'bun:test';
import { floorLampItem, ITEM_SPRITES, partsUnder, toIso } from '@livinglayer/domain';

const { scale } = ITEM_SPRITES.editor;
/** Where a point of the model shows in the editor, in iso pixels. */
const at = (x: number, y: number, z: number) => toIso({ x: x * scale, y: y * scale, z: z * scale });

describe('partsUnder', () => {
  it('picks the part a stroke paints over', () => {
    // Across the base's near rim, in front of the pole's foot.
    expect(partsUnder(floorLampItem(), [at(0.72, 0.6, 0.03), at(0.6, 0.72, 0.03)], 3)).toEqual([
      'base',
    ]);
  });

  it('picks every part a stroke crosses, the most covered first', () => {
    // From the base's rim up the pole, past where the arm leaves it.
    const picked = partsUnder(floorLampItem(), [at(0.68, 0.68, 0.03), at(0.5, 0.5, 4)], 3);
    expect(picked).toEqual(['pole', 'base', 'arm']);
  });

  it('picks nothing for a stroke beside the model', () => {
    expect(partsUnder(floorLampItem(), [at(3, 3, 0), at(4, 3, 0)], 3)).toEqual([]);
  });
});
