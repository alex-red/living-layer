import { useEffect, useState } from 'react';
import {
  DEMO_SURFACE,
  ISO_PRESETS,
  fixtureBox,
  guessedScene,
  closeViewOf,
  itemHeight,
  modelTarget,
  pinFits,
  rotateItem,
  projectBox,
  surfaceMap,
  zoneFromSurface,
  zoneOnSurface,
  type DeskMemory,
  type DeskObservation,
  type EvidenceRun,
  type FixtureInput,
  type IsoItem,
  type IsoScene as Scene,
  type IsoSurface,
  type Mode,
  type SavedItem,
  type SceneGuess,
  type SurfacePin,
  type ZoneRect,
} from '@livinglayer/domain';
import { api } from '../api';
import { IsoScene, type IsoFixture, type IsoObject, type IsoZone } from './IsoScene';
import { ItemEditor } from './ItemEditor';
import { SceneEditor, type LayoutRun } from './SceneEditor';
import type { PhotoRun } from './PhotoReview';
import { pinScene, type WorkScene as Kind } from '../workspace/progress';
import './iso.css';

/** What the iso canvas shows: the room, the layout editor, or an object's model. */
export type IsoPanel = 'room' | 'scene' | 'item';
/** A rule being set up; its zone is dragged out on the iso surface. */
export interface RuleDraft {
  objectId: string;
  entityId: string;
  label: string;
  rect: ZoneRect | null;
}

/** A fixture waiting to be put down: everything about it but where it stands. */
export type FixturePlacing = Omit<FixtureInput, 'at' | 'surfaceId'>;

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
  kind,
  onKind,
  panel,
  onPanel,
  surfaceId,
  onSurfaceId,
  modelOf,
  guess,
  ruleDraft,
  onRuleDraft,
  placing,
  onPlace,
  onFixture,
  focus,
  layers = { trail: true, zones: true },
  memory,
  image,
  lights,
  lampOn,
  drawing,
  zone,
  busy,
  onDraftZone,
  onRun,
  onMemory,
  onUpload,
  onMessage,
  onError,
}: {
  mode: Mode;
  /** The scene the person chose to work on. */
  kind: Kind;
  onKind: (kind: Kind) => void;
  panel: IsoPanel;
  onPanel: (panel: IsoPanel) => void;
  /** The surface the person picked; the pinned one when unset. */
  surfaceId?: string;
  onSurfaceId: (id: string) => void;
  /** Whose model the item editor shows; the mug when unset. */
  modelOf?: string;
  /** Spark's guess of the preset, which may switch props on or off. */
  guess: SceneGuess | null;
  ruleDraft: RuleDraft | null;
  onRuleDraft: (draft: RuleDraft | null) => void;
  /** A fixture to put down with a click in the room. */
  placing?: FixturePlacing | null;
  onPlace?: (where: { at: { x: number; y: number }; surfaceId: string | null }) => void;
  /** A click on a fixture in the room. */
  onFixture?: (id: string) => void;
  /** What the outline has selected, ringed in the room: `tracked` is the mug, `main` its zone. */
  focus?: { object?: string; zone?: string; fixture?: string };
  /** Which canvas layers show: the mug's trail, and saved zones (a draft always shows). */
  layers?: { trail: boolean; zones: boolean };
  memory?: DeskMemory;
  /** The current live photo, for asking Spark about the scene. */
  image?: string;
  /** Lights rules may switch; the first is the main lamp. */
  lights: string[];
  lampOn: boolean;
  drawing: boolean;
  /** The saved zone, or the draft while drawing, in frame coordinates. */
  zone?: ZoneRect;
  busy: boolean;
  onDraftZone: (zone: ZoneRect) => void;
  onRun: (
    run: EvidenceRun<SceneGuess | SavedItem | LayoutRun['output'] | PhotoRun['output']>,
  ) => void;
  onMemory: (memory: DeskMemory) => void;
  /** Prepare a chosen photo as the current frame, and return it. */
  onUpload?: (file: File) => Promise<string | undefined>;
  onMessage: (message: string) => void;
  onError: (error: string | Error) => void;
}) {
  const pin = memory?.surface ?? (mode === 'demo' ? DEMO_SURFACE : null);
  const [asking, setAsking] = useState(false);
  // A new scene or pin starts on the pinned surface when it is in this scene.
  useEffect(() => {
    if (pin && pinFits(pin, pinScene(kind))) onSurfaceId(pin.surfaceId);
  }, [kind, pin?.scene, pin?.surfaceId]);

  const custom = memory?.scene ?? null;
  const scene: Scene =
    kind === 'custom'
      ? (custom ?? ISO_PRESETS.desk)
      : kind === 'custom-desk'
        ? ((custom && closeViewOf(custom)) ?? ISO_PRESETS.desk)
        : guess?.kind === kind
          ? guessedScene(guess)
          : ISO_PRESETS[kind];
  const surface =
    scene.surfaces.find((s) => s.id === (surfaceId ?? pin?.surfaceId ?? 'desk:top')) ??
    scene.surfaces[0];
  const pinned = Boolean(
    surface && pin && pinFits(pin, pinScene(kind)) && pin.surfaceId === surface.id,
  );
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
  if (!layers.trail) trail.length = 0;
  if (!layers.zones)
    zones.splice(
      0,
      zones.length,
      ...zones.filter((z) => z.kind === 'draft' || (drawing && z.kind === 'main')),
    );
  for (const o of objects) o.focused = o.id === focus?.object;
  for (const z of zones) z.focused = z.id === focus?.zone;
  const lit = new Set<string>();
  if (lampOn && defaultLight) lit.add(defaultLight);
  for (const rule of memory?.rules ?? [])
    if (rule.placement === 'inside' && rule.lastDecision?.output.action === 'confirmed')
      lit.add(rule.entityId);
  const drawingRule = Boolean(ruleDraft && ruleMap);
  // Fixtures in this scene; one being moved is drawn only where the pointer is.
  const fixtures: IsoFixture[] = (memory?.fixtures ?? [])
    .filter((f) => f.scene === kind && f.id !== placing?.id)
    .map((f) => ({
      id: f.id,
      label: f.label,
      box: fixtureBox(f, custom),
      item: rotateItem(f.model, f.turns),
      glow: f.control.kind === 'light' && f.state === 'on',
      ...(f.control.kind === 'none' ? {} : { state: f.state ?? null }),
      focused: f.id === focus?.fixture,
    }));
  const turned = placing ? placing.turns % 2 === 1 : false;

  const target = memory ? modelTarget(memory, modelOf) : null;

  async function send<T>(path: string, body: object, done: (r: T) => void) {
    setAsking(true);
    try {
      done(await api<T>(path, { mode, ...body }));
    } catch (e) {
      onError(e instanceof Error ? e : 'The request failed.');
    } finally {
      setAsking(false);
    }
  }
  const off = busy || asking;

  return (
    <div className="iso-view">
      <div className={`iso-frame ${panel === 'item' || panel === 'scene' ? 'editing' : ''}`}>
        {panel === 'item' ? (
          <ItemEditor
            key={target?.id}
            item={target?.item}
            busy={off}
            sparkNote={
              mode === 'demo'
                ? 'Demo: no model call. Drafts fit the illustrated mug’s own pixels.'
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
              onKind('custom');
              if (m.surface?.scene === 'custom') onSurfaceId(m.surface.surfaceId);
              onPanel('room');
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
                  onKind('custom');
                  onSurfaceId(
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
            fixtures={fixtures}
            onFixture={onFixture}
            placing={
              placing && onPlace && placing.scene === kind
                ? {
                    label: placing.label,
                    item: rotateItem(placing.model, placing.turns),
                    size: {
                      w: turned ? placing.size.d : placing.size.w,
                      d: turned ? placing.size.w : placing.size.d,
                      h: placing.size.h,
                    },
                    onPlace,
                  }
                : undefined
            }
            trail={trail}
            zones={zones}
            litLights={lit}
            defaultLight={defaultLight}
            drawing={drawingRule || (drawing && Boolean(mug))}
            onDrag={(a, b) => {
              if (drawingRule && ruleTarget && ruleMap) {
                const rect = zoneFromSurface(a, b, ruleTarget.frame, ruleMap.toFrame);
                if (rect && ruleDraft) onRuleDraft({ ...ruleDraft, rect });
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
              : `ISO · ${scene.label.toUpperCase()} · ${surface?.label.toUpperCase() ?? 'NO SURFACE'}${pinned ? (memory?.surface ? ' · PINNED' : ' · DEMO') : ''}`}
        </span>
      </div>
      {panel === 'room' && (
        <p className="iso-note" role="status">
          {ruleDraft && !ruleMap
            ? 'Pin a surface for the frame this object was seen in, then draw its zone.'
            : note ||
              (guess?.kind === kind
                ? `Spark: ${guess.summary}`
                : guess
                  ? `Spark guessed ${ISO_PRESETS[guess.kind].label}, not this scene. Change the scene to use its guess.`
                  : 'Placement is still decided on the photo. This view only shows it in the room.')}
        </p>
      )}
    </div>
  );
}
