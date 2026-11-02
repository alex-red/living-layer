import { useEffect, useState } from 'react';
import {
  DEMO_SURFACE,
  believableWidth,
  ISO_PRESETS,
  fixtureBox,
  fixtureInput,
  fixtureModel,
  closeViewShift,
  inRoomView,
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
  type Fixture,
  type FixtureInput,
  type IsoItem,
  type IsoScene as Scene,
  type IsoSurface,
  type Mode,
  type SavedItem,
  type SceneGuess,
  type SurfacePin,
  type ZoneOnSurface,
  type ZoneRect,
  type CameraCrop,
} from '@livinglayer/domain';
import { api, type AiFollow } from '../api';
import { ZoomPan } from '../ZoomPan';
import type { BaseRect } from './BaseHandles';
import type { Tool } from '../workspace/ToolStrip';
import { IsoScene, type IsoFixture, type IsoObject, type IsoZone } from './IsoScene';
import { ItemEditor } from './ItemEditor';
import { IllustrationView } from './IllustrationView';
import { SceneEditor, type CalibrateByHand, type LayoutRun } from './SceneEditor';
import type { PhotoRun } from './PhotoReview';
import { pinScene, type WorkScene as Kind } from '../workspace/progress';
import './iso.css';

/** What the iso canvas shows: the room, the layout editor, or an object's model. */
export type IsoPanel = 'room' | 'scene' | 'item';
/** A rule being set up; its zone is dragged out on the iso surface. */
export interface RuleDraft {
  objectId: string;
  /** Empty for a zone that only tells Home Assistant. */
  entityId: string;
  label: string;
  rect: ZoneRect | null;
  /** Where in the room it was drawn, when it was drawn here. */
  onSurface?: ZoneOnSurface;
}
/** A zone being drawn: its frame rectangle, and where in the room when drawn in the room. */
export type DraftZone = ZoneRect & { onSurface?: ZoneOnSurface };

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
  const { at, size } = placed.box;
  const archetype = item && 'fit' in item ? (item as SavedItem).fit?.archetype : null;
  const w = believableWidth(size.w, label, archetype);
  // Shrunk or grown about the same footprint centre.
  const box = {
    at: { x: at.x + (size.w - w) / 2, y: at.y + (size.d - w) / 2, z: at.z },
    size: { w, d: w, h: item ? itemHeight(item) * w : size.h * (w / size.w) },
  };
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
  onMoveFixture,
  onFixtureMenu,
  onResizeFixture,
  tool = 'select',
  onAiEdit,
  hand = false,
  fixtureLook = 'picture',
  lightsOn,
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
  captureFrame,
  cameraLive = false,
  onCalibrateByHand,
  onCalibrateHere,
  follow,
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
  /** Move a fixture by dragging it on the room's picture. */
  onMoveFixture?: (id: string, to: { x: number; y: number; surfaceId: string | null }) => void;
  /** Right-click on a fixture, at the pointer in the window. */
  onFixtureMenu?: (id: string, at: { x: number; y: number }) => void;
  /** Stretch a fixture's base by its handles, to a footprint already turned. */
  onResizeFixture?: (id: string, rect: BaseRect) => Promise<void> | void;
  /** The canvas tool: fixtures move with Select, stretch with Scale. */
  tool?: Tool;
  /** Pick a prop of the saved room for the AI brush. */
  onAiEdit?: (scene: Scene, group: string) => void;
  /** Every drag pans the room, for the hand tool. */
  hand?: boolean;
  /** On the room's picture, fixtures as the picture shows them or as their models. */
  fixtureLook?: 'picture' | 'model';
  /** Lights whose last confirmed action turned them on, from any source. */
  lightsOn?: Set<string>;
  /** What the outline has selected, ringed in the room: `tracked` is the mug, `main` its zone. */
  focus?: { object?: string; zone?: string; fixture?: string };
  /**
   * Which canvas layers show: the mug's trail, saved zones (a draft always
   * shows), and the room's picture in place of its model when it has one.
   */
  layers?: { trail: boolean; zones: boolean; picture?: boolean };
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
  onDraftZone: (zone: DraftZone) => void;
  onRun: (
    run: EvidenceRun<SceneGuess | SavedItem | LayoutRun['output'] | PhotoRun['output']>,
  ) => void;
  onMemory: (memory: DeskMemory) => void;
  /** Prepare a chosen photo as the current frame, and return it. */
  onUpload?: (file: File) => Promise<string | undefined>;
  /** A frame from the live camera, captured now, or the current photo; with its zoomed view. */
  captureFrame?: () => { url: string | undefined; crop: CameraCrop | null };
  cameraLive?: boolean;
  /** Calibrate by hand from what an automatic setup found. */
  onCalibrateByHand?: (found: CalibrateByHand) => void;
  /** Calibrate by hand on the current frame, with no model calls. */
  onCalibrateHere?: () => void;
  /** Follow long AI calls step by step in the AI dialog. */
  follow?: AiFollow;
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
  const lit = new Set<string>(lightsOn);
  if (lampOn && defaultLight) lit.add(defaultLight);
  for (const rule of memory?.rules ?? [])
    if (
      rule.entityId &&
      rule.placement === 'inside' &&
      rule.lastDecision?.output.action === 'confirmed'
    )
      lit.add(rule.entityId);
  const drawingRule = Boolean(ruleDraft && ruleMap);
  // A photographed room with an office desk keeps its own place for each
  // fixture; the desk shows them where its camera puts them, moved into its view.
  const shift =
    custom && (kind === 'custom' || kind === 'custom-desk') ? closeViewShift(custom) : null;
  const shown = (f: Fixture) => (kind === 'custom' && shift ? inRoomView(f) : f);
  const boxOf = (f: Fixture) => {
    const box = fixtureBox(shown(f), custom);
    return kind === 'custom-desk' && shift
      ? { ...box, at: { ...box.at, x: box.at.x + shift.dx, y: box.at.y + shift.dy } }
      : box;
  };
  const onDesk = (f: Fixture) => {
    const { at, size } = boxOf(f);
    return at.x >= 0 && at.y >= 0 && at.x + size.w <= scene.grid.w && at.y + size.d <= scene.grid.d;
  };
  // Fixtures in this scene; one being moved is drawn only where the pointer is.
  const fixtures: IsoFixture[] = (memory?.fixtures ?? [])
    .filter((f) =>
      kind === 'custom-desk'
        ? f.scene === 'custom' && Boolean(shift) && onDesk(f)
        : f.scene === kind,
    )
    .filter((f) => f.id !== placing?.id)
    .map((f) => ({
      id: f.id,
      label: f.label,
      box: boxOf(f),
      item: rotateItem(fixtureModel(f), f.turns),
      glow: f.control.kind === 'light' && f.state === 'on',
      ...(f.control.kind === 'none' && !f.state && !f.states ? {} : { state: f.state ?? null }),
      focused: f.id === focus?.fixture,
      ...(f.track?.status === 'missing' ? { missing: true } : {}),
    }));
  const turned = placing ? placing.turns % 2 === 1 : false;
  // The photographed room and its desk show as their pictures, unless something is being drawn or placed on the model.
  const viewPicture =
    kind === 'custom'
      ? memory?.illustration
      : kind === 'custom-desk'
        ? memory?.deskIllustration
        : null;
  const picture =
    viewPicture &&
    layers.picture !== false &&
    pin?.scene === 'custom' &&
    viewPicture.surfaceId === pin.surfaceId &&
    !drawing &&
    !ruleDraft &&
    !placing
      ? viewPicture
      : null;

  const target = memory ? modelTarget(memory, modelOf) : null;
  const targetFixture = target?.fixture
    ? memory?.fixtures?.find((f) => f.id === target.id)
    : undefined;

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
            fixture={targetFixture}
            busy={off}
            sparkNote={
              mode === 'demo'
                ? 'Demo: no model call. Drafts fit the demo mug’s own pixels, from a close photo of it.'
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
            onDraft={
              target?.fixture
                ? undefined
                : (source) =>
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
            onFixtureState={
              targetFixture
                ? (payload) =>
                    void send<DeskMemory>(
                      'fixtures/state',
                      { fixtureId: targetFixture.id, ...payload },
                      onMemory,
                    )
                : undefined
            }
            onFixtureSize={
              targetFixture
                ? (size) =>
                    void send<DeskMemory>(
                      'fixtures/save',
                      { fixture: { ...fixtureInput(targetFixture), size } },
                      onMemory,
                    )
                : undefined
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
            room={
              kind === 'custom' || kind === 'custom-desk'
                ? 'custom'
                : kind === 'desk'
                  ? 'office'
                  : kind
            }
            cameraLive={cameraLive}
            {...(captureFrame ? { captureFrame } : {})}
            onCalibrated={onMemory}
            onMessage={onMessage}
            hand={hand}
            brushTool={tool === 'brush'}
            {...(onAiEdit ? { onAiEdit } : {})}
            {...(onCalibrateByHand ? { onCalibrateByHand } : {})}
            {...(onCalibrateHere ? { onCalibrateHere } : {})}
            {...(follow ? { follow } : {})}
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
                // A room made another size had its camera fitted again: say how well.
                const refit =
                  m.camera && m.camera.calibratedAt !== memory?.camera?.calibratedAt
                    ? ` The room's camera now fits your corner marks to ${m.camera.error.toFixed(1)} px${m.camera.error > Math.hypot(m.camera.camera.frame.width, m.camera.camera.frame.height) / 60 ? ': too far off, so check the size or mark the corner again' : ''}.`
                    : '';
                onMessage(
                  next
                    ? `Scene saved.${refit || ' Pin one of its surfaces to place objects in it.'}`
                    : 'Custom scene removed.',
                );
              })
            }
          />
        ) : (
          <ZoomPan
            className="iso-zoom"
            hand={hand}
            store="iso"
            resetKey={`${kind} ${picture ? 'picture' : 'model'}`}
          >
            {picture && memory && pin ? (
              <IllustrationView
                illustration={picture}
                pin={pin}
                memory={memory}
                focus={focus}
                showZones={layers.zones}
                fixtures={(memory.fixtures ?? [])
                  .filter((f) => f.scene === pin.scene && f.id !== placing?.id)
                  .map(shown)}
                custom={custom}
                {...(onFixture ? { onFixture } : {})}
                {...(onFixtureMenu ? { onFixtureMenu } : {})}
                {...(onMoveFixture && tool === 'select' ? { onMoveFixture } : {})}
                {...(onResizeFixture && tool === 'scale' ? { onResizeFixture } : {})}
                look={fixtureLook}
              />
            ) : (
              <IsoScene
                scene={scene}
                surface={surface}
                objects={objects}
                fixtures={fixtures}
                onFixture={onFixture}
                onMoveFixture={tool === 'select' ? onMoveFixture : undefined}
                onFixtureMenu={onFixtureMenu}
                onResizeFixture={tool === 'scale' ? onResizeFixture : undefined}
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
                  // Drawn in the room, so it is the room's zone, not one image's.
                  const onSurface =
                    pin && surface ? { scene: pin.scene, surfaceId: surface.id, a, b } : undefined;
                  if (drawingRule && ruleTarget && ruleMap) {
                    const rect = zoneFromSurface(a, b, ruleTarget.frame, ruleMap.toFrame);
                    if (rect && ruleDraft) onRuleDraft({ ...ruleDraft, rect, onSurface });
                    return;
                  }
                  if (!mug || !o) return;
                  const next = zoneFromSurface(a, b, o.frame, mug.map.toFrame);
                  if (next) onDraftZone({ ...next, onSurface });
                }}
              />
            )}
          </ZoomPan>
        )}
        <span className="iso-tag" aria-hidden="true">
          {panel === 'item'
            ? targetFixture
              ? `FIXTURE STUDIO · ${targetFixture.label.toUpperCase()}${targetFixture.state ? ` · ${targetFixture.state.toUpperCase()}` : ''}`
              : `ITEM · ${(target?.item?.label ?? target?.label ?? 'object').toUpperCase()}`
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
