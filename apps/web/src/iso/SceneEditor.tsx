import { useEffect, useRef, useState } from 'react';
import {
  ISO_PRESETS,
  addTemplate,
  groupBounds,
  isoSceneSchema,
  moveGroup,
  overlappingGroups,
  removeGroup,
  rotateGroup,
  rotateScene,
  settleGroup,
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
import { IsoScene } from './IsoScene';
import { PropPickerPopover } from './PropPicker';
import { PhotoReview, type PhotoRun } from './PhotoReview';
import { demoFrameUrl } from '../workspace/demoFrame';

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

type StartFrom = 'camera' | IsoSceneKind | 'empty';
/** What a setup found before it needed the person: the marks, Spark's sizes and the frame. */
export interface CalibrateByHand {
  marks: RoomMarks | null;
  room: { w: number; d: number };
  heightCm?: number;
  frame: { width: number; height: number };
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
  follow,
  room,
  onCalibrateByHand,
  captureFrame,
  cameraLive = false,
  onCalibrated,
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
}) {
  // The room the view shows, not whatever was saved last: editing the office starts from the office.
  const showsSaved = Boolean(saved) && base === saved;
  const initial = () => (showsSaved ? saved! : asCustom(base));
  const [draft, setDraft] = useState<Scene>(initial);
  const [selected, setSelected] = useState<string>();
  const [summary, setSummary] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [photo, setPhoto] = useState<{ run: PhotoRun; url: string } | null>(null);
  const [sparkCheck, setSparkCheck] = useState(true);
  // The camera is the best place to start: chosen whenever there is a frame to set the room up from.
  const canSetUp = mode === 'demo' || cameraLive || Boolean(image);
  const [startFrom, setStartFrom] = useState<StartFrom>('camera');
  /** Quarter turns of the whole room since it was last loaded, to say what a turn means for the camera. */
  const [turned, setTurned] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (showsSaved) setDraft(saved!);
  }, [saved, showsSaved]);
  const flagged = overlappingGroups(draft);
  const check = isoSceneSchema.safeParse(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved ?? null);
  const groupProps = selected ? draft.props.filter((p) => p.group === selected) : [];
  const lamp = groupProps.find((p) => p.role === 'lamp');
  const bounds = selected ? groupBounds(draft, selected) : null;

  function start(from: IsoSceneKind | 'empty') {
    setTurned(0);
    setDraft(from === 'empty' ? EMPTY : asCustom(ISO_PRESETS[from]));
    setSelected(undefined);
    setSummary('');
  }
  /** Spark lists what is in the frame, SAM outlines it, and each thing is placed through the room's camera. */
  async function fromPhoto(url?: string) {
    if (mode === 'live' && !url) return;
    setDrafting(true);
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
            (jobId, signal) => api<PhotoRun>('scene/from-photo', { ...body, jobId }, { signal }),
          )
        : await api<PhotoRun>('scene/from-photo', body);
      if (!run) return;
      setPhoto({ run, url: mode === 'live' ? url! : demoFrameUrl() });
      onDrafted(run);
    } catch (e) {
      onError(e instanceof Error ? e : 'The photo could not be drafted.');
    } finally {
      setDrafting(false);
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
    setDrafting(true);
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
            (jobId, signal) => api<PhotoRun>('scene/setup', { ...body, jobId }, { signal }),
          )
        : await api<PhotoRun>('scene/setup', body);
      // Calibrated even when the draft was then stopped: the room's memory has the camera.
      onCalibrated?.(await api<DeskMemory>(`desk/${mode}`));
      if (!run) return;
      setPhoto({ run, url: mode === 'live' ? url! : demoFrameUrl() });
      onDrafted(run);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'calibrate_by_hand' && e.data && onCalibrateByHand)
        onCalibrateByHand(e.data as unknown as CalibrateByHand);
      else onError(e instanceof Error ? e : 'The room could not be set up.');
    } finally {
      setDrafting(false);
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
          if (m.scene) setDraft(m.scene);
          onPhotoSaved(m);
        }}
        onCancel={() => setPhoto(null)}
        onError={onError}
      />
    );
  async function askSpark() {
    const url = mode === 'live' ? (captureFrame?.().url ?? image) : undefined;
    if (mode === 'live' && !url) return;
    setDrafting(true);
    try {
      const run = await api<LayoutRun>('scene/draft', {
        mode,
        ...(mode === 'live' ? { imageDataUrl: url } : {}),
      });
      setDraft({ ...run.output.scene, label: 'Drafted room' });
      setSummary(run.output.draft.summary);
      setSelected(undefined);
      onDrafted(run);
    } catch (e) {
      onError(e instanceof Error ? e : 'Scene draft failed.');
    } finally {
      setDrafting(false);
    }
  }

  return (
    <div className="scene-editor">
      <div className="scene-editor-tools">
        <label className="iso-surface-pick">
          <span className="tiny">START FROM</span>
          <select
            aria-label="Start from"
            value={startFrom}
            onChange={(e) => {
              const from = e.target.value as StartFrom;
              setStartFrom(from);
              if (from === 'camera') void setUp();
              else start(from);
            }}
          >
            {canSetUp && (
              <option value="camera">
                {mode === 'demo' ? 'Demo camera' : cameraLive ? 'Current camera' : 'Current frame'}
              </option>
            )}
            {(Object.keys(ISO_PRESETS) as IsoSceneKind[]).map((k) => (
              <option key={k} value={k}>
                {ISO_PRESETS[k].label} preset
              </option>
            ))}
            <option value="empty">Empty floor</option>
            {!canSetUp && startFrom === 'camera' && <option value="camera">Choose…</option>}
          </select>
        </label>
        {(['w', 'd'] as const).map((k) => (
          <label key={k} className="iso-surface-pick">
            <span className="tiny">{k === 'w' ? 'WIDTH' : 'DEPTH'}</span>
            <input
              type="number"
              min={2}
              max={16}
              value={draft.grid[k]}
              aria-label={`Grid ${k === 'w' ? 'width' : 'depth'}`}
              onChange={(e) => {
                const v = Math.max(2, Math.min(16, Math.round(Number(e.target.value) || 2)));
                setDraft({ ...draft, grid: { ...draft.grid, [k]: v } });
              }}
            />
          </label>
        ))}
        <button
          className="secondary"
          disabled={busy || drafting}
          title="Turn the whole room a quarter clockwise, to face the way the camera sees it. The back and left walls stay put."
          onClick={() => {
            setDraft(rotateScene(draft));
            setSelected(undefined);
            setTurned((t) => (t + 1) % 4);
          }}
        >
          ↻ Rotate scene
        </button>
        <button
          className="secondary"
          disabled={busy || drafting || !canSetUp}
          onClick={() => void askSpark()}
        >
          {drafting ? 'Drafting…' : 'Draft with Spark'}
        </button>
      </div>
      <div
        className="scene-editor-tools photo-start"
        role="group"
        aria-label="Scene from the camera"
      >
        <span className="tiny">FROM THE CAMERA</span>
        <button
          className="primary"
          disabled={busy || drafting || !canSetUp}
          title="Spark sizes the room, SAM finds its walls, the camera is calibrated and the scene drafted through it, for you to review."
          onClick={() => void setUp()}
        >
          {drafting ? 'Working…' : 'Set up from the camera'}
        </button>
        {mode === 'demo' ? (
          <button
            className="secondary"
            disabled={busy || drafting}
            onClick={() => void fromPhoto()}
          >
            Draft from the demo camera
          </button>
        ) : !memory?.camera ? (
          <span className="tiny">
            {image || cameraLive
              ? 'Or calibrate the corner camera by hand first, then draft through it.'
              : 'Capture a frame from the room’s corner camera to set it up.'}
          </span>
        ) : (
          <>
            <button
              className="primary"
              disabled={busy || drafting || !onUpload}
              onClick={() => file.current?.click()}
            >
              {drafting ? 'Drafting…' : 'Upload a frame'}
            </button>
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
                if (url) await fromPhoto(url);
              }}
            />
            <button
              className="secondary"
              disabled={busy || drafting || !canSetUp}
              onClick={() => void fromPhoto(captureFrame?.().url ?? image)}
            >
              Use the current frame
            </button>
          </>
        )}
        <label className="photo-check">
          <input
            type="checkbox"
            checked={sparkCheck}
            onChange={(e) => setSparkCheck(e.target.checked)}
          />
          <span>Spark checks the drawing</span>
        </label>
        <span className="tiny">
          {mode === 'demo'
            ? 'Demo: no model calls.'
            : `${sparkCheck ? 3 : 2} billed calls: Spark lists, SAM outlines${sparkCheck ? ', Spark checks' : ''}.`}
        </span>
      </div>
      <div className="scene-editor-body">
        <div className="scene-canvas">
          <IsoScene
            scene={draft}
            litLights={new Set(lamp?.lightId ? [lamp.lightId] : [])}
            editing={{
              selected,
              flagged,
              onSelect: setSelected,
              onMove: (g, dx, dy) => setDraft((d) => settleGroup(moveGroup(d, g, dx, dy), g)),
            }}
          />
        </div>
      </div>
      <div className="scene-selected">
        <PropPickerPopover
          scene={draft}
          onAdd={(id) => {
            const next = addTemplate(draft, id);
            setDraft(next.scene);
            setSelected(next.group);
          }}
        />
        {selected && bounds ? (
          <>
            <span className="tiny">
              {groupLabel(draft, selected).toUpperCase()} · {bounds.at.x.toFixed(2)},{' '}
              {bounds.at.y.toFixed(2)}
              {bounds.at.z > 0 ? ` · ON ${bounds.at.z.toFixed(1)}` : ''}
            </span>
            <button
              className="secondary"
              onClick={() => setDraft((d) => settleGroup(rotateGroup(d, selected), selected))}
            >
              Turn
            </button>
            <button
              className="secondary"
              onClick={() => {
                setDraft((d) => removeGroup(d, selected));
                setSelected(undefined);
              }}
            >
              Remove
            </button>
            {lamp && (
              <label className="iso-surface-pick">
                <span className="tiny">LIGHT</span>
                <select
                  aria-label="Lamp light"
                  value={lamp.lightId ?? ''}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      props: d.props.map((p) =>
                        p.group === selected && p.role === 'lamp'
                          ? { ...p, lightId: e.target.value || undefined }
                          : p,
                      ),
                    }))
                  }
                >
                  <option value="">Main light</option>
                  {lights.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        ) : (
          <span className="tiny">Pick a prop to move, turn or remove it. Drag to move.</span>
        )}
      </div>
      <p className="iso-note" role="status">
        {!check.success
          ? (check.error.issues[0]?.message ?? 'This scene does not fit its grid.')
          : flagged.size
            ? `${flagged.size} props cut into each other and may draw out of order. Move them apart.`
            : turned % 2 && memory?.camera
              ? 'Turned. The camera was calibrated for the room the other way round: save, then calibrate it again so it sees the room this way.'
              : turned
                ? `Turned ${turned === 2 ? 'half way' : 'a quarter'}. Save to keep it.`
                : summary
                  ? `Spark: ${summary} Review it, then save.`
                  : saved && !showsSaved
                    ? `Saving replaces your custom scene${saved.label ? ` “${saved.label}”` : ''}. It shows up as Custom in the room view, ready to pin.`
                    : 'Saved scenes show up as Custom in the room view, ready to pin.'}
      </p>
      <div className="item-actions">
        <button
          className="primary"
          disabled={busy || !dirty || !check.success}
          onClick={() => onSave(draft)}
        >
          Save scene
        </button>
        <button
          className="secondary"
          disabled={busy || !dirty}
          onClick={() => {
            setTurned(0);
            setDraft(initial());
          }}
        >
          Revert
        </button>
        {saved && (
          <button className="secondary" disabled={busy} onClick={() => onSave(null)}>
            Remove custom scene
          </button>
        )}
      </div>
    </div>
  );
}
