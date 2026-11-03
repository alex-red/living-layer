import { lazy, useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEMO_SURFACE,
  believableWidth,
  ISO_PRESETS,
  fixtureBox,
  fixtureInput,
  fixtureGlows,
  fixtureModel,
  closeViewShift,
  inRoomView,
  guessedScene,
  closeViewOf,
  itemHeight,
  modelTarget,
  ruleSighting,
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
  type SavedItem,
  type SurfacePin,
  type ZoneOnSurface,
  type LightLook,
  type ZoneRect,
} from '@livinglayer/domain';
import { runOutput } from '@livinglayer/domain';
import { apiAt } from '../api';
import { ZoomPan } from '../ZoomPan';
import type { BaseRect } from './BaseHandles';
import {
  useAi,
  useCalibration,
  useCamera,
  useDesk,
  useFeedback,
  useFixtures,
  useLabParts,
  useNavigation,
  useObservation,
  useRunLog,
  useView,
} from '../workspace/LabContext';
import { IsoScene, type IsoFixture, type IsoObject, type IsoZone } from './IsoScene';
import { Later } from '../Later';
import { pinScene, type WorkScene as Kind } from '../workspace/progress';
import './iso.css';

// The editors and the room's picture load when first shown.
const ItemEditor = lazy(() => import('./ItemEditor').then((m) => ({ default: m.ItemEditor })));
const SceneEditor = lazy(() => import('./SceneEditor').then((m) => ({ default: m.SceneEditor })));
const IllustrationView = lazy(() =>
  import('./IllustrationView').then((m) => ({ default: m.IllustrationView })),
);

/** What the iso canvas shows: the room, the layout editor, or an object's model. */
export type IsoPanel = 'room' | 'scene' | 'item';
/** A rule being set up or changed; its zone is dragged out on the iso surface. */
export interface RuleDraft {
  /** The saved rule being changed; unset for a new one. */
  id?: string;
  /** The fixture the saved rule switches, kept while its entity stays the same. */
  fixtureId?: string;
  /** What the zone counts: anything the camera follows, or these. */
  objects: 'any' | string[];
  /** Switch the entity off again when the zone empties. */
  offWhenEmpty: boolean;
  /** How a light looks when the zone turns it on; unset keeps its own. */
  look?: LightLook;
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
  hand,
  onFixtureMenu,
}: {
  /** Every drag pans the room, for the hand tool (it gives way to drawing, pinning and placing). */
  hand: boolean;
  /** Right-click on a fixture, at the pointer in the window: the canvas shows the menu. */
  onFixtureMenu: (id: string, at: { x: number; y: number }) => void;
}) {
  const kind = useView().workScene;
  return kind ? <IsoViewOf kind={kind} hand={hand} onFixtureMenu={onFixtureMenu} /> : null;
}

function IsoViewOf({
  kind,
  hand,
  onFixtureMenu,
}: {
  /** The scene the person chose to work on. */
  kind: Kind;
  hand: boolean;
  onFixtureMenu: (id: string, at: { x: number; y: number }) => void;
}) {
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useRunLog(),
    useDesk(),
    useCamera(),
    useObservation(),
    useNavigation(),
    useAi(),
    useFixtures(),
    useCalibration(),
  );
  const {
    mode,
    memory,
    image,
    lights,
    guess,
    ruleDraft,
    placing,
    drawing,
    tool,
    cameraFrame: captureFrame,
    upload: onUpload,
    isoPanel: panel,
    isoSurfaceId: surfaceId,
    modelOf,
    fixtureLook,
    selection: sel,
    showTrail,
    showZones,
    showPicture,
    lightsOn,
    visibleZone,
    setWorkScene: onKind,
    setIsoPanel: onPanel,
    setIsoSurfaceId: onSurfaceId,
    setRuleDraft: onRuleDraft,
    setDraftZone: onDraftZone,
    setMemory,
    setSelected,
    setMessage,
    setError: onError,
    refresh,
    select,
    placeFixture,
    updateFixture,
    brushGroup: onAiEdit,
    calibrateByHand: onCalibrateByHand,
    calibrateHere: onCalibrateHere,
    followAi: follow,
  } = lab;
  const zone = visibleZone ?? undefined;
  const cameraLive = lab.camera;
  // A running camera doesn't block the editors: they capture their frame from it.
  const busy = Boolean(lab.busy) || lab.cameraPending;
  const lampOn = lab.lamp !== 'off';
  const focus = useMemo(
    () => ({
      object: sel?.kind === 'object' ? (sel.id === 'main' ? 'tracked' : sel.id) : undefined,
      zone: sel?.kind === 'rule' ? sel.id : undefined,
      fixture: sel?.kind === 'fixture' ? sel.id : undefined,
    }),
    [sel],
  );
  const layers = useMemo(
    () => ({ trail: showTrail, zones: showZones, picture: showPicture }),
    [showTrail, showZones, showPicture],
  );
  const onMessage = useCallback(
    (text: string) => {
      setMessage(text);
      void refresh();
    },
    [setMessage, refresh],
  );
  const onMemory = useCallback(
    (m: DeskMemory) => {
      setMemory(m);
      // A scene saved from a photo is the room now; the next step is its surface or objects.
      if (m.scene && panel === 'scene') select({ kind: 'room' });
    },
    [setMemory, select, panel],
  );
  const onRun = useCallback(
    (run: EvidenceRun) => {
      setSelected(run);
      const item = runOutput(run, 'item');
      setMessage(
        item
          ? `Model drafted: ${item.parts.length} parts. Edit it, then save.`
          : run.kind === 'layout'
            ? 'Scene drafted. Review it in the layout editor, then save.'
            : run.kind === 'photo'
              ? 'Scene drafted from the photo. Review the pin and the objects, then save.'
              : 'Saved.',
      );
      void refresh();
    },
    [setSelected, setMessage, refresh],
  );
  const onFixture = useCallback((id: string) => select({ kind: 'fixture', id }), [select]);
  const onZone = useCallback((id: string) => select({ kind: 'rule', id }), [select]);
  const onPlace = useCallback(
    (where: { at: { x: number; y: number }; surfaceId: string | null }) => void placeFixture(where),
    [placeFixture],
  );
  const onMoveFixture = useCallback(
    (id: string, to: { x: number; y: number; surfaceId: string | null }) => {
      const label = memory?.fixtures?.find((f) => f.id === id)?.label ?? 'fixture';
      // Selecting it would close the layout editor, where it can be moved too.
      if (panel !== 'scene') select({ kind: 'fixture', id });
      void updateFixture(
        id,
        { centre: { x: to.x, y: to.y }, surfaceId: to.surfaceId },
        `Moved the ${label.toLowerCase()}. Scans leave it where you put it.`,
      );
    },
    [memory, panel, select, updateFixture],
  );
  const onResizeFixture = useCallback(
    (id: string, rect: BaseRect) => {
      const f = memory?.fixtures?.find((x) => x.id === id);
      if (!f) return;
      // The handles stretch the base as drawn; the save keeps it before turning.
      const turned = f.turns % 2 === 1;
      return updateFixture(
        id,
        {
          centre: { x: rect.x + rect.w / 2, y: rect.y + rect.d / 2 },
          size: {
            w: turned ? rect.d : rect.w,
            d: turned ? rect.w : rect.d,
            h: f.size.h,
          },
        },
        `Resized the ${f.label.toLowerCase()}'s base. Scans leave it as you set it.`,
      );
    },
    [memory, updateFixture],
  );
  const pin = memory?.surface ?? (mode === 'demo' ? DEMO_SURFACE : null);
  const [asking, setAsking] = useState(false);
  // A new scene or pin starts on the pinned surface when it is in this scene.
  useEffect(() => {
    if (pin && pinFits(pin, pinScene(kind))) onSurfaceId(pin.surfaceId);
    // Only a new scene or a new pin moves the surface; the person's own pick stays until then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, pin?.scene, pin?.surfaceId]);

  const custom = memory?.scene ?? null;
  const scene: Scene = useMemo(
    () =>
      kind === 'custom'
        ? (custom ?? ISO_PRESETS.desk)
        : kind === 'custom-desk'
          ? ((custom && closeViewOf(custom)) ?? ISO_PRESETS.desk)
          : guess?.kind === kind
            ? guessedScene(guess)
            : ISO_PRESETS[kind],
    [kind, custom, guess],
  );
  const surface =
    scene.surfaces.find((s) => s.id === (surfaceId ?? pin?.surfaceId ?? 'desk:top')) ??
    scene.surfaces[0];
  const pinned = Boolean(
    surface && pin && pinFits(pin, pinScene(kind)) && pin.surfaceId === surface.id,
  );
  const defaultLight = lights[0] ?? '';

  // The mug, then every other remembered object the pin can place; the zones, the trail and the lit lights.
  const model = useMemo(() => {
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
      zones.push({
        id: 'main',
        kind: 'main',
        quad: zoneOnSurface(zone, o.frame, mug.map.toSurface),
      });
    for (const rule of memory?.rules ?? []) {
      const map = pinned && pin ? surfaceMap(pin, rule.zone.frame) : null;
      // A rule being changed shows as its draft only.
      if (map && rule.id !== ruleDraft?.id)
        zones.push({
          id: rule.id,
          kind: 'rule',
          label: rule.label,
          inside: rule.placement === 'inside',
          quad: zoneOnSurface(rule.zone.rect, rule.zone.frame, map.toSurface),
        });
    }
    // A rule's zone is drawn on the frame of the newest sighting of what it counts.
    const ruleTarget = ruleDraft && memory ? ruleSighting(memory, ruleDraft.objects) : null;
    const ruleMap = ruleTarget && pinned && pin ? surfaceMap(pin, ruleTarget.frame) : null;
    if (ruleDraft?.rect && ruleTarget && ruleMap)
      zones.push({
        id: 'draft',
        kind: 'draft',
        label: ruleDraft.label.trim() || 'New zone',
        quad: zoneOnSurface(ruleDraft.rect, ruleTarget.frame, ruleMap.toSurface),
      });
    if (!layers.trail) trail.length = 0;
    if (!layers.zones)
      zones.splice(
        0,
        zones.length,
        ...zones.filter((z) => z.kind === 'draft' || (drawing && z.kind === 'main')),
      );
    for (const ob of objects) ob.focused = ob.id === focus.object;
    for (const z of zones) z.focused = z.id === focus.zone;
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
    return { objects, note, o, mug, trail, zones, ruleTarget, ruleMap, lit, drawingRule };
  }, [
    memory,
    pin,
    surface,
    pinned,
    ruleDraft,
    layers,
    drawing,
    focus,
    zone,
    lightsOn,
    lampOn,
    defaultLight,
  ]);
  const { objects, note, o, mug, trail, zones, ruleTarget, ruleMap, lit, drawingRule } = model;
  // A photographed room with an office desk keeps its own place for each
  // fixture; the desk shows them where its camera puts them, moved into its view.
  const shift =
    custom && (kind === 'custom' || kind === 'custom-desk') ? closeViewShift(custom) : null;
  const shown = useCallback(
    (f: Fixture) => (kind === 'custom' && shift ? inRoomView(f) : f),
    [kind, shift],
  );
  // Fixtures in this scene; one being moved is drawn only where the pointer is.
  const placingId = placing?.id;
  const fixtures: IsoFixture[] = useMemo(() => {
    const boxOf = (f: Fixture) => {
      const box = fixtureBox(shown(f), custom);
      return kind === 'custom-desk' && shift
        ? { ...box, at: { ...box.at, x: box.at.x + shift.dx, y: box.at.y + shift.dy } }
        : box;
    };
    const onDesk = (f: Fixture) => {
      const { at, size } = boxOf(f);
      return (
        at.x >= 0 && at.y >= 0 && at.x + size.w <= scene.grid.w && at.y + size.d <= scene.grid.d
      );
    };
    return (memory?.fixtures ?? [])
      .filter((f) =>
        kind === 'custom-desk'
          ? f.scene === 'custom' && Boolean(shift) && onDesk(f)
          : f.scene === kind,
      )
      .filter((f) => f.id !== placingId)
      .map((f) => ({
        id: f.id,
        label: f.label,
        box: boxOf(f),
        item: rotateItem(fixtureModel(f), f.turns),
        glow: fixtureGlows(f),
        ...(f.control.kind === 'none' && !f.state && !f.states ? {} : { state: f.state ?? null }),
        focused: f.id === focus.fixture,
        ...(f.track?.status === 'missing' ? { missing: true } : {}),
      }));
  }, [memory?.fixtures, kind, shift, shown, custom, scene, placingId, focus]);
  const isoPlacing = useMemo(() => {
    if (!placing || placing.scene !== kind) return undefined;
    const turned = placing.turns % 2 === 1;
    return {
      label: placing.label,
      item: rotateItem(placing.model, placing.turns),
      size: {
        w: turned ? placing.size.d : placing.size.w,
        d: turned ? placing.size.w : placing.size.d,
        h: placing.size.h,
      },
      onPlace,
    };
  }, [placing, kind, onPlace]);
  // Dragging on the room draws a zone: a rule's draft, or the mug's.
  const onDrag = useCallback(
    (a: { x: number; y: number }, b: { x: number; y: number }) => {
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
    },
    [pin, surface, drawingRule, ruleTarget, ruleMap, ruleDraft, onRuleDraft, mug, o, onDraftZone],
  );
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
      done(await apiAt<T>(path, { mode, ...body }));
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
          <Later>
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
          </Later>
        ) : panel === 'scene' ? (
          <Later>
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
              captureFrame={captureFrame}
              onCalibrated={onMemory}
              onMessage={onMessage}
              hand={hand}
              brushTool={tool === 'brush'}
              fixtures={fixtures}
              {...(tool === 'select' ? { onMoveFixture } : {})}
              onFixtureMenu={onFixtureMenu}
              onAiEdit={onAiEdit}
              onCalibrateByHand={onCalibrateByHand}
              onCalibrateHere={onCalibrateHere}
              follow={follow}
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
          </Later>
        ) : (
          <ZoomPan
            className="iso-zoom"
            hand={hand}
            store="iso"
            resetKey={`${kind} ${picture ? 'picture' : 'model'}`}
          >
            {picture && memory && pin ? (
              <Later>
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
                  onFixture={onFixture}
                  onFixtureMenu={onFixtureMenu}
                  {...(tool === 'select' ? { onMoveFixture } : {})}
                  {...(tool === 'scale' ? { onResizeFixture } : {})}
                  look={fixtureLook}
                />
              </Later>
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
                placing={isoPlacing}
                trail={trail}
                zones={zones}
                onZone={tool === 'select' && !hand && !ruleDraft ? onZone : undefined}
                litLights={lit}
                defaultLight={defaultLight}
                drawing={drawingRule || (drawing && Boolean(mug))}
                onDrag={onDrag}
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
