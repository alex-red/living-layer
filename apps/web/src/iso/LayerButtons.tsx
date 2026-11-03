import { MAX_LAYER } from '@livinglayer/domain';
import { IconButton } from '../ui/controls';

/**
 * Send a thing back or bring it forward a draw layer, like a z-index: a
 * higher layer is drawn over a lower one wherever they meet. `[` and `]`
 * do the same in the editor.
 */
export function LayerButtons({
  layer,
  disabled,
  onLayer,
}: {
  layer: number;
  disabled?: boolean;
  onLayer: (by: 1 | -1) => void;
}) {
  return (
    <span className="layer-buttons" role="group" aria-label="Draw layer">
      <IconButton
        label="Send back"
        title="Draw it behind what it overlaps ([)"
        disabled={disabled || layer <= -MAX_LAYER}
        onClick={() => onLayer(-1)}
      >
        ⤓
      </IconButton>
      <span className="layer-value" title="Draw layer: higher is drawn over lower">
        {layer > 0 ? `+${layer}` : layer}
      </span>
      <IconButton
        label="Bring forward"
        title="Draw it over what it overlaps (])"
        disabled={disabled || layer >= MAX_LAYER}
        onClick={() => onLayer(1)}
      >
        ⤒
      </IconButton>
    </span>
  );
}
