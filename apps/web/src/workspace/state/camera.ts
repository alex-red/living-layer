import { useEffect, useRef, useState } from 'react';
import type { Mode, Scene, Segmentation, DemoPosition, CameraCrop } from '@livinglayer/domain';
import { cameraForScene } from '@livinglayer/domain';
import {
  cropStream,
  openMjpeg,
  openStream,
  useNetworkStreams,
  type NetworkStream,
} from '../../streams';
import { demoFrameUrl } from '../demoFrame';
import { REOPEN_TRIES } from './helpers';
import type { ViewSlice } from './view';
import type { FeedbackSlice } from './feedback';
import type { RunLogSlice } from './runlog';
import type { DeskSlice } from './desk';
import type { FollowStateSlice } from './follow-state';
import { useStableSlice } from './stable';

/** The Camera slice of the lab's state. */
export function useCameraSlice(
  deps: ViewSlice & FeedbackSlice & RunLogSlice & DeskSlice & FollowStateSlice,
) {
  const {
    boot,
    busy,
    calibrating,
    deskReady,
    mode,
    pinning,
    setDemoPosition,
    setDrawing,
    setError,
    setLamp,
    setMessage,
    setMode,
    setStageView,
    setZooming,
    stopFollow,
    workScene,
  } = deps;
  const [image, setImage] = useState<string>();
  const [dimensions, setDimensions] = useState({ width: 960, height: 640 });
  // The size a frame captured from the running camera would be prepared at.
  const [cameraSize, setCameraSize] = useState<{ width: number; height: number } | null>(null);
  const [scene, setScene] = useState<Scene>();
  const [segmentation, setSegmentation] = useState<Segmentation>();
  const [segmentRunId, setSegmentRunId] = useState<string>();
  const [camera, setCamera] = useState(false);
  const [cameraPending, setCameraPending] = useState(false);
  const cameraGeneration = useRef(0);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const closeNetwork = useRef<(() => void) | null>(null);
  /** The zoomed view of the camera that is open, and of the one the current frame came from. */
  const openCrop = useRef<CameraCrop | null>(null);
  const imageCrop = useRef<CameraCrop | null>(null);
  const network = useStableSlice(useNetworkStreams());
  /** '' for this device's camera, else the id of a network camera. */
  const [cameraSource, setCameraSource] = useState(boot.prefs.cameraSource);
  /** The camera should be on: set when one opens, cleared only when the person stops it. */
  const [cameraWanted, setCameraWanted] = useState(boot.prefs.cameraOn);
  /** Reopens tried since the camera last opened; they stop after a few failures. */
  const [reopenTries, setReopenTries] = useState(0);
  /** The tracking layer: it follows the live camera, so turning it on opens the camera. */
  const [tracking, setTracking] = useState(boot.prefs.tracking);
  const file = useRef<HTMLInputElement>(null);
  const imageGeneration = useRef(0);
  const mounted = useRef(true);
  function releaseStream() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    closeNetwork.current?.();
    closeNetwork.current = null;
    openCrop.current = null;
  }
  /** Close the camera but keep it wanted, so it opens again once it can (back in live mode, the stream back). */
  const dropCamera = () => {
    stopFollow();
    cameraGeneration.current++;
    releaseStream();
    setCamera(false);
    setZooming(null);
  };
  /** The person stopped the camera (or took a frame from it): it stays off, across reloads too. */
  const stopCamera = () => {
    setCameraWanted(false);
    dropCamera();
  };
  function changeMode(next: Mode) {
    dropCamera();
    setReopenTries(0);
    imageGeneration.current++;
    setMode(next);
    setDemoPosition('centre');
    setLamp('off');
    setImage(undefined);
    setDimensions({ width: 960, height: 640 });
    setScene(undefined);
    setSegmentation(undefined);
    setSegmentRunId(undefined);
    setDrawing(false);
    setError('');
    setMessage(
      next === 'demo'
        ? 'Demo selected: the office from its corner camera, with no model calls and a virtual lamp.'
        : 'Add a desk photo. It stays local until you run a live step.',
    );
  }
  /** The size a frame is prepared at: no side over 1280. */
  function frameSize(width: number, height: number) {
    const scale = Math.min(1, 1280 / Math.max(width, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  }
  /** Prepares a frame; `crop` is the zoomed view it came through, when it came from a camera. */
  function captureCanvas(
    source: CanvasImageSource,
    width: number,
    height: number,
    crop: CameraCrop | null = null,
  ) {
    imageCrop.current = crop;
    const canvas = document.createElement('canvas');
    Object.assign(canvas, frameSize(width, height));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot prepare the image.');
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/png');
    setImage(url);
    setDimensions({ width: canvas.width, height: canvas.height });
    setScene(undefined);
    setSegmentation(undefined);
    setSegmentRunId(undefined);
    setDrawing(false);
    setMessage(
      'Photo prepared locally. Live steps send this image to Meta only when you press one.',
    );
    return url;
  }
  const sceneUrl = (position: DemoPosition) => demoFrameUrl(position);
  /** Prepare a chosen photo as the current frame; returns it, or nothing on failure. */
  async function upload(
    chosen?: File,
    crop: CameraCrop | null = null,
  ): Promise<string | undefined> {
    if (!chosen) return;
    const generation = ++imageGeneration.current;
    setError('');
    let url: string | undefined;
    try {
      if (!['image/png', 'image/jpeg'].includes(chosen.type) || chosen.size > 10_000_000)
        throw new Error('Choose a PNG or JPEG under 10 MB.');
      const bitmap = await createImageBitmap(chosen, { imageOrientation: 'from-image' });
      try {
        if (mounted.current && generation === imageGeneration.current)
          url = captureCanvas(bitmap, bitmap.width, bitmap.height, crop);
      } finally {
        bitmap.close();
      }
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not open that image.');
    }
    if (file.current) file.current.value = '';
    return url;
  }
  /** Opens the chosen camera, or `source` when one was just picked (a phone that just paired). */
  async function startCamera(source?: NetworkStream) {
    if (cameraPending || stream.current) return;
    setError('');
    setCameraPending(true);
    const generation = ++cameraGeneration.current;
    const remote = source ?? network.streams.find((s) => s.id === cameraSource);
    // A camera only the server reads, with no live relay: grab one frame of it instead.
    if (remote && !remote.whep && !remote.preview && remote.snapshot) {
      try {
        const response = await fetch(remote.snapshot);
        if (!response.ok)
          throw new Error(
            ((await response.json().catch(() => ({}))) as { error?: { message?: string } }).error
              ?.message ?? `Could not get a picture from ${remote.name}.`,
          );
        const blob = await response.blob();
        if (mounted.current && generation === cameraGeneration.current) {
          await upload(new File([blob], 'camera.png', { type: 'image/png' }), remote.crop ?? null);
          setMessage(`A frame from ${remote.name}. Grab another whenever the room changes.`);
        }
      } catch (e) {
        if (mounted.current && generation === cameraGeneration.current)
          setError(e instanceof Error ? e.message : `Could not get a picture from ${remote.name}.`);
      } finally {
        if (mounted.current) setCameraPending(false);
      }
      return;
    }
    try {
      const lost = () => {
        if (!mounted.current || generation !== cameraGeneration.current) return;
        dropCamera();
        setError(
          remote
            ? `The network camera "${remote.name}" stopped sending.`
            : 'The camera stopped sending.',
        );
      };
      const crop = remote?.crop ?? null;
      // WebRTC comes whole and is cut to the zoomed view here; the server's MJPEG comes cut.
      // A saved camera falls back to that MJPEG when its relay can't be played.
      const webrtc = async (whep: string) => {
        const media = await openStream(whep, lost);
        return crop ? cropStream(media, crop) : media;
      };
      const opened = remote
        ? remote.whep
          ? remote.preview
            ? await webrtc(remote.whep).catch(() => openMjpeg(remote.preview!, lost))
            : await webrtc(remote.whep)
          : await openMjpeg(remote.preview!, lost)
        : {
            media: await navigator.mediaDevices.getUserMedia({
              video: { width: { ideal: 1280 }, height: { ideal: 720 } },
              audio: false,
            }),
            close: undefined,
          };
      if (!mounted.current || generation !== cameraGeneration.current) {
        opened.media.getTracks().forEach((t) => t.stop());
        opened.close?.();
        return;
      }
      stream.current = opened.media;
      closeNetwork.current = opened.close ?? null;
      openCrop.current = crop;
      // This device's camera ends its track when it is unplugged or taken by another app.
      if (!remote) opened.media.getVideoTracks()[0]?.addEventListener('ended', lost);
      setCamera(true);
      setCameraWanted(true);
      setReopenTries(0);
      // The feed draws in the photo half, which the iso view hides; show both.
      setStageView((v) => (v === 'iso' ? 'split' : v));
    } catch {
      if (mounted.current && generation === cameraGeneration.current)
        setError(
          remote
            ? remote.source === 'phone'
              ? `Could not connect to the ${remote.name}. Keep the page open on the phone and try again.`
              : remote.source === 'saved'
                ? `Could not stream ${remote.name}. Check its URL, its credentials and that ffmpeg is installed on the server.`
                : `Could not reach the network camera "${remote.name}". Is the share still running?`
            : 'Camera access is unavailable. Upload a desk photo instead.',
        );
    } finally {
      if (mounted.current) setCameraPending(false);
    }
  }
  useEffect(() => {
    const el = video.current;
    if (!camera || !el) return setCameraSize(null);
    const read = () =>
      setCameraSize(el.videoWidth ? frameSize(el.videoWidth, el.videoHeight) : null);
    read();
    el.addEventListener('loadedmetadata', read);
    el.addEventListener('resize', read);
    return () => {
      el.removeEventListener('loadedmetadata', read);
      el.removeEventListener('resize', read);
    };
  }, [camera]);
  useEffect(() => {
    if (camera && video.current && stream.current) {
      video.current.srcObject = stream.current;
      void video.current
        .play()
        .catch(() => setError('Camera playback failed. Stop the camera and try an upload.'));
    }
  }, [camera]);
  // A camera that was on and wasn't stopped by the person opens again: after a reload,
  // back in live mode, after calibrating or pinning, or once a dropped stream can be reached.
  // A few tries, further apart each time.
  useEffect(() => {
    if (mode !== 'live' || !cameraWanted || camera || cameraPending || busy) return;
    if (pinning || calibrating) return;
    // After the camera list, which can change the room's camera, has loaded.
    if (!deskReady || !network.loaded || reopenTries >= REOPEN_TRIES) return;
    const remote = cameraSource ? network.streams.find((s) => s.id === cameraSource) : undefined;
    // A network camera reopens once it is listed with a live relay; a still-only one never was on.
    if (cameraSource && !(remote?.whep || remote?.preview)) return;
    let cancelled = false;
    const timer = window.setTimeout(
      async () => {
        // Never prompt on its own: this device's camera reopens only if it is already allowed.
        if (!remote) {
          const state = await navigator.permissions
            ?.query({ name: 'camera' as PermissionName })
            .then((p) => p.state)
            .catch(() => 'prompt');
          if (cancelled || state !== 'granted') return;
        }
        setReopenTries((t) => t + 1);
        void startCamera(remote);
      },
      reopenTries ? 2000 * 2 ** (reopenTries - 1) : 500,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    mode,
    cameraWanted,
    camera,
    cameraPending,
    busy,
    pinning,
    calibrating,
    deskReady,
    reopenTries,
    cameraSource,
    network.loaded,
    network.streams,
  ]);
  /** Turns the tracking layer on or off; on, it opens the live camera rather than track a still. */
  function changeTracking(on: boolean) {
    setTracking(on);
    if (!on || mode !== 'live' || camera || pinning || calibrating) return;
    setReopenTries(0);
    void startCamera();
  }
  // A room with a camera assigned to it uses that camera, unless the one chosen is assigned there too.
  useEffect(() => {
    if (camera) return;
    const room = workScene === 'custom-desk' ? 'custom' : workScene;
    const current = network.streams.filter((s) => s.id === cameraSource);
    if (cameraForScene(current, room)) return;
    const assigned = cameraForScene(network.streams, room);
    if (assigned) setCameraSource(assigned.id);
  }, [workScene, network.streams]);
  /** The frame to look in: the camera's, captured now, or the current photo; the demo desk itself in demo mode. */
  function frameNow(): string | undefined {
    if (mode === 'demo') return undefined;
    if (camera && video.current?.videoWidth)
      return captureCanvas(
        video.current,
        video.current.videoWidth,
        video.current.videoHeight,
        openCrop.current,
      );
    return image;
  }
  /** A frame to set the room up from, with the zoomed view it came through. */
  function cameraFrame() {
    const url = frameNow();
    return { url, crop: url ? imageCrop.current : null };
  }
  return useStableSlice({
    camera,
    cameraFrame,
    cameraGeneration,
    cameraPending,
    cameraSize,
    cameraSource,
    cameraWanted,
    captureCanvas,
    changeMode,
    dimensions,
    dropCamera,
    file,
    frameNow,
    frameSize,
    image,
    imageCrop,
    mounted,
    network,
    openCrop,
    releaseStream,
    scene,
    sceneUrl,
    segmentRunId,
    segmentation,
    setCameraSource,
    setCameraWanted,
    setReopenTries,
    setScene,
    setSegmentRunId,
    setSegmentation,
    setTrackingRaw: setTracking,
    startCamera,
    stopCamera,
    tracking,
    upload,
    video,
    setTracking: changeTracking,
  });
}
export type CameraSlice = ReturnType<typeof useCameraSlice>;
