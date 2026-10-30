import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type {
  EvidenceRun,
  LabStatus,
  Mode,
  Scene,
  Segmentation,
  Detection,
  FixtureDraft,
  MappedThing,
  PictureFind,
  Job,
  LampResult,
  DeskMemory,
  ZoneRect,
  PlacementDecision,
  RunKind,
  DeskObservation,
  DemoPosition,
  LocalTrack,
  LocalVerdict,
  LumaFrame,
  UnitBox,
  IsoSceneKind,
  Quad,
  SceneGuess,
  SavedItem,
  FixtureInput,
  WatchView,
} from '@livinglayer/domain';
import {
  DEMO_POSITIONS,
  DEMO_LIGHTS,
  DEMO_SWITCHES,
  OBSERVATION_MAX_AGE_MS,
  ISO_PRESETS,
  cameraForScene,
  fixtureAt,
  fixtureBox,
  fixtureInput,
  runCost,
  startLocalTrack,
  moveDemoMug,
  stepLocalTrack,
  toLuma,
  zoneApplies,
} from '@livinglayer/domain';
import { api, ApiError } from '../api';
import { openMjpeg, openStream, useNetworkStreams, type NetworkStream } from '../streams';
import { useExpose, useWatch } from '../watch';
import { usd } from '../cost';
import { takeHandoff } from '../handoff';
import type { Issue } from '../ProviderUi';
import type { FixturePlacing, IsoPanel, RuleDraft } from '../iso/IsoView';
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
import { lightStates } from './labels';
import {
  parseSelection,
  roomOf,
  sceneProgress,
  selectionForStep,
  selectionHash,
  viewLabel,
  viewOf,
  type Selection,
  type StepId,
  type WorkScene,
} from './progress';
import { sceneOf } from './labels';
import type { Tool } from './ToolStrip';

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
  illustrate: 'Drawing the room',
  camera: 'Updating the camera setting',
  undo: 'Undoing',
  redo: 'Redoing',
  restore: 'Loading the save',
};
/** A long AI action the dialog follows: its job's steps and how it ended. */
export interface AiTask {
  title: string;
  description?: string;
  jobId: string;
  job: Job | null;
  status: 'running' | 'done' | 'failed' | 'stopped';
  error?: string;
  /** Shown; hiding it lets the action go on. */
  open: boolean;
  startedAt: number;
  /** A past action opened to look back at, not one running now. */
  review?: boolean;
}
/** A job as it shows once stopped: what was running or waiting is stopped. */
function stoppedJob(job: Job): Job {
  return {
    ...job,
    stopped: true,
    done: true,
    steps: job.steps.map((s) =>
      s.state === 'running' || s.state === 'waiting' ? { ...s, state: 'stopped' } : s,
    ),
  };
}
export const TRANSITION: Record<NonNullable<PlacementDecision['transition']>, string> = {
  entered: 'Entered the zone',
  stayed_inside: 'Still inside',
  left: 'Left the zone',
  stayed_outside: 'Still outside',
};
/** Redraw the demo desk with the mug, its coffee and its shadow moved together. */
export function demoDesk(svg: string, position: DemoPosition): string {
  const { dx, dy } = DEMO_POSITIONS[position];
  if (!dx && !dy) return '/desk.svg';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(moveDemoMug(svg, position))}`;
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
/** Times a wanted camera is tried again before waiting for the person, after it dropped. */
const REOPEN_TRIES = 4;
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
  'illustration',
  'item',
  'fixture',
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
  !d.rules?.length &&
  !d.fixtures?.length;
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
    case 'fixture': {
      // A scan maps several things, a picture find locates them, and a draft models one.
      if (run.output && typeof run.output === 'object' && 'sculpted' in run.output) {
        const o = run.output as unknown as { label: string; parts: number; iou: number };
        return `${o.label} modelled with AI · ${o.parts} parts · overlap ${Math.round(o.iou * 100)}%`;
      }
      if (run.output && typeof run.output === 'object' && 'found' in run.output) {
        const { found } = run.output as PictureFind;
        return `found on the picture · ${found.filter((f) => f.seen).length} of ${found.length}`;
      }
      if (run.output && typeof run.output === 'object' && 'mapped' in run.output) {
        const { mapped } = run.output as { mapped: MappedThing[] };
        const added = mapped.filter((m) => m.fixture).length;
        return `scan · ${mapped.length} found · ${added} added${mapped.length ? `: ${mapped.map((m) => m.label).join(', ')}` : ''}`;
      }
      const f = run.output as FixtureDraft;
      if (!f?.model) return '';
      return `${f.label} · ${f.model.parts.length} parts · looks like ${f.suggested === 'none' ? 'just a thing' : `a ${f.suggested}`}`;
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
  const [demoPosition, setDemoPosition] = useState<DemoPosition>(
    boot.prefs.demoPosition in DEMO_POSITIONS
      ? (boot.prefs.demoPosition as DemoPosition)
      : 'centre',
  );
  const [deskSvg, setDeskSvg] = useState('');
  const [overlay, setOverlay] = useState(boot.prefs.overlay);
  const [showTrail, setShowTrail] = useState(boot.prefs.trail);
  const [showPicture, setShowPicture] = useState(boot.prefs.picture);
  const [fixtureLook, setFixtureLook] = useState(boot.prefs.fixtureLook);
  const [showZones, setShowZones] = useState(boot.prefs.zones);
  const [stageView, setStageView] = useState<StageView>(boot.prefs.stageView);
  // What a drag on the canvas does.
  const [tool, setTool] = useState<Tool>(boot.prefs.tool);
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
  // An editor reopens only beside what it edits: the layout with the room, a model with its thing.
  const [isoPanel, setIsoPanel] = useState<IsoPanel>(() => {
    const kind = selection?.kind;
    const fits =
      boot.prefs.isoPanel === 'scene'
        ? kind === 'room'
        : boot.prefs.isoPanel === 'item'
          ? kind === 'object' || kind === 'fixture'
          : true;
    return fits ? boot.prefs.isoPanel : 'room';
  });
  // On phones the outline is a sheet that slides up over the page.
  const [outlineOpen, setOutlineOpen] = useState(boot.prefs.outlineOpen);
  const [modelOf, setModelOf] = useState<string | undefined>(boot.prefs.modelOf || undefined);
  const [isoSurfaceId, setIsoSurfaceId] = useState<string | undefined>(
    boot.prefs.isoSurfaceId || undefined,
  );
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  /** A fixture waiting for a click in the iso room that says where it stands. */
  const [placing, setPlacing] = useState<FixturePlacing | null>(null);
  /** A box being drawn around a thing on the desk photo, to draft a fixture from. */
  const [boxing, setBoxing] = useState<{ rect: ZoneRect | null } | null>(null);
  const [guess, setGuess] = useState<SceneGuess | null>(null);
  const sceneLabel =
    workScene === 'custom'
      ? (memory?.scene?.label ?? 'Custom')
      : workScene === 'custom-desk'
        ? viewLabel(workScene)
        : workScene && ISO_PRESETS[workScene].label;
  // A removed custom scene, or one this mode doesn't have, means choosing again;
  // a room whose desk was taken out has no desk view left.
  useEffect(() => {
    if ((workScene === 'custom' || workScene === 'custom-desk') && memory && !memory.scene)
      setWorkScene(null);
    else if (workScene === 'custom-desk' && memory && !viewOf('custom', memory))
      setWorkScene('custom');
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
  const light = () => setLamp(mode === 'demo' ? 'virtual' : 'live');
  const [camera, setCamera] = useState(false);
  const [cameraPending, setCameraPending] = useState(false);
  const cameraGeneration = useRef(0);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const closeNetwork = useRef<(() => void) | null>(null);
  const network = useNetworkStreams();
  /** '' for this device's camera, else the id of a network camera. */
  const [cameraSource, setCameraSource] = useState(boot.prefs.cameraSource);
  /** The camera should be on: set when one opens, cleared only when the person stops it. */
  const [cameraWanted, setCameraWanted] = useState(boot.prefs.cameraOn);
  /** Reopens tried since the camera last opened; they stop after a few failures. */
  const [reopenTries, setReopenTries] = useState(0);
  const [tracking, setTracking] = useState(boot.prefs.tracking);
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
  // The server's watcher: it follows things and fires rules with no tab open; this shows it.
  const watch = useWatch(mode);
  const watching = Boolean(watch?.on);
  // Entities shown in Home Assistant over MQTT, with their states.
  const expose = useExpose(mode);
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
  const undo = useRef<Record<Mode, DeskMemory[]>>({ demo: [], live: [] });
  const redo = useRef<Record<Mode, DeskMemory[]>>({ demo: [], live: [] });
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
    const [nextStatus, nextRuns, demoDesk, liveDesk] = await Promise.all([
      api<LabStatus>('status'),
      api<EvidenceRun[]>('runs'),
      api<DeskMemory>('desk/demo'),
      api<DeskMemory>('desk/live'),
    ]);
    setStatus(nextStatus);
    setRuns(nextRuns);
    if (started === memoryWrites.current) setMemories({ demo: demoDesk, live: liveDesk });
    return { demo: demoDesk, live: liveDesk };
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
    picture: showPicture,
    fixtureLook,
    concept,
    demoPosition,
    cameraSource,
    cameraOn: cameraWanted,
    tracking,
    drawer,
    tool,
    isoPanel,
    modelOf: modelOf ?? '',
    isoSurfaceId: isoSurfaceId ?? '',
    outlineOpen,
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
    // A hot reload that remounts the lab reads the save again, so it must be current too.
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
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
      for (const m of ['demo', 'live'] as const) {
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
      setShowPicture(next.picture);
      setFixtureLook(next.fixtureLook);
      setConcept(next.concept);
      if (next.demoPosition in DEMO_POSITIONS) setDemoPosition(next.demoPosition as DemoPosition);
      setCameraSource(next.cameraSource);
      setCameraWanted(next.cameraOn);
      setReopenTries(0);
      setTracking(next.tracking);
      setDrawer(next.drawer);
      setTool(next.tool);
      setIsoSurfaceId(next.isoSurfaceId || undefined);
      setOutlineOpen(next.outlineOpen);
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
      if (placing) return setPlacing(null);
      if (boxing) return setBoxing(null);
      if (isoPanel !== 'room') return setIsoPanel('room');
      if (choosingScene && workScene) return setChoosingScene(false);
      if (tool !== 'select') return setTool('select');
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
    if (action === 'select' || action === 'scale' || action === 'hand') setTool(action);
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
        for (const m of ['demo', 'live'] as const) {
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
  /** Close the camera but keep it wanted, so it opens again once it can (back in live mode, the stream back). */
  const dropCamera = () => {
    stopFollow();
    cameraGeneration.current++;
    releaseStream();
    setCamera(false);
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
  const sceneUrl = (position: DemoPosition) =>
    deskSvg ? demoDesk(deskSvg, position) : '/desk.svg';
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
          await upload(new File([blob], 'camera.png', { type: 'image/png' }));
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
      const opened = remote
        ? remote.whep
          ? await openStream(remote.whep, lost)
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
    if (camera && video.current && stream.current) {
      video.current.srcObject = stream.current;
      void video.current
        .play()
        .catch(() => setError('Camera playback failed. Stop the camera and try an upload.'));
    }
  }, [camera]);
  // A camera that was on and wasn't stopped by the person opens again: after a reload,
  // back in live mode, or once a dropped stream can be reached. A few tries, further apart each time.
  useEffect(() => {
    if (mode !== 'live' || !cameraWanted || camera || cameraPending || busy || pinning) return;
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
    deskReady,
    reopenTries,
    cameraSource,
    network.loaded,
    network.streams,
  ]);
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
        ...(kind === 'segment' && mode === 'demo' ? { demoPosition } : {}),
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
          : `${mode === 'demo' ? 'Demo' : 'Live'} ${kind} probe saved · ${run.durationMs} ms${costNote(run)}.`,
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
    return `${mode === 'demo' ? 'Virtual' : 'Live'} placement: ${moved}${o.reason} Lamp: ${o.action}.${o.error ? ` ${o.error.message}` : ''}`;
  }
  /**
   * One tracking step: take the current frame (capturing from the camera if it
   * is running), segment the mug, let the server match it to the remembered
   * mug, and verify the zone. One SAM call in live mode. Returns the frame it
   * used, so local following can restart from SAM's box on the same pixels.
   */
  async function track({ keepCamera = false, position = demoPosition } = {}) {
    setBusy('track');
    setError('');
    try {
      let frame = mode === 'demo' ? sceneUrl(position) : image;
      if (mode === 'live' && camera && video.current?.videoWidth) {
        frame = captureCanvas(video.current, video.current.videoWidth, video.current.videoHeight);
        if (!keepCamera) stopCamera();
      }
      const run = await api<EvidenceRun<Segmentation>>('segment', {
        mode,
        concept: 'mug',
        ...(mode === 'demo' ? { demoPosition: position } : { imageDataUrl: frame }),
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
  // A room with a camera assigned to it uses that camera, unless the one chosen is assigned there too.
  useEffect(() => {
    if (camera) return;
    const room = workScene === 'custom-desk' ? 'custom' : workScene;
    const current = network.streams.filter((s) => s.id === cameraSource);
    if (cameraForScene(current, room)) return;
    const assigned = cameraForScene(network.streams, room);
    if (assigned) setCameraSource(assigned.id);
  }, [workScene, network.streams]);
  /** The selected network camera, when the server can read it too (it offers RTSP). */
  const watchCamera = network.streams.find((s) => s.id === cameraSource && s.rtsp);
  /** Whether the server can watch this mode's camera: always in the demo, else an RTSP camera. */
  const canWatch = mode === 'demo' || Boolean(watchCamera) || Boolean(watch?.camera);
  async function toggleWatch() {
    setError('');
    try {
      const on = !watching;
      if (on) stopFollow();
      const view = await api<WatchView>('watch', {
        mode,
        on,
        ...(on && mode === 'live' && watchCamera ? { streamId: watchCamera.id } : {}),
      });
      setMessage(
        on
          ? `The server is watching${view.camera ? ` ${view.camera.name}` : ' the illustrated desk'}. Rules fire on SAM’s answer, with or without this tab.`
          : 'The server stopped watching. Rules fire only when you track by hand.',
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not change watching.');
    }
  }
  // What the watcher's SAM checks changed (sightings, verdicts, a lamp) shows once it lands.
  const seenChecks = useRef(0);
  useEffect(() => {
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
  }, [watch?.checks]);
  // A fixture marked missing (or found again) changes how the room draws it.
  const missingFixtures = (watch?.things ?? []).filter(
    (t) => t.kind === 'fixture' && t.status === 'missing',
  ).length;
  useEffect(() => {
    if (watch) void refresh().catch(() => {});
  }, [missingFixtures]);
  /** The frame to look in: the camera's, captured now, or the current photo; the demo desk itself in demo mode. */
  function frameNow(): string | undefined {
    if (mode === 'demo') return undefined;
    if (camera && video.current?.videoWidth)
      return captureCanvas(video.current, video.current.videoWidth, video.current.videoHeight);
    return image;
  }
  /** Look for a fixture where it should stand in the camera's view; its outlines show for confirming. */
  async function findFixture(id: string) {
    setBusy('find-fixture');
    setError('');
    try {
      const imageDataUrl = frameNow();
      if (mode === 'live' && !imageDataUrl)
        throw new Error('Start the camera or add a photo of the desk to look in.');
      const run = await api<EvidenceRun<Segmentation>>('fixtures/find', {
        mode,
        id,
        ...(imageDataUrl ? { imageDataUrl } : {}),
      });
      setSegmentation(run.output);
      setSegmentRunId(run.id);
      setMessage(
        run.output.detections.length
          ? `Found ${run.output.detections.length} outline${run.output.detections.length === 1 ? '' : 's'}${costNote(run)}. Confirm which one it is.`
          : `SAM found nothing where it should stand${costNote(run)}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not look for it.');
    } finally {
      setBusy('');
      void refresh().catch(() => {});
    }
  }
  async function anchorFixture(id: string, detectionId: string) {
    if (!segmentRunId) return;
    setBusy('anchor-fixture');
    setError('');
    try {
      const next = await api<DeskMemory>('fixtures/anchor', {
        mode,
        id,
        segmentRunId,
        detectionId,
      });
      setMemory(next);
      setMessage(
        watching
          ? 'Confirmed. The server follows it from now on.'
          : 'Confirmed. Watch on the server to follow it from now on.',
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not confirm it.');
    } finally {
      setBusy('');
    }
  }
  async function untrackFixture(id: string) {
    setError('');
    try {
      setMemory(await api<DeskMemory>('fixtures/untrack', { mode, id }));
      setMessage('No longer followed. It stays where it was last seen.');
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not stop following it.');
    }
  }
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
    Boolean(workScene) && !busy && (mode === 'demo' || (metaReady && Boolean(image)));
  const canTrack =
    Boolean(workScene) &&
    !busy &&
    !follow &&
    Boolean(memory?.object && memory.observation) &&
    (mode === 'demo' || (metaReady && (Boolean(image) || camera)));
  const proofCount = status ? Object.values(status.liveEvidence).filter(Boolean).length : 0;
  const confirmedId = currentObservation?.detectionId;
  const progress = sceneProgress({ mode, workScene, memory });
  const lights = mode === 'demo' ? DEMO_LIGHTS : (status?.lamp.lights ?? []);
  /** Each light's last confirmed state in this mode, for lamps that glow. */
  const lightsOn = new Set(
    [...lightStates(memory, runs)].filter(([, s]) => s === 'on').map(([entity]) => entity),
  );
  /** What a rule or a fixture may switch: the lights, then the switches. */
  const entities = [
    ...lights,
    ...(mode === 'demo' ? DEMO_SWITCHES : (status?.lamp.switches ?? [])),
  ];
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
        mode === 'demo'
          ? 'Draft the room from the demo photo, review it, then save.'
          : 'Upload a photo of the room. Spark lists what is in it and SAM outlines it.',
      );
      return;
    }
    setIsoPanel('room');
    const after = sceneProgress({ mode, workScene: next, memory });
    setSelection(after.next ? selectionForStep(after.next, memory) : { kind: 'room' });
    const label =
      next === 'custom'
        ? 'your own scene'
        : `the ${(next === 'custom-desk' ? viewLabel(next) : ISO_PRESETS[next].label).toLowerCase()}`;
    setMessage(
      after.next === 'desk'
        ? `Working in ${label}. Next, get close to the desk and pin its top.`
        : `Working in ${label}. Next, find the mug on the desk.`,
    );
  }
  /** Leave the demo to draft the office from a photo of your own: Live, then the photo draft. */
  function draftOwnPhoto() {
    if (mode !== 'live') changeMode('live');
    pickScene('office', 'photo');
    setMessage(
      'Live: upload a photo of your office. Spark lists what is in it and SAM outlines it.',
    );
  }
  /** Show one node of the outline, and move the canvas to the scene it is in. */
  function select(next: Selection | null) {
    setOutlineOpen(false);
    if (next?.kind !== 'new-rule') setRuleDraft(null);
    if (next?.kind !== 'new-fixture' && next?.kind !== 'fixture') setPlacing(null);
    if (next?.kind !== 'new-fixture') setBoxing(null);
    if (next?.kind === 'lamp') setWorkScene(next.id.split('~')[0] as WorkScene);
    if (next?.kind === 'fixture') {
      const f = memory?.fixtures?.find((x) => x.id === next.id);
      if (f) setWorkScene(f.scene);
    }
    if (next?.kind === 'room' && progress.room) setWorkScene(progress.room);
    if (next?.kind === 'view' && progress.view) setWorkScene(progress.view);
    if (next?.kind === 'surface') {
      setIsoSurfaceId(next.id);
      const inView =
        progress.view && sceneOf(progress.view, memory)?.surfaces.some((x) => x.id === next.id);
      if (progress.room) setWorkScene(inView ? progress.view! : progress.room);
    }
    if (isoPanel === 'scene' && next?.kind !== 'room') setIsoPanel('room');
    if (isoPanel === 'item' && next?.kind !== 'object' && next?.kind !== 'fixture')
      setIsoPanel('room');
    setSelection(next);
  }
  function goToStep(id: StepId) {
    // A room already set up opens; only before one is there does the step choose.
    if (id === 'office' && !workScene) return setChoosingScene(true);
    select(selectionForStep(id, memory));
  }
  /** Open an object's model in the canvas. `undefined` is the mug. */
  function openModel(objectId?: string) {
    setModelOf(objectId);
    setIsoPanel('item');
    if (stageView === 'photo') setStageView('iso');
  }
  function editLayout() {
    // The layout is edited in the whole room, never in its desk view.
    if (workScene === 'custom-desk') setWorkScene('custom');
    setIsoPanel('scene');
    if (stageView === 'photo') setStageView('iso');
  }
  function startRule(objectId: string) {
    setRuleDraft({ objectId, entityId: entities[0] ?? '', label: '', rect: null });
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
  /** Show the desk photo and let the person box the thing a fixture is drafted from. */
  function startBoxing() {
    setBoxing({ rect: null });
    if (stageView === 'iso') setStageView('photo');
    setMessage('Drag a box around the thing on the desk photo. Esc cancels.');
  }
  /**
   * A long AI action shown step by step in its dialog: the job's steps as the
   * server reports them, kept after it ends until the dialog is closed.
   */
  const [aiTask, setAiTask] = useState<AiTask | null>(null);
  /** The action running now; a stop bumps the generation so its answer is dropped. */
  const aiGeneration = useRef(0);
  const aiRun = useRef<{ generation: number; jobId: string; abort: AbortController } | null>(null);
  const aiClose = useRef<ReturnType<typeof setTimeout>>(undefined);
  const updateAiTask = (jobId: string, change: Partial<AiTask>) =>
    setAiTask((t) => (t?.jobId === jobId ? { ...t, ...change } : t));
  /** Past AI actions, newest first, without their pictures: each is fetched to review. */
  const [aiHistory, setAiHistory] = useState<Job[]>([]);
  const loadAiHistory = () =>
    api<Job[]>('jobs')
      .then((list) => mounted.current && setAiHistory(list))
      .catch(() => {});
  useEffect(() => {
    void loadAiHistory();
  }, []);
  /** Open a past AI action in the dialog, read-only, to see what each step did. */
  async function reviewAiRun(jobId: string) {
    if (aiRun.current) return;
    clearTimeout(aiClose.current);
    const job = await api<Job>(`jobs/${jobId}`).catch(() => null);
    if (!job) return setError('That AI run is no longer kept.');
    setAiTask({
      title: job.title ?? 'AI run',
      jobId,
      job,
      status: job.outcome ?? (job.stopped ? 'stopped' : 'done'),
      error: job.error,
      open: true,
      startedAt: Date.parse(job.createdAt),
      review: true,
    });
  }
  /** Stop the running AI action: the server aborts its model call and saves nothing. */
  function stopAiTask() {
    const running = aiRun.current;
    if (!running) return;
    aiRun.current = null;
    aiGeneration.current++;
    const { jobId } = running;
    updateAiTask(jobId, { status: 'stopped' });
    setAiTask((t) => (t?.jobId === jobId && t.job ? { ...t, job: stoppedJob(t.job) } : t));
    setBusy('');
    setMessage(`Stopped: ${aiTask?.title.toLowerCase() ?? 'the AI call'}. Nothing was saved.`);
    // Tell the server first, then drop the request. The job may not be registered
    // yet in the first moments, so the stop is tried again briefly.
    void (async () => {
      for (let tries = 0; tries < 5; tries++) {
        const response = await fetch(`/api/jobs/${jobId}/stop`, { method: 'POST' }).catch(
          () => null,
        );
        if (response?.ok) {
          const job = (await response.json().catch(() => null)) as Job | null;
          if (job?.done && !job.stopped) {
            // It had already finished: what it saved stays, so show it.
            updateAiTask(jobId, { job, status: 'done' });
            setMessage('It had already finished, so the result was kept.');
            void refresh().catch(() => {});
          } else if (job) updateAiTask(jobId, { job });
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      running.abort.abort();
      void loadAiHistory();
    })();
  }
  /** Close the dialog; a running action is stopped first. */
  function closeAiTask() {
    if (aiRun.current) stopAiTask();
    clearTimeout(aiClose.current);
    setAiTask(null);
  }
  /**
   * Run an AI call that reports its steps under a job id, followed in the
   * dialog until it ends. Resolves to its answer, or null when it was stopped.
   */
  async function followAi<T>(
    task: Pick<AiTask, 'title' | 'description'>,
    call: (jobId: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T | null> {
    const generation = ++aiGeneration.current;
    const jobId = crypto.randomUUID();
    const abort = new AbortController();
    aiRun.current = { generation, jobId, abort };
    clearTimeout(aiClose.current);
    setAiTask({ ...task, jobId, job: null, status: 'running', open: true, startedAt: Date.now() });
    const current = () => mounted.current && generation === aiGeneration.current;
    let following = true;
    const poll = async () => {
      while (following && current()) {
        const job = await api<Job>(`jobs/${jobId}`).catch(() => null);
        if (job && following && current()) updateAiTask(jobId, { job });
        await new Promise((r) => setTimeout(r, 350));
      }
    };
    void poll();
    try {
      const result = await call(jobId, abort.signal);
      return current() ? result : null;
    } catch (e) {
      if (!current()) return null;
      updateAiTask(jobId, {
        status: 'failed',
        error: e instanceof Error ? e.message : 'It failed.',
      });
      throw e;
    } finally {
      following = false;
      if (current()) {
        aiRun.current = null;
        // The last word on every step, success or not.
        const job = await api<Job>(`jobs/${jobId}`).catch(() => null);
        setAiTask((t) =>
          t?.jobId !== jobId
            ? t
            : {
                ...t,
                job: job ?? t.job,
                status: t.status === 'running' ? 'done' : t.status,
              },
        );
        void loadAiHistory();
      }
    }
  }
  /**
   * Draw the photographed room as a picture from the current photo (one
   * image call and one SAM call, live), and show it, step by step in the
   * AI dialog, where it can be stopped.
   */
  async function illustrate(view: 'room' | 'desk' = 'room') {
    if (busy) return;
    setBusy('illustrate');
    setError('');
    let ok = false;
    try {
      const result = await followAi(
        {
          title: view === 'desk' ? 'Drawing the desk' : 'Drawing the room',
          description:
            mode === 'live'
              ? view === 'desk'
                ? 'Muse Image redraws this frame in the room’s style. One image call, about $0.01.'
                : 'Muse Image redraws the photo, then SAM finds the desk on it. About $0.02.'
              : 'Demo: the bundled pictures, no model calls.',
        },
        (jobId, signal) =>
          api<{
            run: EvidenceRun;
            segment: EvidenceRun<Segmentation> | null;
            memory: DeskMemory;
          }>(
            'scene/illustrate',
            {
              mode,
              view,
              jobId,
              // The room is redrawn from its own photo (the last picture's, else this one); the desk from this frame.
              ...(mode === 'live' &&
              (view === 'desk' || !(memory?.scenePhoto || memory?.illustration))
                ? { imageDataUrl: image }
                : {}),
            },
            { signal },
          ),
      );
      if (!result) return;
      ok = true;
      setMemory(result.memory);
      setSelected(result.run);
      setShowPicture(true);
      if (stageView === 'photo') setStageView('iso');
      setMessage(
        view === 'desk'
          ? `Drew the desk from this frame${costNote(result.run)}. Sightings in frames this size show on it.`
          : result.memory.illustration?.desk
            ? `Drew the room as a picture${costNote(result.run)}. The mug and zones sit on its desk.`
            : `Drew the room as a picture${costNote(result.run)}, but SAM found no desk in it, so nothing can be placed on it.`,
      );
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The room could not be drawn.');
    } finally {
      // A stop has already freed the lab for the next call.
      if (!aiRun.current) setBusy((b) => (b === 'illustrate' ? '' : b));
      // A clean finish closes itself after a moment to look at it.
      if (ok) aiClose.current = setTimeout(() => setAiTask(null), 2200);
    }
  }
  /**
   * Lift the room's fixtures off its picture, so dragging one moves the thing
   * itself (one SAM call and one image call, live), or put them back.
   */
  async function separate(back = false) {
    if (busy) return;
    setBusy('separate');
    setError('');
    try {
      if (back) {
        const result = await api<{ memory: DeskMemory }>('scene/separate/undo', { mode });
        setMemory(result.memory);
        setMessage('The fixtures are back in the picture.');
        return;
      }
      const result = await api<{
        run: EvidenceRun;
        memory: DeskMemory;
        lifted: number;
        skipped: string[];
      }>('scene/separate', { mode });
      setMemory(result.memory);
      setSelected(result.run);
      setShowPicture(true);
      if (stageView === 'photo') setStageView('iso');
      setMessage(
        `Lifted ${result.lifted} fixture${result.lifted === 1 ? '' : 's'} off the picture${costNote(result.run)}. Drag one to move it.` +
          (result.skipped.length
            ? ` Not lifted, as they couldn’t be outlined cleanly: ${result.skipped.join(', ').toLowerCase()}.`
            : ''),
      );
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The fixtures could not be lifted off the picture.');
    } finally {
      setBusy('');
    }
  }
  /**
   * Modelling a fixture with AI, step by step: the job's steps as the server
   * reports them while the call runs, kept after it ends until another starts.
   */
  const [sculpting, setSculpting] = useState<{ fixtureId: string; job: Job | null } | null>(null);
  /** Rebuild a fixture's model with Spark from the picture of it, then open it to edit. */
  async function sculptFixture(id: string) {
    if (busy) return;
    const f = memory?.fixtures?.find((x) => x.id === id);
    if (!f) return;
    const jobId = crypto.randomUUID();
    setBusy('sculpt');
    setError('');
    setSculpting({ fixtureId: id, job: null });
    // Poll the job while the request is open; each answer replaces the last.
    let open = true;
    const follow = async () => {
      while (open) {
        await new Promise((r) => setTimeout(r, 700));
        const job = await api<Job>(`jobs/${jobId}`).catch(() => null);
        if (job && open) setSculpting({ fixtureId: id, job });
      }
    };
    void follow();
    try {
      const result = await api<{ run: EvidenceRun; memory: DeskMemory }>('fixtures/sculpt', {
        mode,
        fixtureId: id,
        jobId,
      });
      setMemory(result.memory);
      setSelected(result.run);
      const out = result.run.output as { parts: number; note: string };
      setMessage(
        `Modelled the ${f.label.toLowerCase()} in ${out.parts} parts${costNote(result.run)}. ${out.note} Edit it here; undo puts the old model back.`,
      );
      openModel(id);
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The fixture could not be modelled.');
    } finally {
      open = false;
      // The last word on every step, success or not.
      // Refused before it began (no picture, the spend limit), there are no steps to show.
      const job = await api<Job>(`jobs/${jobId}`).catch(() => null);
      setSculpting(job ? { fixtureId: id, job } : null);
      setBusy('');
    }
  }
  /** Show the room a fixture goes in, and wait for a click there to put it down. */
  function startPlacing(next: FixturePlacing) {
    setPlacing(next);
    setWorkScene(next.scene);
    setIsoPanel('room');
    if (stageView === 'photo') setStageView('iso');
    setMessage(
      `Click where the ${next.label.toLowerCase()} stands: on a surface or the floor. Esc cancels.`,
    );
  }
  /**
   * Save a placed fixture with some of it changed by hand: where it stands,
   * its size, or handing its place back to scans. Moving it keeps its
   * footprint's centre on the point, on that surface or the floor.
   */
  async function updateFixture(
    id: string,
    change: {
      centre?: { x: number; y: number };
      surfaceId?: string | null;
      size?: FixtureInput['size'];
      scanned?: boolean;
    },
    done: string,
  ) {
    const f = memory?.fixtures?.find((x) => x.id === id);
    if (!f) return;
    const next: FixtureInput = {
      ...fixtureInput(f),
      ...(change.size ? { size: change.size } : {}),
    };
    if (change.centre || change.surfaceId !== undefined || change.size) {
      const { at, size } = fixtureBox(f, memory?.scene);
      const centre = change.centre ?? { x: at.x + size.w / 2, y: at.y + size.d / 2 };
      const spot = fixtureAt(
        next,
        centre,
        change.surfaceId !== undefined ? change.surfaceId : f.surfaceId,
        memory?.scene ?? null,
      );
      if (spot) Object.assign(next, spot);
    }
    setError('');
    try {
      const m = await api<DeskMemory>('fixtures/save', {
        mode,
        fixture: { ...next, ...(change.scanned ? { scanned: true } : {}) },
      });
      setMemory(m);
      setMessage(done);
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The fixture could not be saved.');
    }
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
    // The corners are dragged on a still photo, not the live camera.
    if (camera) stopCamera();
    const fits =
      image && dimensions.width === pin.frame.width && dimensions.height === pin.frame.height;
    if (!fits) {
      if (pin.scene !== 'custom') {
        setError(
          `Load a ${pin.frame.width} × ${pin.frame.height} frame from the pinned camera first; the corners are checked on it.`,
        );
        return;
      }
      try {
        const res = await fetch(`/api/scene/photo?mode=${mode}`);
        if (!res.ok) throw new Error('This room has no photo of its own kept.');
        const bitmap = await createImageBitmap(await res.blob());
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
  /** Save the fixture being placed where the person clicked, and select it. */
  async function placeFixture(where: { at: { x: number; y: number }; surfaceId: string | null }) {
    if (!placing) return;
    setError('');
    try {
      const m = await api<DeskMemory>('fixtures/save', {
        mode,
        fixture: { ...placing, ...where },
      });
      setMemory(m);
      setPlacing(null);
      const saved = placing.id ? m.fixtures?.find((f) => f.id === placing.id) : m.fixtures?.at(-1);
      setMessage(`${placing.id ? 'Moved' : 'Placed'} the ${placing.label.toLowerCase()}.`);
      if (saved) setSelection({ kind: 'fixture', id: saved.id });
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The fixture could not be placed.');
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
      if (run.output.kind !== workScene && [room, viewOf(room, memory)].includes(run.output.kind))
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
   * screen now: always for the demo, and for a live photo when its source
   * hash matches the mask already showing.
   */
  function canRestore(run: EvidenceRun): boolean {
    if (busy || camera || run.mode !== mode || run.status === 'failed') return false;
    if (run.kind === 'discover') return mode === 'demo';
    if (run.kind !== 'segment') return false;
    const key = (run.output as Segmentation).sourceKey;
    return mode === 'demo' || (Boolean(key) && key === segmentation?.sourceKey);
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
    demoPosition,
    deskSvg,
    overlay,
    setOverlay,
    showTrail,
    setShowTrail,
    showZones,
    setShowZones,
    showPicture,
    setShowPicture,
    tracking,
    setTracking,
    stageView,
    setStageView,
    workScene,
    setWorkScene,
    choosingScene,
    setChoosingScene,
    tool,
    setTool,
    fixtureLook,
    setFixtureLook,
    separate,
    sculptFixture,
    sculpting,
    setSculpting,
    aiTask,
    setAiTask,
    aiHistory,
    reviewAiRun,
    stopAiTask,
    closeAiTask,
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
    placing,
    setPlacing,
    boxing,
    setBoxing,
    startBoxing,
    startPlacing,
    placeFixture,
    updateFixture,
    adjustPin,
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
    watch,
    watching,
    expose,
    canWatch,
    toggleWatch,
    findFixture,
    anchorFixture,
    untrackFixture,
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
    moveDemoMug,
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
    lightsOn,
    entities,
    pickScene,
    draftOwnPhoto,
    illustrate,
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
