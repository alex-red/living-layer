import { useEffect, useRef, useState } from 'react';
import {
  ISO_PRESETS,
  PROP_TEMPLATES,
  TEMPLATE_IDS,
  addTemplate,
  groupBounds,
  isoSceneSchema,
  moveGroup,
  overlappingGroups,
  removeGroup,
  rotateGroup,
  settleGroup,
  type EvidenceRun,
  type IsoScene as Scene,
  type IsoSceneKind,
  type Mode,
  type SceneDraft,
  type TemplateId,
  type DeskMemory,
} from '@livinglayer/domain';
import { api } from '../api';
import { IsoScene } from './IsoScene';
import { PhotoReview, type PhotoRun } from './PhotoReview';

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
}: {
  mode: Mode;
  /** The person's saved scene, if any. */
  saved: Scene | null | undefined;
  /** What the room view shows now, to start from. */
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
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Scene>(saved ?? asCustom(base));
  const [selected, setSelected] = useState<string>();
  const [summary, setSummary] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [photo, setPhoto] = useState<{ run: PhotoRun; url: string } | null>(null);
  const [sparkCheck, setSparkCheck] = useState(true);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (saved) setDraft(saved);
  }, [saved]);
  const flagged = overlappingGroups(draft);
  const check = isoSceneSchema.safeParse(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved ?? null);
  const groupProps = selected ? draft.props.filter((p) => p.group === selected) : [];
  const lamp = groupProps.find((p) => p.role === 'lamp');
  const bounds = selected ? groupBounds(draft, selected) : null;

  function start(from: IsoSceneKind | 'empty') {
    setDraft(from === 'empty' ? EMPTY : asCustom(ISO_PRESETS[from]));
    setSelected(undefined);
    setSummary('');
  }
  /** Spark lists what is in the photo, SAM outlines it, and the layout measures the rest. */
  async function fromPhoto(url?: string) {
    if (mode === 'live' && !url) return;
    setDrafting(true);
    try {
      const run = await api<PhotoRun>('scene/from-photo', {
        mode,
        check: sparkCheck,
        ...(mode === 'live' ? { imageDataUrl: url } : {}),
      });
      setPhoto({ run, url: mode === 'live' ? url! : '/desk.svg' });
      onDrafted(run);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'The photo could not be drafted.');
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
    setDrafting(true);
    try {
      const run = await api<LayoutRun>('scene/draft', {
        mode,
        ...(mode === 'live' ? { imageDataUrl: image } : {}),
      });
      setDraft({ ...run.output.scene, label: 'Drafted room' });
      setSummary(run.output.draft.summary);
      setSelected(undefined);
      onDrafted(run);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Scene draft failed.');
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
            value=""
            onChange={(e) => e.target.value && start(e.target.value as IsoSceneKind | 'empty')}
          >
            <option value="">Choose…</option>
            {(Object.keys(ISO_PRESETS) as IsoSceneKind[]).map((k) => (
              <option key={k} value={k}>
                {ISO_PRESETS[k].label} preset
              </option>
            ))}
            <option value="empty">Empty floor</option>
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
          disabled={busy || drafting || (mode === 'live' && !image)}
          onClick={() => void askSpark()}
        >
          {drafting ? 'Drafting…' : 'Draft with Spark'}
        </button>
      </div>
      <div className="scene-editor-tools photo-start" role="group" aria-label="Scene from a photo">
        <span className="tiny">FROM A PHOTO</span>
        {mode === 'fixture' ? (
          <button className="primary" disabled={busy || drafting} onClick={() => void fromPhoto()}>
            {drafting ? 'Drafting…' : 'Draft from the illustrated desk'}
          </button>
        ) : (
          <>
            <button
              className="primary"
              disabled={busy || drafting || !onUpload}
              onClick={() => file.current?.click()}
            >
              {drafting ? 'Drafting…' : 'Upload a photo'}
            </button>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg"
              hidden
              aria-label="Photo to draft a scene from"
              onChange={async (e) => {
                const chosen = e.target.files?.[0];
                e.target.value = '';
                const url = chosen && onUpload ? await onUpload(chosen) : undefined;
                if (url) await fromPhoto(url);
              }}
            />
            <button
              className="secondary"
              disabled={busy || drafting || !image}
              onClick={() => void fromPhoto(image)}
            >
              Use the current photo
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
          {mode === 'fixture'
            ? 'Fixture: no model calls.'
            : `${sparkCheck ? 3 : 2} billed calls: Spark lists, SAM outlines${sparkCheck ? ', Spark checks' : ''}.`}
        </span>
      </div>
      <div className="scene-editor-body">
        <div className="scene-palette" role="group" aria-label="Add a prop">
          <span className="tiny">ADD</span>
          {TEMPLATE_IDS.map((id: TemplateId) => (
            <button
              key={id}
              className="secondary"
              onClick={() => {
                const next = addTemplate(draft, id);
                setDraft(next.scene);
                setSelected(next.group);
              }}
            >
              + {PROP_TEMPLATES[id].label}
            </button>
          ))}
        </div>
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
            : summary
              ? `Spark: ${summary} Review it, then save.`
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
          onClick={() => setDraft(saved ?? asCustom(base))}
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
