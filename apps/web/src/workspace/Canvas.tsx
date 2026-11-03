import { lazy, useRef, useState, type CSSProperties, type RefObject } from 'react';
import {
  CROP_MIN,
  DEMO_POSITIONS,
  ISO_PRESETS,
  isoSceneKindSchema,
  type DemoPosition,
} from '@livinglayer/domain';
import { api } from '../api';
import { Glyph } from '../Glyph';
import { MaskOverlay } from '../MaskOverlay';
import { TrackingOverlay } from '../TrackingOverlay';
import { Later } from '../Later';
import type { RoomOption } from '../CameraSetup';
import { ZoomPan } from '../ZoomPan';
import { useFrameRate } from '../useFrameRate';
import { ErrorCard } from '../ProviderUi';
import { IsoView } from '../iso/IsoView';
import { SurfacePin } from '../iso/SurfacePin';
import { CalibrationOverlay } from '../iso/CalibrationOverlay';
import type { StageView } from '../session';
import { Button, Check, Segmented, type Option } from '../ui/controls';
import {
  useAi,
  useCalibration,
  useCamera,
  useDesk,
  useFeedback,
  useFixtures,
  useFollowState,
  useNavigation,
  useObservation,
  useProbes,
  useRunLog,
  useTracking,
  useView,
  useLabParts,
} from './LabContext';
import { useFollowView } from './state/follow-store';
import type { Lab } from './useLabState';
import { DeskStep, Onboarding } from './Onboarding';
import { ContextMenu } from './ContextMenu';
import { Popover } from './Popover';
import { ToolStrip } from './ToolStrip';
import { BrushOverlay, BrushPanel } from './Brush';
import { demoFrameUrl } from './demoFrame';

const PhonePairing = lazy(() =>
  import('../PhonePairing').then((m) => ({ default: m.PhonePairing })),
);
const CameraSetup = lazy(() => import('../CameraSetup').then((m) => ({ default: m.CameraSetup })));
const RoomCalibrate = lazy(() =>
  import('../iso/RoomCalibrate').then((m) => ({ default: m.RoomCalibrate })),
);

/** Which layer placed a watched thing's box last, as its tag says it. */
const WATCH_LAYER = { local: 'LOCAL', appearance: 'LOOKS', sam: 'SAM' } as const;

const VIEWS: Option<StageView>[] = [
  { value: 'photo', label: 'Photo' },
  { value: 'iso', label: 'Iso' },
  { value: 'split', label: 'Split' },
];

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

/**
 * The frame rate readout, in its own component: its once-a-second updates
 * re-render only this span, not the canvas.
 */
function FrameRate({ video, on }: { video: RefObject<HTMLVideoElement | null>; on: boolean }) {
  const fps = useFrameRate(video, on);
  return <span>{fps === null ? '– FPS' : `${fps} FPS`}</span>;
}

/**
 * The canvas: the camera frame and the iso room, alone or side by side. The
 * photo stays mounted under the iso view, so the camera keeps sampling.
 */
export function Canvas() {
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useRunLog(),
    useDesk(),
    useFollowState(),
    useCamera(),
    useObservation(),
    useTracking(),
    useNavigation(),
    useAi(),
    useFixtures(),
    useCalibration(),
    useProbes(),
  );
  const boxStart = useRef<{ x: number; y: number } | null>(null);
  const zoomStart = useRef<{ x: number; y: number } | null>(null);
  // The calibration's size and buttons, under the canvas rather than over the frame.
  const [calibratePanel, setCalibratePanel] = useState<HTMLDivElement | null>(null);
  // A fixture's right-click menu in the Iso view.
  const [fixtureMenu, setFixtureMenu] = useState<{
    id: string;
    at: { x: number; y: number };
  } | null>(null);
  // A zoomed view inside the open one, as shares of the camera's whole frame: too small has too few pixels.
  const zoomRect = lab.zooming?.rect;
  const zoomOk =
    zoomRect &&
    zoomRect.width * (lab.zoomable?.crop?.w ?? 1) >= CROP_MIN &&
    zoomRect.height * (lab.zoomable?.crop?.h ?? 1) >= CROP_MIN;
  // The Picture layer is offered once the room has a picture.
  const picture = Boolean(lab.memory?.illustration || lab.memory?.deskIllustration);
  const {
    mode,
    image,
    camera,
    segmentation,
    overlay,
    trail,
    zoneObservation,
    cameraSize,
    visibleZone,
    drawing,
    follow,
    localZone,
    watch,
    watching,
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
  // The saved calibration, over the frames it was made on (the camera's own size while it runs).
  const calibration = memory?.camera ?? null;
  const cornerShown =
    calibration &&
    lab.showCorner &&
    !lab.calibrating &&
    (camera ||
      (calibration.camera.frame.width === dimensions.width &&
        calibration.camera.frame.height === dimensions.height))
      ? calibration
      : null;
  const roomFixtures = (memory?.fixtures ?? []).some((f) => f.scene === workScene);
  // Rooms a stream camera can be assigned to: the presets, and the person's own scene.
  const rooms: RoomOption[] = [
    ...isoSceneKindSchema.options.map((k) => ({ value: k, label: ISO_PRESETS[k].label })),
    ...(memory?.scene ? [{ value: 'custom' as const, label: memory.scene.label ?? 'Custom' }] : []),
  ];
  const chosenStream = lab.network.streams.find((s) => s.id === lab.cameraSource);
  // The hand gives way to anything being drawn, pinned or placed.
  const hand = lab.tool === 'hand' && !drawing && !pinning && !lab.placing && !lab.boxing;
  // The AI brush draws on the camera's picture, read through the room's calibrated camera.
  const brushable = mode === 'demo' || Boolean(calibration);
  const brushing =
    lab.tool === 'brush' &&
    brushable &&
    // Drawn on the picture, which the iso view alone hides; a prop picked in the room shows there too.
    (stageView !== 'iso' || Boolean(lab.brush.shape)) &&
    !drawing &&
    !pinning &&
    !lab.boxing &&
    !lab.calibrating &&
    (camera || mode === 'demo' || Boolean(image));
  // The tracking layer replaces the follow and watch boxes on the camera with ones fitted to the video.
  const tracked = camera && lab.tracking;
  // A segmentation of a frame the camera just gave (it sized the stage) outlines its matches on the
  // stream; the tracking layer draws remembered things' outlines itself.
  const cameraMasks =
    camera &&
    !tracked &&
    segmentation?.frame.width === dimensions.width &&
    segmentation.frame.height === dimensions.height;
  // The zone over the photo or, on the running camera, over the frames it gives.
  const zoneShown = Boolean(zoneObservation && visibleZone && (drawing || lab.showZones));
  // The mug stands in the main zone by the last check: said in words on the tag, not by colour alone.
  const occupied = !drawing && memory?.placement === 'inside';
  const zoneTag = visibleZone
    ? `ZN-01${!drawing && zone?.carried ? ' · CARRIED' : ''}${
        occupied ? ` · ✓ ${(memory?.object?.label ?? 'mug').toUpperCase()} IN` : ''
      }${drawing ? ` · ${Math.round(visibleZone.width * 100)}×${Math.round(visibleZone.height * 100)}%` : ''}`
    : '';
  const zoneLayer = visibleZone && (
    <svg
      className={`zone-overlay ${drawing ? 'drawing' : ''} ${occupied ? 'inside' : ''}`}
      {...(cameraSize ? { width: cameraSize.width, height: cameraSize.height } : {})}
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      aria-label={
        drawing
          ? 'Draw placement zone'
          : `Saved placement zone${occupied ? `, ${memory?.object?.label ?? 'mug'} inside` : ''}`
      }
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
      {/* Nested in the camera's fitted layer, the SVG catches presses only where it paints. */}
      {drawing && <rect className="zone-hit" width="1000" height="1000" />}
      <rect
        x={visibleZone.x * 1000}
        y={visibleZone.y * 1000}
        width={visibleZone.width * 1000}
        height={visibleZone.height * 1000}
      />
    </svg>
  );
  return (
    <section className="ws-canvas" aria-label="Scene and segmentation">
      <div className="scene-toolbar">
        <span>
          <span className={`dot ${mode === 'live' ? 'live' : ''}`} />
          {mode === 'demo'
            ? 'DEMO DESK'
            : camera
              ? `LIVE · ${(chosenStream?.name ?? 'This device').toUpperCase()}`
              : image
                ? 'LOCAL DESK PHOTO'
                : 'AWAITING DESK PHOTO'}
        </span>
        <Popover
          label="Layers"
          className="layers"
          button={(open, toggle) => (
            <Button size="sm" className="layers-button" aria-expanded={open} onClick={toggle}>
              Layers
              <small>
                {
                  [
                    overlay,
                    lab.showTrail,
                    lab.showZones,
                    lab.tracking,
                    ...(picture ? [lab.showPicture] : []),
                    ...(calibration ? [lab.showCorner] : []),
                  ].filter(Boolean).length
                }
                /{4 + Number(picture) + Number(Boolean(calibration))}
              </small>
            </Button>
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
                  [
                    'Tracking',
                    'Tracked objects and fixtures over the live camera',
                    lab.tracking,
                    lab.setTracking,
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
                  ...(calibration
                    ? ([
                        [
                          'Corner',
                          'The far corner and walls the room’s camera was calibrated on',
                          lab.showCorner,
                          lab.setShowCorner,
                        ],
                      ] as const)
                    : []),
                ] as const
              ).map(([name, hint, on, set]) => (
                <Check key={name} className="overlay-toggle" checked={on} onChange={set}>
                  {name}
                  <small>{hint}</small>
                </Check>
              ))}
            </div>
          )}
        </Popover>
        <Segmented
          className="stage-view"
          label="Stage view"
          value={stageView}
          options={VIEWS}
          disabled={Boolean(pinning)}
          onChange={lab.setStageView}
        />
      </div>
      {!onboarding && (
        <div className="stage-tools">
          <ToolStrip
            tool={lab.tool}
            onTool={lab.setTool}
            disabled={{
              brush: brushable
                ? undefined
                : 'Calibrate the room’s camera first: the brush reads what you select through it',
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
                  : lab.tool === 'brush' && brushing && !lab.brush.shape
                    ? 'Drag a box, or click points and press Enter. Esc clears.'
                    : undefined
            }
          />
          {showIso && picture && lab.showPicture && roomFixtures && (
            <Segmented
              className="fixture-look"
              label="Fixtures on the picture"
              value={lab.fixtureLook}
              onChange={lab.setFixtureLook}
              options={[
                {
                  value: 'picture',
                  label: 'Picture',
                  title: 'Fixtures as the picture shows them: their cut-outs, once lifted',
                },
                {
                  value: 'model',
                  label: 'Models',
                  title: 'Fixtures as their own models, drawn on the picture',
                },
              ]}
            />
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
            store="photo"
            resetKey={`${mode} ${dimensions.width}x${dimensions.height}`}
            off={!camera && mode !== 'demo' && !image}
          >
            {camera ? (
              <video ref={lab.video} data-pan muted playsInline aria-label="Desk camera preview" />
            ) : mode === 'demo' || image ? (
              <img
                data-pan
                src={mode === 'demo' ? demoFrameUrl(lab.demoPosition) : image}
                alt={
                  mode === 'demo'
                    ? 'The demo office seen from its corner camera, with a mug, book and bottle on the desk; synthetic demo'
                    : 'Your prepared desk photo'
                }
              />
            ) : (
              <div className="empty-scene">
                <Glyph type="camera" />
                <h3>Your desk, in context.</h3>
                <p>Upload a photo or start the camera below.</p>
                <small>Prepared locally · sent only when you run a live step</small>
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
            {segmentation && overlay && (!camera || cameraMasks) && (
              <MaskOverlay
                key={lab.segmentRunId}
                segmentation={segmentation}
                chosenId={lab.confirmedId}
              />
            )}
            {zoneShown &&
              (camera
                ? cameraSize && (
                    // Fitted to the picture like the video's object-fit: contain, not to the stage.
                    <svg
                      className="zone-fit"
                      viewBox={`0 0 ${cameraSize.width} ${cameraSize.height}`}
                    >
                      {zoneLayer}
                      {visibleZone && (
                        <text
                          className={`zone-label ${drawing ? 'drawing' : ''} ${occupied ? 'inside' : ''}`}
                          x={visibleZone.x * cameraSize.width}
                          y={visibleZone.y * cameraSize.height - 8}
                          fontSize={Math.max(12, Math.round(cameraSize.width / 70))}
                        >
                          {zoneTag}
                        </text>
                      )}
                    </svg>
                  )
                : zoneLayer)}
            {zoneShown && visibleZone && !camera && (
              <span
                className={`zone-tag ${drawing ? 'drawing' : ''} ${occupied ? 'inside' : ''}`}
                style={{ left: `${visibleZone.x * 100}%`, top: `${visibleZone.y * 100}%` }}
                aria-hidden="true"
              >
                {zoneTag}
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
            {lab.zooming && camera && (
              <svg
                className="zone-overlay drawing fixture-box"
                viewBox="0 0 1000 1000"
                preserveAspectRatio="none"
                aria-label="Draw the camera’s zoomed view"
                onPointerDown={(e) => {
                  zoomStart.current = lab.zonePoint(e);
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const a = zoomStart.current;
                  if (!a) return;
                  const p = lab.zonePoint(e);
                  lab.setZooming({
                    rect: {
                      x: Math.min(a.x, p.x),
                      y: Math.min(a.y, p.y),
                      width: Math.abs(a.x - p.x),
                      height: Math.abs(a.y - p.y),
                    },
                  });
                }}
                onPointerUp={() => {
                  zoomStart.current = null;
                }}
                onPointerCancel={() => {
                  zoomStart.current = null;
                }}
              >
                {zoomRect && (
                  <rect
                    x={zoomRect.x * 1000}
                    y={zoomRect.y * 1000}
                    width={zoomRect.width * 1000}
                    height={zoomRect.height * 1000}
                  />
                )}
              </svg>
            )}
            {brushing && lab.brush.held && camera && (
              <img
                className="brush-held"
                src={lab.brush.held}
                alt="The frame held for the AI brush"
              />
            )}
            {brushing && <BrushOverlay brush={lab.brush} point={lab.zonePoint} />}
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
            {follow && !tracked && <FollowOverlay localZone={localZone} zoneShown={zoneShown} />}
            {!follow && !tracked && watching && watch && watch.things.length > 0 && (
              <svg
                className="follow-overlay"
                viewBox="0 0 1000 1000"
                preserveAspectRatio="none"
                aria-label="What the server is watching"
              >
                {watch.things.map((t) => (
                  <rect
                    key={t.id}
                    className={`follow-box ${t.status === 'following' ? 'follow' : 'unsure'}`}
                    x={t.box.x * 1000}
                    y={t.box.y * 1000}
                    width={t.box.width * 1000}
                    height={t.box.height * 1000}
                  />
                ))}
              </svg>
            )}
            {!follow &&
              !tracked &&
              watching &&
              watch?.things.map((t) => (
                <span
                  key={t.id}
                  className={`zone-tag follow-tag ${t.status === 'following' ? 'follow' : 'unsure'}`}
                  style={{ left: `${t.box.x * 100}%`, top: `${t.box.y * 100}%` }}
                  aria-hidden="true"
                >
                  {t.label.toUpperCase()} · {WATCH_LAYER[t.layer]}
                  {t.status === 'following'
                    ? ` · ${t.score.toFixed(2)}`
                    : ` · ${t.status.toUpperCase()}`}
                </span>
              ))}
            {tracked && (
              <FollowedTracking
                video={lab.video}
                memory={memory}
                watch={watch}
                follow={follow}
                segmentation={segmentation}
              />
            )}
            {cornerShown && <CalibrationOverlay calibration={cornerShown} />}
            {lab.calibrating && !camera && (
              <Later>
                <RoomCalibrate
                  frame={dimensions}
                  initial={lab.calibrating}
                  crop={lab.imageCrop.current}
                  panel={calibratePanel}
                  busy={lab.busy === 'calibrate'}
                  onSave={(draft) => void lab.saveCalibration(draft)}
                  onCancel={() => lab.setCalibrating(null)}
                />
              </Later>
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
          {camera && (
            <span className="frame-live" aria-hidden="true">
              <span className="privacy-dot" />
              LIVE
              {/* A running camera is live; its rate is what reaches the page, so a fallback to MJPEG shows. */}
              <FrameRate video={lab.video} on={camera} />
            </span>
          )}
          <span className="frame-label">
            {dimensions.width} × {dimensions.height} <span>FRAME 00</span>
          </span>
        </div>
        {brushing && <BrushPanel brush={lab.brush} busy={Boolean(busy)} />}
        {showIso && <IsoView hand={hand} onFixtureMenu={(id, at) => setFixtureMenu({ id, at })} />}
        {fixtureMenu && (
          <ContextMenu
            at={fixtureMenu.at}
            label={`${memory?.fixtures?.find((f) => f.id === fixtureMenu.id)?.label ?? 'Fixture'} actions`}
            items={[
              {
                label: 'Open',
                onSelect: () => lab.select({ kind: 'fixture', id: fixtureMenu.id }),
              },
              {
                label: 'Delete',
                destructive: true,
                separated: true,
                disabled: Boolean(busy),
                onSelect: () => void lab.deleteFixtures([fixtureMenu.id]),
              },
              {
                label: 'Not a fixture',
                destructive: true,
                disabled: Boolean(busy),
                onSelect: () => void lab.deleteFixtures([fixtureMenu.id], true),
              },
            ]}
            onClose={() => setFixtureMenu(null)}
          />
        )}
      </div>
      {lab.calibrating && !camera && <div className="calibrate-slot" ref={setCalibratePanel} />}
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
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() => {
                      const v = lab.video.current;
                      if (v?.videoWidth) {
                        lab.captureCanvas(v, v.videoWidth, v.videoHeight, lab.openCrop.current);
                        lab.stopCamera();
                      }
                    }}
                  >
                    Capture frame
                  </Button>
                  <Button onClick={lab.stopCamera}>Stop camera</Button>
                  {lab.zoomable &&
                    (lab.zooming ? (
                      <>
                        <Button
                          disabled={!zoomOk || Boolean(busy)}
                          title={
                            zoomRect && !zoomOk
                              ? 'Too small: keep at least a tenth of the camera’s view each way.'
                              : undefined
                          }
                          onClick={() => void lab.saveZoom(zoomRect ?? null)}
                        >
                          Keep this view
                        </Button>
                        <Button onClick={() => lab.setZooming(null)}>Cancel</Button>
                      </>
                    ) : (
                      <>
                        <Button
                          disabled={Boolean(busy)}
                          title="Draw the part of this camera’s view to keep. It opens on it every time it connects."
                          onClick={lab.startZooming}
                        >
                          Zoom view
                        </Button>
                        {lab.zoomable.crop && (
                          <Button disabled={Boolean(busy)} onClick={() => void lab.saveZoom(null)}>
                            Whole view
                          </Button>
                        )}
                      </>
                    ))}
                </>
              ) : (
                <>
                  <Button disabled={Boolean(busy)} onClick={() => lab.file.current?.click()}>
                    <Glyph type="upload" /> Upload
                  </Button>
                  <Button
                    disabled={Boolean(busy) || lab.cameraPending}
                    onClick={() => void lab.startCamera()}
                  >
                    <Glyph type="camera" />{' '}
                    {lab.cameraPending
                      ? 'Opening…'
                      : chosenStream?.snapshot && !chosenStream.whep && !chosenStream.preview
                        ? 'Grab frame'
                        : 'Camera'}
                  </Button>
                  <Popover
                    label="Use a phone as the camera"
                    className="phone-pop"
                    button={(open, toggle) => (
                      <Button aria-expanded={open} disabled={Boolean(busy)} onClick={toggle}>
                        Phone
                      </Button>
                    )}
                  >
                    {(close) => (
                      <Later>
                        <PhonePairing
                          onUse={(phone) => {
                            close();
                            lab.setCameraSource(phone.id);
                            void lab.network.scan();
                            void lab.startCamera(phone);
                          }}
                        />
                      </Later>
                    )}
                  </Popover>
                  <Popover
                    label="Stream cameras"
                    className="camera-pop"
                    button={(open, toggle) => (
                      <Button aria-expanded={open} disabled={Boolean(busy)} onClick={toggle}>
                        Cameras
                      </Button>
                    )}
                  >
                    {(close) => (
                      <Later>
                        <CameraSetup
                          rooms={rooms}
                          onChange={() => void lab.network.scan()}
                          onUse={(id) => {
                            close();
                            lab.setCameraSource(id);
                          }}
                        />
                      </Later>
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
                          {s.scene ? ` · ${rooms.find((r) => r.value === s.scene)?.label}` : ''}
                          {s.crop ? ' · zoomed' : ''}
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
                api('runs').then((all) => {
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

/** The local follower's box and tag; they redraw at the follower's rate, so the canvas around them does not. */
function FollowOverlay({
  localZone,
  zoneShown,
}: {
  localZone: Lab['localZone'];
  zoneShown: boolean;
}) {
  const followView = useFollowView();
  if (!followView) return null;
  return (
    <>
      <svg
        className="follow-overlay"
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
        aria-label={`Locally followed mug, match ${followView.track.score.toFixed(2)}`}
      >
        {localZone && !zoneShown && (
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
    </>
  );
}
/** The camera's tracking layer, with the local follower's box when it is following. */
function FollowedTracking({
  follow,
  ...props
}: { follow: boolean } & Omit<Parameters<typeof TrackingOverlay>[0], 'follow'>) {
  const followView = useFollowView();
  return <TrackingOverlay {...props} follow={follow ? followView : null} />;
}
