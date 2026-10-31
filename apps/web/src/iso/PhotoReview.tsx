import { useMemo, useState } from 'react';
import {
  ARCHETYPES,
  PROP_TEMPLATES,
  TEMPLATE_IDS,
  itemHeight,
  layoutRoom,
  sceneForSave,
  type DeskMemory,
  type EvidenceRun,
  type Mode,
  type PhotoAs,
  type PhotoDraft,
  type PhotoEdit,
  type PlacedThing,
} from '@livinglayer/domain';
import { api } from '../api';
import { IsoScene, type IsoObject } from './IsoScene';
import { Button, Check } from '../ui/controls';

export type PhotoRun = EvidenceRun<PhotoDraft>;
const STATUS: Record<PlacedThing['status'], string> = {
  placed: 'placed',
  object: 'object',
  'not-found': 'not outlined',
  unplaced: 'outside the room',
  removed: 'removed',
};
const pct = (n: number | null | undefined) => (n == null ? '–' : `${Math.round(n * 100)}%`);

/**
 * Review a scene drafted from a frame of the room's camera before anything is
 * saved. Left: the frame with SAM's outlines and the main surface as the
 * calibrated camera sees it. Right: the scene as drafted, with each object's
 * fitted model.
 * Below: one row per thing, to change what it is drawn as, remove it, or
 * track it. The layout is pure code, so every change is laid out again here.
 */
export function PhotoReview({
  mode,
  run,
  photoUrl,
  memory,
  busy,
  onSaved,
  onCancel,
  onError,
}: {
  mode: Mode;
  run: PhotoRun;
  photoUrl: string;
  memory?: DeskMemory;
  busy: boolean;
  onSaved: (memory: DeskMemory) => void;
  onCancel: () => void;
  onError: (error: string | Error) => void;
}) {
  const draft = run.output;
  const frame = draft.segmentation.frame;
  const [edits, setEdits] = useState<Record<string, PhotoEdit>>({});
  const [track, setTrack] = useState<string[]>(() => {
    // Nothing remembered yet: offer the first mug as the main object.
    if (memory?.object) return [];
    const mug = draft.layout.things.find(
      (t) => t.status === 'object' && (t.as === 'mug' || t.as === 'cup'),
    );
    return mug ? [mug.id] : [];
  });
  const [saving, setSaving] = useState(false);
  const layout = useMemo(
    () =>
      // Through the room's calibrated camera, as the draft was: the pin follows from it.
      Object.keys(edits).length === 0
        ? draft.layout
        : layoutRoom({
            inventory: draft.inventory,
            segmentation: draft.segmentation,
            detections: draft.detections,
            edits,
            calibration: draft.calibration,
          }),
    [draft, edits],
  );
  const shown = layout.pin?.corners ?? null;
  const tracked = track.filter((id) =>
    layout.things.some((t) => t.id === id && t.detectionId && t.status !== 'removed'),
  );
  const objects: IsoObject[] = layout.things
    .filter((t) => t.status === 'object' && t.foot)
    .map((t) => {
      const item = draft.items[t.id];
      const box = item
        ? { ...t.foot!, size: { ...t.foot!.size, h: itemHeight(item) * t.foot!.size.w } }
        : t.foot!;
      return { id: t.id, box, label: t.label, item, unsure: !tracked.includes(t.id) };
    });
  const byDetection = new Map(draft.segmentation.detections.map((d) => [d.objectId, d]));

  function edit(id: string, change: PhotoEdit) {
    setEdits((e) => ({ ...e, [id]: { ...e[id], ...change } }));
  }
  async function save() {
    setSaving(true);
    try {
      const saved = await api<DeskMemory>('scene/from-photo/save', {
        mode,
        runId: run.id,
        scene: sceneForSave(layout, tracked),
        pin: layout.pin,
        track: tracked,
      });
      onSaved(saved);
    } catch (e) {
      onError(e instanceof Error ? e : 'The scene could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  const surfaceLabel = layout.things.find((t) => t.id === layout.surfaceThing)?.label;
  return (
    <div className="photo-review">
      <div className="photo-review-body">
        <figure className="photo-review-photo">
          <img src={photoUrl} alt="The photo the scene was drafted from" />
          <svg
            viewBox={`0 0 ${frame.width} ${frame.height}`}
            preserveAspectRatio="none"
            aria-label="SAM outlines and the main surface"
          >
            {layout.things.map((t) => {
              const d = t.detectionId ? byDetection.get(t.detectionId) : undefined;
              if (!d) return null;
              return (
                <path
                  key={t.id}
                  className={`photo-mask ${t.status} ${tracked.includes(t.id) ? 'tracked' : ''}`}
                  d={d.mask.svgPath}
                  fillRule="evenodd"
                  transform={`translate(${d.box.x} ${d.box.y}) scale(${d.box.width / d.mask.width} ${d.box.height / d.mask.height})`}
                  vectorEffect="non-scaling-stroke"
                >
                  <title>{t.label}</title>
                </path>
              );
            })}
            {shown && (
              <polygon
                className="photo-pin"
                points={shown.map((c) => `${c.x},${c.y}`).join(' ')}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        </figure>
        <div className="scene-canvas">
          <IsoScene scene={layout.scene} objects={objects} />
        </div>
      </div>
      <table className="photo-things">
        <thead>
          <tr>
            <th scope="col">Thing</th>
            <th scope="col">Drawn as</th>
            <th scope="col">Match</th>
            <th scope="col">Track</th>
            <th scope="col" aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {layout.things.map((t) => {
            const main = tracked[0] === t.id;
            return (
              <tr key={t.id} className={t.status}>
                <td>
                  {t.label}
                  <small>
                    {t.id === layout.surfaceThing ? 'pinned surface' : STATUS[t.status]}
                  </small>
                </td>
                <td>
                  <select
                    aria-label={`Draw ${t.label} as`}
                    value={t.as}
                    disabled={t.status === 'removed' || t.status === 'not-found'}
                    onChange={(e) => edit(t.id, { as: e.target.value as PhotoAs })}
                  >
                    <optgroup label="Templates">
                      {TEMPLATE_IDS.map((id) => (
                        <option key={id} value={id}>
                          {PROP_TEMPLATES[id].label}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Object models">
                      {ARCHETYPES.filter((a) => !(a in PROP_TEMPLATES)).map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </td>
                <td>{pct(t.iou)}</td>
                <td>
                  {t.detectionId && t.status !== 'removed' && t.id !== layout.surfaceThing ? (
                    <Check
                      checked={tracked.includes(t.id)}
                      onChange={(on) =>
                        setTrack((list) => (on ? [...list, t.id] : list.filter((x) => x !== t.id)))
                      }
                    >
                      {main ? 'main' : tracked.includes(t.id) ? 'yes' : ''}
                    </Check>
                  ) : null}
                </td>
                <td>
                  {t.status !== 'not-found' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => edit(t.id, { removed: t.status !== 'removed' })}
                    >
                      {t.status === 'removed' ? 'Restore' : 'Remove'}
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="iso-note" role="status">
        {layout.pin
          ? `The ${surfaceLabel} is pinned where the room’s camera sees it. Scene match ${pct(layout.score)}.`
          : `Scene match ${pct(layout.score)}. No desk or table in view to pin.`}{' '}
        {tracked.length
          ? `The first ticked object becomes the main one${memory?.object ? ` (${memory.object.label})` : ''}.`
          : 'Tick the objects to track.'}
      </p>
      <details className="photo-assists">
        <summary className="tiny">WHAT EACH MODEL DID</summary>
        <ol>
          {draft.assists.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
          {draft.check?.extra.length ? (
            <li>Spark thinks these are not in the photo: {draft.check.extra.join(', ')}</li>
          ) : null}
        </ol>
      </details>
      <div className="item-actions">
        <Button
          variant="primary"
          disabled={busy}
          busy={saving && 'Saving…'}
          onClick={() => void save()}
        >
          {`Save scene${tracked.length ? ` and track ${tracked.length}` : ''}`}
        </Button>
        <Button disabled={busy || saving} onClick={onCancel}>
          Discard draft
        </Button>
      </div>
    </div>
  );
}
