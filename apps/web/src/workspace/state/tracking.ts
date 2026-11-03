import { useEffect, useRef } from 'react';
import type {
  EvidenceRun,
  Segmentation,
  DeskMemory,
  PlacementDecision,
  DeskObservation,
  DemoPosition,
  LocalTrack,
  LocalVerdict,
  SelectionShape,
  UnitBox,
  WatchView,
} from '@livinglayer/domain';
import { DEMO_POSITIONS, startLocalTrack, stepLocalTrack } from '@livinglayer/domain';
import { api } from '../../api';
import { followStatsStore, followViewStore } from './follow-store';
import { useExpose, useWatch } from '../../watch';
import { useFeedStats } from './stats';
import {
  CONFIRM_GAP_MS,
  FOLLOW_MS,
  REANCHOR_GAP_MS,
  RECOVERED_STEPS,
  TRANSITION,
  loadImage,
  lumaOf,
  maskOf,
  unitBox,
} from './helpers';
import type { ViewSlice } from './view';
import type { FeedbackSlice } from './feedback';
import type { RunLogSlice } from './runlog';
import type { DeskSlice } from './desk';
import type { FollowStateSlice } from './follow-state';
import type { CameraSlice } from './camera';
import type { ObservationSlice } from './observation';
import { useStableSlice } from './stable';
import type { ExposeView } from '@livinglayer/domain';

/** The Tracking slice of the lab's state. */
export function useTrackingSlice(
  deps: ViewSlice &
    FeedbackSlice &
    RunLogSlice &
    DeskSlice &
    FollowStateSlice &
    CameraSlice &
    ObservationSlice,
): TrackingSlice {
  const {
    busy,
    camera,
    cameraSource,
    captureCanvas,
    costNote,
    currentObservation,
    demoPosition,
    dropCamera,
    follow,
    goodSteps,
    image,
    lastCheck,
    light,
    localTrack,
    localZone,
    memory,
    mode,
    network,
    openCrop,
    reanchorGap,
    refresh,
    sceneUrl,
    segmentation,
    setBusy,
    setCameraSource,
    setCameraWanted,
    setDemoPosition,
    setDrawing,
    setError,
    setFollow,
    setLamp,
    setMemory,
    setMessage,
    setOutlining,
    setReopenTries,
    setScene,
    setSegmentRunId,
    setSegmentation,
    setSelected,
    startCamera,
    stopCamera,
    stopFollow,
    tracking,
    video,
  } = deps;
  // The server's watcher: it follows things and fires rules with no tab open; this shows it.
  const watch = useWatch(mode);
  useFeedStats(watch?.stats);
  const watching = Boolean(watch?.on);
  // Entities shown in Home Assistant over MQTT, with their states.
  const expose = useExpose(mode);
  function moveDemoMug(next: DemoPosition) {
    setDemoPosition(next);
    setScene(undefined);
    setSegmentation(undefined);
    setSegmentRunId(undefined);
    setDrawing(false);
    setLamp('off');
    setMessage(
      `Mug moved to ${DEMO_POSITIONS[next].label.toLowerCase()}. This counts as a new frame: track it or segment it.`,
    );
    if (follow && localTrack.current) void followDemo(next);
    if (watching) void api('watch/demo', { position: next }).catch(() => {});
  }
  function placementMessage(event: EvidenceRun<PlacementDecision>) {
    const o = event.output;
    const moved = o.transition ? `${TRANSITION[o.transition]}. ` : '';
    return `${mode === 'demo' ? 'Virtual' : 'Live'} placement: ${moved}${o.reason} Lamp: ${o.action}.${o.error ? ` ${o.error.message}` : ''}`;
  }
  /**
   * One tracking step: take the current frame (capturing from the camera if it
   * is running), segment the mug, let the server match it to the remembered
   * mug, and verify the zone. One SAM call in live mode, or none when given
   * `outline`, what was drawn round the mug, outlined on this machine on the
   * frame it was drawn on. Returns the frame it used, so local following can
   * restart from the mug's box on the same pixels.
   */
  async function track({
    keepCamera = false,
    position = demoPosition,
    outline,
  }: {
    keepCamera?: boolean;
    position?: DemoPosition;
    outline?: { shape: SelectionShape; held: string | null };
  } = {}) {
    setBusy('track');
    setError('');
    try {
      let frame = mode === 'demo' ? sceneUrl(position) : (outline?.held ?? image);
      if (mode === 'live' && camera && !outline?.held && video.current?.videoWidth) {
        frame = captureCanvas(
          video.current,
          video.current.videoWidth,
          video.current.videoHeight,
          openCrop.current,
        );
        // Tracking or watching, the camera stays open: both follow the live feed.
        if (!keepCamera && !tracking && !watching) stopCamera();
      }
      const run = await api('segment', {
        mode,
        concept: 'mug',
        ...(mode === 'demo' ? { demoPosition: position } : { imageDataUrl: frame }),
        ...(outline ? { shape: outline.shape } : {}),
      });
      if (outline) {
        if (!run.output.detections.length)
          throw new Error('Nothing stood out inside what you drew. Draw it closer round the mug.');
        setOutlining(null);
      }
      setSegmentation(run.output);
      setSegmentRunId(run.id);
      setLamp('off');
      const result = await api('desk/track', { mode, segmentRunId: run.id });
      setMemory(result.memory, false);
      setSelected(result.event);
      if (result.event.output.action === 'confirmed') light();
      setMessage(
        `Tracked${outline ? ' on this machine, no model call' : costNote(run)}. ${placementMessage(result.event)}`,
      );
      return { ok: true as const, ...result, frame, segmentation: run.output };
    } catch (e) {
      setError(e instanceof Error ? e : 'Tracking failed.');
      return { ok: false as const, code: (e as { code?: string }).code };
    } finally {
      setBusy('');
      void refresh().catch(() => {});
    }
  }
  /** A fresh local track from SAM's box and mask, on the frame SAM saw. */
  async function seedTrack(
    src: string,
    o: DeskObservation,
    seen: Segmentation | undefined,
    inside: boolean,
  ) {
    const frame = lumaOf(await loadImage(src));
    const d = seen?.detections.find((x) => x.objectId === o.detectionId);
    return startLocalTrack(frame, unitBox(o), inside, d && maskOf(d, o.frame, frame));
  }
  /**
   * Start following the mug locally from the current SAM-confirmed observation.
   * Live mode reopens the camera and samples it; demo mode steps whenever
   * the mug is moved.
   */
  async function startFollow() {
    const o = currentObservation;
    const src = mode === 'demo' ? sceneUrl(demoPosition) : image;
    if (!o || !src) return;
    setError('');
    try {
      const next = await seedTrack(src, o, segmentation, memory?.placement === 'inside');
      if (!next)
        throw new Error('The mug is too small or too plain to follow locally. Keep using Track.');
      localTrack.current = next;
      reanchorGap.current = REANCHOR_GAP_MS.first;
      goodSteps.current = 0;
      followViewStore.set({ track: next, verdict: 'follow' });
      followStatsStore.set({ frames: 0, checks: 0 });
      setFollow(true);
      if (mode === 'live') await startCamera();
      setMessage(
        localZone
          ? "Following locally. SAM is called only once the mug is set down and has crossed the zone edge, or can't be found again."
          : 'Following locally. Save a zone and mark the camera fixed so following can watch for the zone.',
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not start following.');
    }
  }
  /** Ask SAM to settle what the local tracker saw, then restart following from its answer. */
  async function followCheck(verdict: LocalVerdict, position?: DemoPosition) {
    lastCheck.current = Date.now();
    if (verdict === 'reanchor')
      reanchorGap.current = Math.min(REANCHOR_GAP_MS.max, reanchorGap.current * 2);
    const result = await track({ keepCamera: true, position });
    if (!result.ok) {
      // SAM can't see the mug either (covered, or out of frame): stay lost and try again later.
      if (result.code === 'track_lost' && localTrack.current) {
        setError('');
        setMessage(
          `SAM can't see the mug either. Still following; next look in ${Math.round(reanchorGap.current / 1000)} s.`,
        );
        return;
      }
      return stopFollow();
    }
    const o = result.memory.observation;
    try {
      const next =
        o &&
        (await seedTrack(
          result.frame ?? '',
          o,
          result.segmentation,
          result.memory.placement === 'inside',
        ));
      if (!next) throw new Error('SAM found the mug, but it is too small to keep following.');
      localTrack.current = next;
      goodSteps.current = 0;
      followViewStore.set({ track: next, verdict: 'follow' });
      followStatsStore.set((s) => ({ ...s, checks: s.checks + 1 }));
      setMessage(
        (m) =>
          `${verdict === 'confirm' ? 'Zone crossing checked with SAM' : 'Re-anchored with SAM'}. ${m}`,
      );
    } catch (e) {
      stopFollow();
      setError(e instanceof Error ? e : 'Could not keep following.');
    }
  }
  /** Apply one local step. A long enough run of good steps resets the re-anchor back-off. */
  function applyStep(step: { track: LocalTrack; verdict: LocalVerdict }) {
    localTrack.current = step.track;
    goodSteps.current = step.track.lostSteps ? 0 : goodSteps.current + 1;
    if (goodSteps.current >= RECOVERED_STEPS) reanchorGap.current = REANCHOR_GAP_MS.first;
    followViewStore.set(step);
    followStatsStore.set((s) => ({ ...s, frames: s.frames + 1 }));
  }
  async function followDemo(position: DemoPosition) {
    try {
      const frame = lumaOf(await loadImage(sceneUrl(position)));
      const current = localTrack.current;
      if (!current) return;
      // Each demo move is one deliberate frame of a mug already set down, so it needn't settle.
      const step = stepLocalTrack(current, frame, localZone, {
        settleSteps: 1,
        lostSteps: 1,
        quietSteps: 0,
      });
      applyStep(step);
      if (step.verdict !== 'follow') return void followCheck(step.verdict, position);
      setMessage(
        `Followed locally to ${DEMO_POSITIONS[position].label.toLowerCase()} · match ${step.track.score.toFixed(2)} · no model call.`,
      );
    } catch (e) {
      stopFollow();
      setError(e instanceof Error ? e : 'Could not follow the mug.');
    }
  }
  // The sampling loop reads the newest zone and handler through a ref, so renders don't restart it.
  const followLatest = useRef({
    zone: null as UnitBox | null,
    check: followCheck,
    step: applyStep,
  });
  useEffect(() => {
    if (!follow || !camera || busy || mode !== 'live') return;
    const timer = window.setInterval(() => {
      const el = video.current;
      const current = localTrack.current;
      if (!el?.videoWidth || !current) return;
      const step = stepLocalTrack(current, lumaOf(el), followLatest.current.zone);
      followLatest.current.step(step);
      const gap = step.verdict === 'confirm' ? CONFIRM_GAP_MS : reanchorGap.current;
      if (step.verdict !== 'follow' && Date.now() - lastCheck.current > gap)
        void followLatest.current.check(step.verdict);
    }, FOLLOW_MS);
    return () => window.clearInterval(timer);
  }, [follow, camera, busy, mode, video, localTrack, lastCheck, reanchorGap]);
  /** The selected network camera, when the server can read it too (it offers RTSP). */
  const watchCamera = network.streams.find((s) => s.id === cameraSource && s.rtsp);
  /** Whether the server can watch this mode's camera: always in the demo, else an RTSP camera. */
  const canWatch = mode === 'demo' || Boolean(watchCamera) || Boolean(watch?.camera);
  async function toggleWatch() {
    setError('');
    try {
      const on = !watching;
      if (on) stopFollow();
      const view = await api('watch', {
        mode,
        on,
        ...(on && mode === 'live' && watchCamera ? { streamId: watchCamera.id } : {}),
      });
      setMessage(
        on
          ? `The server is watching${view.camera ? ` ${view.camera.name}` : ' the demo camera'}. Rules fire on SAM’s answer, with or without this tab.`
          : 'The server stopped watching. Rules fire only when you track by hand.',
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not change watching.');
    }
  }
  // Watching shows the camera the server watches, live: once when watching starts or the
  // page loads with it on. A camera the person stops afterwards stays off.
  const watchedId = mode === 'live' && watching ? watch?.camera?.id : undefined;
  // What the watcher's effects read when they run: the newest watch, mode and camera.
  const watchNow = useRef({ watch, mode, camera, cameraSource });
  watchNow.current = { watch, mode, camera, cameraSource };
  useEffect(() => {
    if (!watchedId) return;
    const { camera, cameraSource } = watchNow.current;
    if (camera && cameraSource !== watchedId) dropCamera();
    setCameraSource(watchedId);
    setCameraWanted(true);
    setReopenTries(0);
  }, [watchedId, dropCamera, setCameraSource, setCameraWanted, setReopenTries]);
  // What the watcher's SAM checks changed (sightings, verdicts, a lamp) shows once it lands.
  const seenChecks = useRef(0);
  const checks = watch?.checks;
  useEffect(() => {
    const { watch, mode } = watchNow.current;
    if (!watch || watch.checks === seenChecks.current) return;
    const first = seenChecks.current === 0 && watch.checks > 0 && !watch.on;
    seenChecks.current = watch.checks;
    if (first) return;
    void refresh()
      .then((desks) => {
        const action = desks[mode].lastDecision?.output.action;
        if (action === 'confirmed') light();
      })
      .catch(() => {});
  }, [checks, refresh, light]);
  // A fixture marked missing (or found again) changes how the room draws it.
  const missingFixtures = (watch?.things ?? []).filter(
    (t) => t.kind === 'fixture' && t.status === 'missing',
  ).length;
  useEffect(() => {
    if (watchNow.current.watch) void refresh().catch(() => {});
  }, [missingFixtures, refresh]);
  followLatest.current = { zone: localZone, check: followCheck, step: applyStep };
  return useStableSlice({
    canWatch,
    expose,
    moveDemoMug,
    placementMessage,
    startFollow,
    toggleWatch,
    track,
    watch,
    watching,
  });
}
/** What the Tracking slice of the lab offers: its state, derived values and actions. */
export interface TrackingSlice {
  canWatch: boolean;
  expose: ExposeView | null;
  moveDemoMug: (next: DemoPosition) => void;
  placementMessage: (event: EvidenceRun<PlacementDecision>) => string;
  startFollow: () => Promise<void>;
  toggleWatch: () => Promise<void>;
  track: (options?: {
    keepCamera?: boolean;
    position?: DemoPosition;
    outline?: { shape: SelectionShape; held: string | null };
  }) => Promise<
    | {
        memory: DeskMemory;
        event: EvidenceRun<PlacementDecision>;
        ok: true;
        frame: string | undefined;
        segmentation: Segmentation;
        code?: undefined;
      }
    | {
        ok: false;
        code: string | undefined;
      }
  >;
  watch: WatchView | null;
  watching: boolean;
}
