import { useEffect, useState } from 'react';
import {
  FIXTURE_SURFACE,
  ISO_PRESETS,
  guessedScene,
  isoSurface,
  itemHeight,
  modelTarget,
  projectBox,
  surfaceMap,
  zoneFromSurface,
  zoneOnSurface,
  type DeskMemory,
  type DeskObservation,
  type EvidenceRun,
  type IsoItem,
  type IsoSceneKind,
  type IsoScene as Scene,
  type IsoSurface,
  type Mode,
  type SavedItem,
  type SceneGuess,
  type Segmentation,
  type SurfacePin,
  type ZoneRect,
} from '@livinglayer/domain';
import { api } from '../api';
import { IsoScene, type IsoObject, type IsoZone } from './IsoScene';
import { ItemEditor } from './ItemEditor';
import { RulesPanel, type RuleDraft } from './RulesPanel';
import { SceneEditor, type LayoutRun } from './SceneEditor';
import type { PhotoRun } from './PhotoReview';
import './iso.css';

type Kind = IsoSceneKind | 'custom';
type Panel = 'room' | 'scene' | 'rules' | 'item';
const PANELS: { id: Panel; label: string }[] = [
  { id: 'room', label: 'Room' },
  { id: 'scene', label: 'Edit scene' },
  { id: 'rules', label: 'Objects & rules' },
  { id: 'item', label: 'Model' },
];

/** Where one sighting stands on the pinned surface, or null when the pin can't place it. */
function place(
  o: DeskObservation | null | undefined,
  pin: SurfacePin | null,
  surface: IsoSurface,
  pinned: boolean,
) {
  const map = pinned && pin && o ? surfaceMap(pin, o.frame) : null;
  return map && o ? { map, placed: projectBox(o.box, surface, map.toSurface) } : null;
}
/** A model stands as wide as the sighting's footprint, and as tall as its parts. */
function marker(
  id: string,
  label: string,
  placed: ReturnType<typeof projectBox>,
  item?: IsoItem | null,
): IsoObject {
  const box = item
    ? { ...placed.box, size: { ...placed.box.size, h: itemHeight(item) * placed.box.size.w } }
    : placed.box;
  return { id, box, item: item ?? undefined, label, unsure: !placed.onSurface };
}

/**
 * The desk memory drawn as an isometric scene. The pinned surface maps the
 * camera frame onto one surface, so the remembered objects, the mug's trail
 * and every zone land where they are in the room. It is a view, never a
 * verdict: placement is still decided on the frame.
 */
export function IsoView({
  mode,
  memory,
  image,
  segmentation,
  segmentRunId,
  lights,
  lampOn,
  drawing,
  zone,
  busy,
  onDraftZone,
  onPin,
  onClearPin,
  onRun,
  onMemory,
  onUpload,
  onMessage,
  onError,
}: {
  mode: Mode;
  memory?: DeskMemory;
  /** The current live photo, for asking Spark about the scene. */
  image?: string;
  /** The newest segmentation, for remembering and tracking more objects. */
  segmentation?: Segmentation;
  segmentRunId?: string;
  /** Lights rules may switch; the first is the main lamp. */
  lights: string[];
  lampOn: boolean;
  drawing: boolean;
  /** The saved zone, or the draft while drawing, in frame coordinates. */
  zone?: ZoneRect;
  busy: boolean;
  onDraftZone: (zone: ZoneRect) => void;
  onPin: (scene: Kind, surfaceId: string, label: string) => void;
  onClearPin: () => void;
  onRun: (
    run: EvidenceRun<SceneGuess | SavedItem | LayoutRun['output'] | PhotoRun['output']>,
  ) => void;
  onMemory: (memory: DeskMemory) => void;
  /** Prepare a chosen photo as the current frame, and return it. */
  onUpload?: (file: File) => Promise<string | undefined>;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
}) {
  const pin = memory?.surface ?? (mode === 'fixture' ? FIXTURE_SURFACE : null);
  const [kind, setKind] = useState<Kind>(pin?.scene ?? 'desk');
  const [surfaceId, setSurfaceId] = useState(pin?.surfaceId ?? 'desk:top');
  const [guess, setGuess] = useState<SceneGuess | null>(null);
  const [asking, setAsking] = useState(false);
  const [panel, setPanel] = useState<Panel>('room');
  const [modelOf, setModelOf] = useState<string>();
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  useEffect(() => {
    if (!pin) return;
    setKind(pin.scene);
    setSurfaceId(pin.surfaceId);
  }, [pin?.scene, pin?.surfaceId]);
  useEffect(() => {
    setGuess(null);
    setRuleDraft(null);
  }, [mode]);
  useEffect(() => {
    if (kind === 'custom' && !memory?.scene) setKind('desk');
  }, [kind, memory?.scene]);

  const custom = memory?.scene ?? null;
  const scene: Scene =
    kind === 'custom'
      ? (custom ?? ISO_PRESETS.desk)
      : guess?.kind === kind
        ? guessedScene(guess)
        : ISO_PRESETS[kind];
  const surface = isoSurface(kind, surfaceId, custom) ?? scene.surfaces[0];
  const pinned = Boolean(surface && pin?.scene === kind && pin.surfaceId === surface.id);
  const defaultLight = lights[0] ?? '';

  // The mug, then every other remembered object the pin can place.
  const objects: IsoObject[] = [];
  let note = '';
  const o = memory?.observation;
  const mug = surface ? place(o, pin, surface, pinned) : null;
  if (!surface) note = 'This scene has no surface to pin. Add a desk, table or shelf.';
  else if (!pinned)
    note = `Pin the ${surface.label.toLowerCase()} on a photo to place objects here.`;
  else if (!o) note = 'Confirm the mug in a segmentation to see it here.';
  else if (!mug)
    note = 'This frame is a different size from the one the corners were set on. Pin it again.';
  if (mug && memory?.object) {
    objects.push(marker('tracked', memory.object.label, mug.placed, memory.item));
    if (!mug.placed.onSurface)
      note = `The mug's box stands off the ${surface!.label.toLowerCase()}, so it is drawn at the edge.`;
  }
  for (const other of memory?.others ?? []) {
    const at = surface ? place(other.observation, pin, surface, pinned) : null;
    if (at) objects.push(marker(other.id, other.label, at.placed, other.item));
  }
  const trail =
    mug && o
      ? [o, ...(memory?.history ?? [])]
          .filter((h) => h.frame.width === o.frame.width && h.frame.height === o.frame.height)
          .map((h) => projectBox(h.box, surface!, mug.map.toSurface).foot)
      : [];
  const zones: IsoZone[] = [];
  if (mug && o && zone)
    zones.push({ id: 'main', kind: 'main', quad: zoneOnSurface(zone, o.frame, mug.map.toSurface) });
  for (const rule of memory?.rules ?? []) {
    const map = pinned && pin ? surfaceMap(pin, rule.zone.frame) : null;
    if (map)
      zones.push({
        id: rule.id,
        kind: 'rule',
        label: rule.label,
        inside: rule.placement === 'inside',
        quad: zoneOnSurface(rule.zone.rect, rule.zone.frame, map.toSurface),
      });
  }
  // A rule's zone is drawn on the frame of its object's current sighting.
  const ruleTarget =
    ruleDraft && memory ? modelTarget(memory, ruleDraft.objectId)?.observation : null;
  const ruleMap = ruleTarget && pinned && pin ? surfaceMap(pin, ruleTarget.frame) : null;
  if (ruleDraft?.rect && ruleTarget && ruleMap)
    zones.push({
      id: 'draft',
      kind: 'draft',
      label: ruleDraft.label || 'New zone',
      quad: zoneOnSurface(ruleDraft.rect, ruleTarget.frame, ruleMap.toSurface),
    });
  const lit = new Set<string>();
  if (lampOn && defaultLight) lit.add(defaultLight);
  for (const rule of memory?.rules ?? [])
    if (rule.placement === 'inside' && rule.lastDecision?.output.action === 'confirmed')
      lit.add(rule.lightId);
  const drawingRule = panel === 'rules' && Boolean(ruleDraft && ruleMap);

  const target = memory ? modelTarget(memory, modelOf) : null;

  async function ask() {
    setAsking(true);
    try {
      const run = await api<EvidenceRun<SceneGuess>>('scene/classify', {
        mode,
        ...(mode === 'live' ? { imageDataUrl: image } : {}),
      });
      setGuess(run.output);
      setKind(run.output.kind);
      setSurfaceId(ISO_PRESETS[run.output.kind].surfaces[0]!.id);
      onRun(run);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Scene guess failed.');
    } finally {
      setAsking(false);
    }
  }
  async function send<T>(path: string, body: object, done: (r: T) => void) {
    setAsking(true);
    try {
      done(await api<T>(path, { mode, ...body }));
    } catch (e) {
      onError(e instanceof Error ? e.message : 'The request failed.');
    } finally {
      setAsking(false);
    }
  }
  const off = busy || asking;

  return (
    <div className="iso-view">
      <div className="iso-tools">
        <div className="iso-presets" role="group" aria-label="Scene preset">
          {([...Object.keys(ISO_PRESETS), ...(custom ? ['custom'] : [])] as Kind[]).map((k) => (
            <button
              key={k}
              aria-pressed={kind === k}
              onClick={() => {
                setKind(k);
                const next = k === 'custom' ? custom! : ISO_PRESETS[k];
                setSurfaceId(pin?.scene === k ? pin.surfaceId : (next.surfaces[0]?.id ?? ''));
              }}
            >
              {k === 'custom' ? 'Custom' : ISO_PRESETS[k].label}
            </button>
          ))}
        </div>
        {scene.surfaces.length > 1 && (
          <label className="iso-surface-pick">
            <span className="tiny">SURFACE</span>
            <select value={surface?.id} onChange={(e) => setSurfaceId(e.target.value)}>
              {scene.surfaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="iso-actions">
          <button
            className="secondary"
            disabled={off || (mode === 'live' && !image)}
            onClick={() => void ask()}
          >
            {asking ? 'Asking Spark…' : 'Guess scene'}
          </button>
          <button
            className="secondary"
            disabled={off || !surface || (mode === 'live' && !image)}
            onClick={() => surface && onPin(kind, surface.id, surface.label.toLowerCase())}
          >
            {pinned && memory?.surface ? 'Re-pin surface' : 'Pin surface'}
          </button>
          {memory?.surface && (
            <button className="secondary" disabled={off} onClick={onClearPin}>
              Clear pin
            </button>
          )}
        </span>
      </div>
      <div className="iso-panels" role="group" aria-label="Iso panel">
        {PANELS.map((p) => (
          <button
            key={p.id}
            aria-pressed={panel === p.id}
            disabled={p.id === 'item' && !memory?.object}
            onClick={() => {
              setPanel(p.id);
              if (p.id === 'item') setModelOf(undefined);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className={`iso-frame ${panel === 'item' || panel === 'scene' ? 'editing' : ''}`}>
        {panel === 'item' ? (
          <ItemEditor
            key={target?.id}
            item={target?.item}
            busy={off}
            sparkNote={
              mode === 'fixture'
                ? 'Fixture: no model call. Drafts fit the illustrated mug’s own pixels.'
                : 'A Spark draft makes up to four billed calls (Spark twice, SAM up to twice) and sends only the masked crop.'
            }
            cropUrl={
              target?.item?.fit?.crop
                ? `/api/item/crop?mode=${mode}${modelOf ? `&objectId=${modelOf}` : ''}&v=${encodeURIComponent(target.item.fit.crop)}`
                : null
            }
            onRefit={(item) =>
              void send<DeskMemory>(
                'item/refit',
                { item, ...(modelOf ? { objectId: modelOf } : {}) },
                onMemory,
              )
            }
            onDraft={(source) =>
              void send<{ run: EvidenceRun<SavedItem>; memory: DeskMemory }>(
                'item/draft',
                { source, ...(modelOf ? { objectId: modelOf } : {}) },
                (r) => {
                  onMemory(r.memory);
                  onRun(r.run);
                },
              )
            }
            onSave={(item) =>
              void send<DeskMemory>(
                'item/save',
                { item, ...(modelOf ? { objectId: modelOf } : {}) },
                onMemory,
              )
            }
          />
        ) : panel === 'scene' ? (
          <SceneEditor
            mode={mode}
            saved={custom}
            base={scene}
            image={image}
            lights={lights}
            busy={off}
            memory={memory}
            onDrafted={onRun}
            onUpload={onUpload}
            onPhotoSaved={(m) => {
              onMemory(m);
              setKind('custom');
              if (m.surface?.scene === 'custom') setSurfaceId(m.surface.surfaceId);
              setPanel('room');
              const n = (m.object ? 1 : 0) + (m.others?.length ?? 0);
              onMessage(
                `Scene saved from the photo${m.surface ? ', pinned' : ''}${n ? `, tracking ${n} object${n === 1 ? '' : 's'}` : ''}.`,
              );
            }}
            onError={onError}
            onSave={(next) =>
              void send<DeskMemory>('scene/save', { scene: next }, (m) => {
                onMemory(m);
                if (next) {
                  setKind('custom');
                  setSurfaceId(
                    m.surface?.scene === 'custom'
                      ? m.surface.surfaceId
                      : (next.surfaces[0]?.id ?? ''),
                  );
                }
                onMessage(
                  next
                    ? 'Scene saved. Pin one of its surfaces to place objects in it.'
                    : 'Custom scene removed.',
                );
              })
            }
          />
        ) : (
          <IsoScene
            scene={scene}
            surface={surface}
            objects={objects}
            trail={trail}
            zones={zones}
            litLights={lit}
            defaultLight={defaultLight}
            drawing={drawingRule || (drawing && Boolean(mug))}
            onDrag={(a, b) => {
              if (drawingRule && ruleTarget && ruleMap) {
                const rect = zoneFromSurface(a, b, ruleTarget.frame, ruleMap.toFrame);
                if (rect) setRuleDraft((d) => d && { ...d, rect });
                return;
              }
              if (!mug || !o) return;
              const next = zoneFromSurface(a, b, o.frame, mug.map.toFrame);
              if (next) onDraftZone(next);
            }}
          />
        )}
        <span className="iso-tag" aria-hidden="true">
          {panel === 'item'
            ? `ITEM · ${(target?.item?.label ?? target?.label ?? 'object').toUpperCase()}`
            : panel === 'scene'
              ? 'SCENE EDITOR'
              : `ISO · ${scene.label.toUpperCase()} · ${surface?.label.toUpperCase() ?? 'NO SURFACE'}${pinned ? (memory?.surface ? ' · PINNED' : ' · FIXTURE') : ''}`}
        </span>
      </div>
      {panel === 'rules' && (
        <RulesPanel
          mode={mode}
          memory={memory}
          segmentation={segmentation}
          segmentRunId={segmentRunId}
          lights={lights}
          busy={off}
          draft={ruleDraft}
          onDraft={setRuleDraft}
          onModel={(id) => {
            setModelOf(id === memory?.object?.id ? undefined : id);
            setPanel('item');
          }}
          onResult={(m, message) => {
            onMemory(m);
            onMessage(message);
          }}
          onError={onError}
        />
      )}
      {(panel === 'room' || panel === 'rules') && (
        <p className="iso-note" role="status">
          {ruleDraft && !ruleMap && panel === 'rules'
            ? 'Pin a surface for the frame this object was seen in, then draw its zone.'
            : note ||
              (guess?.kind === kind
                ? `Spark: ${guess.summary}`
                : 'Placement is still decided on the photo. This view only shows it in the room.')}
        </p>
      )}
    </div>
  );
}
