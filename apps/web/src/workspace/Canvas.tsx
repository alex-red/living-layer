import { useCallback, useState, type ReactNode } from 'react';
import { IsoView } from '../iso/IsoView';
import { Button, Segmented } from '../ui/controls';
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
import { drawZoneOn, stageForZone, zoneDrawnOn } from './zoneDraw';

/** What the canvas is busy with, if it has taken over: one edit mode at a time. */
function EditBanner() {
  const lab = useLabParts(useView(), useNavigation(), useCamera());
  const { pinning, drawing, isoPanel, stageView, ruleDraft, camera, mode } = lab;
  let text = '';
  let done: (() => void) | null = null;
  let label = 'Cancel';
  let choice: ReactNode = null;
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
    const liveView = camera || mode === 'demo';
    const on = zoneDrawnOn(ruleDraft, liveView);
    const where = on === 'picture' ? 'the camera picture' : 'the iso surface';
    // With a live view, a zone of things can be drawn on it or in the room.
    if (liveView && on !== 'thing' && !ruleDraft.motion)
      choice = (
        <Segmented
          label="Draw the zone on"
          value={on}
          onChange={(to) => {
            const next = drawZoneOn(ruleDraft, to);
            lab.setRuleDraft(next);
            lab.setStageView(stageForZone(next, liveView, stageView));
          }}
          options={[
            { value: 'picture', label: 'Live', title: 'Drag it on the camera picture' },
            { value: 'room', label: 'Iso', title: 'Drag it on the room' },
          ]}
        />
      );
    text = ruleDraft.rect
      ? `Drag again on ${where} to redraw ${name}. Save it in the inspector.`
      : `Drag a rectangle on ${where} to draw ${name}.`;
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
      <span className="edit-banner-actions">
        {choice}
        <Button onClick={done}>{label}</Button>
      </span>
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
  const closeFixtureMenu = useCallback(() => setFixtureMenu(null), []);
  const openFixtureMenu = useCallback(
    (id: string, at: { x: number; y: number }) => setFixtureMenu({ id, at }),
    [],
  );
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
      {/* Before a scene there is nothing to layer or view: the first screen stands alone. */}
      {!onboarding && <SceneToolbar />}
      {!onboarding && <StageTools />}
      {!onboarding && <EditBanner />}
      {!onboarding && <DeskStep />}
      {onboarding && <Onboarding />}
      <div className={`stage-fit ${showIso ? stageView : ''}`} hidden={onboarding}>
        <PhotoStage hand={hand} calibratePanel={calibratePanel} />
        <BrushDock />
        {showIso && <IsoView hand={hand} onFixtureMenu={openFixtureMenu} />}
        {fixtureMenu && <FixtureMenu menu={fixtureMenu} onClose={closeFixtureMenu} />}
      </div>
      {!onboarding && showIso && <DayDock />}
      {lab.calibrating && !lab.camera && <div className="calibrate-slot" ref={setCalibratePanel} />}
      {!onboarding && <SceneBottom />}
      <PhotoInput />
      <IssueCard />
    </section>
  );
}
