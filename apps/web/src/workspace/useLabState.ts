import { useEffect, useRef, useState, type PointerEvent } from 'react';
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
  Quad,
  SceneGuess,
  SavedItem,
} from '@livinglayer/domain';
import {
  FIXTURE_POSITIONS,
  FIXTURE_LIGHTS,
  OBSERVATION_MAX_AGE_MS,
  ISO_PRESETS,
  runCost,
  startLocalTrack,
  stepLocalTrack,
  toLuma,
  zoneApplies,
} from '@livinglayer/domain';
import { api, ApiError } from '../api';
import { openStream, useNetworkStreams } from '../streams';
import { usd } from '../cost';
import { takeHandoff } from '../handoff';
import type { Issue } from '../ProviderUi';
import type { IsoPanel, RuleDraft } from '../iso/IsoView';
import {
  clearSession,
  downloadSave,
  emptyDesk,
  parseSave,
  prefsOf,
  readSession,
  writeSession,
  type Prefs,
  type SessionSave,
  type StageView,
} from '../session';
import { SHORTCUTS, useShortcuts, type ShortcutAction } from '../shortcuts';
import {
  parseSelection,
  roomOf,
  sceneProgress,
  selectionForStep,
  selectionHash,
  viewOf,
  type Selection,
  type StepId,
  type WorkScene,
} from './progress';

export const BUSY: Record<string, string> = {
  text: 'Checking the connection',
  discover: 'Discovering objects',
  segment: 'Finding the shape',
  lamp: 'Switching the lamp',
  select: 'Remembering the mug',
  zone: 'Saving the zone',
  verify: 'Checking placement',
  reset: 'Resetting desk memory',
  track: 'Tracking the mug',
  autopin: 'Finding the desk',
  camera: 'Updating the camera setting',
  undo: 'Undoing',
  redo: 'Redoing',
  restore: 'Loading the save',
};
export const TRANSITION: Record<NonNullable<PlacementDecision['transition']>, string> = {
  entered: 'Entered the zone',
  stayed_inside: 'Still inside',
  left: 'Left the zone',
  stayed_outside: 'Still outside',
};
/** Redraw the fixture desk with the mug, its coffee and its shadow moved together. */
export function fixtureDesk(svg: string, position: FixturePosition): string {
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
export const centre = (o: DeskObservation) => ({
  x: (o.box.x + o.box.width / 2) / o.frame.width,
  y: (o.box.y + o.box.height / 2) / o.frame.height,
});
export const RESULT_GLYPH: Record<EvidenceRun['status'], string> = {
  completed: '✓',
  no_match: '◌',
  unconfirmed: '◌',
  failed: '×',
};
export const RUN_KINDS: RunKind[] = [
  'text',
  'discover',
  'segment',
  'scene',
  'layout',
  'photo',
  'item',
  'lamp',
  'observation',
  'zone',
  'placement',
];
export const LOG_PAGE = 10;
/** Undo steps kept per mode. */
const UNDO_LIMIT = 50;
/** Whether a desk holds anything a person made: an object, a pin, a scene, a rule. */
const deskIsBlank = (d: DeskMemory) =>
  !d.object &&
  !d.surface &&
  !d.scene &&
  !d.zone &&
  !d.item &&
  !d.others?.length &&
  !d.rules?.length;
type ProbeKind = 'text' | 'discover' | 'segment' | 'lamp';
export const isProbe = (kind: RunKind): kind is ProbeKind =>
  ['text', 'discover', 'segment', 'lamp'].includes(kind);

/** One short line on what a run returned, for the log and the inspector. */
export function runDetail(run: EvidenceRun): string {
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

/** All of the lab's state and actions, shared with the workspace through `LabContext`. */
export function useLabState() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // The browser's own save: choices and a copy of each desk, read once.
  const [boot] = useState(() => {
    const save = readSession();
    return { save, prefs: prefsOf(save?.prefs) };
  });
  const [mode, setMode] = useState<Mode>(boot.prefs.mode);
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
  const [concept, setConcept] = useState(boot.prefs.concept);
  const [fixturePosition, setFixturePosition] = useState<FixturePosition>(
    boot.prefs.fixturePosition in FIXTURE_POSITIONS
      ? (boot.prefs.fixturePosition as FixturePosition)
      : 'centre',
  );
  const [deskSvg, setDeskSvg] = useState('');
  const [overlay, setOverlay] = useState(boot.prefs.overlay);
  const [showTrail, setShowTrail] = useState(boot.prefs.trail);
  const [showZones, setShowZones] = useState(boot.prefs.zones);
  const [stageView, setStageView] = useState<StageView>(boot.prefs.stageView);
  // Scene first: nothing runs until the person says which scene they are in.
  const [workScene, setWorkScene] = useState<WorkScene | null>(boot.prefs.workScene);
  const [choosingScene, setChoosingScene] = useState(false);
  // The outline node the inspector shows. It lives in the URL hash, so a reload keeps it.
  const [selection, setSelectionState] = useState<Selection | null>(() =>
    parseSelection(window.location.hash),
  );
  const setSelection = (next: Selection | null) => {
    setSelectionState(next);
    const hash = selectionHash(next);
    window.history.replaceState(null, '', hash || window.location.pathname);
  };
  // What the iso canvas is doing: showing the room, editing the layout, or editing a model.
  const [isoPanel, setIsoPanel] = useState<IsoPanel>('room');
  // On phones the outline is a sheet that slides up over the page.
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [modelOf, setModelOf] = useState<string>();
  const [isoSurfaceId, setIsoSurfaceId] = useState<string>();
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [guess, setGuess] = useState<SceneGuess | null>(null);
  const sceneLabel =
    workScene === 'custom'
      ? (memory?.scene?.label ?? 'Custom')
      : workScene && ISO_PRESETS[workScene].label;
  // A removed custom scene, or one this mode doesn't have, means choosing again.
  useEffect(() => {
    if (workScene === 'custom' && memory && !memory.scene) setWorkScene(null);
  }, [workScene, memory]);
  // Clicking a surface's corners on the photo, for the iso view.
  const [pinning, setPinning] = useState<{
    scene: IsoSceneKind | 'custom';
    surfaceId: string;
    label: string;
    /** Corners found from the photo, to check and adjust instead of clicking. */
    corners?: Quad;
    note?: string;
  } | null>(null);
  const [busy, setBusy] = useState('');
  const [issue, setIssue] = useState<Issue | null>(null);
  const error = issue?.message ?? '';
  /** Show a failure: a plain sentence, or an API error with the provider's own reason. */
  const setError = (e: string | Error) =>
    setIssue(
      !e
        ? null
        : typeof e === 'string'
          ? { message: e }
          : e instanceof ApiError
            ? { message: e.message, code: e.code, detail: e.detail, runId: e.runId }
            : { message: e.message },
    );
  const [message, setMessage] = useState(
    boot.save
      ? 'Welcome back. Your session was restored from this browser.'
      : 'Start with the room: use the demo office, or photograph your own.',
  );
  const [selected, setSelected] = useState<EvidenceRun>();
  const [logKind, setLogKind] = useState<RunKind | 'all'>(
    RUN_KINDS.includes(boot.prefs.logKind as RunKind) ? (boot.prefs.logKind as RunKind) : 'all',
  );
  const [logMode, setLogMode] = useState<Mode | 'all'>(boot.prefs.logMode as Mode | 'all');
  const [failuresOnly, setFailuresOnly] = useState(boot.prefs.failuresOnly);
  const [logLimit, setLogLimit] = useState(LOG_PAGE);
  const [drawer, setDrawer] = useState(boot.prefs.drawer);
  // Drives the ambient warm-up. Only a confirmed lamp state turns it on.
  const [lamp, setLamp] = useState<'off' | 'virtual' | 'live'>('off');
  const light = () => setLamp(mode === 'fixture' ? 'virtual' : 'live');
  const [camera, setCamera] = useState(false);
  const [cameraPending, setCameraPending] = useState(false);
  const cameraGeneration = useRef(0);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const closeNetwork = useRef<(() => void) | null>(null);
  const network = useNetworkStreams();
  /** '' for this device's camera, else the id of a network camera. */
  const [cameraSource, setCameraSource] = useState(boot.prefs.cameraSource);
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
  // Each mode's desks from before (undo) and after (redo) the person's edits.
  const undo = useRef<Record<Mode, DeskMemory[]>>({ fixture: [], live: [] });
  const redo = useRef<Record<Mode, DeskMemory[]>>({ fixture: [], live: [] });
  const [, setHistoryTick] = useState(0);
  /** A new desk memory; an edit can be undone, a sighting (`undoable` false) can't. */
  const setMemory = (next: DeskMemory, undoable = true) => {
    const before = memories[next.mode];
    if (undoable && before && JSON.stringify(before) !== JSON.stringify(next)) {
      undo.current[next.mode] = [...undo.current[next.mode], before].slice(-UNDO_LIMIT);
      redo.current[next.mode] = [];
      setHistoryTick((t) => t + 1);
    }
    memoryWrites.current++;
    setMemories((current) => ({ ...current, [next.mode]: next }));
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
    return { fixture: fixtureDesk, live: liveDesk };
  };
  // Autosave: choices and desks go to this browser as the person works, once
  // the server's desks have loaded so an empty first render never overwrites them.
  const [deskReady, setDeskReady] = useState(false);
  const [savedAt, setSavedAt] = useState(boot.save?.savedAt ?? '');
  const [storageOk, setStorageOk] = useState(true);
  const prefs: Prefs = {
    mode,
    workScene,
    stageView,
    overlay,
    trail: showTrail,
    zones: showZones,
    concept,
    fixturePosition,
    cameraSource,
    drawer,
    logKind,
    logMode,
    failuresOnly,
  };
  function saveNow() {
    const ok = writeSession(prefs, memories);
    setStorageOk(ok);
    if (ok) setSavedAt(new Date().toISOString());
    return ok;
  }
  useEffect(() => {
    if (!deskReady) return;
    const timer = window.setTimeout(saveNow, 400);
    return () => window.clearTimeout(timer);
  }, [deskReady, memories, ...Object.values(prefs)]);
  // A reload or a closed tab can come sooner than the pause autosave waits for, so save on the way out too.
  const flush = useRef(() => {});
  flush.current = () => {
    if (deskReady) saveNow();
  };
  useEffect(() => {
    const leave = () => flush.current();
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, []);
  /** Put a whole desk on the server, for an import, an undo or redo, or the demo. */
  async function restoreDesk(next: DeskMemory) {
    const saved = await api<DeskMemory>('desk/restore', { mode: next.mode, memory: next });
    memoryWrites.current++;
    setMemories((current) => ({ ...current, [saved.mode]: saved }));
    return saved;
  }
  async function stepHistory(back: boolean) {
    const from = back ? undo : redo;
    const to = back ? redo : undo;
    const target = from.current[mode].at(-1);
    const current = memory;
    if (!target || !current || busy || camera) return;
    setBusy(back ? 'undo' : 'redo');
    setError('');
    try {
      await restoreDesk(target);
      from.current[mode] = from.current[mode].slice(0, -1);
      to.current[mode] = [...to.current[mode], current].slice(-UNDO_LIMIT);
      setHistoryTick((t) => t + 1);
      setDrawing(false);
      setPinning(null);
      setMessage(
        back ? `Undone. Redo with ${SHORTCUTS.find((k) => k.action === 'redo')!.keys}.` : 'Redone.',
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Undo failed.');
    } finally {
      setBusy('');
    }
  }
  function exportSave() {
    saveNow();
    downloadSave({
      app: 'livinglayer',
      version: 1,
      savedAt: new Date().toISOString(),
      prefs,
      desks: memories,
    });
    setMessage(
      'Save exported. Import it here or in another browser to pick up where you left off.',
    );
  }
  const importFile = useRef<HTMLInputElement>(null);
  /** Load a save: its desks go to the server, its choices to this page. */
  async function applySave(save: SessionSave, note: string) {
    stopCamera();
    setBusy('restore');
    setError('');
    try {
      for (const m of ['fixture', 'live'] as const) {
        await restoreDesk(save.desks[m] ?? emptyDesk(m));
        undo.current[m] = [];
        redo.current[m] = [];
      }
      const next = prefsOf(save.prefs);
      changeMode(next.mode);
      setWorkScene(next.workScene);
      setChoosingScene(false);
      setStageView(next.stageView);
      setSelection(null);
      setIsoPanel('room');
      setRuleDraft(null);
      setOverlay(next.overlay);
      setShowTrail(next.trail);
      setShowZones(next.zones);
      setConcept(next.concept);
      if (next.fixturePosition in FIXTURE_POSITIONS)
        setFixturePosition(next.fixturePosition as FixturePosition);
      setCameraSource(next.cameraSource);
      setDrawer(next.drawer);
      setLogKind(RUN_KINDS.includes(next.logKind as RunKind) ? (next.logKind as RunKind) : 'all');
      setLogMode(next.logMode as Mode | 'all');
      setFailuresOnly(next.failuresOnly);
      setPinning(null);
      setHistoryTick((t) => t + 1);
      setMessage(note);
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The save could not be loaded.');
    } finally {
      setBusy('');
    }
  }
  async function importSave(chosen: File) {
    try {
      const save = parseSave(await chosen.text());
      await applySave(save, `Save from ${new Date(save.savedAt).toLocaleString()} imported.`);
    } catch (e) {
      setError(e instanceof Error ? e : 'The save could not be read.');
    } finally {
      if (importFile.current) importFile.current.value = '';
    }
  }
  const [showKeys, setShowKeys] = useState(false);
  useShortcuts((action: ShortcutAction) => {
    if (action === 'help') return setShowKeys((v) => !v);
    if (action === 'escape') {
      if (showKeys) return setShowKeys(false);
      if (outlineOpen) return setOutlineOpen(false);
      if (pinning) return setPinning(null);
      if (drawing) return setDrawing(false);
      if (ruleDraft) return setRuleDraft(null);
      if (isoPanel !== 'room') return setIsoPanel('room');
      if (choosingScene && workScene) return setChoosingScene(false);
      return false;
    }
    if (action === 'save') {
      setMessage(saveNow() ? 'Saved to this browser.' : 'This browser would not store the save.');
      return;
    }
    if (action === 'export') return exportSave();
    if (action === 'import') return importFile.current?.click();
    if (action === 'undo' || action === 'redo') return void stepHistory(action === 'undo');
    if (action === 'photo' || action === 'iso') {
      if (pinning) return false;
      setStageView(action);
      setIsoPanel('room');
      return;
    }
    if (action === 'scene' && !busy && !pinning) setChoosingScene(true);
  });
  async function resetToDemo() {
    if (
      !window.confirm(
        'Reset everything to the demo? Both desks, your scene, pins, rules and models are cleared, and this browser’s save is replaced. The evidence log is kept. Export a save first to keep a copy.',
      )
    )
      return;
    clearSession();
    await applySave(
      { app: 'livinglayer', version: 1, savedAt: new Date().toISOString(), prefs: {}, desks: {} },
      'Reset to the demo. Choose a room to begin.',
    );
  }
  useEffect(() => {
    void fetch('/desk.svg')
      .then((r) => r.text())
      .then(setDeskSvg)
      .catch(() => {});
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh()
      .then(async (desks) => {
        // A fresh server (new data folder) takes this browser's copy of its desks.
        for (const m of ['fixture', 'live'] as const) {
          const local = boot.save?.desks[m];
          if (local && !deskIsBlank(local) && deskIsBlank(desks[m]))
            await restoreDesk(local).catch(() => {});
        }
        setDeskReady(true);
      })
      .catch(() => setError('The local API is unavailable. Start both services with bun run dev.'));
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
      releaseStream();
    };
  }, []);
  function stopFollow() {
    localTrack.current = null;
    setFollow(false);
    setFollowView(null);
  }
  function releaseStream() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    closeNetwork.current?.();
    closeNetwork.current = null;
  }
  const stopCamera = () => {
    stopFollow();
    cameraGeneration.current++;
    releaseStream();
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
        ? 'Demo selected: the illustrated desk, with no model calls and a virtual lamp.'
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
      setError(e instanceof Error ? e : 'Could not open that image.');
    }
    if (file.current) file.current.value = '';
    return url;
  }
  async function startCamera() {
    if (cameraPending || stream.current) return;
    setError('');
    setCameraPending(true);
    const generation = ++cameraGeneration.current;
    const remote = network.streams.find((s) => s.id === cameraSource);
    try {
      const opened = remote
        ? await openStream(remote.whep, () => {
            if (!mounted.current || generation !== cameraGeneration.current) return;
            stopCamera();
            setError(`The network camera "${remote.name}" stopped sending.`);
          })
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
      setCamera(true);
    } catch {
      if (mounted.current && generation === cameraGeneration.current)
        setError(
          remote
            ? `Could not reach the network camera "${remote.name}". Is the share still running?`
            : 'Camera access is unavailable. Upload a desk photo instead.',
        );
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
          : `${mode === 'fixture' ? 'Demo' : 'Live'} ${kind} probe saved · ${run.durationMs} ms${costNote(run)}.`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e : 'Probe failed.');
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
      setMemory(result.memory, false);
      setSelected(result.event);
      if (result.event.output.action === 'confirmed') light();
      setMessage(`Tracked${costNote(run)}. ${placementMessage(result.event)}`);
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
      setError(e instanceof Error ? e : 'Could not start following.');
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
      setError(e instanceof Error ? e : 'Could not keep following.');
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
      setError(e instanceof Error ? e : 'Could not follow the mug.');
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
            ? 'Mug identity manually confirmed. Track it, then draw its zone.'
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
      setError(e instanceof Error ? e : 'Desk operation failed.');
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
    status.meta.spentToday < status.meta.spendLimit,
  );
  const lampReady = Boolean(status?.lamp.configured && status.lamp.enabled);
  const spendShare = status
    ? Math.min(1, status.meta.spentToday / Math.max(0.01, status.meta.spendLimit))
    : 0;
  const spendTone = spendShare >= 1 ? 'blocked' : spendShare >= 0.8 ? 'unsure' : 'ok';
  const [limitDraft, setLimitDraft] = useState('');
  useEffect(() => {
    if (status) setLimitDraft(String(status.meta.spendLimit));
  }, [status?.meta.spendLimit]);
  async function saveSpendLimit(usdLimit: number | null) {
    try {
      const saved = await api<{ spendLimit: number }>('settings/spend-limit', { usd: usdLimit });
      setMessage(`Daily Meta spending limit set to ${usd(saved.spendLimit)}.`);
      setError('');
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The limit could not be saved.');
    }
  }
  const canVision =
    Boolean(workScene) && !busy && (mode === 'fixture' || (metaReady && Boolean(image)));
  const canTrack =
    Boolean(workScene) &&
    !busy &&
    !follow &&
    Boolean(memory?.object && memory.observation) &&
    (mode === 'fixture' || (metaReady && (Boolean(image) || camera)));
  const proofCount = status ? Object.values(status.liveEvidence).filter(Boolean).length : 0;
  const confirmedId = currentObservation?.detectionId;
  const progress = sceneProgress({ mode, workScene, memory });
  const lights = mode === 'fixture' ? FIXTURE_LIGHTS : (status?.lamp.lights ?? []);
  /** Choose the room to work in: the demo preset, or start drafting one from a photo. */
  function pickScene(next: WorkScene, from: 'preset' | 'photo' = 'preset') {
    setWorkScene(next);
    setChoosingScene(false);
    setError('');
    setGuess(null);
    setRuleDraft(null);
    if (from === 'photo') {
      setStageView('iso');
      setIsoPanel('scene');
      setSelection({ kind: 'room' });
      setMessage(
        mode === 'fixture'
          ? 'Draft the room from the demo photo, review it, then save.'
          : 'Upload a photo of the room. Spark lists what is in it and SAM outlines it.',
      );
      return;
    }
    setIsoPanel('room');
    const after = sceneProgress({ mode, workScene: next, memory });
    setSelection(after.next ? selectionForStep(after.next, memory) : { kind: 'room' });
    const label =
      next === 'custom' ? 'your own scene' : `the ${ISO_PRESETS[next].label.toLowerCase()}`;
    setMessage(
      after.next === 'desk'
        ? `Working in ${label}. Next, get close to the desk and pin its top.`
        : `Working in ${label}. Next, find the mug on the desk.`,
    );
  }
  /** Show one node of the outline, and move the canvas to the scene it is in. */
  function select(next: Selection | null) {
    setOutlineOpen(false);
    if (next?.kind !== 'new-rule') setRuleDraft(null);
    if (next?.kind === 'room' && progress.room) setWorkScene(progress.room);
    if (next?.kind === 'view' && progress.view) setWorkScene(progress.view);
    if (next?.kind === 'surface') {
      setIsoSurfaceId(next.id);
      const inView =
        progress.view && ISO_PRESETS[progress.view].surfaces.some((x) => x.id === next.id);
      if (progress.room) setWorkScene(inView ? progress.view! : progress.room);
    }
    if (isoPanel === 'scene' && next?.kind !== 'room') setIsoPanel('room');
    if (isoPanel === 'item' && next?.kind !== 'object') setIsoPanel('room');
    setSelection(next);
  }
  function goToStep(id: StepId) {
    if (id === 'office') return setChoosingScene(true);
    select(selectionForStep(id, memory));
  }
  /** Open an object's model in the canvas. `undefined` is the mug. */
  function openModel(objectId?: string) {
    setModelOf(objectId);
    setIsoPanel('item');
    if (stageView === 'photo') setStageView('iso');
  }
  function editLayout() {
    setIsoPanel('scene');
    if (stageView === 'photo') setStageView('iso');
  }
  function startRule(objectId: string) {
    setRuleDraft({ objectId, lightId: lights[0] ?? '', label: '', rect: null });
    setIsoPanel('room');
    if (stageView === 'photo') setStageView('iso');
    setSelection({ kind: 'new-rule' });
  }
  /**
   * Find a surface's corners on the current photo (one SAM call, live), then
   * open the pin with them to check. No desk found means clicking by hand.
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
      const result = await api<{
        run: EvidenceRun<Segmentation>;
        pin: { corners: Quad; iou: number; frame: { width: number; height: number } } | null;
      }>('desk/auto-pin', { mode, ...(mode === 'live' ? { imageDataUrl: image } : {}) });
      setSelected(result.run);
      const fits =
        result.pin &&
        result.pin.frame.width === dimensions.width &&
        result.pin.frame.height === dimensions.height;
      if (!result.pin || !fits) {
        setPinning(target);
        setMessage(
          `No ${target.label} found in this photo${costNote(result.run)}. Click its four corners instead.`,
        );
      } else {
        const unsure = result.pin.iou < 0.85;
        setPinning({
          ...target,
          corners: result.pin.corners,
          note: unsure
            ? `The ${target.label}’s outline isn’t a clean rectangle, so check each corner before saving.`
            : undefined,
        });
        setMessage(
          `Found the ${target.label}${costNote(result.run)}. Drag any corner that’s off, then save the pin.`,
        );
      }
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not find the desk.');
    } finally {
      setBusy('');
    }
  }
  const [asking, setAsking] = useState(false);
  /** Ask Spark which preset the photo shows; it may only move between a room and its close view. */
  async function askGuess() {
    if (!workScene) return;
    setAsking(true);
    setError('');
    try {
      const run = await api<EvidenceRun<SceneGuess>>('scene/classify', {
        mode,
        ...(mode === 'live' ? { imageDataUrl: image } : {}),
      });
      setGuess(run.output);
      const room = roomOf(workScene);
      if (run.output.kind !== workScene && [room, viewOf(room)].includes(run.output.kind))
        setWorkScene(run.output.kind);
      setSelected(run);
      setMessage(`Scene guess saved: ${run.output.kind}. ${run.output.summary}`);
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'Scene guess failed.');
    } finally {
      setAsking(false);
    }
  }
  // A guess for another mode or room no longer applies.
  useEffect(() => setGuess(null), [mode]);
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
    setDrawer(true);
  }
  /** Why a saved probe can't be repeated right now, or null if it can. */
  function rerunBlock(run: EvidenceRun): string | null {
    if (!isProbe(run.kind)) return 'Only probes can be repeated. Use the inspector for desk steps.';
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
  return {
    now,
    mode,
    status,
    runs,
    image,
    dimensions,
    scene,
    segmentation,
    memory,
    segmentRunId,
    draftZone,
    setDraftZone,
    drawing,
    setDrawing,
    zoneStart,
    concept,
    setConcept,
    fixturePosition,
    deskSvg,
    overlay,
    setOverlay,
    showTrail,
    setShowTrail,
    showZones,
    setShowZones,
    stageView,
    setStageView,
    workScene,
    setWorkScene,
    choosingScene,
    setChoosingScene,
    selection,
    select,
    outlineOpen,
    setOutlineOpen,
    isoPanel,
    setIsoPanel,
    modelOf,
    isoSurfaceId,
    setIsoSurfaceId,
    ruleDraft,
    setRuleDraft,
    guess,
    asking,
    askGuess,
    sceneLabel,
    pinning,
    setPinning,
    autoPin,
    busy,
    issue,
    setIssue,
    error,
    setError,
    message,
    setMessage,
    selected,
    setSelected,
    logKind,
    setLogKind,
    logMode,
    setLogMode,
    failuresOnly,
    setFailuresOnly,
    logLimit,
    setLogLimit,
    drawer,
    setDrawer,
    lamp,
    camera,
    cameraPending,
    video,
    network,
    cameraSource,
    setCameraSource,
    file,
    follow,
    followView,
    followStats,
    undo,
    redo,
    setMemory,
    refresh,
    savedAt,
    storageOk,
    saveNow,
    stepHistory,
    exportSave,
    importFile,
    importSave,
    showKeys,
    setShowKeys,
    resetToDemo,
    stopFollow,
    stopCamera,
    changeMode,
    captureCanvas,
    moveFixtureMug,
    upload,
    startCamera,
    costNote,
    execute,
    track,
    startFollow,
    deskAction,
    currentObservation,
    observationStale,
    zone,
    localZone,
    visibleZone,
    sightings,
    verdictFor,
    trail,
    zonePoint,
    metaReady,
    lampReady,
    spendShare,
    spendTone,
    limitDraft,
    setLimitDraft,
    saveSpendLimit,
    canVision,
    canTrack,
    proofCount,
    confirmedId,
    progress,
    lights,
    pickScene,
    goToStep,
    openModel,
    editLayout,
    startRule,
    capsuleTone,
    filteredRuns,
    logStats,
    inspect,
    rerunBlock,
    rerun,
    canRestore,
    restore,
    copyRun,
    sorted,
  };
}
export type Lab = ReturnType<typeof useLabState>;
