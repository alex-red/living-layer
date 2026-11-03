import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type {
  IsoScene,
  Fixture,
  EvidenceRun,
  LabStatus,
  Mode,
  Scene,
  RoomMarks,
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
  CameraCrop,
} from '@livinglayer/domain';
import {
  DEMO_CAMERA,
  DEMO_POSITIONS,
  DEMO_LIGHTS,
  DEMO_SWITCHES,
  ISO_PRESETS,
  cameraForScene,
  closeViewOf,
  fixtureAt,
  fixtureBox,
  inRoomView,
  fixtureInput,
  runCost,
  startLocalTrack,
  stepLocalTrack,
  toLuma,
  zoneApplies,
  cropWithin,
  groupInFrame,
} from '@livinglayer/domain';
import { api, ApiError } from '../api';
import { useBrush } from './useBrush';
import {
  cropStream,
  openMjpeg,
  openStream,
  useNetworkStreams,
  type NetworkStream,
} from '../streams';
import { useExpose, useWatch } from '../watch';
import { usd } from '../cost';
import { takeHandoff } from '../handoff';
import type { Issue } from '../ProviderUi';
import type { DraftZone, FixturePlacing, IsoPanel, RuleDraft } from '../iso/IsoView';
import type { CalibrationDraft } from '../iso/RoomCalibrate';
import {
  clearSession,
  downloadSave,
  emptyDesk,
  parseSave,
  prefsOf,
  readSaves,
  readSession,
  readUi,
  saveName,
  withSave,
  writeSaves,
  writeSession,
  writeUi,
  type NamedSave,
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
import { demoFrameUrl } from './demoFrame';
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
  scan: 'Scanning and mapping',
  reapply: 'Applying the model again',
  camera: 'Updating the camera setting',
  undo: 'Undoing',
  revert: 'Reverting the AI run',
  redo: 'Redoing',
  restore: 'Loading the save',
};
/** A long AI action the dialog follows: its job's steps and how it ended. */
/** What calibrating by hand starts from: marks found so far, the room's size and the frame. */
interface HandCalibration {
  marks: RoomMarks | null;
  room: { w: number; d: number };
  heightCm?: number;
  frame: { width: number; height: number };
}
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
  /** What to do after it stopped short: the dialog stays open and offers it. */
  next?: { label: string; run: () => void };
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
  'assist',
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
      if (run.output && typeof run.output === 'object' && 'views' in run.output) {
        const o = run.output as unknown as { model: { label: string }; views: number; iou: number };
        return `${o.model.label} · another photo, ${o.views} views fused · ${Math.round(o.iou * 100)}% outline match`;
      }
      if (run.output && typeof run.output === 'object' && 'shaped' in run.output) {
        const o = run.output as unknown as { item: { label: string }; kept: boolean; iou: number };
        return `${o.item.label} · SAM 3D shape ${o.kept ? 'kept' : 'not kept'} · ${Math.round(o.iou * 100)}% outline match`;
      }
      const f = run.output as FixtureDraft;
      if (!f?.model) return '';
      return `${f.label} · ${f.model.parts.length} parts · looks like ${f.suggested === 'none' ? 'just a thing' : `a ${f.suggested}`}`;
    }
    case 'lamp':
      return `state ${(run.output as LampResult).state}`;
    case 'placement': {
      // What the zone saw happen, then what its light did.
      const p = run.output as PlacementDecision;
      const what = p.transition?.replace('_', ' ') ?? p.decision;
      const light = p.lamp
        ? `${p.lamp.entityId} ${p.lamp.action ?? 'on'}: ${p.action}`
        : p.action === 'none'
          ? 'no light switched'
          : `light ${p.action}`;
      return `${what} · ${light}`;
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
  // The size a frame captured from the running camera would be prepared at.
  const [cameraSize, setCameraSize] = useState<{ width: number; height: number } | null>(null);
  const [scene, setScene] = useState<Scene>();
  const [segmentation, setSegmentation] = useState<Segmentation>();
  const [memories, setMemories] = useState<Partial<Record<Mode, DeskMemory>>>({});
  const memory = memories[mode];
  const [segmentRunId, setSegmentRunId] = useState<string>();
  const [draftZone, setDraftZone] = useState<DraftZone>({
    x: 0.3,
    y: 0.2,
    width: 0.4,
    height: 0.6,
  });
  const [drawing, setDrawing] = useState(false);
  const zoneStart = useRef<{ x: number; y: number } | null>(null);
  const [concept, setConcept] = useState(boot.prefs.concept);
  const [demoPosition, setDemoPosition] = useState<DemoPosition>(
    boot.prefs.demoPosition in DEMO_POSITIONS
      ? (boot.prefs.demoPosition as DemoPosition)
      : 'centre',
  );
  const [overlay, setOverlay] = useState(boot.prefs.overlay);
  const [showTrail, setShowTrail] = useState(boot.prefs.trail);
  const [showPicture, setShowPicture] = useState(boot.prefs.picture);
  const [showCorner, setShowCorner] = useState(boot.prefs.corner);
  const [fixtureLook, setFixtureLook] = useState(boot.prefs.fixtureLook);
  const [showZones, setShowZones] = useState(boot.prefs.zones);
  const [stageView, setStageView] = useState<StageView>(boot.prefs.stageView);
  // What a drag on the canvas does.
  const [tool, setTool] = useState<Tool>(boot.prefs.tool);
  /** Choose a canvas tool; the AI brush draws on the camera's picture, so it shows it beside the room. */
  function chooseTool(next: Tool) {
    setTool(next);
    if (next === 'brush') setStageView((v) => (v === 'iso' ? 'split' : v));
  }
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
  /** A zoomed view being drawn over the live camera, as shares of what it shows now. */
  const [zooming, setZooming] = useState<{ rect: ZoneRect | null } | null>(null);
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
  const [calibrating, setCalibrating] = useState<CalibrationDraft | null>(null);
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
  /** The zoomed view of the camera that is open, and of the one the current frame came from. */
  const openCrop = useRef<CameraCrop | null>(null);
  const imageCrop = useRef<CameraCrop | null>(null);
  const network = useNetworkStreams();
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
  /** Edits, undos and redos so far; a named save notes the count it was saved or loaded at. */
  const edits = useRef(0);
  /** A new desk memory; an edit can be undone, a sighting (`undoable` false) can't. */
  const setMemory = (next: DeskMemory, undoable = true) => {
    const before = memories[next.mode];
    if (undoable && before && JSON.stringify(before) !== JSON.stringify(next)) {
      undo.current[next.mode] = [...undo.current[next.mode], before].slice(-UNDO_LIMIT);
      redo.current[next.mode] = [];
      edits.current++;
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
    corner: showCorner,
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
      edits.current++;
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
  function currentSave(name?: string): SessionSave {
    return {
      app: 'livinglayer',
      version: 1,
      savedAt: new Date().toISOString(),
      ...(name ? { name } : {}),
      prefs,
      desks: memories,
    };
  }
  // Named saves: the person's own copies in this browser, and the one they last saved or loaded.
  const [saves, setSaves] = useState<NamedSave[]>(readSaves);
  const [activeSaveId, setActiveSaveId] = useState(() => {
    const id = readUi('activeSave');
    return typeof id === 'string' ? id : '';
  });
  const activeSave = saves.find((s) => s.id === activeSaveId) ?? null;
  const savedEdits = useRef(0);
  /** Whether there are edits no named save holds, so loading another would lose them. */
  const unsaved = !activeSave || edits.current !== savedEdits.current;
  function markActive(entry: NamedSave | null) {
    setActiveSaveId(entry?.id ?? '');
    writeUi('activeSave', entry?.id ?? '');
    savedEdits.current = edits.current;
  }
  function storeSaves(list: NamedSave[]) {
    const ok = writeSaves(list);
    if (ok) setSaves(list);
    else
      setError(
        'This browser would not store the save. Delete an old save or export this one to a file.',
      );
    return ok;
  }
  /** Keep what's on the desks under a name; a name already used updates that save. */
  function saveAs(name: string) {
    const clean = saveName(name);
    if (!clean) return false;
    saveNow();
    const same = saves.find((s) => s.name.toLowerCase() === clean.toLowerCase());
    const entry: NamedSave = {
      id: same?.id ?? crypto.randomUUID(),
      name: clean,
      save: currentSave(clean),
    };
    if (!storeSaves(withSave(saves, entry))) return false;
    markActive(entry);
    setMessage(same ? `Updated “${clean}”.` : `Saved as “${clean}”.`);
    return true;
  }
  /** Put what's on the desks into an existing named save. */
  function updateSave(id: string) {
    const entry = saves.find((s) => s.id === id);
    if (!entry) return false;
    saveNow();
    const next = { ...entry, save: currentSave(entry.name) };
    if (!storeSaves(withSave(saves, next))) return false;
    markActive(next);
    return true;
  }
  function renameSave(id: string, name: string) {
    const clean = saveName(name);
    const entry = saves.find((s) => s.id === id);
    if (!clean || !entry) return false;
    const taken = saves.some((s) => s.id !== id && s.name.toLowerCase() === clean.toLowerCase());
    if (taken) {
      setError(`There is already a save called “${clean}”.`);
      return false;
    }
    return storeSaves(
      saves.map((s) => (s.id === id ? { ...s, name: clean, save: { ...s.save, name: clean } } : s)),
    );
  }
  function deleteSave(id: string) {
    const entry = saves.find((s) => s.id === id);
    if (!entry || !storeSaves(saves.filter((s) => s.id !== id))) return;
    if (id === activeSaveId) markActive(null);
    setMessage(`Deleted “${entry.name}”.`);
  }
  async function loadSave(id: string) {
    const entry = saves.find((s) => s.id === id);
    if (!entry) return;
    if (await applySave(entry.save, `Loaded “${entry.name}”.`)) markActive(entry);
  }
  function exportSave(id?: string) {
    saveNow();
    const entry = saves.find((s) => s.id === (id ?? activeSaveId));
    // The active save's name goes with what's on the desks now; another save goes as it was kept.
    downloadSave(id && entry ? entry.save : currentSave(entry?.name));
    setMessage(
      'Save exported. Import it here or in another browser to pick up where you left off.',
    );
  }
  const importFile = useRef<HTMLInputElement>(null);
  /** Load a save: its desks go to the server, its choices to this page. False when it failed. */
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
      setLastAiRun(null);
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
      setShowCorner(next.corner);
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
      return true;
    } catch (e) {
      setError(e instanceof Error ? e : 'The save could not be loaded.');
      return false;
    } finally {
      setBusy('');
    }
  }
  /** Load a save file, and keep it among the named saves under its own name or the file's. */
  async function importSave(chosen: File) {
    try {
      const save = parseSave(await chosen.text());
      const taken = new Set(saves.map((s) => s.name.toLowerCase()));
      const base = save.name || saveName(chosen.name.replace(/\.json$/i, '')) || 'Imported save';
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = saveName(`${base} (${n})`);
      const entry: NamedSave = { id: crypto.randomUUID(), name, save: { ...save, name } };
      if (!(await applySave(save, `Imported “${name}”.`))) return;
      if (writeSaves(withSave(saves, entry))) {
        setSaves(withSave(saves, entry));
        markActive(entry);
      }
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
      // A rule being changed goes back to its own panel.
      if (ruleDraft) return select(ruleDraft.id ? { kind: 'rule', id: ruleDraft.id } : null);
      if (placing) return setPlacing(null);
      if (boxing) return setBoxing(null);
      if (zooming) return setZooming(null);
      if (isoPanel !== 'room') return setIsoPanel('room');
      if (choosingScene && workScene) return setChoosingScene(false);
      if (brush.escape()) return;
      if (tool !== 'select') return setTool('select');
      return false;
    }
    if (action === 'save') return saveEverything();
    if (action === 'export') return exportSave();
    if (action === 'import') return importFile.current?.click();
    if (action === 'undo' || action === 'redo') return void stepHistory(action === 'undo');
    if (action === 'photo' || action === 'iso') {
      if (pinning) return false;
      setStageView(action);
      setIsoPanel('room');
      return;
    }
    if (action === 'delete') {
      // The layout editor deletes its own selection.
      if (selection?.kind !== 'fixture' || busy || pinning || placing || isoPanel === 'scene')
        return false;
      return void deleteFixtures([selection.id]);
    }
    if (action === 'scene' && !busy && !pinning) setChoosingScene(true);
    if (action === 'select' || action === 'scale' || action === 'hand') setTool(action);
    if (action === 'brush') chooseTool('brush');
  });
  /** The autosave, and the named save in use if there is one. */
  function saveEverything() {
    if (!saveNow()) return setMessage('This browser would not store the save.');
    if (activeSave && updateSave(activeSave.id)) return setMessage(`Saved “${activeSave.name}”.`);
    setMessage('Saved to this browser. Name a save to keep a copy you can load again.');
  }
  /** Clear both desks and this browser's autosave, keeping named saves; the menu asks first, as embedded browsers block confirm(). */
  async function resetToDemo() {
    clearSession();
    markActive(null);
    await applySave(
      { app: 'livinglayer', version: 1, savedAt: new Date().toISOString(), prefs: {}, desks: {} },
      'Reset to the demo. Choose a room to begin.',
    );
  }
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
        setMessage('Frame from the camera playground, prepared locally. Run a live step on it.');
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
  function costNote(run: EvidenceRun) {
    const cost = runCost(run);
    return cost === null ? '' : ` · ≈ ${usd(cost)}`;
  }
  async function execute(kind: 'text' | 'discover' | 'segment' | 'lamp', overrideConcept?: string) {
    // A running camera is looked at as it is now, not as it was last captured.
    const photo = ['discover', 'segment'].includes(kind) ? frameNow() : undefined;
    setBusy(kind);
    setError('');
    try {
      const run = await api<EvidenceRun>(kind, {
        mode,
        ...(photo ? { imageDataUrl: photo } : {}),
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
          : `${mode === 'demo' ? 'Demo' : 'Live'} ${kind} run saved ·${run.durationMs} ms${costNote(run)}.`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e : 'Call failed.');
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
        frame = captureCanvas(
          video.current,
          video.current.videoWidth,
          video.current.videoHeight,
          openCrop.current,
        );
        // Tracking or watching, the camera stays open: both follow the live feed.
        if (!keepCamera && !tracking && !watching) stopCamera();
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
  useEffect(() => {
    if (!watchedId) return;
    if (camera && cameraSource !== watchedId) dropCamera();
    setCameraSource(watchedId);
    setCameraWanted(true);
    setReopenTries(0);
  }, [watchedId]);
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
  /** Put one of a fixture's earlier drafts back as its model; the current one is kept. */
  async function chooseFixtureDraft(id: string, draft: number) {
    setBusy('fixture-draft');
    setError('');
    try {
      setMemory(await api<DeskMemory>('fixtures/choose', { mode, fixtureId: id, draft }));
      setMessage('Put that draft back. The one it replaced is kept among the earlier drafts.');
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not use that draft.');
    } finally {
      setBusy('');
    }
  }
  /**
   * Another photo of a fixture, fitted and fused with its model: a close one
   * of a thing the room's camera sees too small. The demo uses its own.
   */
  async function addFixturePhoto(id: string, imageDataUrl?: string) {
    setBusy('fixture-photo');
    setError('');
    try {
      const { run, memory: next } = await api<{
        run: EvidenceRun<{ views: number; iou: number }>;
        memory: DeskMemory;
      }>('fixtures/photo', { mode, fixtureId: id, ...(imageDataUrl ? { imageDataUrl } : {}) });
      setMemory(next);
      setMessage(
        `Fitted the photo and fused it with ${run.output.views - 1} earlier view${run.output.views === 2 ? '' : 's'}: ${Math.round(run.output.iou * 100)}% outline match${costNote(run)}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not fit the photo.');
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
  // Where a zone is drawn: the mug in this frame, or, on the running camera, its last sighting
  // from a frame the camera gives, since the stream shows that same view.
  const zoneObservation =
    currentObservation ??
    (camera &&
    memory?.observation &&
    memory.observation.frame.width === cameraSize?.width &&
    memory.observation.frame.height === cameraSize.height
      ? memory.observation
      : null);
  const zone = memory && zoneObservation ? zoneApplies(memory) : null;
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
    Boolean(workScene) && !busy && (mode === 'demo' || (metaReady && (Boolean(image) || camera)));
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
    if (next?.kind === 'lamp' || next?.kind === 'built-in')
      setWorkScene(next.id.split('~')[0] as WorkScene);
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
  /** Set up a rule counting one thing, or anything the camera follows. */
  function startRule(objectId?: string) {
    // A name to start from, so the zone can be saved as soon as it is drawn.
    const taken = new Set(memory?.rules?.map((r) => r.label));
    let n = (memory?.rules?.length ?? 0) + 1;
    while (taken.has(`Zone ${n}`)) n++;
    openRule({
      objects: objectId ? [objectId] : 'any',
      offWhenEmpty: false,
      entityId: entities[0] ?? '',
      label: `Zone ${n}`,
      rect: null,
    });
  }
  /** Open a saved rule in the rule builder: its zone dragged again, anything else changed. */
  function editRule(id: string) {
    const r = memory?.rules?.find((x) => x.id === id);
    if (!r) return;
    openRule({
      id: r.id,
      ...(r.fixtureId ? { fixtureId: r.fixtureId } : {}),
      objects: r.objects,
      offWhenEmpty: Boolean(r.offWhenEmpty),
      entityId: r.entityId ?? '',
      label: r.label,
      rect: r.zone.rect,
      ...(r.zone.onSurface ? { onSurface: r.zone.onSurface } : {}),
    });
  }
  function openRule(draft: RuleDraft) {
    setDrawing(false);
    setRuleDraft(draft);
    setIsoPanel('room');
    if (stageView === 'photo') setStageView('iso');
    setSelection({ kind: 'new-rule' });
  }
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
      const result = await api<{
        run: EvidenceRun<Segmentation> | null;
        pin: { corners: Quad; iou: number; frame: { width: number; height: number } } | null;
      }>('desk/auto-pin', { mode, surfaceId: target.surfaceId });
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
      const result = await api<{
        run: EvidenceRun<Segmentation>;
        marks: RoomMarks | null;
        frame: { width: number; height: number };
      }>('room/floor', { mode, ...(mode === 'live' ? { imageDataUrl: image } : {}) });
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
    if (aiTaskNow.current) {
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
        await api<DeskMemory>('room/keep', {
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
      const result = await api<{
        memory: DeskMemory;
        fit: { error: number; heightCm: number; hfovDeg: number };
      }>('room/calibrate', {
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
   * A long AI action shown step by step in its dialog: the job's steps as the
   * server reports them, kept after it ends until the dialog is closed.
   */
  const [aiTask, setAiTask] = useState<AiTask | null>(null);
  // The task as it is now, for handlers made before it started (a setup's error lands after).
  const aiTaskNow = useRef(aiTask);
  aiTaskNow.current = aiTask;
  /** The action running now; a stop bumps the generation so its answer is dropped. */
  const aiGeneration = useRef(0);
  const aiRun = useRef<{ generation: number; jobId: string; abort: AbortController } | null>(null);
  const aiClose = useRef<ReturnType<typeof setTimeout>>(undefined);
  const updateAiTask = (jobId: string, change: Partial<AiTask>) =>
    setAiTask((t) => (t?.jobId === jobId ? { ...t, ...change } : t));
  /** The last AI action that finished, with the desk from just before it, to revert to. */
  const [lastAiRun, setLastAiRun] = useState<{ jobId: string; desk: DeskMemory } | null>(null);
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
  /**
   * Put a past modelling run's model back on its fixture, as it was saved then
   * (no model call), and open it to edit; undo puts the model it replaces back.
   */
  async function reapplyAiRun(jobId: string) {
    if (busy) return;
    setBusy('reapply');
    setError('');
    try {
      const result = await api<{ memory: DeskMemory; fixtureId: string; label: string }>(
        'fixtures/sculpt/reapply',
        { mode, jobId },
      );
      setMemory(result.memory);
      closeAiTask();
      setMessage(
        `Applied that run’s model to the ${result.label.toLowerCase()} again. Undo puts the old model back.`,
      );
      openModel(result.fixtureId);
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'That run’s model could not be applied again.');
    } finally {
      setBusy((b) => (b === 'reapply' ? '' : b));
    }
  }
  /**
   * Put the desk back as it was before the last AI action: what it saved goes,
   * and so do edits made since. Undo brings it all back.
   */
  async function revertLastAiRun() {
    const last = lastAiRun;
    const current = last && memories[last.desk.mode];
    if (!last || !current || busy || aiRun.current) return;
    setBusy('revert');
    setError('');
    try {
      await restoreDesk(last.desk);
      const m = last.desk.mode;
      undo.current[m] = [...undo.current[m], current].slice(-UNDO_LIMIT);
      redo.current[m] = [];
      edits.current++;
      setHistoryTick((t) => t + 1);
      setLastAiRun(null);
      const title = aiHistory.find((j) => j.id === last.jobId)?.title ?? aiTask?.title;
      closeAiTask();
      setMessage(
        `Reverted${title ? `: ${title.toLowerCase()}` : ' the last AI run'}. The desk is as it was before it; undo with ${SHORTCUTS.find((k) => k.action === 'undo')!.keys}.`,
      );
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The AI run could not be reverted.');
    } finally {
      setBusy((b) => (b === 'revert' ? '' : b));
    }
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
  /** Hide the dialog of a clean finish after a moment to look at it; the next action cancels this. */
  function closeAiTaskSoon(ms: number) {
    clearTimeout(aiClose.current);
    aiClose.current = setTimeout(() => setAiTask(null), ms);
  }
  const brush = useBrush({
    mode,
    frameNow,
    followAi,
    closeAiTaskSoon,
    setMemory,
    showOwnScene: () => setWorkScene('custom'),
    setMessage,
    setError,
  });
  /**
   * The AI brush on a prop picked in the room rather than drawn round on the
   * picture: its box, seen through the room's camera, is the selection.
   */
  function brushGroup(scene: IsoScene, group: string) {
    const camera = mode === 'demo' ? DEMO_CAMERA : memory?.camera?.camera;
    if (!camera)
      return setError(
        'Calibrate the room’s camera first: the AI brush reads what you pick through it.',
      );
    // A little wider than its box: the room may draw it too small, and SAM needs all of it in view.
    const box = groupInFrame(camera, scene, group, 0.15);
    if (!box)
      return setError('The room’s camera doesn’t see all of it, so the AI brush can’t pick it.');
    const { width, height } = camera.frame;
    chooseTool('brush');
    void brush.finish({
      kind: 'rect',
      a: { x: box.left / width, y: box.top / height },
      b: { x: box.right / width, y: box.bottom / height },
    });
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
    // The desk as it was, for reverting what this action saves.
    const before = memory;
    const abort = new AbortController();
    aiRun.current = { generation, jobId, abort };
    clearTimeout(aiClose.current);
    setAiTask({ ...task, jobId, job: null, status: 'running', open: true, startedAt: Date.now() });
    const current = () => mounted.current && generation === aiGeneration.current;
    /** In development, say why a result goes nowhere: a newer task started, or this one was stopped. */
    const dropped = (what: string) => {
      if (!import.meta.env.DEV || !mounted.current) return;
      const why =
        aiRun.current && aiRun.current.jobId !== jobId
          ? 'a newer AI task started'
          : 'it was stopped';
      console.warn(`AI task "${task.title}" (${jobId.slice(0, 8)}): ${what} dropped, ${why}`);
    };
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
      if (current()) {
        if (before) setLastAiRun({ jobId, desk: before });
        return result;
      }
      dropped('its result');
      return null;
    } catch (e) {
      if (!current()) {
        dropped(`its failure (${e instanceof Error ? e.message : String(e)})`);
        return null;
      }
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
  async function illustrate(view: 'room' | 'desk' = 'room', note?: string) {
    if (busy) return;
    // The desk is drawn from what the camera shows now, not the last frame captured.
    const photo = view === 'desk' ? frameNow() : image;
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
                : 'Muse Image redraws the corner camera’s frame, keeping its framing. One image call, about $0.01.'
              : 'Demo: the saved room through the demo camera, no model calls.',
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
                ? { imageDataUrl: photo }
                : {}),
              ...(note?.trim() ? { note: note.trim() } : {}),
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
          : `Drew the room as a picture${costNote(result.run)}. The room’s camera places the mug and zones on it.`,
      );
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The room could not be drawn.');
    } finally {
      // A stop has already freed the lab for the next call.
      if (!aiRun.current) setBusy((b) => (b === 'illustrate' ? '' : b));
      // A clean finish closes itself after a moment to look at it.
      if (ok) closeAiTaskSoon(2200);
    }
  }
  /**
   * Scan a view's photo and map what stays put into a scene (one Spark and one
   * SAM call, live), step by step in the AI dialog, where it can be stopped.
   * Resolves to what each thing became, or null when it failed or was stopped.
   */
  async function scanFixtures(
    scene: IsoSceneKind | 'custom',
    replace: boolean,
    addNew: boolean,
  ): Promise<MappedThing[] | null> {
    if (busy) return null;
    // What the camera shows now, which is the frame the pin was set on, not the last one captured.
    const photo = frameNow();
    setBusy('scan');
    setError('');
    try {
      const result = await followAi(
        {
          title: 'Scanning and mapping',
          description:
            mode === 'live'
              ? 'Spark lists what stays put, SAM outlines each one, and each is placed through the pin. One Spark and one SAM call.'
              : 'Demo: the office from its corner camera, no model calls.',
        },
        (jobId, signal) =>
          api<{ run: EvidenceRun; mapped: MappedThing[]; memory: DeskMemory }>(
            'fixtures/scan',
            {
              mode,
              scene,
              replace,
              addNew,
              jobId,
              ...(mode === 'live' ? { imageDataUrl: photo } : {}),
            },
            { signal },
          ),
      );
      if (!result) return null;
      setMemory(result.memory);
      setSelected(result.run);
      const added = result.mapped.filter((m) => m.fixture).length;
      const moved = result.mapped.filter((m) => m.moveTo || m.moveBy).length;
      setMessage(
        result.mapped.length
          ? `Scanned ${result.mapped.length} thing${result.mapped.length === 1 ? '' : 's'}; moved ${moved}${addNew ? `, added ${added}` : ''}${costNote(result.run)}.`
          : 'The scan found nothing that stays put.',
      );
      void refresh().catch(() => {});
      return result.mapped;
    } catch (e) {
      setError(e instanceof Error ? e : 'The scan failed.');
      return null;
    } finally {
      // A stop has already freed the lab for the next call.
      if (!aiRun.current) setBusy((b) => (b === 'scan' ? '' : b));
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
      const result = await followAi(
        {
          title: 'Lifting the fixtures',
          description:
            mode === 'live'
              ? 'Spark finds each fixture on the picture, SAM outlines it, and Muse Image redraws the room without them. About $0.02.'
              : 'Demo: cut out where the layout puts them, no model calls.',
        },
        (jobId, signal) =>
          api<{
            run: EvidenceRun;
            memory: DeskMemory;
            lifted: number;
            skipped: string[];
          }>('scene/separate', { mode, jobId }, { signal }),
      );
      if (!result) return;
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
      // A stop has already freed the lab for the next call.
      if (!aiRun.current) setBusy((b) => (b === 'separate' ? '' : b));
    }
  }
  /**
   * Rebuild a fixture's model with Spark from the picture of it (two Spark
   * calls, live; a third looks up what the person says of it, `note`, first),
   * step by step in the AI dialog where it can be stopped, then open it to edit.
   */
  /**
   * Refine a fixture's shape with SAM 3D (experimental). It takes minutes,
   * so the server answers at once and this follows its job to the end; the
   * lab stays usable meanwhile, and the server saves the result either way.
   */
  async function refineFixture3d(id: string) {
    const f = memory?.fixtures?.find((x) => x.id === id);
    if (!f) return;
    setError('');
    try {
      const job = await followAi(
        {
          title: `Refining the ${f.label.toLowerCase()} with SAM 3D`,
          description:
            'SAM 3D reconstructs it whole from its photo crop, and its profile, height and handle replace the fit’s. About 10 minutes on this machine. Experimental.',
        },
        async (jobId, signal) => {
          await api('fixtures/refine3d', { mode, fixtureId: id, jobId }, { signal });
          for (;;) {
            if (signal.aborted) throw new Error('Stopped.');
            const job = await api<Job>(`jobs/${jobId}`, undefined, { signal });
            if (job.done) {
              if (job.outcome === 'failed') throw new Error(job.error ?? 'SAM 3D failed.');
              return job;
            }
            await new Promise((r) => setTimeout(r, 2000));
          }
        },
      );
      if (!job) return;
      await refresh();
      setMessage(
        `SAM 3D: ${job.steps.find((s) => s.id === 'check')?.detail ?? 'done'}. The old shape is under Earlier drafts.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'SAM 3D could not refine it.');
    }
  }
  async function sculptFixture(id: string, note?: string) {
    if (busy) return;
    const f = memory?.fixtures?.find((x) => x.id === id);
    if (!f) return;
    setBusy('sculpt');
    setError('');
    try {
      const result = await followAi(
        {
          title: `Modelling the ${f.label.toLowerCase()}`,
          description: note
            ? `Spark drafts its model in parts from its picture three ways at once and the best is kept, while “${note}” is looked up. Four Spark calls, about $0.05 to $0.15.`
            : 'Spark drafts its model in parts from its picture three ways at once, and the best is kept. Three Spark calls, about $0.05 to $0.10.',
        },
        (jobId, signal) =>
          api<{ run: EvidenceRun; memory: DeskMemory }>(
            'fixtures/sculpt',
            { mode, fixtureId: id, jobId, ...(note ? { note } : {}) },
            { signal },
          ),
      );
      if (!result) return;
      setMemory(result.memory);
      setSelected(result.run);
      const out = result.run.output as { parts: number; note: string; product?: string | null };
      setMessage(
        `Modelled the ${f.label.toLowerCase()}${out.product ? ` as the ${out.product}` : ''} in ${out.parts} parts${costNote(result.run)}. ${out.note} Edit it here; undo puts the old model back.`,
      );
      openModel(id);
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The fixture could not be modelled.');
    } finally {
      // A stop has already freed the lab for the next call.
      if (!aiRun.current) setBusy((b) => (b === 'sculpt' ? '' : b));
    }
  }
  /** Show the room a fixture goes in, and wait for a click there to put it down. */
  /** Model the next placed fixture with AI as soon as it is saved: a shape the fitter draws poorly. */
  const sculptNext = useRef(false);
  function startPlacing(next: FixturePlacing, { sculpt = false }: { sculpt?: boolean } = {}) {
    sculptNext.current = sculpt;
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
  /** Whether a fixture is being shown in the room's own view, apart from its office desk. */
  const inRoomViewOf = (f: Pick<Fixture, 'scene'>) =>
    workScene === 'custom' &&
    f.scene === 'custom' &&
    Boolean(memory?.scene && closeViewOf(memory.scene));
  async function updateFixture(
    id: string,
    change: {
      centre?: { x: number; y: number };
      surfaceId?: string | null;
      size?: FixtureInput['size'];
      scanned?: boolean;
      /** Null puts it back where the desk's camera puts it, in the room's view too. */
      room?: null;
    },
    done: string,
  ) {
    const f = memory?.fixtures?.find((x) => x.id === id);
    if (!f) return;
    const next: FixtureInput = {
      ...fixtureInput(f),
      ...(change.size ? { size: change.size } : {}),
      ...(change.room === null ? { room: null } : {}),
    };
    // The room's own view of a room with an office desk keeps its own place for it.
    const roomView = inRoomViewOf(f);
    const here = roomView ? inRoomView(f) : f;
    if (change.centre || change.surfaceId !== undefined || change.size) {
      const { at, size } = fixtureBox(here, memory?.scene);
      const centre = change.centre ?? { x: at.x + size.w / 2, y: at.y + size.d / 2 };
      const spot = fixtureAt(
        next,
        centre,
        change.surfaceId !== undefined ? change.surfaceId : here.surfaceId,
        memory?.scene ?? null,
      );
      if (spot && roomView) next.room = spot;
      else if (spot) Object.assign(next, spot);
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
        const res = await fetch(`/api/scene/photo?mode=${mode}`);
        if (!res.ok)
          throw new Error(
            (await res.json().catch(() => null))?.error?.message ??
              'This room has no photo of its own kept.',
          );
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
  /** Remove fixtures; "Not a fixture" (`dismiss`) also tells scans to skip things named like them. */
  async function deleteFixtures(ids: string[], dismiss = false) {
    const gone = (memory?.fixtures ?? []).filter((f) => ids.includes(f.id));
    if (!gone.length) return;
    setError('');
    try {
      const m = await api<DeskMemory>('fixtures/delete', {
        mode,
        fixtureIds: gone.map((f) => f.id),
        ...(dismiss ? { dismiss: true } : {}),
      });
      setMemory(m);
      if (selection?.kind === 'fixture' && ids.includes(selection.id)) setSelection(null);
      const undoKeys = SHORTCUTS.find((k) => k.action === 'undo')!.keys;
      setMessage(
        (gone.length === 1
          ? `Removed the ${gone[0]!.label.toLowerCase()}.`
          : `Removed ${gone.length} fixtures.`) +
          (dismiss ? ' Scans will skip things named like it.' : '') +
          ` Undo with ${undoKeys}.`,
      );
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The fixture could not be removed.');
    }
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
      if (sculptNext.current && saved && !placing.id) {
        sculptNext.current = false;
        void sculptFixture(saved.id);
      }
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
    if (!isProbe(run.kind))
      return 'Only model and lamp calls can be repeated. Use the inspector for scene steps.';
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
    overlay,
    setOverlay,
    showTrail,
    setShowTrail,
    showZones,
    setShowZones,
    showPicture,
    setShowPicture,
    showCorner,
    setShowCorner,
    tracking,
    setTracking: changeTracking,
    stageView,
    setStageView,
    workScene,
    setWorkScene,
    choosingScene,
    setChoosingScene,
    tool,
    setTool: chooseTool,
    brush,
    brushGroup,
    fixtureLook,
    setFixtureLook,
    separate,
    sculptFixture,
    addFixturePhoto,
    chooseFixtureDraft,
    refineFixture3d,
    scanFixtures,
    followAi,
    aiTask,
    setAiTask,
    aiHistory,
    reviewAiRun,
    reapplyAiRun,
    lastAiRun,
    revertLastAiRun,
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
    zooming,
    setZooming,
    openCrop,
    imageCrop,
    cameraFrame,
    calibrateByHand,
    calibrateHere,
    pinHere,
    keepCameraView,
    zoomable: zoomable(),
    startZooming,
    saveZoom,
    startBoxing,
    startPlacing,
    placeFixture,
    updateFixture,
    deleteFixtures,
    inRoomViewOf,
    adjustPin,
    guess,
    asking,
    askGuess,
    sceneLabel,
    pinning,
    setPinning,
    autoPin,
    calibrating,
    setCalibrating,
    startCalibrating,
    saveCalibration,
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
    saveEverything,
    saves,
    activeSave,
    unsaved,
    saveAs,
    updateSave,
    renameSave,
    deleteSave,
    loadSave,
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
    zoneObservation,
    cameraSize,
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
    editRule,
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
