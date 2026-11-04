import { describe, expect, it } from 'bun:test';
import { starterTemplateModel } from '@livinglayer/domain';
import { spritePng } from '../scripts/lib/models.js';

describe('a model drawn for a look', () => {
  const tree = starterTemplateModel('cat-tree');

  it('crops round the parts it is asked to focus on', async () => {
    const whole = await spritePng(tree, { zoom: 1 });
    const toy = await spritePng(tree, { zoom: 1, focus: ['toy'] });
    expect(toy.width).toBeLessThan(whole.width / 2);
    expect(toy.height).toBeLessThan(whole.height / 2);
  });

  it('keeps the whole picture when no part it names is there', async () => {
    const whole = await spritePng(tree, { zoom: 1 });
    const none = await spritePng(tree, { zoom: 1, focus: ['no-such-part'] });
    expect([none.width, none.height]).toEqual([whole.width, whole.height]);
  });

  it('crops to shares of the picture', async () => {
    const whole = await spritePng(tree, { zoom: 1 });
    const half = await spritePng(tree, { zoom: 1, focus: [0, 0, 0.5, 1] });
    expect(half.width).toBeCloseTo(whole.width / 2, -1);
    expect(half.height).toBe(whole.height);
  });

  it('draws a detailed model finer in the room than a plain one', async () => {
    const detailed = {
      ...tree,
      parts: [...tree.parts, ...tree.parts.map((p) => ({ ...p, id: `${p.id}-2` }))],
    };
    const plain = await spritePng(tree, { preset: 'room', scale: 2.5, zoom: 1 });
    const fine = await spritePng(detailed, { preset: 'room', scale: 2.5, zoom: 1 });
    expect(fine.width).toBeGreaterThan(plain.width * 1.5);
  });
});
