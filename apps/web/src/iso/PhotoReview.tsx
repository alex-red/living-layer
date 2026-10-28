import { useMemo, useRef, useState } from 'react';
import {
  ARCHETYPES,
  PROP_TEMPLATES,
  TEMPLATE_IDS,
  itemHeight,
  layoutPhoto,
  quadIsConvex,
  sceneForSave,
  type DeskMemory,
  type EvidenceRun,
  type Mode,
  type PhotoAs,
  type PhotoDraft,
  type PhotoEdit,
  type PlacedThing,
  type Quad,
} from '@livinglayer/domain';
import { api } from '../api';
import { IsoScene, type IsoObject } from './IsoScene';

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
 * Review a scene drafted from a photo before anything is saved. Left: the
 * photo with SAM's outlines and the pinned surface's corners, which can be
 * dragged. Right: the scene as drafted, with each object's fitted model.
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
  onError: (message: string) => void;
}) {
  const draft = run.output;
  const frame = draft.segmentation.frame;
  const [edits, setEdits] = useState<Record<string, PhotoEdit>>({});
  const [corners, setCorners] = useState<Quad | null>(draft.layout.pin?.corners ?? null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [track, setTrack] = useState<string[]>(() => {
    // Nothing remembered yet: offer the first mug as the main object.
    if (memory?.object) return [];
    const mug = draft.layout.things.find(
      (t) => t.status === 'object' && (t.as === 'mug' || t.as === 'cup'),
    );
    return mug ? [mug.id] : [];
  });
  const [saving, setSaving] = useState(false);
  const svg = useRef<SVGSVGElement>(null);

  const moved =
    JSON.stringify(corners) !== JSON.stringify(draft.layout.pin?.corners ?? null) ||
    Object.keys(edits).length > 0;
  const layout = useMemo(
    () =>
      moved
        ? layoutPhoto({
            inventory: draft.inventory,
            segmentation: draft.segmentation,
            detections: draft.detections,
            corners,
            edits,
            // Refining while a corner is dragged would make the drag lag.
            refine: dragging === null,
          })
        : draft.layout,
    [draft, corners, edits, dragging, moved],
  );
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

  function point(e: React.PointerEvent) {
    const m = svg.current?.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return {
      x: Math.max(0, Math.min(frame.width, p.x)),
      y: Math.max(0, Math.min(frame.height, p.y)),
    };
  }
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
      onError(e instanceof Error ? e.message : 'The scene could not be saved.');
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
            ref={svg}
            viewBox={`0 0 ${frame.width} ${frame.height}`}
            preserveAspectRatio="none"
            aria-label="SAM outlines and the pinned surface"
            onPointerMove={(e) => {
              if (dragging === null || !corners) return;
              const p = point(e);
              if (!p) return;
              const next = corners.map((c, i) => (i === dragging ? p : c)) as Quad;
              if (quadIsConvex(next, (frame.width * frame.height) / 400)) setCorners(next);
            }}
            // Grab the nearest corner from anywhere close by: a corner on the photo's edge
            // has half its handle outside the picture.
            onPointerDown={(e) => {
              const p = point(e);
              if (!p || !corners) return;
              const reach = Math.max(frame.width, frame.height) / 20;
              const near = corners
                .map((c, i) => ({ i, d: Math.hypot(c.x - p.x, c.y - p.y) }))
                .sort((a, b) => a.d - b.d)[0]!;
              if (near.d > reach) return;
              e.currentTarget.setPointerCapture?.(e.pointerId);
              setDragging(near.i);
            }}
            onPointerUp={() => setDragging(null)}
            onPointerLeave={() => setDragging(null)}
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
            {corners && (
              <>
                <polygon
                  className="photo-pin"
                  points={corners.map((c) => `${c.x},${c.y}`).join(' ')}
                  vectorEffect="non-scaling-stroke"
                />
                {corners.map((c, i) => (
                  <circle
                    key={i}
                    className={`photo-corner ${dragging === i ? 'active' : ''}`}
                    cx={c.x}
                    cy={c.y}
                    r={Math.max(frame.width, frame.height) / 70}
                    role="slider"
                    aria-label={`Pin corner ${i + 1}`}
                    aria-valuetext={`${Math.round(c.x)}, ${Math.round(c.y)}`}
                  />
                ))}
              </>
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
                    <label className="photo-track">
                      <input
                        type="checkbox"
                        checked={tracked.includes(t.id)}
                        onChange={(e) =>
                          setTrack((list) =>
                            e.target.checked ? [...list, t.id] : list.filter((x) => x !== t.id),
                          )
                        }
                      />
                      <span>{main ? 'main' : tracked.includes(t.id) ? 'yes' : ''}</span>
                    </label>
                  ) : null}
                </td>
                <td>
                  {t.status !== 'not-found' && (
                    <button
                      className="link"
                      onClick={() => edit(t.id, { removed: t.status !== 'removed' })}
                    >
                      {t.status === 'removed' ? 'Restore' : 'Remove'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="iso-note" role="status">
        {layout.pin
          ? `Pinned the ${surfaceLabel} (camera ${Math.round(layout.camera!.elevation)}° up${layout.camera!.focalGuessed ? ', lens guessed' : ''}). Scene match ${pct(layout.score)}. Drag a corner if the pin is off.`
          : 'No surface could be pinned, so things are spread by where they are in the photo. Save, then pin a surface by hand.'}{' '}
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
        <button className="primary" disabled={busy || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : `Save scene${tracked.length ? ` and track ${tracked.length}` : ''}`}
        </button>
        <button className="secondary" disabled={busy || saving} onClick={onCancel}>
          Discard draft
        </button>
      </div>
    </div>
  );
}
