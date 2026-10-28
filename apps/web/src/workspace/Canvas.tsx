import type { CSSProperties } from 'react';
import {
  FIXTURE_POSITIONS,
  type EvidenceRun,
  type FixturePosition,
  type SavedItem,
} from '@livinglayer/domain';
import { api } from '../api';
import { Glyph } from '../Glyph';
import { MaskOverlay } from '../MaskOverlay';
import { ErrorCard } from '../ProviderUi';
import { IsoView } from '../iso/IsoView';
import { SurfacePin } from '../iso/SurfacePin';
import type { StageView } from '../session';
import { useLab } from './LabContext';
import { DeskStep, Onboarding } from './Onboarding';
import { fixtureDesk } from './useLabState';

const VIEWS: { id: StageView; label: string }[] = [
  { id: 'photo', label: 'Photo' },
  { id: 'iso', label: 'Iso' },
  { id: 'split', label: 'Split' },
];

/** What the canvas is busy with, if it has taken over: one edit mode at a time. */
function EditBanner() {
  const lab = useLab();
  const { pinning, drawing, isoPanel, stageView, ruleDraft } = lab;
  let text = '';
  let done: (() => void) | null = null;
  let label = 'Cancel';
  if (pinning) {
    text = `Click the four corners of the ${pinning.label}, starting at the back left.`;
    done = () => lab.setPinning(null);
    label = 'Cancel pin';
  } else if (drawing) {
    text = 'Drag a rectangle on the photo or the iso surface. Save it in the inspector.';
    done = () => lab.setDrawing(false);
  } else if (ruleDraft) {
    text = 'Drag on the iso surface to draw the rule’s zone.';
    done = () => lab.select(null);
  } else if (stageView !== 'photo' && isoPanel !== 'room') {
    text = isoPanel === 'scene' ? 'Editing the room’s layout.' : 'Editing a model.';
    done = () => lab.setIsoPanel('room');
    label = 'Room';
  }
  if (!done) return null;
  return (
    <div className="edit-banner" role="status">
      <span>{text}</span>
      <button className="secondary" onClick={done}>
        {label}
      </button>
    </div>
  );
}

/**
 * The canvas: the camera frame and the iso room, alone or side by side. The
 * photo stays mounted under the iso view, so the camera keeps sampling.
 */
export function Canvas() {
  const lab = useLab();
  const {
    mode,
    image,
    camera,
    segmentation,
    overlay,
    trail,
    currentObservation,
    visibleZone,
    drawing,
    follow,
    followView,
    localZone,
    pinning,
    dimensions,
    stageView,
    workScene,
    choosingScene,
    busy,
    memory,
    zone,
  } = lab;
  const onboarding = (!workScene || choosingScene) && !pinning;
  const showIso = stageView !== 'photo' && !pinning && Boolean(workScene);
  return (
    <section className="ws-canvas" aria-label="Scene and segmentation">
      <div className="scene-toolbar">
        <span>
          <span className={`dot ${mode === 'live' ? 'live' : ''}`} />
          {mode === 'fixture' ? 'DEMO DESK' : image ? 'LOCAL DESK PHOTO' : 'AWAITING DESK PHOTO'}
        </span>
        <label className="overlay-toggle">
          <input
            type="checkbox"
            checked={overlay}
            onChange={(e) => lab.setOverlay(e.target.checked)}
          />{' '}
          Mask overlay
        </label>
        <div className="mode-switch stage-view three" aria-label="Stage view">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              aria-pressed={stageView === v.id}
              disabled={Boolean(pinning)}
              onClick={() => lab.setStageView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      {!onboarding && <EditBanner />}
      {!onboarding && <DeskStep />}
      {onboarding && <Onboarding />}
      <div className={`stage-fit ${showIso ? stageView : ''}`} hidden={onboarding}>
        <div
          className="scene"
          style={
            {
              aspectRatio: `${dimensions.width} / ${dimensions.height}`,
              '--ar': dimensions.width / dimensions.height,
            } as CSSProperties
          }
        >
          {camera ? (
            <video ref={lab.video} muted playsInline aria-label="Desk camera preview" />
          ) : mode === 'fixture' || image ? (
            <img
              src={
                mode === 'fixture'
                  ? lab.deskSvg
                    ? fixtureDesk(lab.deskSvg, lab.fixturePosition)
                    : '/desk.svg'
                  : image
              }
              alt={
                mode === 'fixture'
                  ? 'Illustrated desk with a mug, book, and bottle; synthetic fixture'
                  : 'Your prepared desk photo'
              }
            />
          ) : (
            <div className="empty-scene">
              <Glyph type="camera" />
              <h3>Your desk, in context.</h3>
              <p>Upload a photo or start the camera below.</p>
              <small>Prepared locally · sent only on an explicit live probe</small>
            </div>
          )}
          {!camera && segmentation && overlay && trail.length > 1 && (
            <svg
              className="trail-overlay"
              viewBox={`0 0 ${segmentation.frame.width} ${segmentation.frame.height}`}
              aria-label={`Trail of ${trail.length} sightings`}
            >
              <polyline
                points={[...trail]
                  .reverse()
                  .map((o) => `${o.box.x + o.box.width / 2},${o.box.y + o.box.height / 2}`)
                  .join(' ')}
              />
              {trail.slice(1).map((o) => (
                <rect
                  key={o.id}
                  x={o.box.x}
                  y={o.box.y}
                  width={o.box.width}
                  height={o.box.height}
                />
              ))}
            </svg>
          )}
          {!camera && segmentation && overlay && (
            <MaskOverlay
              key={lab.segmentRunId}
              segmentation={segmentation}
              chosenId={lab.confirmedId}
            />
          )}
          {!camera && currentObservation && visibleZone && (
            <svg
              className={`zone-overlay ${drawing ? 'drawing' : ''}`}
              viewBox="0 0 1000 1000"
              preserveAspectRatio="none"
              aria-label={drawing ? 'Draw placement zone' : 'Saved placement zone'}
              onPointerDown={(e) => {
                if (!drawing || busy) return;
                lab.zoneStart.current = lab.zonePoint(e);
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!drawing || !lab.zoneStart.current) return;
                const p = lab.zonePoint(e),
                  a = lab.zoneStart.current;
                lab.setDraftZone({
                  x: Math.min(a.x, p.x),
                  y: Math.min(a.y, p.y),
                  width: Math.abs(a.x - p.x),
                  height: Math.abs(a.y - p.y),
                });
              }}
              onPointerUp={() => {
                lab.zoneStart.current = null;
              }}
              onPointerCancel={() => {
                lab.zoneStart.current = null;
              }}
            >
              <rect
                x={visibleZone.x * 1000}
                y={visibleZone.y * 1000}
                width={visibleZone.width * 1000}
                height={visibleZone.height * 1000}
              />
            </svg>
          )}
          {!camera && currentObservation && visibleZone && (
            <span
              className={`zone-tag ${drawing ? 'drawing' : ''}`}
              style={{ left: `${visibleZone.x * 100}%`, top: `${visibleZone.y * 100}%` }}
              aria-hidden="true"
            >
              ZN-01
              {!drawing && zone?.carried && ' · CARRIED'}
              {drawing &&
                ` · ${Math.round(visibleZone.width * 100)}×${Math.round(visibleZone.height * 100)}%`}
            </span>
          )}
          {follow && followView && (
            <svg
              className="follow-overlay"
              viewBox="0 0 1000 1000"
              preserveAspectRatio="none"
              aria-label={`Locally followed mug, match ${followView.track.score.toFixed(2)}`}
            >
              {localZone && !(!camera && currentObservation && visibleZone) && (
                <rect
                  className="follow-zone"
                  x={localZone.x * 1000}
                  y={localZone.y * 1000}
                  width={localZone.width * 1000}
                  height={localZone.height * 1000}
                />
              )}
              <rect
                className={`follow-box ${followView.verdict} ${followView.track.lostSteps ? 'unsure' : ''}`}
                x={followView.track.box.x * 1000}
                y={followView.track.box.y * 1000}
                width={followView.track.box.width * 1000}
                height={followView.track.box.height * 1000}
              />
            </svg>
          )}
          {follow && followView && (
            <span
              className={`zone-tag follow-tag ${followView.verdict} ${followView.track.lostSteps ? 'unsure' : ''}`}
              style={{
                left: `${followView.track.box.x * 100}%`,
                top: `${followView.track.box.y * 100}%`,
              }}
              aria-hidden="true"
            >
              LOCAL · {followView.track.score.toFixed(2)}
              {followView.verdict !== 'follow'
                ? ' · ASKING SAM'
                : followView.track.lostSteps > 0 &&
                  (followView.track.stillSteps > 0 ? ' · UNSURE' : ' · MOVING')}
            </span>
          )}
          {pinning && !camera && (
            <SurfacePin
              frame={dimensions}
              label={pinning.label}
              onDone={(corners) =>
                void lab.deskAction('surface', {
                  pin: {
                    scene: pinning.scene,
                    surfaceId: pinning.surfaceId,
                    corners,
                    frame: dimensions,
                  },
                })
              }
            />
          )}
          <span className="frame-tick tl" aria-hidden="true" />
          <span className="frame-tick tr" aria-hidden="true" />
          <span className="frame-tick bl" aria-hidden="true" />
          <span className="frame-tick br" aria-hidden="true" />
          <span className="frame-label">
            {dimensions.width} × {dimensions.height} <span>FRAME 00</span>
          </span>
        </div>
        {showIso && workScene && (
          <IsoView
            mode={mode}
            kind={workScene}
            onKind={lab.setWorkScene}
            panel={lab.isoPanel}
            onPanel={lab.setIsoPanel}
            surfaceId={lab.isoSurfaceId}
            onSurfaceId={lab.setIsoSurfaceId}
            modelOf={lab.modelOf}
            guess={lab.guess}
            ruleDraft={lab.ruleDraft}
            onRuleDraft={lab.setRuleDraft}
            memory={memory}
            image={image}
            lights={lab.lights}
            lampOn={lab.lamp !== 'off'}
            drawing={drawing}
            zone={visibleZone ?? undefined}
            busy={Boolean(busy) || camera || lab.cameraPending}
            onDraftZone={lab.setDraftZone}
            onRun={(run) => {
              lab.setSelected(run as EvidenceRun);
              lab.setMessage(
                run.kind === 'item'
                  ? `Model drafted: ${(run.output as SavedItem).parts.length} parts. Edit it, then save.`
                  : run.kind === 'layout'
                    ? 'Scene drafted. Review it in the layout editor, then save.'
                    : run.kind === 'photo'
                      ? 'Scene drafted from the photo. Review the pin and the objects, then save.'
                      : 'Saved.',
              );
              void lab.refresh();
            }}
            onMemory={(m) => {
              lab.setMemory(m);
              // A scene saved from a photo is the room now; the next step is its surface or objects.
              if (m.scene && lab.isoPanel === 'scene') lab.select({ kind: 'room' });
            }}
            onUpload={lab.upload}
            onMessage={(text) => {
              lab.setMessage(text);
              void lab.refresh();
            }}
            onError={lab.setError}
          />
        )}
      </div>
      {!onboarding && (
        <div className="scene-bottom">
          <span>
            {mode === 'fixture'
              ? 'Demo desk. Move the mug to test tracking; no model call or real lamp.'
              : camera
                ? 'Camera on. Capture a frame to work on it.'
                : 'Your photo stays here until you run a live step.'}
          </span>
          {mode === 'fixture' && (
            <div className="capture-actions" role="group" aria-label="Move the fixture mug">
              {(Object.keys(FIXTURE_POSITIONS) as FixturePosition[]).map((p) => (
                <button
                  key={p}
                  aria-pressed={lab.fixturePosition === p}
                  disabled={Boolean(busy)}
                  onClick={() => lab.moveFixtureMug(p)}
                >
                  {FIXTURE_POSITIONS[p].label}
                </button>
              ))}
            </div>
          )}
          {mode === 'live' && (
            <div className="capture-actions">
              {camera ? (
                <>
                  <button
                    disabled={Boolean(busy)}
                    onClick={() => {
                      const v = lab.video.current;
                      if (v?.videoWidth) {
                        lab.captureCanvas(v, v.videoWidth, v.videoHeight);
                        lab.stopCamera();
                      }
                    }}
                  >
                    Capture frame
                  </button>
                  <button onClick={lab.stopCamera}>Stop camera</button>
                </>
              ) : (
                <>
                  <button disabled={Boolean(busy)} onClick={() => lab.file.current?.click()}>
                    <Glyph type="upload" /> Upload
                  </button>
                  <button
                    disabled={Boolean(busy) || lab.cameraPending}
                    onClick={() => void lab.startCamera()}
                  >
                    <Glyph type="camera" /> {lab.cameraPending ? 'Opening…' : 'Camera'}
                  </button>
                  {lab.network.streams.length > 0 && (
                    <select
                      aria-label="Camera source"
                      value={lab.cameraSource}
                      disabled={lab.cameraPending}
                      onChange={(e) => lab.setCameraSource(e.target.value)}
                    >
                      <option value="">This device</option>
                      {lab.network.streams.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {s.host}
                        </option>
                      ))}
                    </select>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
      <input
        ref={lab.file}
        type="file"
        accept="image/png,image/jpeg"
        hidden
        aria-label="Desk photo to upload"
        onChange={(e) => void lab.upload(e.target.files?.[0])}
      />
      {lab.issue && (
        <ErrorCard
          issue={lab.issue}
          onDismiss={() => lab.setIssue(null)}
          onInspect={(runId) =>
            void lab
              .refresh()
              .catch(() => null)
              .then(() =>
                api<EvidenceRun[]>('runs').then((all) => {
                  const run = all.find((x) => x.id === runId);
                  if (run) lab.inspect(run);
                }),
              )
          }
        />
      )}
    </section>
  );
}
