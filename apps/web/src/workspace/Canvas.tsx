import { useRef, type CSSProperties } from 'react';
import {
  DEMO_POSITIONS,
  type EvidenceRun,
  type DemoPosition,
  type SavedItem,
} from '@livinglayer/domain';
import { api } from '../api';
import { Glyph } from '../Glyph';
import { MaskOverlay } from '../MaskOverlay';
import { PhonePairing } from '../PhonePairing';
import { ZoomPan } from '../ZoomPan';
import { ErrorCard } from '../ProviderUi';
import { IsoView } from '../iso/IsoView';
import { SurfacePin } from '../iso/SurfacePin';
import type { StageView } from '../session';
import { useLab } from './LabContext';
import { DeskStep, Onboarding } from './Onboarding';
import { Popover } from './Popover';
import { ToolStrip } from './ToolStrip';
import { demoDesk } from './useLabState';

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
    text = pinning.corners
      ? `Check the ${pinning.label}’s corners on the photo.`
      : `Click the four corners of the ${pinning.label}, starting at the back left.`;
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
  const boxStart = useRef<{ x: number; y: number } | null>(null);
  // The Picture layer is offered once the room has a picture.
  const picture = Boolean(lab.memory?.illustration || lab.memory?.deskIllustration);
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
  const sel = lab.selection;
  const focus = {
    object: sel?.kind === 'object' ? (sel.id === 'main' ? 'tracked' : sel.id) : undefined,
    zone: sel?.kind === 'rule' ? sel.id : undefined,
    fixture: sel?.kind === 'fixture' ? sel.id : undefined,
  };
  // The selected object's latest sighting, ringed on the photo when it was seen on a frame this size.
  const focusSeen =
    sel?.kind === 'object'
      ? sel.id === 'main'
        ? memory?.observation
        : memory?.others?.find((o) => o.id === sel.id)?.observation
      : null;
  const focusBox =
    focusSeen &&
    !camera &&
    focusSeen.frame.width === dimensions.width &&
    focusSeen.frame.height === dimensions.height
      ? focusSeen
      : null;
  const showIso = stageView !== 'photo' && !pinning && Boolean(workScene);
  const roomFixtures = (memory?.fixtures ?? []).some((f) => f.scene === workScene);
  // The hand gives way to anything being drawn, pinned or placed.
  const hand = lab.tool === 'hand' && !drawing && !pinning && !lab.placing && !lab.boxing;
  return (
    <section className="ws-canvas" aria-label="Scene and segmentation">
      <div className="scene-toolbar">
        <span>
          <span className={`dot ${mode === 'live' ? 'live' : ''}`} />
          {mode === 'demo' ? 'DEMO DESK' : image ? 'LOCAL DESK PHOTO' : 'AWAITING DESK PHOTO'}
        </span>
        <Popover
          label="Layers"
          className="layers"
          button={(open, toggle) => (
            <button className="secondary layers-button" aria-expanded={open} onClick={toggle}>
              Layers
              <small>
                {
                  [
                    overlay,
                    lab.showTrail,
                    lab.showZones,
                    ...(picture ? [lab.showPicture] : []),
                  ].filter(Boolean).length
                }
                /{picture ? 4 : 3}
              </small>
            </button>
          )}
        >
          {() => (
            <div className="layers-menu">
              <span className="tiny">SHOW ON THE CANVAS</span>
              {(
                [
                  ['Masks', 'What SAM outlined in this frame', overlay, lab.setOverlay],
                  ['Trail', 'Where the mug has been', lab.showTrail, lab.setShowTrail],
                  [
                    'Zones',
                    'Saved zones, on the photo and in the room',
                    lab.showZones,
                    lab.setShowZones,
                  ],
                  ...(picture
                    ? ([
                        [
                          'Picture',
                          'The room as its drawing, not its model',
                          lab.showPicture,
                          lab.setShowPicture,
                        ],
                      ] as const)
                    : []),
                ] as const
              ).map(([name, hint, on, set]) => (
                <label key={name} className="overlay-toggle">
                  <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
                  <span>
                    {name}
                    <small>{hint}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
        </Popover>
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
      {!onboarding && (
        <div className="stage-tools">
          <ToolStrip
            tool={lab.tool}
            onTool={lab.setTool}
            disabled={{
              scale: !showIso
                ? 'Switch to the Iso view to scale a fixture'
                : lab.isoPanel !== 'room'
                  ? 'Close the editor to scale a fixture'
                  : !roomFixtures
                    ? 'Add a fixture to this scene first'
                    : undefined,
            }}
            note={
              lab.tool === 'scale' && showIso && roomFixtures && sel?.kind !== 'fixture'
                ? 'Select a fixture, then drag the handles on its base.'
                : lab.tool === 'hand'
                  ? 'Drag to pan. Scroll to zoom.'
                  : undefined
            }
          />
          {showIso && picture && lab.showPicture && roomFixtures && (
            <div className="mode-switch fixture-look" aria-label="Fixtures on the picture">
              {(
                [
                  [
                    'picture',
                    'Picture',
                    'Fixtures as the picture shows them: their cut-outs, once lifted',
                  ],
                  ['model', 'Models', 'Fixtures as their own models, drawn on the picture'],
                ] as const
              ).map(([id, label, hint]) => (
                <button
                  key={id}
                  aria-pressed={lab.fixtureLook === id}
                  title={hint}
                  onClick={() => lab.setFixtureLook(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
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
          <ZoomPan
            hand={hand}
            resetKey={`${mode} ${dimensions.width}x${dimensions.height}`}
            off={!camera && mode !== 'demo' && !image}
          >
            {camera ? (
              <video ref={lab.video} data-pan muted playsInline aria-label="Desk camera preview" />
            ) : mode === 'demo' || image ? (
              <img
                data-pan
                src={
                  mode === 'demo'
                    ? lab.deskSvg
                      ? demoDesk(lab.deskSvg, lab.demoPosition)
                      : '/desk.svg'
                    : image
                }
                alt={
                  mode === 'demo'
                    ? 'Illustrated desk with a mug, book, and bottle; synthetic demo'
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
            {!camera && segmentation && lab.showTrail && trail.length > 1 && (
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
            {!camera && currentObservation && visibleZone && (drawing || lab.showZones) && (
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
            {!camera && currentObservation && visibleZone && (drawing || lab.showZones) && (
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
            {lab.boxing && !camera && (mode === 'demo' || image) && (
              <svg
                className="zone-overlay drawing fixture-box"
                viewBox="0 0 1000 1000"
                preserveAspectRatio="none"
                aria-label="Draw a box around the thing"
                onPointerDown={(e) => {
                  boxStart.current = lab.zonePoint(e);
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const a = boxStart.current;
                  if (!a) return;
                  const p = lab.zonePoint(e);
                  lab.setBoxing({
                    rect: {
                      x: Math.min(a.x, p.x),
                      y: Math.min(a.y, p.y),
                      width: Math.abs(a.x - p.x),
                      height: Math.abs(a.y - p.y),
                    },
                  });
                }}
                onPointerUp={() => {
                  boxStart.current = null;
                }}
                onPointerCancel={() => {
                  boxStart.current = null;
                }}
              >
                {lab.boxing.rect && (
                  <rect
                    x={lab.boxing.rect.x * 1000}
                    y={lab.boxing.rect.y * 1000}
                    width={lab.boxing.rect.width * 1000}
                    height={lab.boxing.rect.height * 1000}
                  />
                )}
              </svg>
            )}
            {focusBox && (
              <svg
                className="focus-overlay"
                viewBox={`0 0 ${focusBox.frame.width} ${focusBox.frame.height}`}
                aria-label={`Selected: last seen here${focusBox.id === lab.currentObservation?.id ? '' : ', in an earlier frame'}`}
              >
                <rect
                  className={focusBox.id === lab.currentObservation?.id ? '' : 'earlier'}
                  x={focusBox.box.x - 6}
                  y={focusBox.box.y - 6}
                  width={focusBox.box.width + 12}
                  height={focusBox.box.height + 12}
                />
              </svg>
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
                key={pinning.corners ? 'found' : 'clicks'}
                frame={dimensions}
                label={pinning.label}
                initial={pinning.corners}
                note={pinning.note}
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
          </ZoomPan>
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
            placing={lab.placing}
            onPlace={(where) => void lab.placeFixture(where)}
            onFixture={(id) => lab.select({ kind: 'fixture', id })}
            onMoveFixture={(id, to) => {
              const label = memory?.fixtures?.find((f) => f.id === id)?.label ?? 'fixture';
              lab.select({ kind: 'fixture', id });
              void lab.updateFixture(
                id,
                { centre: { x: to.x, y: to.y }, surfaceId: to.surfaceId },
                `Moved the ${label.toLowerCase()}. Scans leave it where you put it.`,
              );
            }}
            tool={lab.tool}
            hand={hand}
            fixtureLook={lab.fixtureLook}
            onResizeFixture={(id, rect) => {
              const f = memory?.fixtures?.find((x) => x.id === id);
              if (!f) return;
              // The handles stretch the base as drawn; the save keeps it before turning.
              const turned = f.turns % 2 === 1;
              return lab.updateFixture(
                id,
                {
                  centre: { x: rect.x + rect.w / 2, y: rect.y + rect.d / 2 },
                  size: {
                    w: turned ? rect.d : rect.w,
                    d: turned ? rect.w : rect.d,
                    h: f.size.h,
                  },
                },
                `Resized the ${f.label.toLowerCase()}'s base. Scans leave it as you set it.`,
              );
            }}
            lightsOn={lab.lightsOn}
            focus={focus}
            layers={{ trail: lab.showTrail, zones: lab.showZones, picture: lab.showPicture }}
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
            {mode === 'demo'
              ? 'Demo desk. Move the mug to test tracking; no model call or real lamp.'
              : camera
                ? 'Camera on. Capture a frame to work on it.'
                : 'Your photo stays here until you run a live step.'}
          </span>
          {mode === 'demo' && (
            <div className="capture-actions" role="group" aria-label="Move the demo mug">
              {(Object.keys(DEMO_POSITIONS) as DemoPosition[]).map((p) => (
                <button
                  key={p}
                  aria-pressed={lab.demoPosition === p}
                  disabled={Boolean(busy)}
                  onClick={() => lab.moveDemoMug(p)}
                >
                  {DEMO_POSITIONS[p].label}
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
                  <Popover
                    label="Use a phone as the camera"
                    className="phone-pop"
                    button={(open, toggle) => (
                      <button aria-expanded={open} disabled={Boolean(busy)} onClick={toggle}>
                        Phone
                      </button>
                    )}
                  >
                    {(close) => (
                      <PhonePairing
                        onUse={(phone) => {
                          close();
                          lab.setCameraSource(phone.id);
                          void lab.network.scan();
                          void lab.startCamera(phone);
                        }}
                      />
                    )}
                  </Popover>
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
