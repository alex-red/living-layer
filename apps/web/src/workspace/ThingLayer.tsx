import type { DeskMemory, Fixture } from '@livinglayer/domain';
import { LayerButtons } from '../iso/LayerButtons';
import { useDesk, useFeedback, useLabParts } from './LabContext';
import { useCall } from './panel';

/**
 * A Thing's draw layer, like a z-index: ⤓ draws it behind what it overlaps in
 * the room, ⤒ over it. Only the layer is saved, so a thing the camera follows
 * (the mug) stays followed.
 */
export function ThingLayer({
  thing,
  disabled,
}: {
  thing: Pick<Fixture, 'id' | 'label' | 'layer'>;
  disabled?: boolean;
}) {
  const lab = useLabParts(useDesk(), useFeedback());
  const { call, off } = useCall();
  const layer = thing.layer ?? 0;
  return (
    <LayerButtons
      layer={layer}
      disabled={disabled || off}
      onLayer={(by) =>
        void call<DeskMemory>('fixtures/layer', { fixtureId: thing.id, layer: layer + by }, (m) => {
          lab.setMemory(m);
          lab.setMessage(
            by > 0
              ? `Drew the ${thing.label.toLowerCase()} over what it overlaps.`
              : `Drew the ${thing.label.toLowerCase()} behind what it overlaps.`,
          );
        })
      }
    />
  );
}
