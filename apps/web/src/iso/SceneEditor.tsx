import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ISO_PRESETS,
  ISO_TILE_CM,
  addTemplate,
  groupBounds,
  groupLayer,
  isoSceneSchema,
  moveGroup,
  overlappingGroups,
  removeGroup,
  rotateGroup,
  rotateScene,
  resizeRoom,
  settleGroup,
  withGroupLayer,
  type EvidenceRun,
  type IsoScene as Scene,
  type IsoSceneKind,
  type Mode,
  type SceneDraft,
  type DeskMemory,
  type CameraCrop,
  type RoomMarks,
} from '@livinglayer/domain';
import { api, type AiFollow } from '../api';
import { ApiError } from '../activity';
import { ZoomPan } from '../ZoomPan';
import { IsoScene, type IsoFixture } from './IsoScene';
import { PropPickerPopover } from './PropPicker';
import { PhotoReview, type PhotoRun } from './PhotoReview';
import { demoFrameUrl } from '../workspace/demoFrame';
import { Popover } from '../workspace/Popover';
import { Button, Check, IconButton, NumberInput, Select, Toolbar } from '../ui/controls';
import { LayerButtons } from './LayerButtons';

export type LayoutRun = EvidenceRun<{ draft: SceneDraft; scene: Scene }>;
const EMPTY: Scene = {
  kind: 'custom',
  label: 'My room',
  grid: { w: 8, d: 6 },
  props: [],
  surfaces: [],
};
const asCustom = (scene: Scene): Scene => ({
  ...scene,
  kind: 'custom',
  label: scene.kind === 'custom' ? scene.label : `My ${scene.label.toLowerCase()}`,
});
const groupLabel = (scene: Scene, g: string) => {
  const props = scene.props.filter((p) => p.group === g);
  return props.find((p) => p.id === g)?.label ?? props[0]?.label ?? g;
};

const NO_FIXTURES: IsoFixture[] = [];

type Preset = IsoSceneKind | 'empty';
type Running = 'setup' | 'spark' | 'upload' | 'frame' | 'fit';
type Snapshot = { draft: Scene; turned: number };
const HISTORY_LIMIT = 100;
/** Edits under one key closer together than this are one undo step (a drag, typing a size). */
const COALESCE_MS = 600;
/** Keys typed into a field are its own: native undo there, no shortcuts. */
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
/** What a setup found before it needed the person: the marks, Spark's sizes and the frame. */
export interface CalibrateByHand {
  marks: RoomMarks | null;
  room: { w: number; d: number };
  heightCm?: number;
  frame: { width: number; height: number };
}

/** A close view of the room to edit through: its groups, drawn moved by dx, dy on its own grid. */
export interface SceneView {
  label: string;
  groups: ReadonlySet<string>;
  dx: number;
  dy: number;
  grid: Scene['grid'];
}
/** The room as its close view draws it, with the groups added while editing there. */
function throughView(scene: Scene, view: SceneView, added: ReadonlySet<string>): Scene {
  const at = <T extends { x: number; y: number }>(p: T): T => ({
    ...p,
    x: p.x + view.dx,
    y: p.y + view.dy,
  });
  const props = scene.props
    .filter((p) => view.groups.has(p.group) || added.has(p.group))
    .map((p) => ({ ...p, at: at(p.at) }));
  const own = new Set(props.map((p) => p.id));
  return {
    ...scene,
    label: view.label,
    grid: view.grid,
    props,
    surfaces: scene.surfaces
      .filter((s) => own.has(s.propId))
      .map((s) => ({ ...s, rect: at(s.rect) })),
  };
}

/**
 * Build a scene from the template palette: start from a preset, an empty
 * floor or a Spark draft, then add, drag, turn and remove whole groups.
 * Tabletop templates settle onto whatever surface they are dropped over.
 */
export function SceneEditor({
  mode,
  saved,
  base,
  image,
  lights,
  busy,
  memory,
  onSave,
  onDrafted,
  onUpload,
  onPhotoSaved,
  onError,
  onMessage,
  follow,
  room,
  onCalibrateByHand,
  onCalibrateHere,
  captureFrame,
  cameraLive = false,
  onCalibrated,
  hand = false,
  brushTool = false,
  onAiEdit,
  onMakeThing,
  fixtures = NO_FIXTURES,
  onMoveFixture,
  onFixtureMenu,
  view,
}: {
  mode: Mode;
  /** The person's saved scene, if any. */
  saved: Scene | null | undefined;
  /** What the room view shows now, to start from: a preset, or the saved scene itself. */
  base: Scene;
  image?: string;
  lights: string[];
  busy: boolean;
  memory?: DeskMemory;
  onSave: (scene: Scene | null) => void;
  onDrafted: (run: LayoutRun | PhotoRun) => void;
  /** Prepare a chosen photo as the lab's current frame, and return it. */
  onUpload?: (file: File) => Promise<string | undefined>;
  onPhotoSaved: (memory: DeskMemory) => void;
  onError: (error: string | Error) => void;
  /** Say what an edit did, in the lab's message line. */
  onMessage?: (text: string) => void;
  /** Follow a photo draft step by step in the AI dialog. */
  follow?: AiFollow;
  /** The room the camera is calibrated for when setting the room up. */
  room: IsoSceneKind | 'custom';
  /**
   * The frame to set the room up from: one captured from the live camera now,
   * else the current photo, with the zoomed view it came through.
   */
  captureFrame?: () => { url: string | undefined; crop: CameraCrop | null };
  /** Whether the room's camera is streaming, so a frame can be taken from it. */
  cameraLive?: boolean;
  /** The camera was calibrated: the room's memory as it is now. */
  onCalibrated?: (memory: DeskMemory) => void;
  /** The setup couldn't fit the camera by itself: carry on by hand from what it found. */
  onCalibrateByHand?: (found: CalibrateByHand) => void;
  /** Calibrate by hand on the current frame, with no model calls. */
  onCalibrateHere?: () => void;
  /** Every drag pans the room, for the hand tool. */
  hand?: boolean;
  /** The AI brush is the canvas tool: a click on a prop picks it for the brush. */
  brushTool?: boolean;
  /** Pick a prop of the saved room for the AI brush. */
  onAiEdit?: (scene: Scene, group: string) => void;
  /** Make a prop a thing of its own, out of the layout: it can then be named, followed and keep stats. */
  onMakeThing?: (scene: Scene, group: string) => void;
  /** The room's fixtures, drawn where they stand; saved as they move, apart from the layout. */
  fixtures?: IsoFixture[];
  onMoveFixture?: (id: string, to: { x: number; y: number; surfaceId: string | null }) => void;
  onFixtureMenu?: (id: string, at: { x: number; y: number }) => void;
  /** Edit the room through its close view: only what the view shows is drawn and listed. */
  view?: SceneView;
}) {
  // The room the view shows, not whatever was saved last: editing the office starts from the office.
  const showsSaved = Boolean(saved) && base === saved;
  const initial = () => (showsSaved ? saved! : asCustom(base));
  const [draft, setDraft] = useState<Scene>(initial);
  const [selected, setSelected] = useState<string>();
  // Groups left out of the drawing while editing, to see and reach what they cover; never saved.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  // Props added from the close view, shown there wherever they are dropped.
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [summary, setSummary] = useState('');
  // Which camera action is running, so only its button says so.
  const [running, setRunning] = useState<Running>();
  const drafting = Boolean(running);
  const [photo, setPhoto] = useState<{ run: PhotoRun; url: string } | null>(null);
  const [sparkCheck, setSparkCheck] = useState(true);
  // Whether there is a frame to set the room up from: the camera is the best place to start.
  const canSetUp = mode === 'demo' || cameraLive || Boolean(image);
  /** Quarter turns of the whole room since it was last loaded, to say what a turn means for the camera. */
  const [turned, setTurned] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  // The saved scene as the editor last took it. A save from elsewhere (the live camera's own
  // updates come every few seconds) is taken only while the draft has no edits of its own.
  const taken = useRef(saved);
  useEffect(() => {
    if (!showsSaved) return;
    const before = taken.current;
    taken.current = saved;
    setDraft((d) => (JSON.stringify(d) === JSON.stringify(before ?? null) ? saved! : d));
  }, [saved, showsSaved]);

  // Undo and redo: the draft (and its turns) before each edit. A drag or a typed
  // size sends many edits under one key; those within a moment make one step.
  const now = useRef({ draft, turned });
  now.current = { draft, turned };
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const lastEdit = useRef<{ key?: string; at: number }>({ at: 0 });
  const [, setHistoryVersion] = useState(0);
  function edit(next: Scene | ((d: Scene) => Scene), key?: string) {
    const at = Date.now();
    const last = lastEdit.current;
    if (!key || key !== last.key || at - last.at > COALESCE_MS) {
      past.current = [...past.current.slice(1 - HISTORY_LIMIT), now.current];
      future.current = [];
      setHistoryVersion((v) => v + 1);
    }
    lastEdit.current = { key, at };
    setDraft(next);
  }
  /** Bring a group forward (+1) or send it back (-1) a draw layer. */
  function layer(g: string, by: 1 | -1) {
    edit((d) => withGroupLayer(d, g, groupLayer(d, g) + by), `layer:${g}`);
  }
  function restore(from: Snapshot[], to: Snapshot[]) {
    const snap = from.pop();
    if (!snap) return;
    to.push(now.current);
    lastEdit.current = { at: 0 };
    setDraft(snap.draft);
    setTurned(snap.turned);
    setSelected((g) => (g && snap.draft.props.some((p) => p.group === g) ? g : undefined));
    setHistoryVersion((v) => v + 1);
  }
  const undo = () => restore(past.current, future.current);
  const redo = () => restore(future.current, past.current);
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (photo || isTyping(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') (e.shiftKey ? redo : undo)();
    else if (mod && k === 'y') redo();
    else if (!mod && selected && (e.key === 'Delete' || e.key === 'Backspace')) {
      edit((d) => removeGroup(d, selected));
      setSelected(undefined);
    } else if (!mod && e.key === 'Escape' && selected) setSelected(undefined);
    else if (!mod && selected && (e.key === ']' || e.key === '['))
      layer(selected, e.key === ']' ? 1 : -1);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const flagged = useMemo(() => overlappingGroups(draft), [draft]);
  const shown = useMemo(
    () => (view ? throughView(draft, view, added) : draft),
    [draft, view, added],
  );
  const groups = useMemo(() => [...new Set(shown.props.map((p) => p.group))], [shown]);
  const overlapping = groups.filter((g) => flagged.has(g)).length;
  const hide = (gs: string[], off: boolean) =>
    setHidden((h) => {
      const next = new Set(h);
      for (const g of gs) {
        if (off) next.add(g);
        else next.delete(g);
      }
      return next;
    });
  const check = useMemo(() => isoSceneSchema.safeParse(draft), [draft]);
  const draftJson = useMemo(() => JSON.stringify(draft), [draft]);
  const savedJson = useMemo(() => JSON.stringify(saved ?? null), [saved]);
  const initialJson = useMemo(
    () => JSON.stringify(showsSaved ? saved! : asCustom(base)),
    [showsSaved, saved, base],
  );
  const dirty = draftJson !== savedJson;
  // The AI brush reads the room as it is shown, so it waits for the layout's edits to be saved.
  const aiBlocked =
    draftJson !== initialJson
      ? 'Save the layout first: the AI brush edits the room as saved.'
      : null;
  const groupProps = selected ? draft.props.filter((p) => p.group === selected) : [];
  const lamp = groupProps.find((p) => p.role === 'lamp');
  // What the scene is handed stays the same object while nothing it shows changes.
  const sceneFixtures = useMemo(
    () => fixtures.filter((f) => !hidden.has(`fixture:${f.id}`)),
    [fixtures, hidden],
  );
  const lampLight = lamp?.lightId;
  const litLights = useMemo(() => new Set(lampLight ? [lampLight] : []), [lampLight]);
  const latest = useRef({ draft, aiBlocked, brushTool, onAiEdit, edit });
  latest.current = { draft, aiBlocked, brushTool, onAiEdit, edit };
  const editing = useMemo(
    () => ({
      selected,
      flagged,
      onSelect: (g: string) => {
        setSelected(g);
        const l = latest.current;
        if (g && l.brushTool && !l.aiBlocked) l.onAiEdit?.(l.draft, g);
      },
      onMove: (g: string, dx: number, dy: number) =>
        latest.current.edit((d) => settleGroup(moveGroup(d, g, dx, dy), g), `move.${g}`),
    }),
    [selected, flagged],
  );
  const bounds = selected ? groupBounds(draft, selected) : null;

  function start(from: IsoSceneKind | 'empty') {
    setTurned(0);
    edit(from === 'empty' ? EMPTY : asCustom(ISO_PRESETS[from]));
    setSelected(undefined);
    setSummary('');
  }
  /** Spark lists what is in the frame, SAM outlines it, and each thing is placed through the room's camera. */
  async function fromPhoto(url?: string, from: Running = 'frame') {
    if (mode === 'live' && !url) return;
    setRunning(from);
    try {
      const body = { mode, check: sparkCheck, ...(mode === 'live' ? { imageDataUrl: url } : {}) };
      const run = follow
        ? await follow(
            {
              title: 'Drafting the room',
              description:
                mode === 'live'
                  ? `Spark lists what is in the frame, SAM outlines it, and each thing is placed through the room’s camera${sparkCheck ? ', then Spark compares the draft with the frame' : ''}.`
                  : 'Demo: the office from its corner camera, no model calls.',
            },
            (jobId, signal) => api('scene/from-photo', { ...body, jobId }, { signal }),
          )
        : await api('scene/from-photo', body);
      if (!run) return;
      setPhoto({ run, url: mode === 'live' ? url! : demoFrameUrl() });
      onDrafted(run);
    } catch (e) {
      onError(e instanceof Error ? e : 'The photo could not be drafted.');
    } finally {
      setRunning(undefined);
    }
  }
  /**
   * Move the selected prop to where the camera sees it: SAM outlines it on
   * the current frame (one call, live) and it is moved, or turned round,
   * until its drawing matches. An edit like any other: undo takes it back.
   */
  async function fitToCamera(g: string) {
    const url = mode === 'live' ? (captureFrame?.().url ?? image) : undefined;
    if (mode === 'live' && !url) return;
    setRunning('fit');
    try {
      const r = await api('scene/fit', {
        mode,
        scene: draft,
        group: g,
        ...(url ? { imageDataUrl: url } : {}),
      });
      const name = groupLabel(draft, g).toLowerCase();
      const moved = Math.round(Math.hypot(r.fit.movedCm.x, r.fit.movedCm.y));
      if (r.fit.kept) {
        edit(r.scene);
        setSummary('');
        onMessage?.(
          `Moved the ${name} ${moved} cm${r.fit.turned ? ' and turned it round' : ''} to where the camera sees it (match ${Math.round(r.fit.from * 100)}% → ${Math.round(r.fit.iou * 100)}%). Undo takes it back.`,
        );
      } else
        onMessage?.(
          r.fit.iou >= r.fit.from + 0.05
            ? `The ${name} matches the camera only ${Math.round(r.fit.iou * 100)}% at best, so it stays put: check what SAM outlined.`
            : `The ${name} already stands where the camera sees it (match ${Math.round(r.fit.from * 100)}%).`,
        );
    } catch (e) {
      onError(e instanceof Error ? e : 'The prop could not be fitted to the camera.');
    } finally {
      setRunning(undefined);
    }
  }
  /**
   * The whole setup from one frame, calibrated or not: Spark lists the room
   * and estimates its size, SAM finds the floor and walls, the camera is
   * fitted (which wall is the back decides the scene's direction) and saved,
   * then the draft runs through it for review.
   */
  async function setUp() {
    const frame = mode === 'live' ? captureFrame?.() : undefined;
    const url = frame?.url;
    if (mode === 'live' && !url) return;
    setRunning('setup');
    try {
      const body = {
        mode,
        check: sparkCheck,
        scene: room,
        ...(mode === 'live' ? { imageDataUrl: url, crop: frame?.crop ?? null } : {}),
      };
      const run = follow
        ? await follow(
            {
              title: 'Setting up the room',
              description:
                mode === 'live'
                  ? `Spark lists the room and estimates its size, SAM finds the floor and walls, the corner camera is fitted and saved, then each thing is placed through it${sparkCheck ? ' and Spark compares the draft with the frame' : ''}.`
                  : 'Demo: the office from its corner camera, no model calls.',
            },
            (jobId, signal) => api('scene/setup', { ...body, jobId }, { signal }),
          )
        : await api('scene/setup', body);
      // Calibrated even when the draft was then stopped: the room's memory has the camera.
      onCalibrated?.(await api(`desk/${mode}`));
      if (!run) return;
      setPhoto({ run, url: mode === 'live' ? url! : demoFrameUrl() });
      onDrafted(run);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'calibrate_by_hand' && e.data && onCalibrateByHand)
        onCalibrateByHand(e.data as unknown as CalibrateByHand);
      else onError(e instanceof Error ? e : 'The room could not be set up.');
    } finally {
      setRunning(undefined);
    }
  }
  if (photo)
    return (
      <PhotoReview
        mode={mode}
        run={photo.run}
        photoUrl={photo.url}
        memory={memory}
        busy={busy}
        onSaved={(m) => {
          setPhoto(null);
          if (m.scene) edit(m.scene);
          onPhotoSaved(m);
        }}
        onCancel={() => setPhoto(null)}
        onError={onError}
      />
    );
  async function askSpark() {
    const url = mode === 'live' ? (captureFrame?.().url ?? image) : undefined;
    if (mode === 'live' && !url) return;
    setRunning('spark');
    try {
      const run = await api('scene/draft', {
        mode,
        ...(mode === 'live' ? { imageDataUrl: url } : {}),
      });
      edit({ ...run.output.scene, label: 'Drafted room' });
      setSummary(run.output.draft.summary);
      setSelected(undefined);
      onDrafted(run);
    } catch (e) {
      onError(e instanceof Error ? e : 'Scene draft failed.');
    } finally {
      setRunning(undefined);
    }
  }

  const presets: Preset[] = [...(Object.keys(ISO_PRESETS) as IsoSceneKind[]), 'empty'];
  const metres = (tiles: number) => ((tiles * ISO_TILE_CM) / 100).toFixed(1);
  const note = !check.success
    ? (check.error.issues[0]?.message ?? 'This scene does not fit its grid.')
    : overlapping
      ? `${overlapping} props cut into each other and may draw out of order. Move them apart.`
      : turned % 2 && memory?.camera
        ? 'Turned. The camera was calibrated for the room the other way round: save, then calibrate it again.'
        : summary
          ? `Spark: ${summary} Review it, then save.`
          : !memory?.camera && mode !== 'demo'
            ? 'The camera isn’t calibrated yet: Layout → From the camera.'
            : '';

  return (
    <div className="scene-editor">
      <div className="scene-editor-body">
        <div className="scene-layers" role="group" aria-label="Props in the room">
          <div className="scene-layers-head">
            <span className="tiny">PROPS · {groups.length}</span>
            {hidden.size > 0 && (
              <Button variant="text" size="sm" onClick={() => setHidden(new Set())}>
                Show all
              </Button>
            )}
          </div>
          <ul>
            {groups.map((g) => (
              <li
                key={g}
                className={[
                  g === selected ? 'selected' : '',
                  hidden.has(g) ? 'hidden' : '',
                  flagged.has(g) ? 'overlap' : '',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  checked={!hidden.has(g)}
                  aria-label={`Show ${groupLabel(draft, g)}`}
                  title={hidden.has(g) ? 'Show it' : 'Hide it while editing'}
                  onChange={(e) => hide([g], !e.target.checked)}
                />
                <button
                  type="button"
                  aria-pressed={g === selected}
                  onClick={() => setSelected(g === selected ? undefined : g)}
                >
                  {groupLabel(draft, g)}
                </button>
              </li>
            ))}
          </ul>
          {fixtures.length > 0 && (
            <>
              <div className="scene-layers-head">
                <span
                  className="tiny"
                  title="Things found or placed in the room. Drag one to move it; right-click for more. They move apart from the layout, saved as you drop them."
                >
                  FIXTURES · {fixtures.length}
                </span>
              </div>
              <ul aria-label="Fixtures in the room">
                {fixtures.map((f) => (
                  <li key={f.id} className={hidden.has(`fixture:${f.id}`) ? 'hidden' : ''}>
                    <input
                      type="checkbox"
                      checked={!hidden.has(`fixture:${f.id}`)}
                      aria-label={`Show ${f.label}`}
                      title={hidden.has(`fixture:${f.id}`) ? 'Show it' : 'Hide it while editing'}
                      onChange={(e) => hide([`fixture:${f.id}`], !e.target.checked)}
                    />
                    <span className="scene-layer-name">{f.label}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="scene-canvas">
          <ZoomPan className="iso-zoom" hand={hand} store="scene-editor" resetKey={room}>
            <IsoScene
              scene={shown}
              hidden={hidden}
              fixtures={sceneFixtures}
              {...(onMoveFixture ? { onMoveFixture } : {})}
              {...(onFixtureMenu ? { onFixtureMenu } : {})}
              litLights={litLights}
              editing={editing}
            />
          </ZoomPan>
        </div>
      </div>
      {note && (
        <p className="iso-note" role="status">
          {note}
        </p>
      )}
      <Toolbar
        label="Edit the layout"
        end={
          <>
            <IconButton
              label="Undo"
              title="Undo (⌘Z)"
              disabled={busy || drafting || !past.current.length}
              onClick={undo}
            >
              ↶
            </IconButton>
            <IconButton
              label="Redo"
              title="Redo (⇧⌘Z)"
              disabled={busy || drafting || !future.current.length}
              onClick={redo}
            >
              ↷
            </IconButton>
            <Button
              variant="primary"
              disabled={busy || drafting || !dirty || !check.success}
              title={
                saved && !showsSaved
                  ? `Replaces your custom scene${saved.label ? ` “${saved.label}”` : ''}.`
                  : 'Saved scenes show up as Custom in the room view, ready to pin.'
              }
              onClick={() => onSave(draft)}
            >
              Save
            </Button>
          </>
        }
      >
        <Popover
          label="Layout"
          className="scene-pop"
          button={(open, toggle) => (
            <Button variant="ghost" aria-expanded={open} aria-haspopup="dialog" onClick={toggle}>
              {drafting ? (
                'Working…'
              ) : (
                <>
                  Layout <span aria-hidden="true">▾</span>
                </>
              )}
            </Button>
          )}
        >
          {(close) => {
            // Close on the way out, so the canvas shows what the action did.
            const then = (act: () => void) => () => {
              close();
              act();
            };
            return (
              <>
                <div className="scene-pop-row">
                  <span
                    className="tiny"
                    title="The room's size, walls included. Saving fits the room's camera to it again, from the corner you marked."
                  >
                    SIZE
                  </span>
                  {(['w', 'd'] as const).map((k, i) => (
                    <span key={k} className="scene-size">
                      {i > 0 && <span aria-hidden="true">×</span>}
                      <NumberInput
                        min={2}
                        max={16}
                        value={draft.grid[k]}
                        disabled={busy || drafting}
                        aria-label={`Grid ${k === 'w' ? 'width' : 'depth'} in tiles`}
                        onChange={(v) =>
                          edit((d) => resizeRoom(d, { ...d.grid, [k]: v }), `grid.${k}`)
                        }
                      />
                    </span>
                  ))}
                  <span className="micro">
                    {metres(draft.grid.w)} × {metres(draft.grid.d)} m
                  </span>
                  <IconButton
                    framed
                    label="Turn room"
                    disabled={busy || drafting}
                    title="Turn the whole room a quarter clockwise, to face the way the camera sees it. The back and left walls stay put."
                    onClick={() => {
                      edit(rotateScene(draft));
                      setSelected(undefined);
                      setTurned((t) => (t + 1) % 4);
                    }}
                  >
                    ↻
                  </IconButton>
                </div>
                <div className="scene-pop-group" role="group" aria-label="Start over">
                  <span className="tiny">START OVER · UNDO BRINGS IT BACK</span>
                  <div className="scene-pop-row">
                    <Button
                      variant="primary"
                      disabled={busy || drafting || !canSetUp}
                      title="Spark sizes the room, SAM finds its walls, the camera is calibrated and the scene drafted through it, for you to review."
                      onClick={then(() => void setUp())}
                    >
                      From the camera
                    </Button>
                    {mode === 'demo' ? (
                      <Button
                        disabled={busy || drafting}
                        title="Draft through the demo camera, which is already calibrated."
                        onClick={then(() => void fromPhoto())}
                      >
                        Demo frame
                      </Button>
                    ) : (
                      memory?.camera && (
                        <>
                          <Button
                            disabled={busy || drafting || !canSetUp}
                            title="Draft through the calibrated camera from what it shows now."
                            onClick={then(() => void fromPhoto(captureFrame?.().url ?? image))}
                          >
                            This frame
                          </Button>
                          <Button
                            disabled={busy || drafting || !onUpload}
                            title="Draft through the calibrated camera from a frame you saved."
                            onClick={then(() => file.current?.click())}
                          >
                            Upload…
                          </Button>
                        </>
                      )
                    )}
                  </div>
                  <div className="scene-pop-row">
                    {presets.map((k) => (
                      <Button
                        key={k}
                        size="sm"
                        disabled={busy || drafting}
                        onClick={then(() => start(k))}
                      >
                        {k === 'empty' ? 'Empty' : ISO_PRESETS[k].label}
                      </Button>
                    ))}
                  </div>
                  <p className="micro">
                    {mode === 'demo'
                      ? 'Demo: no model calls.'
                      : !canSetUp
                        ? 'Start the camera or capture a frame to draft from it.'
                        : `From the camera: ${sparkCheck ? 3 : 2} billed calls.`}
                  </p>
                  <details className="scene-more">
                    <summary>More ways</summary>
                    <div className="scene-pop-row">
                      {onCalibrateHere && mode !== 'demo' && (
                        <Button
                          size="sm"
                          disabled={busy || drafting || !canSetUp}
                          title="Place the far corner and each wall’s floor line yourself on the current frame, with no model calls. Then draft through it."
                          onClick={then(onCalibrateHere)}
                        >
                          Calibrate by hand
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={busy || drafting || !canSetUp}
                        title="Spark alone lays out the room from the frame: one billed call, no camera."
                        onClick={then(() => void askSpark())}
                      >
                        Spark only
                      </Button>
                      <Check checked={sparkCheck} onChange={setSparkCheck}>
                        Spark checks the draft
                      </Check>
                    </div>
                  </details>
                </div>
                <div className="scene-pop-row scene-pop-end">
                  <Button
                    disabled={busy || drafting || !dirty}
                    title="Back to the saved scene. Undo brings your edits back."
                    onClick={then(() => {
                      setTurned(0);
                      edit(initial());
                    })}
                  >
                    Revert
                  </Button>
                  {saved && (
                    <Button
                      variant="danger"
                      disabled={busy || drafting}
                      onClick={then(() => onSave(null))}
                    >
                      Remove custom scene
                    </Button>
                  )}
                </div>
              </>
            );
          }}
        </Popover>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          aria-label="Frame of the room's camera to draft a scene from"
          onChange={async (e) => {
            const chosen = e.target.files?.[0];
            e.target.value = '';
            const url = chosen && onUpload ? await onUpload(chosen) : undefined;
            if (url) await fromPhoto(url, 'upload');
          }}
        />
        <PropPickerPopover
          scene={draft}
          label="+ Prop"
          onAdd={(id) => {
            const next = addTemplate(draft, id);
            const b = view && groupBounds(next.scene, next.group);
            // From a close view, a new prop starts in the middle of it, settled on what is there.
            edit(
              view && b
                ? settleGroup(
                    moveGroup(
                      next.scene,
                      next.group,
                      view.grid.w / 2 - view.dx - (b.at.x + b.size.w / 2),
                      view.grid.d / 2 - view.dy - (b.at.y + b.size.d / 2),
                    ),
                    next.group,
                  )
                : next.scene,
            );
            if (view) setAdded((a) => new Set(a).add(next.group));
            setSelected(next.group);
          }}
        />
        {selected && bounds && (
          <span className="scene-picked" role="group" aria-label="Selected prop">
            <span className="scene-picked-name">{groupLabel(draft, selected)}</span>
            <IconButton
              label="Turn prop"
              disabled={busy || drafting}
              title="Turn it a quarter clockwise"
              onClick={() => edit((d) => settleGroup(rotateGroup(d, selected), selected))}
            >
              ↻
            </IconButton>
            <LayerButtons
              layer={groupLayer(draft, selected)}
              disabled={busy || drafting}
              onLayer={(by) => layer(selected, by)}
            />
            <Button
              size="sm"
              disabled={busy || drafting || !canSetUp}
              title={
                mode === 'demo'
                  ? 'Move it to where the demo camera sees it. No model calls.'
                  : 'Move it to where the camera sees it in the current frame: SAM outlines it, one billed call.'
              }
              onClick={() => void fitToCamera(selected)}
            >
              {running === 'fit' ? 'Fitting…' : 'Fit to camera'}
            </Button>
            {onAiEdit && (
              <Button
                size="sm"
                disabled={busy || drafting || Boolean(aiBlocked)}
                title={
                  aiBlocked ??
                  'Change its model with the AI brush: say what it is or what to change, as on the picture.'
                }
                onClick={() => onAiEdit(draft, selected)}
              >
                Edit with AI
              </Button>
            )}
            {onMakeThing && (
              <Button
                size="sm"
                disabled={busy || drafting}
                title="Take it out of the layout as a thing of its own, drawn the same: it can be named, moved and followed, and keep stats such as occupied"
                onClick={() => {
                  onMakeThing(draft, selected);
                  setSelected(undefined);
                }}
              >
                Make it a thing
              </Button>
            )}
            <IconButton
              label="Remove prop"
              disabled={busy || drafting}
              title="Remove it (Delete)"
              onClick={() => {
                edit((d) => removeGroup(d, selected));
                setSelected(undefined);
              }}
            >
              ✕
            </IconButton>
            {lamp && (
              <Select
                aria-label="Lamp light"
                title="The light this lamp drives"
                value={lamp.lightId ?? ''}
                options={[
                  { value: '', label: 'Main light' },
                  ...lights.map((l) => ({ value: l, label: l })),
                ]}
                onChange={(v) =>
                  edit((d) => ({
                    ...d,
                    props: d.props.map((p) =>
                      p.group === selected && p.role === 'lamp'
                        ? { ...p, lightId: v || undefined }
                        : p,
                    ),
                  }))
                }
              />
            )}
          </span>
        )}
      </Toolbar>
    </div>
  );
}
