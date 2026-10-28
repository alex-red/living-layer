import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type {
  EvidenceRun,
  LabStatus,
  Mode,
  Scene,
  Segmentation,
  Detection,
  LampResult,
  DeskMemory,
  ZoneRect,
  PlacementDecision,
  RunKind,
  DeskObservation,
  FixturePosition,
  LocalTrack,
  LocalVerdict,
  LumaFrame,
  UnitBox,
  IsoSceneKind,
  SceneGuess,
  SavedItem,
} from '@livinglayer/domain';
import {
  FIXTURE_POSITIONS,
  OBSERVATION_MAX_AGE_MS,
  isMugConcept,
  FIXTURE_LIGHTS,
  runCost,
  startLocalTrack,
  stepLocalTrack,
  toLuma,
  zoneApplies,
} from '@livinglayer/domain';
import { api } from './api';
import { estimateLabel, usd } from './cost';
import { Glyph } from './Glyph';
import { takeHandoff } from './handoff';
import { MaskOverlay } from './MaskOverlay';
import { IsoView } from './iso/IsoView';
import { SurfacePin } from './iso/SurfacePin';

const BUSY: Record<string, string> = {
  text: 'Checking the connection',
  discover: 'Discovering objects',
  segment: 'Finding the shape',
  lamp: 'Switching the lamp',
  select: 'Remembering the mug',
  zone: 'Saving the zone',
  verify: 'Checking placement',
  reset: 'Resetting desk memory',
  track: 'Tracking the mug',
  camera: 'Updating the camera setting',
};
const TRANSITION: Record<NonNullable<PlacementDecision['transition']>, string> = {
  entered: 'Entered the zone',
  stayed_inside: 'Still inside',
  left: 'Left the zone',
  stayed_outside: 'Still outside',
};
/** Redraw the fixture desk with the mug, its coffee and its shadow moved together. */
function fixtureDesk(svg: string, position: FixturePosition): string {
  const { dx, dy } = FIXTURE_POSITIONS[position];
  if (!dx && !dy) return '/desk.svg';
  const moved = svg
    .replace('translate(350 180)', `translate(${350 + dx} ${180 + dy})`)
    .replace('cx="485" cy="455"', `cx="${485 + dx}" cy="${455 + dy}"`)
    .replace('cx="450" cy="245"', `cx="${450 + dx}" cy="${245 + dy}"`);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(moved)}`;
}
/** Local following samples the camera this often, on frames this wide. */
const FOLLOW_MS = 100;
const LUMA_WIDTH = 160;
/**
 * Gaps between SAM checks while following the live camera. A zone crossing
 * waits briefly; re-anchoring backs off while the mug stays lost, so a mug
 * that can't be told from its surroundings doesn't call SAM every few frames.
 */
const CONFIRM_GAP_MS = 2000;
const REANCHOR_GAP_MS = { first: 2000, max: 30_000 };
/** Good local steps in a row (about 3 s) before re-anchoring is trusted to have worked. */
const RECOVERED_STEPS = 30;
const lumaCanvas = document.createElement('canvas');
/** Downsample any image or video frame to grayscale for the local tracker. */
function lumaOf(source: HTMLImageElement | HTMLVideoElement): LumaFrame {
  const [w, h] =
    source instanceof HTMLVideoElement
      ? [source.videoWidth, source.videoHeight]
      : [source.naturalWidth, source.naturalHeight];
  lumaCanvas.width = LUMA_WIDTH;
  lumaCanvas.height = Math.max(1, Math.round((LUMA_WIDTH * h) / w));
  const context = lumaCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser cannot read frames for local following.');
  context.drawImage(source, 0, 0, lumaCanvas.width, lumaCanvas.height);
  const { data } = context.getImageData(0, 0, lumaCanvas.width, lumaCanvas.height);
  return toLuma(data, lumaCanvas.width, lumaCanvas.height);
}
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read the frame for local following.'));
    img.src = src;
  });
}
/** SAM's mask for `d`, drawn onto a frame-sized 0/1 grid at the tracker's resolution. */
function maskOf(
  d: Detection,
  frame: Segmentation['frame'],
  luma: LumaFrame,
): Uint8Array | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = luma.width;
  canvas.height = luma.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return undefined;
  context.scale(luma.width / frame.width, luma.height / frame.height);
  context.translate(d.box.x, d.box.y);
  context.scale(d.box.width / d.mask.width, d.box.height / d.mask.height);
  context.fill(new Path2D(d.mask.svgPath), 'evenodd');
  const alpha = context.getImageData(0, 0, luma.width, luma.height).data;
  const mask = new Uint8Array(luma.width * luma.height);
  // Only pixels mostly inside the mask, so edge pixels blended with the background stay out.
  for (let i = 0; i < mask.length; i++) mask[i] = alpha[i * 4 + 3]! > 160 ? 1 : 0;
  return mask;
}
const unitBox = (o: DeskObservation): UnitBox => ({
  x: o.box.x / o.frame.width,
  y: o.box.y / o.frame.height,
  width: o.box.width / o.frame.width,
  height: o.box.height / o.frame.height,
});
/** Box centre as a share of the frame, for comparing observations across frames. */
const centre = (o: DeskObservation) => ({
  x: (o.box.x + o.box.width / 2) / o.frame.width,
  y: (o.box.y + o.box.height / 2) / o.frame.height,
});
const RESULT_GLYPH: Record<EvidenceRun['status'], string> = {
  completed: '✓',
  no_match: '◌',
  unconfirmed: '◌',
  failed: '×',
};
const RUN_KINDS: RunKind[] = [
  'text',
  'discover',
  'segment',
  'scene',
  'layout',
  'item',
  'lamp',
  'observation',
  'zone',
  'placement',
];
const LOG_PAGE = 10;
type ProbeKind = 'text' | 'discover' | 'segment' | 'lamp';
const isProbe = (kind: RunKind): kind is ProbeKind =>
  ['text', 'discover', 'segment', 'lamp'].includes(kind);

/** One short line on what a run returned, for the log and the inspector. */
function runDetail(run: EvidenceRun): string {
  const output = run.output as Record<string, unknown> | null;
  if (run.status === 'failed')
    return (output?.error as { message?: string } | undefined)?.message ?? 'Failed';
  switch (run.kind) {
    case 'segment': {
      const s = run.output as Segmentation;
      return `"${s.concept}" · ${s.detections.length} mask${s.detections.length === 1 ? '' : 's'}`;
    }
    case 'discover': {
      const s = run.output as Scene;
      return `${s.objects.length} object${s.objects.length === 1 ? '' : 's'}: ${s.objects.map((o) => o.label).join(', ')}`;
    }
    case 'scene': {
      const g = run.output as SceneGuess;
      return `${g.kind} · ${g.visibleProps.length} prop${g.visibleProps.length === 1 ? '' : 's'} seen`;
    }
    case 'layout': {
      const l = run.output as { draft: { items: unknown[]; summary: string } };
      return `${l.draft.items.length} templates · ${l.draft.summary}`;
    }
    case 'item': {
      const item = run.output as SavedItem;
      return `${item.label} · ${item.parts.length} parts · ${item.source}`;
    }
    case 'lamp':
      return `state ${(run.output as LampResult).state}`;
    case 'placement': {
      const p = run.output as PlacementDecision;
      return `${p.decision} · lamp ${p.action}`;
    }
    default:
      return '';
  }
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function App() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [mode, setMode] = useState<Mode>('fixture');
  const [status, setStatus] = useState<LabStatus>();
  const [runs, setRuns] = useState<EvidenceRun[]>([]);
  const [image, setImage] = useState<string>();
  const [dimensions, setDimensions] = useState({ width: 960, height: 640 });
  const [scene, setScene] = useState<Scene>();
  const [segmentation, setSegmentation] = useState<Segmentation>();
  const [memories, setMemories] = useState<Partial<Record<Mode, DeskMemory>>>({});
  const memory = memories[mode];
  const [segmentRunId, setSegmentRunId] = useState<string>();
  const [draftZone, setDraftZone] = useState<ZoneRect>({ x: 0.3, y: 0.2, width: 0.4, height: 0.6 });
  const [drawing, setDrawing] = useState(false);
  const zoneStart = useRef<{ x: number; y: number } | null>(null);
  const [concept, setConcept] = useState('mug');
  const [fixturePosition, setFixturePosition] = useState<FixturePosition>('centre');
  const [deskSvg, setDeskSvg] = useState('');
  const [overlay, setOverlay] = useState(true);
  const [stageView, setStageView] = useState<'photo' | 'iso'>('photo');
  // Clicking a surface's corners on the photo, for the iso view.
  const [pinning, setPinning] = useState<{
    scene: IsoSceneKind | 'custom';
    surfaceId: string;
    label: string;
  } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState(
    'Start with the illustrated desk. Every fixture result is labeled.',
  );
  const [selected, setSelected] = useState<EvidenceRun>();
  const [logKind, setLogKind] = useState<RunKind | 'all'>('all');
  const [logMode, setLogMode] = useState<Mode | 'all'>('all');
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [logLimit, setLogLimit] = useState(LOG_PAGE);
  const [sideTab, setSideTab] = useState<'runs' | 'inspect' | 'setup'>('runs');
  // Drives the ambient warm-up. Only a confirmed lamp state turns it on.
  const [lamp, setLamp] = useState<'off' | 'virtual' | 'live'>('off');
  const light = () => setLamp(mode === 'fixture' ? 'virtual' : 'live');
  const [camera, setCamera] = useState(false);
  const [cameraPending, setCameraPending] = useState(false);
  const cameraGeneration = useRef(0);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const imageGeneration = useRef(0);
  const mounted = useRef(true);
  // Local following: the tracker lives in a ref so the sampling loop never waits on a render.
  const [follow, setFollow] = useState(false);
  const [followView, setFollowView] = useState<{
    track: LocalTrack;
    verdict: LocalVerdict;
  } | null>(null);
  const [followStats, setFollowStats] = useState({ frames: 0, checks: 0 });
  const localTrack = useRef<LocalTrack | null>(null);
  const lastCheck = useRef(0);
  const reanchorGap = useRef(REANCHOR_GAP_MS.first);
  const goodSteps = useRef(0);
  /**
   * Bumped by every memory write. A refresh applies its desk memory only if
   * nothing newer landed while it was in flight, so a slow fire-and-forget
   * refresh can't put back a memory from before a draft or a track.
   */
  const memoryWrites = useRef(0);
  const setMemory = (next: DeskMemory) => {
    memoryWrites.current++;
    setMemories((current) => ({ ...current, [mode]: next }));
  };
  const refresh = async () => {
    const started = ++memoryWrites.current;
    const [nextStatus, nextRuns, fixtureDesk, liveDesk] = await Promise.all([
      api<LabStatus>('status'),
      api<EvidenceRun[]>('runs'),
      api<DeskMemory>('desk/fixture'),
      api<DeskMemory>('desk/live'),
    ]);
    setStatus(nextStatus);
    setRuns(nextRuns);
    if (started === memoryWrites.current) setMemories({ fixture: fixtureDesk, live: liveDesk });
  };
  useEffect(() => {
    void fetch('/desk.svg')
      .then((r) => r.text())
      .then(setDeskSvg)
      .catch(() => {});
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() =>
      setError('The local API is unavailable. Start both services with bun run dev.'),
    );
    const handedOff = takeHandoff();
    if (handedOff) {
      changeMode('live');
      const frame = new Image();
      frame.onload = () => {
        if (!mounted.current) return;
        captureCanvas(frame, frame.naturalWidth, frame.naturalHeight);
        setMessage('Frame from the camera playground, prepared locally. Run a live probe on it.');
      };
      frame.src = handedOff;
    }
    return () => {
      mounted.current = false;
      cameraGeneration.current++;
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  function stopFollow() {
    localTrack.current = null;
    setFollow(false);
    setFollowView(null);
  }
  const stopCamera = () => {
    stopFollow();
    cameraGeneration.current++;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setCamera(false);
  };
  function changeMode(next: Mode) {
    stopCamera();
    imageGeneration.current++;
    setMode(next);
    setFixturePosition('centre');
    setLamp('off');
    setImage(undefined);
    setDimensions({ width: 960, height: 640 });
    setScene(undefined);
    setSegmentation(undefined);
    setSegmentRunId(undefined);
    setDrawing(false);
    setError('');
    setMessage(
      next === 'fixture'
        ? 'Illustrated fixture selected. No inference or physical action.'
        : 'Add a desk photo. It stays local until you explicitly run a live probe.',
    );
  }
  function captureCanvas(source: CanvasImageSource, width: number, height: number) {
    const scale = Math.min(1, 1280 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
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
      'Photo prepared locally. Live probes send this image to Meta only when you press a probe button.',
    );
    return url;
  }
  const sceneUrl = (position: FixturePosition) =>
    deskSvg ? fixtureDesk(deskSvg, position) : '/desk.svg';
  function moveFixtureMug(next: FixturePosition) {
    setFixturePosition(next);
    setScene(undefined);
    setSegmentation(undefined);
    setSegmentRunId(undefined);
    setDrawing(false);
    setLamp('off');
    setMessage(
      `Mug moved to ${FIXTURE_POSITIONS[next].label.toLowerCase()}. This counts as a new frame: track it or segment it.`,
    );
    if (follow && localTrack.current) void followFixture(next);
  }
  /** Prepare a chosen photo as the current frame; returns it, or nothing on failure. */
  async function upload(chosen?: File): Promise<string | undefined> {
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
          url = captureCanvas(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that image.');
    }
    if (file.current) file.current.value = '';
    return url;
  }
  async function startCamera() {
    if (cameraPending || stream.current) return;
    setError('');
    setCameraPending(true);
    const generation = ++cameraGeneration.current;
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (!mounted.current || generation !== cameraGeneration.current) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = media;
      setCamera(true);
    } catch {
      if (mounted.current && generation === cameraGeneration.current)
        setError('Camera access is unavailable. Upload a desk photo instead.');
    } finally {
      if (mounted.current) setCameraPending(false);
    }
  }
  useEffect(() => {
    if (camera && video.current && stream.current) {
      video.current.srcObject = stream.current;
      void video.current
        .play()
        .catch(() => setError('Camera playback failed. Stop the camera and try an upload.'));
    }
  }, [camera]);
  function costNote(run: EvidenceRun) {
    const cost = runCost(run);
    return cost === null ? '' : ` · ≈ ${usd(cost)}`;
  }
  async function execute(kind: 'text' | 'discover' | 'segment' | 'lamp', overrideConcept?: string) {
    setBusy(kind);
    setError('');
    try {
      const run = await api<EvidenceRun>(kind, {
        mode,
        ...(['discover', 'segment'].includes(kind) && image ? { imageDataUrl: image } : {}),
        ...(kind === 'segment' ? { concept: overrideConcept ?? concept } : {}),
        ...(kind === 'segment' && mode === 'fixture' ? { fixturePosition } : {}),
      });
      if (kind === 'discover') setScene(run.output as Scene);
      if (kind === 'discover' || kind === 'segment') setLamp('off');
      if (kind === 'lamp' && (run.output as LampResult).stateConfirmed) light();
      if (kind === 'segment') {
        setSegmentation(run.output as Segmentation);
        setSegmentRunId(run.id);
        setDrawing(false);
      }
      setSelected(run);
      setMessage(
        kind === 'segment' && run.status === 'no_match'
          ? 'No match. The previous mask has been cleared.'
          : `${mode === 'fixture' ? 'Fixture' : 'Live'} ${kind} probe saved · ${run.durationMs} ms${costNote(run)}.`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Probe failed.');
      if (kind === 'segment') setSegmentation(undefined);
      void refresh().catch(() => {});
    } finally {
      setBusy('');
    }
  }
  function placementMessage(event: EvidenceRun<PlacementDecision>) {
    const o = event.output;
    const moved = o.transition ? `${TRANSITION[o.transition]}. ` : '';
    return `${mode === 'fixture' ? 'Virtual' : 'Live'} placement: ${moved}${o.reason} Lamp: ${o.action}.${o.error ? ` ${o.error.message}` : ''}`;
  }
  /**
   * One tracking step: take the current frame (capturing from the camera if it
   * is running), segment the mug, let the server match it to the remembered
   * mug, and verify the zone. One SAM call in live mode. Returns the frame it
   * used, so local following can restart from SAM's box on the same pixels.
   */
  async function track({ keepCamera = false, position = fixturePosition } = {}) {
    setBusy('track');
    setError('');
    try {
      let frame = mode === 'fixture' ? sceneUrl(position) : image;
      if (mode === 'live' && camera && video.current?.videoWidth) {
        frame = captureCanvas(video.current, video.current.videoWidth, video.current.videoHeight);
        if (!keepCamera) stopCamera();
      }
      const run = await api<EvidenceRun<Segmentation>>('segment', {
        mode,
        concept: 'mug',
        ...(mode === 'fixture' ? { fixturePosition: position } : { imageDataUrl: frame }),
      });
      setSegmentation(run.output);
      setSegmentRunId(run.id);
      setLamp('off');
      const result = await api<{ memory: DeskMemory; event: EvidenceRun<PlacementDecision> }>(
        'desk/track',
        { mode, segmentRunId: run.id },
      );
      setMemory(result.memory);
      setSelected(result.event);
      if (result.event.output.action === 'confirmed') light();
      setMessage(`Tracked${costNote(run)}. ${placementMessage(result.event)}`);
      return { ok: true as const, ...result, frame, segmentation: run.output };
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tracking failed.');
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
   * Live mode reopens the camera and samples it; fixture mode steps whenever
   * the mug is moved.
   */
  async function startFollow() {
    const o = currentObservation;
    const src = mode === 'fixture' ? sceneUrl(fixturePosition) : image;
    if (!o || !src) return;
    setError('');
    try {
      const next = await seedTrack(src, o, segmentation, memory?.placement === 'inside');
      if (!next)
        throw new Error('The mug is too small or too plain to follow locally. Keep using Track.');
      localTrack.current = next;
      reanchorGap.current = REANCHOR_GAP_MS.first;
      goodSteps.current = 0;
      setFollowView({ track: next, verdict: 'follow' });
      setFollowStats({ frames: 0, checks: 0 });
      setFollow(true);
      if (mode === 'live') await startCamera();
      setMessage(
        localZone
          ? "Following locally. SAM is called only once the mug is set down and has crossed the zone edge, or can't be found again."
          : 'Following locally. Save a zone and mark the camera fixed so following can watch for the zone.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start following.');
    }
  }
  /** Ask SAM to settle what the local tracker saw, then restart following from its answer. */
  async function followCheck(verdict: LocalVerdict, position?: FixturePosition) {
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
      setFollowView({ track: next, verdict: 'follow' });
      setFollowStats((s) => ({ ...s, checks: s.checks + 1 }));
      setMessage(
        (m) =>
          `${verdict === 'confirm' ? 'Zone crossing checked with SAM' : 'Re-anchored with SAM'}. ${m}`,
      );
    } catch (e) {
      stopFollow();
      setError(e instanceof Error ? e.message : 'Could not keep following.');
    }
  }
  /** Apply one local step. A long enough run of good steps resets the re-anchor back-off. */
  function applyStep(step: { track: LocalTrack; verdict: LocalVerdict }) {
    localTrack.current = step.track;
    goodSteps.current = step.track.lostSteps ? 0 : goodSteps.current + 1;
    if (goodSteps.current >= RECOVERED_STEPS) reanchorGap.current = REANCHOR_GAP_MS.first;
    setFollowView(step);
    setFollowStats((s) => ({ ...s, frames: s.frames + 1 }));
  }
  async function followFixture(position: FixturePosition) {
    try {
      const frame = lumaOf(await loadImage(sceneUrl(position)));
      const current = localTrack.current;
      if (!current) return;
      // Each fixture move is one deliberate frame of a mug already set down, so it needn't settle.
      const step = stepLocalTrack(current, frame, localZone, {
        settleSteps: 1,
        lostSteps: 1,
        quietSteps: 0,
      });
      applyStep(step);
      if (step.verdict !== 'follow') return void followCheck(step.verdict, position);
      setMessage(
        `Followed locally to ${FIXTURE_POSITIONS[position].label.toLowerCase()} · match ${step.track.score.toFixed(2)} · no model call.`,
      );
    } catch (e) {
      stopFollow();
      setError(e instanceof Error ? e.message : 'Could not follow the mug.');
    }
  }
  // The sampling loop reads the newest zone and handler through a ref, so renders don't restart it.
  const followLatest = useRef({ zone: null as UnitBox | null, check: followCheck });
  useEffect(() => {
    if (!follow || !camera || busy || mode !== 'live') return;
    const timer = window.setInterval(() => {
      const el = video.current;
      const current = localTrack.current;
      if (!el?.videoWidth || !current) return;
      const step = stepLocalTrack(current, lumaOf(el), followLatest.current.zone);
      applyStep(step);
      const gap = step.verdict === 'confirm' ? CONFIRM_GAP_MS : reanchorGap.current;
      if (step.verdict !== 'follow' && Date.now() - lastCheck.current > gap)
        void followLatest.current.check(step.verdict);
    }, FOLLOW_MS);
    return () => window.clearInterval(timer);
  }, [follow, camera, busy, mode]);
  async function deskAction(
    path: 'select' | 'zone' | 'verify' | 'reset' | 'camera' | 'surface',
    fields: object = {},
  ) {
    setBusy(path);
    setError('');
    try {
      const result = await api<DeskMemory | EvidenceRun<PlacementDecision>>(`desk/${path}`, {
        mode,
        ...fields,
      });
      if (path === 'verify') {
        const event = result as EvidenceRun<PlacementDecision>;
        setSelected(event);
        if (event.output.action === 'confirmed') light();
        setMessage(placementMessage(event));
      } else {
        setMemory(result as DeskMemory);
        if (path === 'reset') {
          setLamp('off');
          stopFollow();
        }
        const saved = result as DeskMemory;
        setMessage(
          path === 'select'
            ? 'Mug identity manually confirmed. Draw or edit its zone next.'
            : path === 'zone'
              ? saved.fixedCamera
                ? 'Zone saved. The camera is marked fixed, so it carries over to new frames of this size.'
                : 'Zone saved for this exact image. Review it before verifying placement.'
              : path === 'camera'
                ? saved.fixedCamera
                  ? 'Camera marked fixed. The zone now carries over to new frames of the same size.'
                  : 'Camera no longer marked fixed. A zone applies only to the image it was drawn on.'
                : path === 'surface'
                  ? saved.surface
                    ? 'Surface pinned. The iso view places the mug on it for frames of this size.'
                    : 'Surface pin cleared.'
                  : 'Desk memory reset. Evidence and action deduplication are retained.',
        );
        if (path === 'surface') {
          setPinning(null);
          setStageView('iso');
        }
        setDrawing(false);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Desk operation failed.');
    } finally {
      setBusy('');
    }
  }
  const currentObservation =
    memory?.observation &&
    segmentation?.sourceKey === memory.observation.sourceKey &&
    segmentRunId === memory.observation.segmentRunId
      ? memory.observation
      : null;
  const observationStale = memory?.observation
    ? now - Date.parse(memory.observation.observedAt) > OBSERVATION_MAX_AGE_MS
    : false;
  const zone = memory && currentObservation ? zoneApplies(memory) : null;
  // New frames from following only have a zone by the fixed-camera assumption.
  const localZone: UnitBox | null =
    memory?.zone &&
    memory.fixedCamera &&
    memory.zone.frame?.width === memory.observation?.frame.width &&
    memory.zone.frame?.height === memory.observation?.frame.height
      ? memory.zone.rect
      : null;
  followLatest.current = { zone: localZone, check: followCheck };
  const visibleZone = drawing ? draftZone : zone?.applies && memory?.zone ? memory.zone.rect : null;
  // Where the mug has been, newest first, with the verdict each sighting got.
  const sightings = memory?.observation ? [memory.observation, ...(memory.history ?? [])] : [];
  const verdictFor = (o: DeskObservation) =>
    runs.find(
      (r): r is EvidenceRun<PlacementDecision> =>
        r.kind === 'placement' && (r.output as PlacementDecision).observationId === o.id,
    )?.output;
  // Earlier boxes only line up with this frame when the frame is the same size.
  const trail = segmentation
    ? sightings.filter(
        (o) =>
          o.frame.width === segmentation.frame.width &&
          o.frame.height === segmentation.frame.height,
      )
    : [];
  function zonePoint(e: PointerEvent<SVGSVGElement>) {
    const bounds = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (e.clientY - bounds.top) / bounds.height)),
    };
  }
  const metaReady = Boolean(
    status?.meta.configured &&
    status.meta.enabled &&
    status.meta.usedToday < status.meta.requestLimit,
  );
  const lampReady = Boolean(status?.lamp.configured && status.lamp.enabled);
  const canVision = !busy && (mode === 'fixture' || (metaReady && Boolean(image)));
  const canTrack =
    !busy &&
    !follow &&
    Boolean(memory?.object && memory.observation) &&
    (mode === 'fixture' || (metaReady && (Boolean(image) || camera)));
  const proofCount = status ? Object.values(status.liveEvidence).filter(Boolean).length : 0;
  const confirmedId = currentObservation?.detectionId;
  const step = !scene && !segmentation ? 1 : !segmentation ? 2 : 3;
  const capsuleTone = error ? 'blocked' : busy ? 'busy' : lamp !== 'off' ? 'warm' : 'idle';

  const filteredRuns = runs.filter(
    (run) =>
      (logKind === 'all' || run.kind === logKind) &&
      (logMode === 'all' || run.mode === logMode) &&
      (!failuresOnly || run.status === 'failed'),
  );
  const logStats = {
    failed: filteredRuns.filter((r) => r.status === 'failed').length,
    medianMs: median(filteredRuns.map((r) => r.durationMs)),
    cost: filteredRuns.reduce((sum, r) => sum + (runCost(r) ?? 0), 0),
  };
  function inspect(run: EvidenceRun) {
    setSelected(run);
    setSideTab('inspect');
  }
  /** Why a saved probe can't be repeated right now, or null if it can. */
  function rerunBlock(run: EvidenceRun): string | null {
    if (!isProbe(run.kind)) return 'Only probes can be repeated. Use the bench for desk steps.';
    if (run.mode !== mode) return `Switch to ${run.mode} mode to repeat this run.`;
    if (busy) return 'Wait for the current call to finish.';
    if (camera) return 'Capture or stop the camera first.';
    if (run.kind === 'lamp')
      return mode === 'live' && !lampReady ? 'The lamp is not set up.' : null;
    if (mode === 'live' && !metaReady) return 'Live Meta calls are not available.';
    if (run.kind !== 'text' && mode === 'live' && !image) return 'Add a desk photo first.';
    return null;
  }
  function rerun(run: EvidenceRun) {
    if (!isProbe(run.kind) || rerunBlock(run)) return;
    const again = run.kind === 'segment' ? (run.output as Segmentation).concept : undefined;
    if (again) setConcept(again);
    void execute(run.kind, again);
  }
  /**
   * A saved mask can go back on the scene when it was made from the image on
   * screen now: always for the fixture, and for a live photo when its source
   * hash matches the mask already showing.
   */
  function canRestore(run: EvidenceRun): boolean {
    if (busy || camera || run.mode !== mode || run.status === 'failed') return false;
    if (run.kind === 'discover') return mode === 'fixture';
    if (run.kind !== 'segment') return false;
    const key = (run.output as Segmentation).sourceKey;
    return mode === 'fixture' || (Boolean(key) && key === segmentation?.sourceKey);
  }
  function restore(run: EvidenceRun) {
    if (run.kind === 'discover') {
      setScene(run.output as Scene);
      setMessage('Saved discovery restored to the scene.');
      return;
    }
    const restored = run.output as Segmentation;
    setSegmentation(restored);
    setSegmentRunId(run.id);
    setConcept(restored.concept);
    setDrawing(false);
    setLamp('off');
    setMessage(`Mask from run ${run.id.slice(0, 8)} restored. You can confirm it as before.`);
  }
  function copyRun(run: EvidenceRun) {
    navigator.clipboard
      .writeText(JSON.stringify(run, null, 2))
      .then(() => setMessage(`Run ${run.id.slice(0, 8)} copied as JSON.`))
      .catch(() => setError('The clipboard is unavailable. Select the JSON below instead.'));
  }
  const sorted = segmentation
    ? [...segmentation.detections].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    : [];
  return (
    <div className={`shell lamp-${lamp}`}>
      <header className="topbar">
        <div className="topbar-id">
          <a className="brand" href="/" aria-label="Living Layer home">
            <span className="brand-icon">
              <Glyph />
            </span>
            Living Layer
          </a>
          <h1 className="page-title">
            Desk lab{mode === 'live' && <span className="live-tag">LIVE</span>}
          </h1>
        </div>
        <div className={`feedback ${capsuleTone}`} role="status" aria-live="polite">
          {camera && <span className="privacy-dot" aria-label="Camera on" />}
          <span className="dot" />
          <span className="feedback-text">
            {busy ? `${BUSY[busy] ?? 'Working'}…` : error || message}
          </span>
          {lamp === 'virtual' && <span className="hud-tag">VIRTUAL</span>}
        </div>
        <nav className="topbar-links">
          <a className="playground-link" href="/playground">
            Camera playground
          </a>
          <a className="export" href="/api/evidence" download>
            Export evidence <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>
      <main className="lab">
        <aside className="lab-controls" aria-label="Probe bench">
          <div className="pane-head">
            <span className="tiny">PROBE BENCH</span>
            <div className="mode-switch" aria-label="Data source">
              {(['fixture', 'live'] as const).map((value) => (
                <button
                  key={value}
                  disabled={Boolean(busy) || camera || cameraPending}
                  aria-pressed={mode === value}
                  onClick={() => changeMode(value)}
                >
                  {value === 'fixture' ? 'Fixture' : 'Live'}
                </button>
              ))}
            </div>
          </div>
          <div className={`probe ${step === 1 ? 'current' : ''}`}>
            <div className="probe-title">
              <span className="step">01</span>
              <h3>Discover the scene</h3>
              <span className="model-tag">SPARK</span>
            </div>
            <p>Name up to three objects and describe the desk.</p>
            <button
              className="primary"
              disabled={!canVision || camera}
              onClick={() => void execute('discover')}
            >
              {busy === 'discover' ? 'Discovering…' : 'Discover objects'}
              <Glyph type="arrow" />
            </button>
            {mode === 'live' && status && (
              <p className="micro">{estimateLabel(status.meta.estimates.discover)}</p>
            )}
          </div>
          <div className={`probe ${step === 2 ? 'current' : ''}`}>
            <div className="probe-title">
              <span className="step">02</span>
              <h3>Find the shape</h3>
              <span className="model-tag">SAM 3.1</span>
            </div>
            <label className="input-label" htmlFor="concept">
              Object concept
            </label>
            <div className="concept-input">
              <input
                id="concept"
                value={concept}
                maxLength={80}
                onChange={(e) => setConcept(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canVision && concept.trim() && !camera)
                    void execute('segment');
                }}
              />
              <span>↵ TO RUN</span>
            </div>
            <button
              className="primary"
              disabled={!canVision || !concept.trim() || camera}
              onClick={() => void execute('segment')}
            >
              {busy === 'segment' ? 'Decoding…' : 'Segment object'}
              <Glyph type="arrow" />
            </button>
            <button
              className="text-button"
              disabled={!canVision || camera}
              onClick={() => void execute('segment', 'unicorn')}
            >
              Test absent target <span>↗</span>
            </button>
            {mode === 'live' && status && (
              <p className="micro">{estimateLabel(status.meta.estimates.segment, 'image')}</p>
            )}
            {segmentation && sorted.length > 0 ? (
              <table className="detections">
                <caption>
                  {sorted.length} mask{sorted.length === 1 ? '' : 's'} for “{segmentation.concept}”
                  · {segmentation.frame.width}×{segmentation.frame.height}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">ID</th>
                    <th scope="col">SCORE</th>
                    <th scope="col">BOX X,Y W×H</th>
                    <th scope="col">AREA</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((d) => (
                    <tr key={d.objectId} className={d.objectId === confirmedId ? 'chosen' : ''}>
                      <td>
                        {d.objectId === confirmedId ? '✓ ' : ''}#{d.objectId}
                      </td>
                      <td>{d.confidence != null ? d.confidence.toFixed(2) : '—'}</td>
                      <td>
                        {Math.round(d.box.x)},{Math.round(d.box.y)} {Math.round(d.box.width)}×
                        {Math.round(d.box.height)}
                      </td>
                      <td>
                        {/* The mask raster is crop-local, so scale its fill up to the box. */}
                        {(
                          ((d.mask.foregroundPixels / (d.mask.width * d.mask.height)) *
                            d.box.width *
                            d.box.height *
                            100) /
                          (segmentation.frame.width * segmentation.frame.height)
                        ).toFixed(1)}
                        %
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="micro">
                {segmentation
                  ? `No “${segmentation.concept}” found · ${mode}`
                  : 'Crop-local mask → source-pixel overlay'}
              </p>
            )}
          </div>
          <div className={`probe placement-controls ${step === 3 ? 'current chosen' : ''}`}>
            <div className="probe-title">
              <span className="step">03</span>
              <h3>Remember & place</h3>
              <span className="model-tag">ZONE</span>
            </div>
            <p>
              Confirm the mug once, then Track follows it. The lamp fires when its whole box enters
              the zone.
            </p>
            {segmentation?.detections.map((d) => (
              <button
                key={d.objectId}
                className="secondary"
                disabled={Boolean(busy) || !segmentRunId || !isMugConcept(segmentation.concept)}
                onClick={() => void deskAction('select', { segmentRunId, detectionId: d.objectId })}
              >
                Confirm mug mask #{d.objectId}
              </button>
            ))}
            {memory?.object && (
              <p className="micro">
                {memory.object.label} · {memory.object.id.slice(0, 8)}
                <br />
                {memory.observation
                  ? `Last observed ${new Date(memory.observation.observedAt).toLocaleTimeString()} · ${memory.observation.identity} identity`
                  : 'No observation'}
                {observationStale && ' · STALE: segment a new frame.'}
                {!currentObservation && ' · Segment and confirm the current frame to continue.'}
              </p>
            )}
            <button
              className="primary"
              disabled={!canTrack}
              onClick={() => void track()}
              title="Segment the mug in the current frame, match it to the remembered mug, and verify the zone"
            >
              {busy === 'track'
                ? 'Tracking…'
                : mode === 'live' && camera
                  ? 'Capture & track'
                  : 'Track the mug'}
              <Glyph type="arrow" />
            </button>
            <p className="micro">
              {!memory?.observation
                ? 'Confirm a mug mask by hand first; tracking starts from it.'
                : mode === 'fixture'
                  ? 'Move the mug with the buttons under the scene, then track.'
                  : `${status ? estimateLabel(status.meta.estimates.segment, 'track') : 'One SAM call per track'}. Move the mug, start the camera, then capture & track.`}
            </p>
            <button
              className="secondary"
              disabled={follow ? false : Boolean(busy) || !currentObservation}
              onClick={() => (follow ? stopFollow() : void startFollow())}
              title="Follow the mug frame to frame in the browser, calling SAM only at the zone edge or when the match gets weak"
            >
              {follow ? 'Stop following' : 'Follow locally'}
            </button>
            <p className="micro">
              {follow
                ? `${followStats.frames} local step${followStats.frames === 1 ? '' : 's'} · ${followStats.checks} SAM check${followStats.checks === 1 ? '' : 's'}${followView ? ` · match ${followView.track.score.toFixed(2)}, lead ${followView.track.lead.toFixed(2)} · ${followView.track.template.masked ? 'mask' : 'whole box'} template` : ''}${localZone ? '' : ' · no zone to watch: save one and mark the camera fixed'}`
                : currentObservation
                  ? 'Prototype: template matching in the browser. SAM confirms each zone crossing before the lamp can fire.'
                  : 'Track or confirm the mug in the current frame, then follow it locally.'}
            </p>
            <label className="overlay-toggle">
              <input
                type="checkbox"
                checked={Boolean(memory?.fixedCamera)}
                disabled={Boolean(busy) || !memory}
                onChange={(e) => void deskAction('camera', { fixed: e.target.checked })}
              />
              Camera is fixed: keep the zone for new frames of the same size
            </label>
            <button
              className="text-button"
              disabled={Boolean(busy) || !currentObservation || camera}
              onClick={() => {
                setDraftZone(memory?.zone?.rect ?? { x: 0.3, y: 0.2, width: 0.4, height: 0.6 });
                setDrawing(true);
              }}
            >
              Draw / edit zone ↗
            </button>
            {drawing && (
              <div className="zone-editor">
                <p className="micro">Drag a rectangle on the image, or enter percentages below.</p>
                <div className="zone-fields">
                  {(['x', 'y', 'width', 'height'] as const).map((key) => (
                    <label key={key}>
                      Zone {key} %
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        value={Math.round(draftZone[key] * 100)}
                        disabled={Boolean(busy)}
                        onChange={(e) =>
                          setDraftZone((z) => ({ ...z, [key]: Number(e.target.value) / 100 }))
                        }
                      />
                    </label>
                  ))}
                </div>
                <button
                  className="secondary"
                  disabled={Boolean(busy) || !currentObservation}
                  onClick={() =>
                    void deskAction('zone', {
                      observationId: currentObservation?.id,
                      rect: draftZone,
                    })
                  }
                >
                  Save zone
                </button>
              </div>
            )}
            <p className="micro">
              {!memory?.zone
                ? 'No saved zone.'
                : memory.fixedCamera
                  ? 'Zone saved; carried to same-size frames while the camera is marked fixed.'
                  : 'Zone saved for its source image.'}{' '}
              Observations expire after 5 minutes. A still photo does not prove the current physical
              scene.
            </p>
            <button
              className="physical"
              disabled={
                Boolean(busy) ||
                drawing ||
                !currentObservation ||
                !memory?.zone ||
                (mode === 'live' && !lampReady)
              }
              onClick={() =>
                void deskAction('verify', {
                  observationId: currentObservation?.id,
                  zoneId: memory?.zone?.id,
                })
              }
            >
              {busy === 'verify'
                ? 'Checking placement…'
                : mode === 'fixture'
                  ? 'Verify placement · virtual lamp'
                  : 'Verify placement · turn on lamp'}
            </button>
            {memory?.lastDecision && (
              <p className="placement-result" role="note">
                {memory.lastDecision.mode.toUpperCase()} · {memory.lastDecision.output.decision} ·
                lamp {memory.lastDecision.output.action}
                <br />
                {memory.lastDecision.output.reason}
                {memory.lastDecision.output.error && (
                  <>
                    <br />
                    {memory.lastDecision.output.error.message}
                  </>
                )}
                {memory.lastDecision.output.lamp && (
                  <>
                    <br />
                    {memory.lastDecision.output.lamp.explanation}
                  </>
                )}
              </p>
            )}
            {sightings.length > 0 && (
              <div className="timeline">
                <div className="section-label">
                  <span>MOVEMENT</span>
                  <span>
                    {sightings.length} SIGHTING{sightings.length === 1 ? '' : 'S'}
                  </span>
                </div>
                <ol>
                  {sightings.map((o, i) => {
                    const here = centre(o);
                    const before = sightings[i + 1];
                    const moved = before
                      ? Math.hypot(here.x - centre(before).x, here.y - centre(before).y) * 100
                      : null;
                    const verdict = verdictFor(o);
                    return (
                      <li key={o.id} className={i === 0 ? 'current' : ''}>
                        <span className={`transition ${verdict?.transition ?? 'none'}`}>
                          {verdict?.transition
                            ? TRANSITION[verdict.transition]
                            : verdict
                              ? 'Blocked'
                              : 'Not checked'}
                        </span>
                        <span className="micro">
                          {new Date(o.observedAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}{' '}
                          · {o.identity} · at {Math.round(here.x * 100)},{Math.round(here.y * 100)}%
                          {moved !== null && ` · moved ${moved.toFixed(1)}%`}
                          {o.overlap != null && ` · overlap ${o.overlap.toFixed(2)}`}
                          {verdict?.assumedFixedCamera && ' · carried zone'}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
            <button
              className="text-button destructive"
              disabled={Boolean(busy) || !memory?.object}
              onClick={() => void deskAction('reset')}
            >
              Reset desk memory
            </button>
          </div>
          <div className="probe">
            <div className="probe-title">
              <span className="step">04</span>
              <h3>Test one light</h3>
              <span className="model-tag">HA</span>
            </div>
            <p>
              {mode === 'fixture'
                ? 'Virtual lamp only. No hardware action.'
                : 'Turns on your configured lamp. Check the physical effect separately.'}
            </p>
            <button
              className="physical"
              disabled={Boolean(busy) || (mode === 'live' && !lampReady)}
              onClick={() => void execute('lamp')}
            >
              {busy === 'lamp'
                ? 'Checking state…'
                : mode === 'fixture'
                  ? 'Simulate lamp action'
                  : 'Turn on desk lamp'}
              <Glyph type="arrow" />
            </button>
          </div>
          <div className="connection">
            <span className="tiny">CONNECTION CHECK</span>
            <button
              className="text-button"
              disabled={Boolean(busy) || (mode === 'live' && !metaReady)}
              onClick={() => void execute('text')}
            >
              {busy === 'text' ? 'Checking…' : 'Run text smoke test'} <span>↗</span>
            </button>
            {mode === 'live' && status && (
              <p className="micro">{estimateLabel(status.meta.estimates.text)}</p>
            )}
          </div>
        </aside>
        <section className="lab-stage" aria-label="Scene and segmentation">
          <div className="scene-toolbar">
            <span>
              <span className={`dot ${mode === 'live' ? 'live' : ''}`} />
              {mode === 'fixture'
                ? 'ILLUSTRATED FIXTURE'
                : image
                  ? 'LOCAL DESK PHOTO'
                  : 'AWAITING DESK PHOTO'}
            </span>
            <label className="overlay-toggle">
              <input
                type="checkbox"
                checked={overlay}
                onChange={(e) => setOverlay(e.target.checked)}
              />{' '}
              Mask overlay
            </label>
            {pinning ? (
              <button className="secondary" onClick={() => setPinning(null)}>
                Cancel pin
              </button>
            ) : (
              <div className="mode-switch stage-view" aria-label="Stage view">
                {(['photo', 'iso'] as const).map((value) => (
                  <button
                    key={value}
                    aria-pressed={stageView === value}
                    onClick={() => setStageView(value)}
                  >
                    {value === 'photo' ? 'Photo' : 'Iso'}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className={`stage-fit ${stageView === 'iso' && !pinning ? 'iso' : ''}`}>
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
                <video ref={video} muted playsInline aria-label="Desk camera preview" />
              ) : mode === 'fixture' || image ? (
                <img
                  src={
                    mode === 'fixture'
                      ? deskSvg
                        ? fixtureDesk(deskSvg, fixturePosition)
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
                  <p>Upload a photo or capture a frame to begin.</p>
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
                  key={segmentRunId}
                  segmentation={segmentation}
                  chosenId={confirmedId}
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
                    zoneStart.current = zonePoint(e);
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!drawing || !zoneStart.current) return;
                    const p = zonePoint(e),
                      a = zoneStart.current;
                    setDraftZone({
                      x: Math.min(a.x, p.x),
                      y: Math.min(a.y, p.y),
                      width: Math.abs(a.x - p.x),
                      height: Math.abs(a.y - p.y),
                    });
                  }}
                  onPointerUp={() => {
                    zoneStart.current = null;
                  }}
                  onPointerCancel={() => {
                    zoneStart.current = null;
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
                    void deskAction('surface', {
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
            {stageView === 'iso' && !pinning && (
              <IsoView
                mode={mode}
                memory={memory}
                image={image}
                segmentation={segmentation}
                segmentRunId={segmentRunId}
                lights={mode === 'fixture' ? FIXTURE_LIGHTS : (status?.lamp.lights ?? [])}
                lampOn={lamp !== 'off'}
                drawing={drawing}
                zone={visibleZone ?? undefined}
                busy={Boolean(busy) || camera || cameraPending}
                onDraftZone={setDraftZone}
                onPin={(scene, surfaceId, label) => {
                  setDrawing(false);
                  setPinning({ scene, surfaceId, label });
                }}
                onClearPin={() => void deskAction('surface', { pin: null })}
                onRun={(run) => {
                  setSelected(run);
                  setMessage(
                    run.kind === 'item'
                      ? `Model drafted: ${(run.output as SavedItem).parts.length} parts. Edit it, then save.`
                      : run.kind === 'layout'
                        ? 'Scene drafted. Review it in the scene editor, then save.'
                        : run.kind === 'photo'
                          ? 'Scene drafted from the photo. Review the pin and the objects, then save.'
                          : `Scene guess saved: ${(run.output as SceneGuess).kind}. ${(run.output as SceneGuess).summary}`,
                  );
                  void refresh();
                }}
                onMemory={setMemory}
                onUpload={upload}
                onMessage={(text) => {
                  setMessage(text);
                  void refresh();
                }}
                onError={setError}
              />
            )}
          </div>
          <div className="scene-bottom">
            <span>
              {mode === 'fixture'
                ? 'Synthetic scene. Move the mug to test tracking; no inference or physical action.'
                : 'Your photo is sent to Meta for live vision probes.'}
            </span>
            {mode === 'fixture' && (
              <div className="capture-actions" role="group" aria-label="Move the fixture mug">
                {(Object.keys(FIXTURE_POSITIONS) as FixturePosition[]).map((p) => (
                  <button
                    key={p}
                    aria-pressed={fixturePosition === p}
                    disabled={Boolean(busy)}
                    onClick={() => moveFixtureMug(p)}
                  >
                    {FIXTURE_POSITIONS[p].label}
                  </button>
                ))}
              </div>
            )}
            {mode === 'live' && (
              <div className="capture-actions">
                <input
                  ref={file}
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  onChange={(e) => void upload(e.target.files?.[0])}
                />
                {camera ? (
                  <>
                    <button
                      disabled={Boolean(busy)}
                      onClick={() => {
                        if (video.current?.videoWidth) {
                          captureCanvas(
                            video.current,
                            video.current.videoWidth,
                            video.current.videoHeight,
                          );
                          stopCamera();
                        }
                      }}
                    >
                      Capture frame
                    </button>
                    <button onClick={stopCamera}>Stop camera</button>
                  </>
                ) : (
                  <>
                    <button disabled={Boolean(busy)} onClick={() => file.current?.click()}>
                      <Glyph type="upload" /> Upload
                    </button>
                    <button
                      disabled={Boolean(busy) || cameraPending}
                      onClick={() => void startCamera()}
                    >
                      <Glyph type="camera" /> {cameraPending ? 'Opening…' : 'Camera'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="observed">
            <div className="section-label">
              <span>DISCOVERED OBJECTS</span>
              <span>
                {scene
                  ? `${scene.objects.length.toString().padStart(2, '0')} OBJECTS`
                  : 'AWAITING PROBE'}
              </span>
            </div>
            {scene ? (
              <>
                <p className="scene-summary">{scene.summary}</p>
                <div className="object-grid">
                  {scene.objects.map((object, i) => (
                    <button
                      key={i}
                      disabled={Boolean(busy)}
                      onClick={() => setConcept(object.category)}
                      className={`object-card ${concept === object.category ? 'chosen' : ''}`}
                    >
                      <span className="object-number">0{i + 1}</span>
                      <strong>{object.label}</strong>
                      <small>{object.appearance}</small>
                      <span className="object-category">
                        {object.category} <span>↗</span>
                      </span>
                    </button>
                  ))}
                </div>
                {!scene.objects.length && <p>No suitable objects were returned.</p>}
              </>
            ) : (
              <p className="placeholder">Discovered objects show up here.</p>
            )}
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
        </section>
        <aside className="lab-side" aria-label="Evidence and setup">
          <div className="side-tabs" role="tablist" aria-label="Side panel">
            {(['runs', 'inspect', 'setup'] as const).map((tab) => (
              <button
                key={tab}
                role="tab"
                id={`tab-${tab}`}
                aria-selected={sideTab === tab}
                aria-controls={`panel-${tab}`}
                onClick={() => setSideTab(tab)}
              >
                {tab === 'runs'
                  ? `Runs · ${filteredRuns.length}`
                  : tab === 'inspect'
                    ? 'Inspect'
                    : `Setup · ${proofCount}/4`}
              </button>
            ))}
          </div>
          <div
            className="side-panel"
            role="tabpanel"
            id="panel-runs"
            aria-labelledby="tab-runs"
            hidden={sideTab !== 'runs'}
          >
            <div className="log-filters" role="group" aria-label="Filter the evidence log">
              <label>
                Kind
                <select
                  value={logKind}
                  onChange={(e) => {
                    setLogKind(e.target.value as RunKind | 'all');
                    setLogLimit(LOG_PAGE);
                  }}
                >
                  <option value="all">All kinds</option>
                  {RUN_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Mode
                <select
                  value={logMode}
                  onChange={(e) => {
                    setLogMode(e.target.value as Mode | 'all');
                    setLogLimit(LOG_PAGE);
                  }}
                >
                  <option value="all">Both modes</option>
                  <option value="fixture">Fixture</option>
                  <option value="live">Live</option>
                </select>
              </label>
              <label className="overlay-toggle">
                <input
                  type="checkbox"
                  checked={failuresOnly}
                  onChange={(e) => {
                    setFailuresOnly(e.target.checked);
                    setLogLimit(LOG_PAGE);
                  }}
                />{' '}
                Failures only
              </label>
              <p className="log-stats" aria-live="polite">
                {filteredRuns.length} run{filteredRuns.length === 1 ? '' : 's'}
                {logStats.failed > 0 && (
                  <span className="failed"> · × {logStats.failed} failed</span>
                )}
                {logStats.medianMs !== null && ` · median ${logStats.medianMs} ms`}
                {logStats.cost > 0 && ` · ≈ ${usd(logStats.cost)}`}
              </p>
            </div>
            <div className="evidence-table">
              <div className="table-head">
                <span>PROBE / SOURCE</span>
                <span>RESULT</span>
                <span>DURATION</span>
              </div>
              {filteredRuns.length ? (
                filteredRuns.slice(0, logLimit).map((run) => (
                  <button
                    className={`run-row ${selected?.id === run.id ? 'selected' : ''}`}
                    key={run.id}
                    aria-pressed={selected?.id === run.id}
                    onClick={() => inspect(run)}
                  >
                    <span>
                      <strong>{run.kind}</strong>
                      <small>
                        {new Date(run.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}{' '}
                        <b className={`badge ${run.mode}`}>{run.mode}</b>
                      </small>
                      {runDetail(run) && <em className="run-detail">{runDetail(run)}</em>}
                    </span>
                    <span className={`result ${run.status}`}>
                      <span aria-hidden="true">{RESULT_GLYPH[run.status]}</span>{' '}
                      {run.status.replace('_', ' ')}
                    </span>
                    <span>
                      {run.durationMs} ms{costNote(run)} <span className="row-arrow">↗</span>
                    </span>
                  </button>
                ))
              ) : (
                <div className="empty-evidence">
                  {runs.length
                    ? 'No runs match these filters.'
                    : 'No probes yet. Start with discovery above.'}
                </div>
              )}
              {filteredRuns.length > logLimit && (
                <button className="log-more" onClick={() => setLogLimit((n) => n + LOG_PAGE * 2)}>
                  Show more · {filteredRuns.length - logLimit} older
                </button>
              )}
            </div>
          </div>
          <div
            className="side-panel"
            role="tabpanel"
            id="panel-inspect"
            aria-labelledby="tab-inspect"
            hidden={sideTab !== 'inspect'}
          >
            {selected ? (
              <section
                className="inspector"
                key={selected.id}
                aria-label={`${selected.kind} run ${selected.id.slice(0, 8)}`}
              >
                <header className="inspector-head">
                  <div>
                    <span className="tiny">RUN INSPECTOR</span>
                    <h3>
                      <span className="inspector-kind">{selected.kind}</span>{' '}
                      <code>{selected.id.slice(0, 8)}</code>
                    </h3>
                  </div>
                  <span className={`result ${selected.status}`}>
                    <span aria-hidden="true">{RESULT_GLYPH[selected.status]}</span>{' '}
                    {selected.status.replace('_', ' ')}
                  </span>
                  <button
                    className="inspector-close"
                    aria-label="Close inspector"
                    onClick={() => {
                      setSelected(undefined);
                      setSideTab('runs');
                    }}
                  >
                    ×
                  </button>
                </header>
                {runDetail(selected) && <p className="inspector-detail">{runDetail(selected)}</p>}
                {selected.kind === 'lamp' && <p>{(selected.output as LampResult).explanation}</p>}
                <dl className="inspector-facts">
                  <div>
                    <dt>MODE</dt>
                    <dd>{selected.mode}</dd>
                  </div>
                  <div>
                    <dt>MODEL</dt>
                    <dd>{selected.model ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>PROMPT</dt>
                    <dd>{selected.promptVersion}</dd>
                  </div>
                  <div>
                    <dt>DURATION</dt>
                    <dd>{selected.durationMs} ms</dd>
                  </div>
                  <div>
                    <dt>TOKENS IN / OUT</dt>
                    <dd>
                      {selected.usage
                        ? `${selected.usage.inputTokens} / ${selected.usage.outputTokens}`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>EST. COST</dt>
                    <dd>{runCost(selected) === null ? '—' : `≈ ${usd(runCost(selected)!)}`}</dd>
                  </div>
                  <div>
                    <dt>REQUEST ID</dt>
                    <dd>{selected.requestId ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>CREATED</dt>
                    <dd>{new Date(selected.createdAt).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>ASSETS</dt>
                    <dd>{selected.assets.length ? selected.assets.join(', ') : '—'}</dd>
                  </div>
                </dl>
                <div className="inspector-actions">
                  {isProbe(selected.kind) && (
                    <button
                      className="secondary"
                      disabled={Boolean(rerunBlock(selected))}
                      title={rerunBlock(selected) ?? undefined}
                      onClick={() => rerun(selected)}
                    >
                      Run again
                      {selected.kind === 'segment' &&
                        ` · “${(selected.output as Segmentation).concept}”`}
                    </button>
                  )}
                  {(selected.kind === 'segment' || selected.kind === 'discover') && (
                    <button
                      className="secondary"
                      disabled={!canRestore(selected)}
                      title={
                        canRestore(selected)
                          ? undefined
                          : 'Only results made from the image on screen can go back on it.'
                      }
                      onClick={() => restore(selected)}
                    >
                      Show on scene
                    </button>
                  )}
                  <button className="text-button" onClick={() => copyRun(selected)}>
                    Copy JSON
                  </button>
                </div>
                {isProbe(selected.kind) && rerunBlock(selected) && (
                  <p className="micro">{rerunBlock(selected)}</p>
                )}
                <details>
                  <summary>Raw evidence</summary>
                  <pre>{JSON.stringify(selected, null, 2)}</pre>
                </details>
              </section>
            ) : (
              <p className="placeholder">Pick a run in Runs to inspect it.</p>
            )}
          </div>
          <div
            className="side-panel"
            role="tabpanel"
            id="panel-setup"
            aria-labelledby="tab-setup"
            hidden={sideTab !== 'setup'}
          >
            <dl className="session-strip" aria-label="Session">
              <div>
                <dt>SPARK</dt>
                <dd>{status?.meta.sparkModel ?? '…'}</dd>
              </div>
              <div>
                <dt>SAM</dt>
                <dd>{status?.meta.samModel ?? '…'}</dd>
              </div>
              <div>
                <dt>META</dt>
                <dd className={metaReady ? 'ok' : 'unsure'}>
                  {metaReady ? '● ready' : '◌ off'}
                  {status && (
                    <small>
                      {status.meta.usedToday} / {status.meta.requestLimit} calls
                    </small>
                  )}
                </dd>
                {status && (
                  <span className="budget" aria-hidden="true">
                    <span
                      style={{
                        width: `${Math.min(100, (status.meta.usedToday / Math.max(1, status.meta.requestLimit)) * 100)}%`,
                      }}
                    />
                  </span>
                )}
              </div>
              <div>
                <dt>SPENT TODAY</dt>
                <dd>{status ? `≈ ${usd(status.meta.spentToday)}` : '…'}</dd>
              </div>
              <div>
                <dt>LAMP</dt>
                <dd className={lampReady ? 'ok' : 'unsure'}>{lampReady ? '● ready' : '◌ off'}</dd>
              </div>
              <div>
                <dt>LIVE PROOF</dt>
                <dd>{proofCount} / 4</dd>
              </div>
            </dl>
            <aside className="readiness">
              <span className="tiny">LIVE PROOF CHECKLIST</span>
              <h3>
                {proofCount}
                <span> / 4</span>
              </h3>
              <p>Fixture runs never count toward live proof.</p>
              {(['text', 'discover', 'segment', 'lamp'] as const).map((kind) => (
                <div className="proof-row" key={kind}>
                  <span className={`ring ${status?.liveEvidence[kind] ? 'done' : ''}`}>
                    {status?.liveEvidence[kind] ? '✓' : ''}
                  </span>
                  {
                    {
                      text: 'Spark connection',
                      discover: 'Real desk discovery',
                      segment: 'Real mug mask',
                      lamp: 'HA state observed',
                    }[kind]
                  }
                  <small>{status?.liveEvidence[kind] ? 'Saved' : 'Pending'}</small>
                </div>
              ))}
              <div className="setup-note">
                <strong>{metaReady ? 'Meta calls enabled' : 'Meta access pending'}</strong>
                <p>{status?.meta.note ?? 'Checking local configuration…'}</p>
                <strong>{lampReady ? 'Lamp adapter enabled' : 'Lamp setup pending'}</strong>
                <p>{status?.lamp.note}</p>
                <small>
                  {status
                    ? `${status.meta.usedToday} / ${status.meta.requestLimit} Meta attempts today (UTC) · ≈ ${usd(status.meta.spentToday)} spent`
                    : 'No outbound calls on startup.'}
                </small>
              </div>
            </aside>
          </div>
        </aside>
      </main>
    </div>
  );
}
