import { describe, expect, it } from 'bun:test';
import { depthOrder } from '@livinglayer/domain';
import type { IsoObject } from '../apps/web/src/iso/IsoScene.js';
import { withThingLayers } from '../apps/web/src/iso/thingLayer.js';

const mug: IsoObject = {
  id: 'tracked',
  thingId: 'mug-1',
  label: 'Mug',
  box: { at: { x: 1, y: 1, z: 2 }, size: { w: 1, d: 1, h: 1 } },
};

describe('a placed thing’s draw layer', () => {
  it('draws the mug on its Thing’s layer', () => {
    const [drawn] = withThingLayers([mug], [{ id: 'mug-1', layer: 3 }]);
    expect(drawn!.box.layer).toBe(3);
  });
  it('leaves a thing with no layer as it was', () => {
    const [drawn] = withThingLayers([mug], [{ id: 'mug-1' }]);
    expect(drawn).toBe(mug);
  });
  it('puts a thing on a higher layer after one it would otherwise follow', () => {
    // In front by depth, so drawn last on the same layer…
    const keyboard = { at: { x: 3, y: 3, z: 2 }, size: { w: 1, d: 1, h: 1 }, name: 'keyboard' };
    const [drawn] = withThingLayers([mug], [{ id: 'mug-1', layer: 1 }]);
    const order = depthOrder([keyboard, { ...drawn!.box, name: 'mug' }]).map((b) => b.name);
    expect(order).toEqual(['keyboard', 'mug']);
  });
});
