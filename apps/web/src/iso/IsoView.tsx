import { lazy, useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEMO_SURFACE,
  archetypeOf,
  believableWidth,
  buildItem,
  defaultFit,
  mugItem,
  ISO_PRESETS,
  fixtureBox,
  fixtureInput,
  fixtureGlows,
  withHaStates,
  fixtureModel,
  followStats,
  closeViewShift,
  inRoomView,
  guessedScene,
  closeViewOf,
  itemHeight,
  modelTarget,
  ruleSighting,
  actionsColor,
  MAIN_RULE,
  anchoredZone,
  type ZoneAnchor,
  type Quad,
  pinFits,
  rotateItem,
  projectBox,
  followedSighting,
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
  type LampResult,
  type SavedItem,
  type SurfacePin,
  type ZoneOnSurface,
  type ZoneActions,
  type MotionTrigger,
  ruleActions,
  type ZoneRect,
  promoteGroup,
  withoutPromoted,
  foodKeeps,
  sampleFood,
  dayOf,
  foodNow,
  type FoodNow,
  mugHistory,
  mugModel,
  mugOf,
  mugSighting,
  otherObjects,
  placedFixtures,
  surfaceWorld,
  type Point,
} from '@livinglayer/domain';
import { applyHomography, runOutput, type MugSpot } from '@livinglayer/domain';
import { withThingLayers } from './thingLayer';
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
import { IsoScene, type IsoDrawn, type IsoFixture, type IsoObject, type IsoZone } from './IsoScene';
import { FRIDGE_ANGLES, fromAngle, type FridgeAngle } from './fridgeAngle';
import { Later } from '../Later';
import { LayerChips } from '../workspace/LayerChips';
import { DESK_THINGS } from '../workspace/labels';
import { sightedCallouts, type IsoCallout } from './Callouts';
import { ThingEditor } from './ThingEditor';
import { pinScene, type WorkScene as Kind } from '../workspace/progress';
import './iso.css';
import type { SceneView } from './SceneEditor';
import { DayChip, DayNudges } from '../workspace/DayDock';
import { clock, dayAt } from '../workspace/demoDay';
import { useReplay } from '../workspace/state/replay';
import { demoLampAt, useCoach } from '../workspace/state/coach';
import { statsStore } from '../workspace/state/stats';
import { useStore } from '../workspace/state/store';

// The editors and the room's picture load when first shown.
const SceneEditor = lazy(() => import('./SceneEditor').then((m) => ({ default: m.SceneEditor })));
const IllustrationView = lazy(() =>
  import('./IllustrationView').then((m) => ({ default: m.IllustrationView })),
);

/** What the iso canvas shows: the room, the layout editor, or an object's model. */
export type IsoPanel = 'room' | 'scene' | 'item';
/**
 * The bottom of a motion zone's rectangle: where what it watches stands on
 * the surface. The whole rectangle is mostly the thing's body above the
 * surface, which mapped onto the surface lands far behind it.
 */
const footBand = (r: ZoneRect): ZoneRect => ({
  x: r.x,
  y: r.y + r.height * 0.8,
  width: r.width,
  height: r.height * 0.2,
});
/** The rectangle around these points on the surface. */
function uvRect(ps: readonly { x: number; y: number }[]) {
  const xs = ps.map((p) => p.x),
    ys = ps.map((p) => p.y);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
/** A rule being set up or changed; its zone is dragged out on the iso surface. */
export interface RuleDraft {
  /** The saved rule being changed; unset for a new one. */
  id?: string;
  /** What the zone counts: anything the camera follows, or these. */
  objects: 'any' | string[];
  /** `all`: only every one of them together fills it. */
  match?: 'all';
  /** What it does as something enters and as it empties; none only tells Home Assistant. */
  actions: ZoneActions;
  /** Set for a motion zone, drawn on the camera's picture rather than in the room. */
  motion?: MotionTrigger;
  label: string;
  rect: ZoneRect | null;
  /** Where in the room it was drawn, when it was drawn here. */
  onSurface?: ZoneOnSurface;
  /** Set for a zone that is a thing: it isn't drawn, it is wherever the thing is. */
  anchor?: ZoneAnchor;
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
/** Where the replay stands the mug, in surface units; the coaster is the main zone's middle when there is one. */
const REPLAY_SPOTS: Record<Exclude<MugSpot, 'away'>, Point> = {
  coaster: { x: 0.72, y: 0.35 },
  keyboard: { x: 0.45, y: 0.5 },
  edge: { x: 0.12, y: 0.82 },
};
/** A sighting's placement at a point of the surface, as `projectBox` gives one. */
function placedAt(surface: IsoSurface, foot: Point): ReturnType<typeof projectBox> {
  const w = 0.35;
  const c = surfaceWorld(surface, foot);
  return {
    foot,
    onSurface: true,
    box: { at: { x: c.x - w / 2, y: c.y - w / 2, z: surface.z }, size: { w, d: w, h: w } },
  };
}
/** What a thing not modelled yet is drawn as: the stock mug, or its archetype's usual shape. */
function stockItem(label: string): IsoItem {
  const archetype = archetypeOf(label);
  return archetype === 'mug'
    ? mugItem(undefined, undefined, label)
    : buildItem(label, defaultFit(archetype));
}
/** A model stands as wide as the sighting's footprint, and as tall as its parts. */
function marker(
  id: string,
  label: string,
  placed: ReturnType<typeof projectBox>,
  fitted?: IsoItem | null,
): IsoObject {
  const { at, size } = placed.box;
  const item = fitted ?? stockItem(label);
  const archetype = fitted && 'fit' in fitted ? (fitted as SavedItem).fit?.archetype : null;
  const w = believableWidth(size.w, label, archetype);
  // Shrunk or grown about the same footprint centre.
  const box = {
    at: { x: at.x + (size.w - w) / 2, y: at.y + (size.d - w) / 2, z: at.z },
    size: { w, d: w, h: itemHeight(item) * w },
  };
  return { id, box, item, label, unsure: !placed.onSurface };
}

/**
 * How a fixture lights the room: a lamp with its own light glows whole; one
 * whose shades switch their own lights glows only in its shades, each lit one
 * with a glow around it in its light's colour. `item` is drawn in `box`.
 */
function lightOf(
  f: Fixture,
  item: IsoItem,
  box: IsoFixture['box'],
  colors: Readonly<Record<string, string>>,
): Pick<IsoFixture, 'glow' | 'halos'> {
  if (!f.lights?.length) return { glow: fixtureGlows(f) };
  // The sprite draws the item from the box's corner, its footprint's longer side one unit.
  const scale = Math.max(box.size.w, box.size.d);
  const halos = f.lights.flatMap((l) => {
    const p = f.lit?.[l.part] ? item.parts.find((q) => q.id === l.part) : undefined;
    if (!p) return [];
    const at = {
      x: box.at.x + (p.at.x + p.size.w / 2) * scale,
      y: box.at.y + (p.at.y + p.size.d / 2) * scale,
      z: box.at.z + (p.at.z + p.size.h / 2) * scale,
    };
    return [{ at, color: colors[l.entityId] ?? 'var(--warm)' }];
  });
  return { glow: false, ...(halos.length ? { halos } : {}) };
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

/** A food thing's use-by line, when it has one. */
function foodLine(f: Fixture): { food?: FoodNow } {
  const food = foodNow(f.food);
  return food ? { food } : {};
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
    liveHa,
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
  // The mug is `tracked` in the room and `main` in the outline.
  const onObject = useCallback(
    (id: string) => select({ kind: 'object', id: id === 'tracked' ? 'main' : id }),
    [select],
  );
  /** A thing's light, switch or desktop display turned on or off from its card. */
  const onSwitch = useCallback(
    (id: string, action: 'on' | 'off') =>
      void apiAt<{ memory: DeskMemory; event: EvidenceRun<LampResult> | null }>(
        'fixtures/control',
        { mode, fixtureId: id, action },
      )
        .then((r) => {
          setMemory(r.memory);
          if (r.event) setMessage(r.event.output.explanation);
          void refresh();
        })
        .catch((e: unknown) => onError(e instanceof Error ? e : 'The request failed.')),
    [mode, setMemory, setMessage, refresh, onError],
  );
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
          : // A preset's built-in thing made a thing of its own is drawn as that thing.
            withoutPromoted(
              guess?.kind === kind ? guessedScene(guess) : ISO_PRESETS[kind],
              memory?.fixtures,
            ),
    [kind, custom, guess, memory?.fixtures],
  );
  const surface =
    scene.surfaces.find((s) => s.id === (surfaceId ?? pin?.surfaceId ?? 'desk:top')) ??
    scene.surfaces[0];
  const pinned = Boolean(
    surface && pin && pinFits(pin, pinScene(kind)) && pin.surfaceId === surface.id,
  );
  const defaultLight = lights[0] ?? '';

  // The day replay, when open, stands the mug and switches the lamp as the sample day had them.
  // Live, the dock only asks: the room stays as it is.
  const replaying = mode === 'demo';
  const replayMug = useReplay((r) => (r.open && replaying ? dayAt(r.minute).mug : null));
  // A coach nudge's "Turn it off" switches the replay's lamp off until the day switches it again.
  const coachExtra = useCoach((c) => c.extra);
  const replayLamp = useReplay((r) =>
    r.open && replaying ? demoLampAt(r.minute, dayAt(r.minute).lamp, coachExtra) : null,
  );
  const replayClock = useReplay((r) => (r.open && replaying ? clock(Math.floor(r.minute)) : null));

  // The mug, then every other remembered object the pin can place; the zones, the trail and the lit lights.
  const model = useMemo(() => {
    const objects: IsoObject[] = [];
    let note = '';
    // Where each thing is now: its sighting, or where the watcher followed it since.
    const now = (id: string, seen: DeskObservation | null) => {
      const track = memory?.fixtures?.find((f) => f.id === id)?.track;
      return track ? followedSighting(track) : seen;
    };
    const mugThing = mugOf(memory);
    const o = mugThing ? now(mugThing.id, mugSighting(memory)) : mugSighting(memory);
    const mug = surface ? place(o, pin, surface, pinned) : null;
    if (!surface) note = 'This scene has no surface to pin. Add a desk, table or shelf.';
    else if (!pinned)
      note = `Pin the ${surface.label.toLowerCase()} on a photo to place objects here.`;
    else if (!o) note = 'Find the mug to see it here.';
    else if (!mug)
      note = 'This frame is a different size from the one the corners were set on. Pin it again.';
    if (mug && mugOf(memory)) {
      objects.push({
        ...marker('tracked', mugOf(memory)!.label, mug.placed, mugModel(memory)),
        thingId: mugOf(memory)!.id,
      });
      if (!mug.placed.onSurface)
        note = `The mug's box stands off the ${surface!.label.toLowerCase()}, so it is drawn at the edge.`;
    }
    for (const other of otherObjects(memory) ?? []) {
      const at = surface ? place(now(other.id, other.observation), pin, surface, pinned) : null;
      if (at) objects.push(marker(other.id, other.label, at.placed, other.item));
    }
    const trail =
      mug && o
        ? [o, ...(mugHistory(memory) ?? [])]
            .filter((h) => h.frame.width === o.frame.width && h.frame.height === o.frame.height)
            .map((h) => projectBox(h.box, surface!, mug.map.toSurface).foot)
        : [];
    const zones: IsoZone[] = [];
    // The main zone where the mug was seen: its saved rule's name, state and colour, or the one being drawn.
    const main = memory?.rules?.find((r) => r.id === MAIN_RULE);
    const mainRgb = main && !drawing ? actionsColor(ruleActions(main)) : null;
    if (mug && o && zone)
      zones.push({
        id: 'main',
        kind: 'main',
        quad: zoneOnSurface(zone, o.frame, mug.map.toSurface),
        ...(main && !drawing ? { label: main.label, inside: main.placement === 'inside' } : {}),
        ...(mainRgb ? { color: `rgb(${mainRgb.join(' ')})` } : {}),
      });
    for (const rule of memory?.rules ?? []) {
      const map = pinned && pin ? surfaceMap(pin, rule.zone.frame) : null;
      // A zone that is a thing is its footprint on the surface; the box round it in the frame is bigger.
      const on = rule.anchor && rule.zone.onSurface?.surfaceId === pin?.surfaceId;
      // A rule being changed shows as its draft only; the main one, once, as above when it can be.
      const shown = rule.id === MAIN_RULE && zones.some((z) => z.id === 'main');
      if (map && rule.id !== ruleDraft?.id && !shown) {
        const rgb = actionsColor(ruleActions(rule));
        zones.push({
          id: rule.id,
          kind: 'rule',
          label: rule.label,
          inside: rule.placement === 'inside',
          quad: on
            ? cornersOf(rule.zone.onSurface!)
            : zoneOnSurface(
                rule.motion ? footBand(rule.zone.rect) : rule.zone.rect,
                rule.zone.frame,
                map.toSurface,
              ),
          ...(rgb ? { color: `rgb(${rgb.join(' ')})` } : {}),
          ...(rule.motion ? { motion: true } : {}),
        });
      }
    }
    // A thing's zone being set up shows where the thing is now.
    const anchored = ruleDraft?.anchor && memory ? anchoredZone(memory, ruleDraft.anchor) : null;
    if (anchored?.onSurface && anchored.onSurface.surfaceId === pin?.surfaceId)
      zones.push({
        id: 'draft',
        kind: 'draft',
        label: ruleDraft!.label.trim() || 'New zone',
        quad: cornersOf(anchored.onSurface),
      });
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
    if (replayMug && surface) {
      const at = objects.findIndex((ob) => ob.id === 'tracked');
      if (at >= 0) objects.splice(at, 1);
      const main = zones.find((z) => z.kind === 'main')?.quad;
      const foot =
        replayMug === 'coaster' && main
          ? { x: main.reduce((a, p) => a + p.x, 0) / 4, y: main.reduce((a, p) => a + p.y, 0) / 4 }
          : replayMug === 'away'
            ? null
            : REPLAY_SPOTS[replayMug];
      const mugThing = mugOf(memory);
      if (foot)
        objects.unshift({
          ...marker(
            'tracked',
            mugThing?.label ?? 'My desk mug',
            placedAt(surface, foot),
            mugModel(memory),
          ),
          ...(mugThing ? { thingId: mugThing.id } : {}),
        });
      note = '';
    }
    if (!layers.trail || replayMug) trail.length = 0;
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
    if (replayLamp !== null && defaultLight) {
      if (replayLamp) lit.add(defaultLight);
      else lit.delete(defaultLight);
    }
    for (const rule of memory?.rules ?? [])
      if (rule.placement === 'inside' && rule.lastDecision?.output.action === 'confirmed')
        for (const s of ruleActions(rule).onEnter)
          // The main zone's old empty entity is the main lamp, lit by `lampOn`.
          if (s.kind === 'switch' && s.to === 'on' && s.entityId) lit.add(s.entityId);
    // A motion zone is drawn on the camera's picture: a plushie stands above the surface.
    // A zone that is a thing isn't drawn: it is wherever the thing is.
    const drawingRule = Boolean(ruleDraft && ruleMap && !ruleDraft.motion && !ruleDraft.anchor);
    return {
      objects: withThingLayers(objects, memory?.fixtures),
      note,
      o,
      mug,
      trail,
      zones,
      ruleTarget,
      ruleMap,
      lit,
      drawingRule,
    };
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
    replayMug,
    replayLamp,
  ]);
  const { objects, note, o, mug, trail, zones, ruleTarget, ruleMap, lit, drawingRule } = model;
  // The zone being drawn: on the surface as it was drawn here, else in the frame it was drawn on.
  const drawnOn = drawingRule
    ? ruleDraft?.onSurface
    : drawing
      ? lab.draftZone.onSurface
      : undefined;
  const drawn = useMemo((): IsoDrawn | null => {
    if (drawnOn && pin && drawnOn.scene === pin.scene && drawnOn.surfaceId === surface?.id)
      return { rect: uvRect([drawnOn.a, drawnOn.b]) };
    const at = drawingRule
      ? ruleDraft?.rect && ruleTarget && ruleMap
        ? { rect: ruleDraft.rect, frame: ruleTarget.frame, map: ruleMap }
        : null
      : drawing && zone && o && mug
        ? { rect: zone, frame: o.frame, map: mug.map }
        : null;
    if (!at) return null;
    const { width: w, height: h } = at.frame;
    return {
      rect: at.rect,
      frame: {
        toSurface: (p) => applyHomography(at.map.toSurface, { x: p.x * w, y: p.y * h }),
        fromSurface: (uv) => {
          const f = applyHomography(at.map.toFrame, uv);
          return { x: f.x / w, y: f.y / h };
        },
        onRect: (rect) => {
          if (!drawingRule) return onDraftZone(rect);
          if (!ruleDraft) return;
          const { onSurface: _, ...draft } = ruleDraft;
          onRuleDraft({ ...draft, rect });
        },
      },
    };
  }, [
    drawnOn,
    pin,
    surface?.id,
    drawingRule,
    drawing,
    ruleDraft,
    ruleTarget,
    ruleMap,
    zone,
    o,
    mug,
    onDraftZone,
    onRuleDraft,
  ]);
  // A photographed room with an office desk keeps its own place for each
  // fixture; the desk shows them where its camera puts them, moved into its view.
  const shift = useMemo(
    () => (custom && (kind === 'custom' || kind === 'custom-desk') ? closeViewShift(custom) : null),
    [custom, kind],
  );
  // The layout is edited in the whole room; from the desk's view, through that view.
  const sceneView: SceneView | null = useMemo(
    () =>
      kind === 'custom-desk' && shift
        ? {
            label: scene.label,
            groups: new Set(shift.props.map((p) => p.group)),
            dx: shift.dx,
            dy: shift.dy,
            grid: scene.grid,
          }
        : null,
    [kind, shift, scene],
  );
  const shown = useCallback(
    (f: Fixture) => (kind === 'custom' && shift ? inRoomView(f) : f),
    [kind, shift],
  );
  // Each thing as its stats read now (on or off, occupied), as they stream in: the saved
  // memory only catches up when it is loaded again. Renders only when one of those changes.
  const readings = useStore(statsStore, (now) =>
    Object.entries(now)
      .map(([id, n]) => `${id}:${n.power?.value ?? ''}:${n.occupied?.value ?? ''}`)
      .join(' '),
  );
  // Lights as Home Assistant reports them now, not only as last switched here.
  const things = useMemo(
    () =>
      followStats(memory?.fixtures ?? [], statsStore.get()).map((f) =>
        liveHa ? withHaStates(f, liveHa.states) : f,
      ),
    // `readings` says when a reading changed; the store holds them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [memory?.fixtures, readings, liveHa],
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
    return placedFixtures({ fixtures: things })
      .filter((f) =>
        kind === 'custom-desk'
          ? f.scene === 'custom' && Boolean(shift) && onDesk(f)
          : f.scene === kind,
      )
      .filter((f) => f.id !== placingId)
      .map((f) => {
        const box = boxOf(f);
        const item = rotateItem(fixtureModel(f, f.state, liveHa?.colors), f.turns);
        return {
          id: f.id,
          label: f.label,
          box,
          item,
          ...lightOf(f, item, box, liveHa?.colors ?? {}),
          ...(f.control.kind === 'none' && !f.state && !f.states ? {} : { state: f.state ?? null }),
          focused: f.id === focus.fixture,
          ...(f.track?.status === 'missing' ? { missing: true } : {}),
          ...(f.control.kind === 'light' ? { lamp: true } : {}),
          ...foodLine(f),
        };
      });
  }, [things, kind, shift, shown, custom, scene, placingId, focus, liveHa]);
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
  // The fridge from the corner chosen; drawing and placing stay in its usual one.
  const held = Boolean(placing || drawing || ruleDraft);
  const angle: FridgeAngle = kind === 'fridge' && !held ? lab.fridgeAngle : 'right';
  const view = useMemo(
    () => fromAngle(angle, { scene, objects, fixtures, zones, trail }),
    [angle, scene, objects, fixtures, zones, trail],
  );
  const viewSurface = view.scene.surfaces.find((s) => s.id === surface?.id) ?? surface;
  /**
   * The stats layer's cards: each thing that keeps food or stats, or is named
   * like food, each thing the camera places that keeps stats, and each food
   * thing still drawn with the room, which the card invites to be made a thing.
   */
  const callouts: IsoCallout[] = useMemo(() => {
    const top = (b: {
      at: { x: number; y: number; z: number };
      size: { w: number; d: number; h: number };
    }) => ({
      x: b.at.x + b.size.w / 2,
      y: b.at.y + b.size.d / 2,
      z: b.at.z + b.size.h,
    });
    const things = view.fixtures.flatMap((shownFixture): IsoCallout[] => {
      const f = memory?.fixtures?.find((x) => x.id === shownFixture.id);
      const keys = (memory?.thingStats?.[shownFixture.id] ?? []).map((s) => s.key);
      // A thing a light, switch or desktop drives can be switched from its card.
      const switched = f && f.control.kind !== 'none';
      if (!f || (!f.food && !keys.length && !switched && foodKeeps(f.label) === null)) return [];
      return [
        {
          id: f.id,
          label: f.label,
          anchor: top(shownFixture.box),
          ...(f.food ? { food: f.food } : {}),
          ...(keys.length ? { stats: keys } : {}),
          ...(shownFixture.lamp ? { lamp: true } : {}),
          ...(switched
            ? {
                actions: (['on', 'off'] as const).map((action) => ({
                  label: action === 'on' ? 'On' : 'Off',
                  current: (f.state ?? null) === action,
                  run: () => onSwitch(f.id, action),
                })),
              }
            : {}),
          onSelect: () => onFixture(f.id),
        },
      ];
    });
    const drawn = view.scene.props.flatMap((p): IsoCallout[] =>
      p.id === p.group && p.template && DESK_THINGS.has(p.template) && foodKeeps(p.label) !== null
        ? [
            {
              id: `${kind}~${p.group}`,
              label: p.label,
              anchor: top(p),
              builtIn: true,
              onSelect: () => select({ kind: 'built-in', id: `${kind}~${p.group}` }),
            },
          ]
        : [],
    );
    // A thing the camera places (the mug, a mouse) gets a card like any other, by its thing's id.
    const sighted = sightedCallouts(
      view.objects,
      (id) => (memory?.thingStats?.[id] ?? []).map((s) => s.key),
      (id) => select({ kind: 'object', id }),
    );
    return [...things, ...sighted, ...drawn];
  }, [view, memory?.fixtures, memory?.thingStats, kind, onFixture, onSwitch, select]);
  // Turned, a fixture's box isn't where it stands: it is moved and sized from the usual corner.
  const turned = angle === 'left';
  // Dragging on the room draws a zone: a rule's draft, or the mug's.
  const onDrag = useCallback(
    (a: { x: number; y: number }, b: { x: number; y: number }) => {
      // Drawn in the room, so it is the room's zone, not one image's.
      const onSurface =
        pin && surface ? { scene: pin.scene, surfaceId: surface.id, a, b } : undefined;
      if (ruleDraft?.motion) return;
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
  // The picture's fixtures, kept while only the pointer moves.
  const pictureScene = picture && memory && pin ? pin.scene : null;
  const pictureFixtures = useMemo(
    () =>
      pictureScene
        ? placedFixtures({ fixtures: things })
            .filter((f) => f.scene === pictureScene && f.id !== placingId)
            .map(shown)
        : [],
    [pictureScene, things, placingId, shown],
  );

  const target = memory ? modelTarget(memory, modelOf) : null;
  const targetFixture = target?.fixture
    ? memory?.fixtures?.find((f) => f.id === target.id)
    : undefined;

  // The food things the stats layer shows here: what Randomize gives sample values.
  const foodThings = callouts.flatMap((c) =>
    c.builtIn
      ? []
      : (memory?.fixtures?.filter((f) => f.id === c.id && foodKeeps(f.label) !== null) ?? []),
  );
  /**
   * Sample values for a demo: each food thing here gets a believable use-by
   * day, opened day and how much is left, and when it was last used if it
   * keeps that, in the last three days.
   */
  async function randomize() {
    const today = dayOf(Date.now());
    let saved = 0;
    for (const f of foodThings) {
      const food = sampleFood(f.label, today);
      if (!food) continue;
      await send<DeskMemory>('fixtures/save', { fixture: { ...fixtureInput(f), food } }, (m) => {
        setMemory(m);
        saved++;
      });
      if (memory?.thingStats?.[f.id]?.some((s) => s.key === 'lastUsed'))
        await send(
          'things/used',
          { id: f.id, at: Date.now() - Math.round(Math.random() * 3 * 86_400_000) },
          () => {},
        );
    }
    setMessage(
      `Gave ${saved} food thing${saved === 1 ? '' : 's'} sample values. Set real ones on each card.`,
    );
  }
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
  /**
   * A prop of the layout as a thing of its own: the layout saved without it,
   * then a fixture drawn the same where it stood. Only once the layout has
   * let go of it, so a failure never leaves it twice.
   */
  async function makeThing(draft: Scene, group: string) {
    const made = promoteGroup(draft, group);
    if (!made) return onError('That prop has nothing to draw as a thing.');
    let removed = false;
    await send<DeskMemory>('scene/save', { scene: made.scene }, (m) => {
      setMemory(m);
      removed = true;
    });
    if (!removed) return;
    await send<DeskMemory>('fixtures/save', { fixture: made.fixture }, (m) => {
      setMemory(m);
      onKind('custom');
      onPanel('room');
      const thing = m.fixtures?.at(-1);
      if (thing) select({ kind: 'fixture', id: thing.id });
      setMessage(
        `The ${made.fixture.label.toLowerCase()} is a thing of its own now. Find it in the camera, or keep a stat for it.`,
      );
    });
  }

  return (
    <div className="iso-view">
      <div className={`iso-frame ${panel === 'item' || panel === 'scene' ? 'editing' : ''}`}>
        {panel === 'item' ? (
          <ThingEditor objectId={modelOf} />
        ) : panel === 'scene' ? (
          <Later>
            <SceneEditor
              mode={mode}
              saved={custom}
              base={sceneView && custom ? custom : scene}
              {...(sceneView ? { view: sceneView } : {})}
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
              onMakeThing={(d, g) => void makeThing(d, g)}
              onCalibrateByHand={onCalibrateByHand}
              onCalibrateHere={onCalibrateHere}
              follow={follow}
              onPhotoSaved={(m) => {
                onMemory(m);
                onKind('custom');
                if (m.surface?.scene === 'custom') onSurfaceId(m.surface.surfaceId);
                onPanel('room');
                const n = (mugOf(m) ? 1 : 0) + (otherObjects(m)?.length ?? 0);
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
            resetKey={`${kind} ${picture ? 'picture' : 'model'} ${angle}`}
          >
            {picture && memory && pin ? (
              <Later>
                <IllustrationView
                  illustration={picture}
                  pin={pin}
                  memory={memory}
                  focus={focus}
                  showZones={layers.zones}
                  fixtures={pictureFixtures}
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
                scene={view.scene}
                seeThrough={view.seeThrough}
                surface={viewSurface}
                objects={view.objects}
                fixtures={view.fixtures}
                onFixture={onFixture}
                onObject={onObject}
                onMoveFixture={tool === 'select' && !turned ? onMoveFixture : undefined}
                onFixtureMenu={onFixtureMenu}
                onResizeFixture={tool === 'scale' && !turned ? onResizeFixture : undefined}
                placing={isoPlacing}
                trail={view.trail}
                zones={view.zones}
                onZone={tool === 'select' && !hand && !ruleDraft ? onZone : undefined}
                litLights={lit}
                defaultLight={defaultLight}
                drawing={drawingRule || (drawing && Boolean(mug))}
                drawn={drawn}
                onDrag={onDrag}
                stats={lab.showStats}
                callouts={callouts}
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
              : `${replayClock ? `SAMPLE DAY ${replayClock} · ` : 'ISO · '}${scene.label.toUpperCase()} · ${surface?.label.toUpperCase() ?? 'NO SURFACE'}${pinned ? (memory?.surface ? ' · PINNED' : ' · DEMO') : ''}`}
        </span>
        {panel === 'room' && <LayerChips view="iso" />}
        {panel === 'room' && !picture && <DayChip />}
        {panel === 'room' && <DayNudges />}
        {panel === 'room' && lab.showStats && foodThings.length > 0 && !picture && (
          <div className="layer-chips iso sample" role="group" aria-label="Sample values">
            <button
              type="button"
              className="layer-chip"
              disabled={off}
              title="Give every food thing here sample values: use-by, opened, how much is left and when it was last used"
              onClick={() => void randomize()}
            >
              ⚄ Randomize
            </button>
          </div>
        )}
        {panel === 'room' && kind === 'fridge' && !picture && (
          <div className="layer-chips iso angles" role="group" aria-label="Fridge seen from">
            {(Object.keys(FRIDGE_ANGLES) as FridgeAngle[]).map((a) => (
              <button
                key={a}
                type="button"
                className="layer-chip"
                aria-pressed={angle === a}
                disabled={held}
                title={FRIDGE_ANGLES[a].hint}
                onClick={() => lab.setFridgeAngle(a)}
              >
                {FRIDGE_ANGLES[a].label}
              </button>
            ))}
          </div>
        )}
      </div>
      {panel === 'room' && ((ruleDraft && !ruleMap) || note || guess) && (
        <p className="iso-note" role="status">
          {ruleDraft && !ruleMap
            ? 'Pin a surface for the frame this object was seen in, then draw its zone.'
            : note ||
              (guess?.kind === kind
                ? `Spark: ${guess.summary}`
                : `Spark guessed ${ISO_PRESETS[guess!.kind].label}, not this scene. Change the scene to use its guess.`)}
        </p>
      )}
    </div>
  );
}

/** A zone's two corners on a surface, as its four, round the way a drawn zone's go. */
function cornersOf({ a, b }: Pick<ZoneOnSurface, 'a' | 'b'>): Quad {
  return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
}
