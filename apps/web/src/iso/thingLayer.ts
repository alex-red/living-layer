import type { Fixture } from '@livinglayer/domain';
import type { IsoObject } from './IsoScene';

/**
 * Placed objects drawn on their Thing's draw layer, like a z-index: the mug
 * set to +1 is drawn over the keyboard it overlaps. Its box comes from the
 * camera, so the layer is read off the saved Thing by its id.
 */
export function withThingLayers(
  objects: IsoObject[],
  things: readonly Pick<Fixture, 'id' | 'layer'>[] | undefined,
): IsoObject[] {
  return objects.map((o) => {
    const layer = things?.find((t) => t.id === (o.thingId ?? o.id))?.layer;
    return layer ? { ...o, box: { ...o.box, layer } } : o;
  });
}
