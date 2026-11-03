import { useEffect } from 'react';
import type { SelectionShape } from '@livinglayer/domain';
import { Glyph } from '../Glyph';
import { Button } from '../ui/controls';
import { useCamera, useFeedback, useLabParts, useView } from './LabContext';
import { Cost } from './panel';

/**
 * Outlining a thing on this machine, with no model call, while tracking may
 * not call AI: draw a box or a polygon round it on the picture (the brush's
 * own drawing, `OutlineLayer`), then outline what is inside. `target` names
 * what it is for (`'object'` for a new one, a fixture's id), so one panel's
 * drawing isn't another's.
 */
export function LocalOutline({
  target,
  disabled = false,
  working,
  onOutline,
}: {
  target: string;
  disabled?: boolean;
  /** Whether the outline is being made now. */
  working: boolean;
  onOutline: (drawn: { shape: SelectionShape; held: string | null }) => void;
}) {
  const lab = useLabParts(useView(), useFeedback(), useCamera());
  const { outlining, setOutlining, mode, image, camera, busy } = lab;
  const mine = outlining?.target === target ? outlining : null;
  // A drawing for this panel goes when the panel does.
  useEffect(
    () => () => setOutlining((o) => (o?.target === target ? null : o)),
    [setOutlining, target],
  );
  const picture = mode === 'demo' || Boolean(image) || camera;
  const off = disabled || Boolean(busy) || !picture;
  return (
    <>
      {!mine ? (
        <Button variant="primary" disabled={off} onClick={() => lab.startOutlining(target)}>
          Draw round it on the picture
          <Glyph type="arrow" />
        </Button>
      ) : !mine.shape ? (
        <>
          <p className="micro">
            Drag a box round it on the picture, or click points round it and press Enter.
          </p>
          <div className="save-actions">
            <Button onClick={() => setOutlining(null)}>Cancel</Button>
          </div>
        </>
      ) : (
        <div className="save-actions">
          <Button
            variant="primary"
            disabled={off}
            onClick={() => mine.shape && onOutline({ shape: mine.shape, held: mine.held })}
          >
            {working ? 'Outlining…' : 'Outline it'}
            <Glyph type="arrow" />
          </Button>
          <Button
            variant="text"
            disabled={Boolean(busy)}
            onClick={() => setOutlining({ ...mine, shape: null, held: null })}
          >
            Draw again
          </Button>
          <Button variant="text" disabled={Boolean(busy)} onClick={() => setOutlining(null)}>
            Cancel
          </Button>
        </div>
      )}
      {!picture && <p className="micro">Start the camera or add a photo of the desk to draw on.</p>}
      <Cost>Free: outlined on this machine, no model call.</Cost>
    </>
  );
}
