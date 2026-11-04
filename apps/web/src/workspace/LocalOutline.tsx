import { useEffect } from 'react';
import { META_PRICES, type DeskObservation, type SelectionShape } from '@livinglayer/domain';
import { Glyph } from '../Glyph';
import { Button } from '../ui/controls';
import { useCamera, useDesk, useFeedback, useLabParts, useView } from './LabContext';
import { useStore } from './state/store';
import { watchStore } from '../watch';
import { Cost } from './panel';

/**
 * Says so when a followed thing was learned from the whole box drawn round
 * it, not its outline (its last sighting, or what the watcher follows it
 * from): it is followed with its background, and can stay on the desk when it moves.
 */
export function BoxOnlyNote({
  id,
  seen,
}: {
  id: string;
  seen: DeskObservation | null | undefined;
}) {
  const { trackingAi } = useDesk();
  const watchedBoxOnly = useStore(watchStore, (w) =>
    Boolean(w?.on && w.things.find((t) => t.id === id)?.boxOnly),
  );
  if (!seen?.boxOnly && !watchedBoxOnly) return null;
  return (
    <p className="micro box-only" role="note">
      Learned from the whole box drawn round it, not its outline, so it’s followed with what’s
      behind it and may stay put when it moves.{' '}
      {trackingAi ? 'Find it again so SAM outlines it.' : 'Draw round it again, closer.'}
    </p>
  );
}

/**
 * Outlining a thing on this machine, with no model call: draw a box or a
 * polygon round it on the picture (the brush's own drawing, `OutlineLayer`),
 * then outline what is inside. With `onSam`, SAM can outline what is drawn
 * round instead (one billed call the person asks for, so whether tracking may
 * call AI doesn't apply). `target` names
 * what it is for (`'object'` for a new one, a fixture's id), so one panel's
 * drawing isn't another's.
 */
export function LocalOutline({
  target,
  disabled = false,
  working,
  waiting = false,
  onOutline,
  onSam,
}: {
  target: string;
  disabled?: boolean;
  /** An outline is waiting to be confirmed, so drawing again is the lesser step. */
  waiting?: boolean;
  /** Whether the outline is being made now. */
  working: boolean;
  onOutline: (drawn: { shape: SelectionShape; held: string | null }) => void;
  /** SAM outlines what was drawn round, billed. */
  onSam?: (drawn: { shape: SelectionShape; held: string | null }) => void;
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
  const sam = onSam && (
    <Button
      variant={waiting ? 'text' : undefined}
      disabled={off}
      onClick={() => lab.startOutlining(target, true)}
    >
      {waiting ? 'Or with SAM' : 'Draw round it with SAM'}
    </Button>
  );
  return (
    <>
      {!mine ? (
        waiting ? (
          <div className="save-actions">
            <Button variant="text" disabled={off} onClick={() => lab.startOutlining(target)}>
              Not it? Draw round it again
            </Button>
            {sam}
          </div>
        ) : (
          <>
            <Button variant="primary" disabled={off} onClick={() => lab.startOutlining(target)}>
              Draw round it on the picture
              <Glyph type="arrow" />
            </Button>
            {sam}
          </>
        )
      ) : !mine.shape ? (
        <>
          <p className="micro">
            Drag a box round it on the picture, or click points round it and press Enter
            {mine.sam ? ': SAM outlines what is inside.' : '.'}
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
            onClick={() => {
              if (!mine.shape) return;
              const drawn = { shape: mine.shape, held: mine.held };
              if (mine.sam && onSam) onSam(drawn);
              else onOutline(drawn);
            }}
          >
            {working ? 'Outlining…' : mine.sam ? 'Outline it with SAM' : 'Outline it'}
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
      {!mine?.sam && <Cost>Free: outlined on this machine, no model call.</Cost>}
      {onSam && (!mine || mine.sam) && (
        <Cost>{`With SAM: one call, $${META_PRICES.samPerImage}.`}</Cost>
      )}
    </>
  );
}
