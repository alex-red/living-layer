import {
  lazy,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  CROP_MIN,
  DEMO_POSITIONS,
  ISO_PRESETS,
  cameraFitsScene,
  isoSceneKindSchema,
  type DemoPosition,
  type ZoneRect,
  mainPlacement,
  mugOf,
  MAIN_RULE,
  mugSighting,
  otherObjects,
  placedFixtures,
} from '@livinglayer/domain';
import { api } from '../api';
import { Glyph } from '../Glyph';
import { MaskOverlay } from '../MaskOverlay';
import { RectHandles, dragRect, grabOf, type Grab } from '../RectGrab';
import { StatsOverlay, TrackingOverlay, selectedThing } from '../TrackingOverlay';
import { HealthBar } from '../HealthBar';
import './scene.css';
import { Later } from '../Later';
import type { RoomOption } from '../CameraSetup';
import { ZoomPan } from '../ZoomPan';
import { useFrameRate } from '../useFrameRate';
import { ErrorCard } from '../ProviderUi';
import { SurfacePin } from '../iso/SurfacePin';
import { CalibrationOverlay } from '../iso/CalibrationOverlay';
import type { StageView } from '../session';
import { Button, Check, Segmented, type Option } from '../ui/controls';
import { cameraFilterView } from './cameraFilter';
import { CameraFilterLayer } from './CameraFilterLayer';
import { followDraw } from './followLayers';
import {
  useAi,
  useCalibration,
  useCamera,
  useDesk,
  useFeedback,
  useFixtures,
  useFollowState,
  useLabParts,
  useNavigation,
  useObservation,
  useProbes,
  useRunLog,
  useTracking,
  useView,
} from './LabContext';
import { followHealthStore, useFollowView } from './state/follow-store';
import { createStore, useStore } from './state/store';
import { dragRectStore, useDragRect } from './state/view';
import { watchStore } from '../watch';
import { LayerChips, useLayers, usePicture } from './LayerChips';
import { SavedZones } from './SavedZones';
import { ruleRects, useHoveredZone } from './zoneHover';
import type { Lab } from './useLabState';
import { ContextMenu } from './ContextMenu';
import { Popover } from './Popover';
import { ToolStrip } from './ToolStrip';
import { BrushOverlay } from './Brush';
import { shapeOf, type BrushStroke } from './useBrush';
import { stageSize } from './stage-size';
import { useDemoFrameUrl } from './demoFrame';
import { FRIDGE_PHOTO, FRIDGE_VIEWS, fridgeViewUrl, type FridgeView } from './demoFridge';

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

/**
 * The frame rate readout, in its own component: its once-a-second updates
 * re-render only this span, not the canvas.
 */
function FrameRate({ video, on }: { video: RefObject<HTMLVideoElement | null>; on: boolean }) {
  const fps = useFrameRate(video, on);
  return <span>{fps === null ? '– FPS' : `${fps} FPS`}</span>;
}

/** Whether the work scene has any fixture. */
function useRoomFixtures(): boolean {
  const { memory } = useDesk();
  const { workScene } = useView();
  return placedFixtures(memory).some((f) => f.scene === workScene);
}

/** Whether the fridge's placeholder photos stand in for a camera: the fridge, with no camera or photo of its own. */
function useFridgePlaceholder(): boolean {
  const lab = useLabParts(useView(), useCamera());
  return lab.workScene === 'fridge' && !lab.camera && !lab.image;
}

/** Whether the iso room is shown beside or instead of the photo. */
export function useShowIso(): boolean {
  const { stageView, pinning, workScene } = useView();
  return stageView !== 'photo' && !pinning && Boolean(workScene);
}

/**
 * Whether the AI brush is drawing on the camera's picture: it reads through
 * the room's calibrated camera.
 */
export function useBrushing(): { brushable: boolean; brushing: boolean } {
  const lab = useLabParts(useView(), useDesk(), useCamera(), useAi());
  const { mode, drawing, pinning, stageView, camera, image } = lab;
  const brushable = mode === 'demo' || Boolean(lab.memory?.camera);
  const brushing =
    lab.tool === 'brush' &&
    brushable &&
    // Drawn on the picture, which the iso view alone hides; a prop picked in the room shows there too.
    (stageView !== 'iso' || Boolean(lab.brush.shape)) &&
    !drawing &&
    !pinning &&
    !lab.boxing &&
    !lab.outlining &&
    !lab.calibrating &&
    (camera || mode === 'demo' || Boolean(image));
  return { brushable, brushing: Boolean(brushing) };
}

/**
 * The main zone over the photo, and the words on its tag. `live` is the zone
 * being dragged, which stands in for the drawn one until the drag ends.
 */
function useZoneView(live?: ZoneRect | null) {
  const lab = useLabParts(useView(), useDesk(), useObservation());
  const { zoneObservation, drawing, memory, zone } = lab;
  const visibleZone = (drawing && live) || lab.visibleZone;
  // The zone over the photo or, on the running camera, over the frames it gives.
  const zoneShown = Boolean(zoneObservation && visibleZone && (drawing || lab.showZones));
  // The mug stands in the main zone by the last check: said in words on the tag, not by colour alone.
  const occupied = !drawing && mainPlacement(memory) === 'inside';
  const zoneTag = visibleZone
    ? `ZN-01${!drawing && zone?.carried ? ' · CARRIED' : ''}${
        occupied ? ` · ✓ ${(mugOf(memory)?.label ?? 'mug').toUpperCase()} IN` : ''
      }${drawing ? ` · ${Math.round(visibleZone.width * 100)}×${Math.round(visibleZone.height * 100)}%` : ''}`
    : '';
  return { zoneShown, occupied, zoneTag };
}

/** The bar over the canvas: what is shown, the layers and the stage view. */
export function SceneToolbar() {
  const lab = useLabParts(useView(), useDesk(), useCamera());
  const { mode, camera, image, stageView, pinning } = lab;
  const layers = useLayers();
  const chosenStream = lab.network.streams.find((s) => s.id === lab.cameraSource);
  const fridge = useFridgePlaceholder();
  return (
    <div className="scene-toolbar">
      <span>
        <span className={`dot ${mode === 'live' && !fridge ? 'live' : ''}`} />
        {fridge
          ? `FRIDGE CAMERA · PLACEHOLDER · ${FRIDGE_VIEWS[lab.fridgeView].label.toUpperCase()}`
          : mode === 'demo'
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
              {layers.filter((l) => l.on).length}/{layers.length}
            </small>
          </Button>
        )}
      >
        {() => (
          <div className="layers-menu">
            <span className="tiny">SHOW ON THE CANVAS</span>
            {layers.map(({ name, hint, on, set }) => (
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
  );
}

/** The tool strip, and the choice of how fixtures look on the picture. */
export function StageTools() {
  const lab = useLabParts(useView(), useAi());
  const { brushable, brushing } = useBrushing();
  const showIso = useShowIso();
  const picture = usePicture();
  const roomFixtures = useRoomFixtures();
  const sel = lab.selection;
  return (
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
          lab.outlining && !lab.outlining.shape
            ? 'Drag a box round the thing, or click points and press Enter. Esc cancels.'
            : lab.tool === 'scale' && showIso && roomFixtures && sel?.kind !== 'fixture'
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
  );
}

/** The photo, the video or the empty scene. */
function Media() {
  const lab = useLabParts(useView(), useCamera());
  const { camera, mode, image } = lab;
  const fridge = useFridgePlaceholder();
  const demoUrl = useDemoFrameUrl(lab.demoPosition, mode === 'demo');
  if (camera) {
    const filter = cameraFilterView(lab.cameraFilter, lab.cameraFilterKind);
    return (
      <>
        <video
          ref={lab.video}
          data-pan
          muted
          playsInline
          aria-label="Desk camera preview"
          className={[filter.videoClass, filter.hideVideo && 'camera-hidden']
            .filter(Boolean)
            .join(' ')}
          style={{ filter: filter.videoFilter }}
        />
        <CameraFilterLayer video={lab.video} view={filter} />
      </>
    );
  }
  if (fridge)
    return (
      <img
        data-pan
        src={fridgeViewUrl(lab.fridgeView)}
        alt={`${FRIDGE_VIEWS[lab.fridgeView].alt}; placeholder photo`}
      />
    );
  if (mode === 'demo' || image)
    return (
      <img
        data-pan
        src={mode === 'demo' ? demoUrl : image}
        alt={
          mode === 'demo'
            ? 'The demo office seen from its corner camera, with a mug, book and bottle on the desk; synthetic demo'
            : 'Your prepared desk photo'
        }
      />
    );
  // Opening the camera takes a moment: say so, rather than asking for a photo.
  if (lab.cameraPending)
    return (
      <div className="empty-scene opening" role="status">
        <Glyph type="camera" />
        <h3>Opening the camera…</h3>
      </div>
    );
  return (
    <div className="empty-scene">
      <Glyph type="camera" />
      <h3>Your desk, in context.</h3>
      <p>Upload a photo or start the camera below.</p>
      <small>Prepared locally · sent only when you run a live step</small>
    </div>
  );
}

/** Where the mug has been, as a line over the photo. */
function TrailLayer() {
  const lab = useLabParts(useView(), useCamera(), useObservation());
  const { camera, segmentation, trail } = lab;
  if (!(!camera && segmentation && lab.showTrail && trail.length > 1)) return null;
  return (
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
        <rect key={o.id} x={o.box.x} y={o.box.y} width={o.box.width} height={o.box.height} />
      ))}
    </svg>
  );
}

/** What SAM outlined in this frame. */
function MasksLayer() {
  const lab = useLabParts(useView(), useCamera(), useObservation(), useDesk());
  const { camera, segmentation, overlay, dimensions } = lab;
  // A segmentation of a frame the camera just gave (it sized the stage) outlines its matches on the
  // stream; the tracking layer draws remembered things' outlines itself, so a run a thing was
  // already seen in is left to it, and one still to confirm (a new outline) is drawn here.
  const sighted = lab.memory?.fixtures?.some(
    (f) => f.track?.observation.segmentRunId === lab.segmentRunId,
  );
  const cameraMasks =
    camera &&
    !(lab.tracking && sighted) &&
    segmentation?.frame.width === dimensions.width &&
    segmentation.frame.height === dimensions.height;
  if (!(segmentation && overlay && (!camera || cameraMasks))) return null;
  return (
    <MaskOverlay key={lab.segmentRunId} segmentation={segmentation} chosenId={lab.confirmedId} />
  );
}

/** The saved zone over the photo or the camera's frames, and while it is drawn. */
function ZoneLayer() {
  const lab = useLabParts(useView(), useFeedback(), useCamera(), useObservation(), useDesk());
  const { camera, cameraSize, drawing, busy, memory } = lab;
  // While it is dragged, the zone lives in a store this reads; the lab gets it on release.
  const live = useDragRect('zone');
  const visibleZone = (drawing && live) || lab.visibleZone;
  const { zoneShown, occupied, zoneTag } = useZoneView(live);
  // Named while it is drawn, selected, or under the pointer; saved zones are hit-tested too.
  const { ref, hovered } = useHoveredZone(ruleRects(memory), camera ? cameraSize : null);
  const named =
    drawing ||
    hovered === MAIN_RULE ||
    (lab.selection?.kind === 'rule' && lab.selection.id === MAIN_RULE);
  // What the press took hold of, and the zone as it was then.
  const grab = useRef<{ grab: Grab; from: Rect | null }>({ grab: 'draw', from: null });
  const endDrag = () => {
    lab.zoneStart.current = null;
    const d = dragRectStore.get();
    if (d?.kind !== 'zone') return;
    dragRectStore.set(null);
    lab.setDraftZone(d.rect);
  };
  useEffect(() => () => dragRectStore.set((d) => (d?.kind === 'zone' ? null : d)), []);
  const layer = visibleZone && (
    <svg
      ref={camera ? undefined : ref}
      className={`zone-overlay ${drawing ? 'drawing' : ''} ${occupied ? 'inside' : ''}`}
      {...(cameraSize ? { width: cameraSize.width, height: cameraSize.height } : {})}
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      aria-label={
        drawing
          ? 'Draw placement zone'
          : `Saved placement zone${occupied ? `, ${mugOf(memory)?.label ?? 'mug'} inside` : ''}`
      }
      onPointerDown={(e) => {
        if (!drawing || busy) return;
        lab.zoneStart.current = lab.zonePoint(e);
        grab.current = { grab: grabOf(e.target), from: visibleZone };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drawing || !lab.zoneStart.current) return;
        const { grab: g, from } = grab.current;
        dragRectStore.set({
          kind: 'zone',
          rect: dragRect(from, g, lab.zoneStart.current, lab.zonePoint(e)),
        });
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Nested in the camera's fitted layer, the SVG catches presses only where it paints. */}
      {drawing && <rect className="zone-hit" width="1000" height="1000" />}
      <rect
        x={visibleZone.x * 1000}
        y={visibleZone.y * 1000}
        width={visibleZone.width * 1000}
        height={visibleZone.height * 1000}
      />
      {drawing && (
        <RectHandles
          rect={visibleZone}
          to={(p) => ({ x: p.x * 1000, y: p.y * 1000 })}
          {...(cameraSize ? { scale: { x: cameraSize.width, y: cameraSize.height } } : {})}
        />
      )}
    </svg>
  );
  return (
    <>
      {zoneShown &&
        (camera
          ? cameraSize && (
              // Fitted to the picture like the video's object-fit: contain, not to the stage.
              <svg
                ref={ref}
                className="zone-fit"
                viewBox={`0 0 ${cameraSize.width} ${cameraSize.height}`}
              >
                {layer}
                {visibleZone && named && (
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
          : layer)}
      {zoneShown && visibleZone && named && !camera && (
        <span
          className={`zone-tag ${drawing ? 'drawing' : ''} ${occupied ? 'inside' : ''}`}
          style={{ left: `${visibleZone.x * 100}%`, top: `${visibleZone.y * 100}%` }}
          aria-hidden="true"
        >
          {zoneTag}
        </span>
      )}
    </>
  );
}

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Drag a rectangle on the photo: for the box around a thing, and for the
 * camera's zoomed view. The rectangle being dragged lives in `dragRectStore`,
 * so only this draws at the pointer's rate; `onRect` gets it on release.
 */
function RectDraw({
  kind,
  label,
  rect: drawn,
  onRect,
}: {
  kind: 'box' | 'zoom' | 'motion';
  label: string;
  rect: Rect | null | undefined;
  onRect: (rect: Rect) => void;
}) {
  const { zonePoint } = useObservation();
  const start = useRef<{ x: number; y: number; grab: Grab; from: Rect | null } | null>(null);
  const live = useDragRect(kind);
  const rect = live ?? drawn;
  const endDrag = () => {
    start.current = null;
    const d = dragRectStore.get();
    if (d?.kind !== kind) return;
    dragRectStore.set(null);
    onRect(d.rect);
  };
  useEffect(() => () => dragRectStore.set((d) => (d?.kind === kind ? null : d)), [kind]);
  return (
    <svg
      className="zone-overlay drawing fixture-box"
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      aria-label={label}
      onPointerDown={(e) => {
        start.current = { ...zonePoint(e), grab: grabOf(e.target), from: rect ?? null };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const a = start.current;
        if (!a) return;
        dragRectStore.set({ kind, rect: dragRect(a.from, a.grab, a, zonePoint(e)) });
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {rect && (
        <rect
          x={rect.x * 1000}
          y={rect.y * 1000}
          width={rect.width * 1000}
          height={rect.height * 1000}
        />
      )}
      {rect && <RectHandles rect={rect} to={(p) => ({ x: p.x * 1000, y: p.y * 1000 })} />}
    </svg>
  );
}

/** The box drawn around a thing to add as a fixture, the camera's zoomed view, and a motion zone. */
function DrawLayers() {
  const lab = useLabParts(useView(), useCamera(), useNavigation());
  const { camera, mode, image, boxing, zooming, ruleDraft } = lab;
  return (
    <>
      {ruleDraft?.motion && (camera || mode === 'demo' || image) && (
        <RectDraw
          kind="motion"
          label="Draw the motion zone"
          rect={ruleDraft.rect}
          onRect={(rect) => {
            const { onSurface: _, ...draft } = ruleDraft;
            lab.setRuleDraft({ ...draft, rect });
          }}
        />
      )}
      {boxing && !camera && (mode === 'demo' || image) && (
        <RectDraw
          kind="box"
          label="Draw a box around the thing"
          rect={boxing.rect}
          onRect={(rect) => lab.setBoxing({ rect })}
        />
      )}
      {zooming && camera && (
        <RectDraw
          kind="zoom"
          label="Draw the camera’s zoomed view"
          rect={zooming.rect}
          onRect={(rect) => lab.setZooming({ rect })}
        />
      )}
    </>
  );
}

/** The brush's held frame and its overlay. */
function BrushLayer() {
  const lab = useLabParts(useCamera(), useAi(), useObservation());
  const { brushing } = useBrushing();
  if (!brushing) return null;
  return (
    <>
      {lab.brush.held && lab.camera && (
        <img className="brush-held" src={lab.brush.held} alt="The frame held for the AI brush" />
      )}
      <BrushOverlay brush={lab.brush} point={lab.zonePoint} />
    </>
  );
}

/**
 * A box or polygon drawn round a thing to outline it on this machine, with
 * the brush's own drawing. Live, the frame is held when it is finished, so
 * the outline is of what was drawn on.
 */
function OutlineLayer() {
  const lab = useLabParts(useView(), useCamera(), useObservation());
  // The stroke being drawn, read only by the overlay that draws it.
  const [stroke] = useState(() => createStore<BrushStroke | null>(null));
  const { outlining, mode, camera, image } = lab;
  if (!outlining || lab.drawing || lab.pinning || !(camera || mode === 'demo' || image))
    return null;
  const draw = {
    stroke,
    shape: outlining.shape,
    finish: async (next: BrushStroke) => {
      stroke.set(null);
      const shape = shapeOf(next);
      if (shape)
        lab.setOutlining({
          ...outlining,
          shape,
          held: mode === 'live' ? (lab.frameNow() ?? null) : null,
        });
    },
  };
  return (
    <>
      {outlining.held && camera && (
        <img className="brush-held" src={outlining.held} alt="The frame held for the outline" />
      )}
      <BrushOverlay
        brush={draw}
        point={lab.zonePoint}
        label="Outline a thing: drag a box, or click points around it"
      />
    </>
  );
}

/** The selected object's latest sighting, ringed on the photo when it was seen on a frame this size. */
function FocusLayer() {
  const lab = useLabParts(useView(), useDesk(), useCamera(), useObservation());
  const { memory, camera, dimensions } = lab;
  const sel = lab.selection;
  const focusSeen =
    sel?.kind === 'object'
      ? sel.id === 'main'
        ? mugSighting(memory)
        : otherObjects(memory)?.find((o) => o.id === sel.id)?.observation
      : null;
  const focusBox =
    focusSeen &&
    !camera &&
    focusSeen.frame.width === dimensions.width &&
    focusSeen.frame.height === dimensions.height
      ? focusSeen
      : null;
  if (!focusBox) return null;
  return (
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
  );
}

/** What the local follower, the server's watch and the tracking layer draw over the camera. */
function FollowLayers() {
  const lab = useLabParts(
    useView(),
    useCamera(),
    useDesk(),
    useFollowState(),
    useTracking(),
    useObservation(),
  );
  const { follow, watching, memory, segmentation } = lab;
  const selected = selectedThing(lab.selection, memory);
  const { zoneShown } = useZoneView();
  // The watcher's boxes belong over a picture: with none yet (the camera opening), they float on nothing.
  const draw = followDraw({
    camera: Boolean(lab.camera),
    tracking: lab.tracking,
    follow: Boolean(follow),
    watching: Boolean(watching),
    picture: Boolean(lab.image) || lab.mode === 'demo',
  });
  return (
    <>
      {draw === 'follow' && <FollowOverlay localZone={lab.localZone} zoneShown={zoneShown} />}
      {draw === 'watch' && <WatchedBoxes selected={selected} />}
      {draw === 'tracking' && (
        <WatchedTracking
          video={lab.video}
          selected={selected}
          memory={memory}
          follow={follow}
          segmentation={segmentation}
        />
      )}
      {lab.camera && lab.showStats && <WatchedStats video={lab.video} memory={memory} />}
    </>
  );
}

/**
 * How the trackers keep up, in the line under the camera: the server's
 * watcher while it watches, the browser's local follow while it follows,
 * else the line's own caption. Each renders at its tracker's rate, alone.
 */
function HealthBars({ caption }: { caption: ReactNode }) {
  const watcher = useStore(watchStore, (w) => (w?.on ? (w.health ?? null) : null));
  const local = useStore(followHealthStore);
  if (!watcher && !local) return caption;
  return (
    <div className="health-bars">
      {watcher && <HealthBar who="Watcher" health={watcher} />}
      {local && <HealthBar who="This tab" health={local} />}
    </div>
  );
}

/** The server watcher's boxes and their tags; it renders for each message the watcher sends, alone. */
function WatchedBoxes({ selected }: { selected: string | null }) {
  const watch = useStore(watchStore);
  if (!watch) return null;
  const picked = selected && watch.things.some((t) => t.id === selected) ? selected : null;
  return (
    <>
      {watch.things.length > 0 && (
        <svg
          className={`follow-overlay${picked ? ' picked' : ''}`}
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          aria-label="What the server is watching"
        >
          {watch.things.map((t) => (
            <rect
              key={t.id}
              className={`follow-box ${t.status === 'following' ? 'follow' : 'unsure'}${t.id === picked ? ' selected' : ''}`}
              x={t.box.x * 1000}
              y={t.box.y * 1000}
              width={t.box.width * 1000}
              height={t.box.height * 1000}
            />
          ))}
        </svg>
      )}
      {watch.things.map((t) => (
        <span
          key={t.id}
          className={`zone-tag follow-tag ${t.status === 'following' ? 'follow' : 'unsure'}`}
          style={{ left: `${t.box.x * 100}%`, top: `${t.box.y * 100}%` }}
          aria-hidden="true"
        >
          {t.label.toUpperCase()} · {WATCH_LAYER[t.layer]}
          {t.status === 'following'
            ? ` · ${t.score.toFixed(2)}`
            : t.status === 'entangled'
              ? ' · WHICH ONE?'
              : t.status === 'covered'
                ? ' · PARTLY HIDDEN'
                : ` · ${t.status.toUpperCase()}`}
        </span>
      ))}
    </>
  );
}

/** The tracking layer, given the watcher's newest view from its store. */
function WatchedTracking(props: Omit<Parameters<typeof FollowedTracking>[0], 'watch'>) {
  const watch = useStore(watchStore);
  return <FollowedTracking {...props} watch={watch} />;
}

/** The stats over the camera, given the watcher's newest view from its store. */
function WatchedStats(props: Omit<Parameters<typeof StatsOverlay>[0], 'watch'>) {
  const watch = useStore(watchStore);
  return <StatsOverlay {...props} watch={watch} />;
}

/** The calibration's corner, the calibration editor and the surface pin, over the photo. */
function CalibrationLayers({ calibratePanel }: { calibratePanel: HTMLDivElement | null }) {
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useDesk(),
    useCamera(),
    useCalibration(),
    useProbes(),
  );
  const { camera, dimensions, pinning, memory } = lab;
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
  return (
    <>
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
    </>
  );
}

/** The photo or the camera, with everything drawn over it, framed and labelled. */
export function PhotoStage({
  hand,
  calibratePanel,
}: {
  hand: boolean;
  calibratePanel: HTMLDivElement | null;
}) {
  const lab = useLabParts(useView(), useCamera());
  const { mode, camera, image } = lab;
  // The fridge's placeholder is a photo at its own size, not a frame: nothing measured on a frame is drawn over it.
  const fridge = useFridgePlaceholder();
  const dimensions = fridge ? FRIDGE_PHOTO : stageSize(camera, lab.cameraSize, lab.dimensions);
  return (
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
        <Media />
        {!fridge && (
          <>
            <TrailLayer />
            <MasksLayer />
            <ZoneLayer />
            <SavedZones />
            <DrawLayers />
            <BrushLayer />
            <OutlineLayer />
            <FocusLayer />
            <FollowLayers />
            <CalibrationLayers calibratePanel={calibratePanel} />
          </>
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
      <LayerChips view="photo" />
    </div>
  );
}

/** A fixture's right-click menu in the Iso view. */
export function FixtureMenu({
  menu,
  onClose,
}: {
  menu: { id: string; at: { x: number; y: number } };
  onClose: () => void;
}) {
  const lab = useLabParts(useFeedback(), useDesk(), useNavigation(), useFixtures());
  const { busy, memory } = lab;
  return (
    <ContextMenu
      at={menu.at}
      label={`${memory?.fixtures?.find((f) => f.id === menu.id)?.label ?? 'Fixture'} actions`}
      items={[
        {
          label: 'Open',
          onSelect: () => lab.select({ kind: 'fixture', id: menu.id }),
        },
        {
          label: 'Edit',
          onSelect: () =>
            window.open(`/studio?thing=${encodeURIComponent(menu.id)}`, '_blank', 'noopener'),
        },
        {
          label: 'Delete',
          destructive: true,
          separated: true,
          disabled: Boolean(busy),
          onSelect: () => void lab.deleteFixtures([menu.id]),
        },
        {
          label: 'Not a fixture',
          destructive: true,
          disabled: Boolean(busy),
          onSelect: () => void lab.deleteFixtures([menu.id], true),
        },
      ]}
      onClose={onClose}
    />
  );
}

/** The buttons that move the demo mug: the only part under the canvas that reads tracking. */
function DemoMugButtons() {
  const lab = useLabParts(useView(), useFeedback(), useTracking());
  return (
    <div className="capture-actions" role="group" aria-label="Move the demo mug">
      {(Object.keys(DEMO_POSITIONS) as DemoPosition[]).map((p) => (
        <button
          key={p}
          aria-pressed={lab.demoPosition === p}
          disabled={Boolean(lab.busy)}
          onClick={() => lab.moveDemoMug(p)}
        >
          {DEMO_POSITIONS[p].label}
        </button>
      ))}
    </div>
  );
}

/** The line under the canvas, and the buttons that move the demo mug or set up a camera. */
export function SceneBottom() {
  const lab = useLabParts(useView(), useFeedback(), useDesk(), useCamera(), useCalibration());
  const { mode, busy, camera } = lab;
  const fridge = useFridgePlaceholder();
  /** Take the placeholder photo on show as this frame, to pin and work on like an upload. */
  async function takeFridgePhoto() {
    const img = new Image();
    img.src = fridgeViewUrl(lab.fridgeView);
    await img.decode();
    lab.captureCanvas(img, img.naturalWidth, img.naturalHeight);
  }
  // Rooms a stream camera can be assigned to: the presets, and the person's own scene.
  const rooms: RoomOption[] = [
    ...isoSceneKindSchema.options.map((k) => ({ value: k, label: ISO_PRESETS[k].label })),
    ...(lab.memory?.scene
      ? [{ value: 'custom' as const, label: lab.memory.scene.label ?? 'Custom' }]
      : []),
  ];
  const chosenStream = lab.network.streams.find((s) => s.id === lab.cameraSource);
  // Cameras locked to another room aren't offered here; the one chosen stays listed.
  const room = lab.workScene === 'custom-desk' ? 'custom' : lab.workScene;
  const streams = lab.network.streams.filter(
    (s) => s.id === lab.cameraSource || cameraFitsScene(s, room),
  );
  // A zoomed view inside the open one, as shares of the camera's whole frame: too small has too few pixels.
  const zoomRect = lab.zooming?.rect;
  const zoomOk =
    zoomRect &&
    zoomRect.width * (lab.zoomable?.crop?.w ?? 1) >= CROP_MIN &&
    zoomRect.height * (lab.zoomable?.crop?.h ?? 1) >= CROP_MIN;
  return (
    <div className="scene-bottom">
      <HealthBars
        caption={
          <span>
            {fridge
              ? 'Placeholder fridge camera: photos of a real fridge until yours is set up.'
              : mode === 'demo'
                ? 'Demo desk. Move the mug to test tracking; no model call or real lamp.'
                : camera
                  ? 'Camera on. Capture a frame to work on it.'
                  : 'Your photo stays here until you run a live step.'}
          </span>
        }
      />
      {fridge && (
        <div className="capture-actions" role="group" aria-label="Fridge camera view">
          {(Object.keys(FRIDGE_VIEWS) as FridgeView[]).map((v) => (
            <button
              key={v}
              aria-pressed={lab.fridgeView === v}
              onClick={() => lab.setFridgeView(v)}
            >
              {FRIDGE_VIEWS[v].label}
            </button>
          ))}
          {mode === 'live' && (
            <Button disabled={Boolean(busy)} onClick={() => void takeFridgePhoto()}>
              Use this photo
            </Button>
          )}
        </div>
      )}
      {mode === 'demo' && !fridge && <DemoMugButtons />}
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
              {streams.length > 0 && (
                <select
                  aria-label="Camera source"
                  value={lab.cameraSource}
                  disabled={lab.cameraPending}
                  onChange={(e) => lab.setCameraSource(e.target.value)}
                >
                  <option value="">This device</option>
                  {streams.map((s) => (
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
  );
}

/** The hidden file input behind Upload. */
export function PhotoInput() {
  const lab = useCamera();
  return (
    <input
      ref={lab.file}
      type="file"
      accept="image/png,image/jpeg"
      hidden
      aria-label="Desk photo to upload"
      onChange={(e) => void lab.upload(e.target.files?.[0])}
    />
  );
}

/** The card for a failed step, with a way to open its run. */
export function IssueCard() {
  const lab = useLabParts(useFeedback(), useDesk(), useRunLog());
  if (!lab.issue) return null;
  return (
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
