import type { ZoneRect, IsoSceneKind, Quad } from '@livinglayer/domain';
import { ISO_PRESETS, cropWithin } from '@livinglayer/domain';
import { api, ApiError, apiBlob } from '../../api';
import { aiTaskStore, setAiTask } from './ai-task-store';
import type { CalibrationDraft } from '../../iso/RoomCalibrate';
import type { HandCalibration } from './helpers';
import type { ViewSlice } from './view';
import type { FeedbackSlice } from './feedback';
import type { RunLogSlice } from './runlog';
import type { DeskSlice } from './desk';
import type { FollowStateSlice } from './follow-state';
import type { CameraSlice } from './camera';
import type { ObservationSlice } from './observation';
import type { TrackingSlice } from './tracking';
import type { NavigationSlice } from './navigation';
import type { AiSlice } from './ai';
import type { FixturesSlice } from './fixtures';
import { useStableSlice } from './stable';
import type { NetworkStream } from '../../streams';

/** The Calibration slice of the lab's state. */
export function useCalibrationSlice(
  deps: ViewSlice &
    FeedbackSlice &
    RunLogSlice &
    DeskSlice &
    FollowStateSlice &
    CameraSlice &
    ObservationSlice &
    TrackingSlice &
    NavigationSlice &
    AiSlice &
    FixturesSlice,
): CalibrationSlice {
  const {
    busy,
    camera,
    cameraSource,
    captureCanvas,
    costNote,
    dimensions,
    dropCamera,
    frameNow,
    frameSize,
    image,
    imageCrop,
    memory,
    mode,
    network,
    openCrop,
    pinning,
    refresh,
    setBoxing,
    setBusy,
    setCalibrating,
    setDrawing,
    setError,
    setMemory,
    setMessage,
    setPinning,
    setStageView,
    setZooming,
    stageView,
    startCamera,
    stopCamera,
    tracking,
    video,
    watching,
    workScene,
  } = deps;
  /**
   * Find a surface's corners where the room's calibrated camera sees it (no
   * call), then open the pin with them to check. Not in view means clicking
   * by hand.
   */
  async function autoPin(target: {
    scene: IsoSceneKind | 'custom';
    surfaceId: string;
    label: string;
  }) {
    if (busy) return;
    setBusy('autopin');
    setError('');
    setDrawing(false);
    try {
      const result = await api('desk/auto-pin', { mode, surfaceId: target.surfaceId });
      const cost = ' through the calibrated camera';
      const fits =
        result.pin &&
        result.pin.frame.width === dimensions.width &&
        result.pin.frame.height === dimensions.height;
      if (!result.pin || !fits) {
        setPinning(target);
        setMessage(`The ${target.label} isn’t in view${cost}. Click its four corners instead.`);
      } else {
        setPinning({ ...target, corners: result.pin.corners });
        setMessage(
          `Found the ${target.label}${cost}. Drag any corner that’s off, then save the pin.`,
        );
      }
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not place the surface.');
    } finally {
      setBusy('');
    }
  }
  /**
   * Calibrate the room's camera on the current frame: SAM outlines the floor
   * and walls (two calls, live) to suggest the marks, which open on the photo
   * to drag into place beside the room's size.
   */
  async function startCalibrating() {
    if (busy) return;
    setBusy('calibrate');
    setError('');
    setDrawing(false);
    setPinning(null);
    try {
      const result = await api('room/floor', {
        mode,
        ...(mode === 'live' ? { imageDataUrl: image } : {}),
      });
      const { width, height } = result.frame;
      const marks = result.marks ?? {
        corner: { x: width / 2, y: height * 0.3 },
        back: [{ x: width * 0.85, y: height * 0.65 }],
        left: [{ x: width * 0.15, y: height * 0.6 }],
      };
      setCalibrating({ marks, room: roomFloorCm() });
      if (stageView === 'iso') setStageView('split');
      setMessage(
        result.marks
          ? `Found the floor and walls${costNote(result.run)}. Drag the marks onto the far corner and along each wall's floor line, and give the room's size.`
          : `No floor found${costNote(result.run)}. Drag the marks onto the far corner and along each wall's floor line.`,
      );
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not find the floor.');
    } finally {
      setBusy('');
    }
  }
  /**
   * Calibrate by hand from what an automatic setup found: its corner and wall
   * lines where it saw them, a guess for a hidden wall, and Spark's sizes. The
   * frame stays the one the setup used, so the camera stops to show it.
   */
  function calibrateByHand(found: HandCalibration) {
    // The setup's dialog stays open on why it stopped, and offers this as the next step.
    if (aiTaskStore.get()) {
      setAiTask((t) =>
        t
          ? {
              ...t,
              open: true,
              next: {
                label: 'Place corner by hand',
                run: () => openCalibration(withOwnSize(found)),
              },
            }
          : t,
      );
      setMessage('The setup stopped short of calibrating: place the far corner by hand.');
      return;
    }
    openCalibration(withOwnSize(found));
  }
  /** A room the person drew or calibrated is sized as they made it, not as Spark guessed. */
  function withOwnSize(found: HandCalibration): HandCalibration {
    const own = memory?.camera || workScene === 'custom' || workScene === 'custom-desk';
    return own ? { ...found, room: roomFloorCm() } : found;
  }
  /**
   * The room's floor inside its walls, in centimetres, as the calibration
   * starts it: as last calibrated, else as the room's scene is drawn (turned
   * or not), so its sides run along the walls they belong to.
   */
  function roomFloorCm() {
    const custom = workScene === 'custom' || workScene === 'custom-desk';
    const scene = custom
      ? memory?.scene
      : ISO_PRESETS[workScene === 'desk' || !workScene ? 'office' : workScene];
    const wall = (g: string) => scene?.props.find((p) => p.group === g);
    const left = wall('wall-left')?.size.w ?? 0;
    const back = wall('wall-back')?.size.d ?? 0;
    const known = memory?.camera?.camera.room;
    const tiles = known ?? scene?.grid;
    if (!tiles) return { w: 300, d: 240 };
    return { w: Math.round((tiles.w - left) * 30), d: Math.round((tiles.d - back) * 30) };
  }
  /** Stop the camera on the frame in hand and open calibration from what was found. */
  function openCalibration(found: HandCalibration) {
    const { width, height } = found.frame;
    const corner = found.marks?.corner ?? { x: width / 2, y: height * 0.3 };
    // A hidden wall starts as a line from the corner towards its side of the frame, to drag into place.
    const towards = (side: -1 | 1) =>
      [1, 2].map((k) => ({
        x: Math.min(width, Math.max(0, corner.x + side * k * width * 0.15)),
        y: Math.min(height, corner.y + k * height * 0.06),
      }));
    const back = found.marks?.back.length ? found.marks.back : towards(1);
    const left = found.marks?.left.length ? found.marks.left : towards(-1);
    if (camera) (tracking || watching ? dropCamera : stopCamera)();
    setCalibrating({
      marks: { corner, back, left, backEnd: null, leftEnd: null },
      room: found.room,
      ...(found.heightCm ? { heightCm: found.heightCm } : {}),
    });
    setStageView('split');
    setMessage(
      'Set the far corner by hand: drag the red mark onto where the walls meet the floor (behind the furniture if need be), then each wall’s marks onto its floor line. Check the room’s size, then calibrate and draft from the camera.',
    );
  }
  /**
   * Calibrate by hand on the frame the camera shows now, or the current
   * photo, with no model calls: the marks start where the last calibration
   * left them on a frame this size, or as a guess to drag.
   */
  function calibrateHere() {
    const v = video.current;
    const size = camera && v?.videoWidth ? frameSize(v.videoWidth, v.videoHeight) : dimensions;
    if (!frameNow()) return;
    const known = memory?.camera;
    const same =
      known?.camera.frame.width === size.width && known.camera.frame.height === size.height;
    openCalibration({
      marks: same ? known.marks : null,
      room: roomFloorCm(),
      frame: size,
    });
  }
  /**
   * Click a surface's corners on the frame the camera shows now, or the
   * current photo. The camera stops on that frame while the corners are set.
   */
  function pinHere(target: NonNullable<typeof pinning>) {
    if (!frameNow() && mode === 'live') return;
    if (camera) (tracking || watching ? dropCamera : stopCamera)();
    setDrawing(false);
    setPinning(target);
  }
  /**
   * The camera was taken to have moved but its calibration still holds: the
   * frame it shows now is what later frames are compared with, and zones apply
   * again (redraw any that no longer fit).
   */
  async function keepCameraView() {
    if (busy) return;
    setBusy('calibrate');
    setError('');
    try {
      const imageDataUrl = frameNow();
      if (mode === 'live' && !imageDataUrl)
        throw new Error('Start the camera or add a photo of the room first.');
      setMemory(
        await api('room/keep', {
          mode,
          ...(imageDataUrl ? { imageDataUrl } : {}),
        }),
      );
      setMessage(
        'Kept the calibration: zones apply again. Redraw any zone that no longer lines up.',
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not keep the camera’s view.');
    } finally {
      setBusy('');
    }
  }
  async function saveCalibration(draft: CalibrationDraft) {
    setBusy('calibrate');
    setError('');
    try {
      const scene =
        workScene === 'custom' || workScene === 'custom-desk' ? 'custom' : (workScene ?? 'office');
      const result = await api('room/calibrate', {
        mode,
        ...(mode === 'live' ? { imageDataUrl: image, crop: imageCrop.current } : {}),
        ...draft,
        scene: scene === 'desk' ? 'office' : scene,
      });
      setMemory(result.memory);
      setCalibrating(null);
      // One camera, one room: the frame and the room side by side.
      setStageView('split');
      setMessage(
        `Calibrated: the camera is about ${result.fit.heightCm} cm up and ${result.fit.hfovDeg}° wide. Zones drawn in the room now apply to every frame from it.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not calibrate the camera.');
    } finally {
      setBusy('');
    }
  }
  /** The camera that is open, when it can keep a zoomed view: a saved camera or the phone. */
  const zoomable = () => {
    const remote = network.streams.find((s) => s.id === cameraSource);
    return camera && remote && (remote.source === 'saved' || remote.source === 'phone')
      ? remote
      : null;
  };
  function startZooming() {
    setZooming({ rect: null });
    if (stageView === 'iso') setStageView('split');
    setMessage(
      'Drag a box over the part of the camera’s view to keep. It opens on it from now on. Esc cancels.',
    );
  }
  /**
   * Keeps the open camera's zoomed view on the server, so it opens on it every
   * time it connects, here or in any tab, and reopens it now. `rect` is a share
   * of what the camera shows now, so zooming in again goes further in; null
   * goes back to the whole frame.
   */
  async function saveZoom(rect: ZoneRect | null) {
    const remote = zoomable();
    setZooming(null);
    if (!remote) return;
    const crop = rect
      ? cropWithin(openCrop.current, { x: rect.x, y: rect.y, w: rect.width, h: rect.height })
      : null;
    setBusy('zoom');
    setError('');
    try {
      await api('streams/crop', { streamId: remote.id, crop });
      await network.scan();
      dropCamera();
      await startCamera({ ...remote, crop });
      const calibrated =
        memory?.camera && JSON.stringify(memory.camera.crop ?? null) !== JSON.stringify(crop);
      setMessage(
        `${remote.name} ${crop ? `now opens zoomed to ${Math.round(crop.w * 100)}×${Math.round(crop.h * 100)}% of its view` : 'now opens on its whole view'}.${calibrated ? ' The room was calibrated through another view: calibrate it again.' : ''}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not keep the camera’s view.');
    } finally {
      setBusy('');
    }
  }
  /** Show the desk photo and let the person box the thing a fixture is drafted from. */
  function startBoxing() {
    setBoxing({ rect: null });
    if (stageView === 'iso') setStageView('photo');
    setMessage('Drag a box around the thing on the desk photo. Esc cancels.');
  }
  /**
   * Check and drag the pinned surface's corners on the photo they were set on.
   * A drafted room's own photo is loaded when the page has lost it; another
   * room needs a frame from the same camera, the same size, on the stage.
   */
  async function adjustPin() {
    const pin = memory?.surface;
    if (!pin || busy) return;
    const label = (
      (pin.scene === 'custom' ? memory?.scene : ISO_PRESETS[pin.scene])?.surfaces.find(
        (s) => s.id === pin.surfaceId,
      )?.label ?? 'surface'
    ).toLowerCase();
    setError('');
    // The corners are dragged on a still photo, not the live camera: what it shows
    // now, which is the pinned camera's frame when it is the pin's size.
    let size = image ? dimensions : null;
    if (camera && video.current?.videoWidth) {
      frameNow();
      size = frameSize(video.current.videoWidth, video.current.videoHeight);
    }
    if (camera) (tracking || watching ? dropCamera : stopCamera)();
    const fits = size && size.width === pin.frame.width && size.height === pin.frame.height;
    if (!fits) {
      if (pin.scene !== 'custom') {
        setError(
          `Load a ${pin.frame.width} × ${pin.frame.height} frame from the pinned camera first; the corners are checked on it.`,
        );
        return;
      }
      try {
        const photo = await apiBlob(`scene/photo?mode=${mode}`).catch((e: unknown) => {
          throw new Error(
            e instanceof ApiError && e.code ? e.message : 'This room has no photo of its own kept.',
          );
        });
        const bitmap = await createImageBitmap(photo);
        try {
          captureCanvas(bitmap, bitmap.width, bitmap.height);
        } finally {
          bitmap.close();
        }
      } catch (e) {
        setError(e instanceof Error ? e : 'Could not load the room’s photo.');
        return;
      }
    }
    setStageView('photo');
    setPinning({
      scene: pin.scene,
      surfaceId: pin.surfaceId,
      label,
      corners: pin.corners,
      note: `Drag the corners onto the ${label}’s real corners. Things a scan placed move with the pin.`,
    });
    setMessage(`Check the ${label}’s corners on the photo, then save the pin.`);
  }
  return useStableSlice({
    adjustPin,
    autoPin,
    calibrateByHand,
    calibrateHere,
    keepCameraView,
    pinHere,
    saveCalibration,
    saveZoom,
    startBoxing,
    startCalibrating,
    startZooming,
    zoomable: zoomable(),
  });
}
/** What the Calibration slice of the lab offers: its state, derived values and actions. */
export interface CalibrationSlice {
  adjustPin: () => Promise<void>;
  autoPin: (target: {
    scene: IsoSceneKind | 'custom';
    surfaceId: string;
    label: string;
  }) => Promise<void>;
  calibrateByHand: (found: HandCalibration) => void;
  calibrateHere: () => void;
  keepCameraView: () => Promise<void>;
  pinHere: (
    target: NonNullable<{
      scene: IsoSceneKind | 'custom';
      surfaceId: string;
      label: string;
      corners?: Quad;
      note?: string;
    } | null>,
  ) => void;
  saveCalibration: (draft: CalibrationDraft) => Promise<void>;
  saveZoom: (rect: ZoneRect | null) => Promise<void>;
  startBoxing: () => void;
  startCalibrating: () => Promise<void>;
  startZooming: () => void;
  zoomable: NetworkStream | null;
}
