import { useState } from 'react';
import { IsoView } from '../iso/IsoView';
import { Button } from '../ui/controls';
import { useAi, useCamera, useFeedback, useLabParts, useNavigation, useView } from './LabContext';
import { DeskStep, Onboarding } from './Onboarding';
import { BrushPanel } from './Brush';
import { DayDock } from './DayDock';
import {
  FixtureMenu,
  IssueCard,
  PhotoInput,
  PhotoStage,
  SceneBottom,
  SceneToolbar,
  StageTools,
  useBrushing,
  useShowIso,
} from './CanvasPanes';

/** What the canvas is busy with, if it has taken over: one edit mode at a time. */
function EditBanner() {
  const lab = useLabParts(useView(), useNavigation());
  const { pinning, drawing, isoPanel, stageView, ruleDraft } = lab;
  let text = '';
  let done: (() => void) | null = null;
  let label = 'Cancel';
  if (pinning) {
    text = pinning.corners
      ? `Check the ${pinning.label}’s corners on the photo.`
      : `Click the four corners of the ${pinning.label}, starting at the back left.`;
    done = () => lab.setPinning(null);
    label = 'Cancel pin';
  } else if (drawing) {
    text = 'Drag a rectangle on the photo or the iso surface. Save it in the inspector.';
    done = () => lab.setDrawing(false);
  } else if (ruleDraft) {
    const name = ruleDraft.label.trim() || 'the zone';
    text = ruleDraft.rect
      ? `Drag again on the iso surface to redraw ${name}. Save it in the inspector.`
      : `Drag a rectangle on the iso surface to draw ${name}.`;
    done = () => lab.select(ruleDraft.id ? { kind: 'rule', id: ruleDraft.id } : null);
  } else if (stageView !== 'photo' && isoPanel !== 'room') {
    text = isoPanel === 'scene' ? 'Editing the room’s layout.' : 'Editing a model.';
    done = () => lab.setIsoPanel('room');
    label = 'Room';
  }
  if (!done) return null;
  return (
    <div className="edit-banner" role="status">
      <span>{text}</span>
      <Button onClick={done}>{label}</Button>
    </div>
  );
}

/** The AI brush's panel, under the stage while the brush is drawing. */
function BrushDock() {
  const { brush } = useAi();
  const { busy } = useFeedback();
  const { brushing } = useBrushing();
  return brushing ? <BrushPanel brush={brush} busy={Boolean(busy)} /> : null;
}

/**
 * The canvas: the camera frame and the iso room, alone or side by side. The
 * photo stays mounted under the iso view, so the camera keeps sampling. It
 * only lays the panes out; each reads the slices it draws from.
 */
export function Canvas() {
  const lab = useLabParts(useView(), useCamera());
  const { workScene, choosingScene, pinning, stageView } = lab;
  // The calibration's size and buttons, under the canvas rather than over the frame.
  const [calibratePanel, setCalibratePanel] = useState<HTMLDivElement | null>(null);
  // A fixture's right-click menu in the Iso view.
  const [fixtureMenu, setFixtureMenu] = useState<{
    id: string;
    at: { x: number; y: number };
  } | null>(null);
  const onboarding = (!workScene || choosingScene) && !pinning;
  const showIso = useShowIso();
  // The hand gives way to anything being drawn, pinned or placed.
  const hand =
    lab.tool === 'hand' &&
    !lab.drawing &&
    !pinning &&
    !lab.placing &&
    !lab.boxing &&
    !lab.outlining;
  return (
    <section className="ws-canvas" aria-label="Scene and segmentation">
      <SceneToolbar />
      {!onboarding && <StageTools />}
      {!onboarding && <EditBanner />}
      {!onboarding && <DeskStep />}
      {onboarding && <Onboarding />}
      <div className={`stage-fit ${showIso ? stageView : ''}`} hidden={onboarding}>
        <PhotoStage hand={hand} calibratePanel={calibratePanel} />
        <BrushDock />
        {showIso && <IsoView hand={hand} onFixtureMenu={(id, at) => setFixtureMenu({ id, at })} />}
        {fixtureMenu && <FixtureMenu menu={fixtureMenu} onClose={() => setFixtureMenu(null)} />}
      </div>
      {!onboarding && showIso && <DayDock />}
      {lab.calibrating && !lab.camera && <div className="calibrate-slot" ref={setCalibratePanel} />}
      {!onboarding && <SceneBottom />}
      <PhotoInput />
      <IssueCard />
    </section>
  );
}
