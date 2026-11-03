import {
  DEMO_SURFACE,
  ISO_PRESETS,
  ruleActions,
  stepEntities,
  foodNow,
  pinFits,
  type DeskMemory,
  type Fixture,
  type IsoScene,
  type IsoSceneKind,
  type IsoSurface,
  type Mode,
  type PlacementRule,
} from '@livinglayer/domain';
import { groupBase, isBuiltInThing, roomLabel, sceneOf, surfaceUnder } from './labels';
import { pinScene, roomOf, viewOf, type Selection, type WorkScene } from './progress';

/**
 * The sidebar, one scene at a time. Every thing and zone is listed in one
 * scene only: the most particular one it is in. What stands on the office
 * desk is the desk's; the office lists the desk as one row instead.
 */

/** A scene the switcher offers: a room, or the close view inside one. */
interface SceneChoice {
  scene: WorkScene;
  label: string;
  /** A close view inside `room`, drawn under it. */
  view: boolean;
  /** One of the example rooms, beside a room of your own. */
  example: boolean;
  room: WorkScene;
}
/** The rooms there are, each followed by its close view: your own first, then the presets. */
export function sceneChoices(memory?: DeskMemory | null): SceneChoice[] {
  const rooms: WorkScene[] = [
    ...(memory?.scene ? (['custom'] as const) : []),
    ...(Object.keys(ISO_PRESETS) as IsoSceneKind[]).filter((k) => roomOf(k) === k),
  ];
  return rooms.flatMap((room) => {
    const view = viewOf(room, memory);
    const example = room !== 'custom' && Boolean(memory?.scene);
    return [
      { scene: room, label: roomLabel(room, memory), view: false, room, example },
      ...(view ? [{ scene: view, label: roomLabel(view, memory), view: true, room, example }] : []),
    ];
  });
}

/**
 * The scene a thing standing on a surface is listed in: the room's close view
 * when that view has the surface, else the scene it was saved in.
 */
export function homeOf(
  scene: IsoSceneKind | 'custom',
  surfaceId: string | null | undefined,
  memory?: DeskMemory | null,
): WorkScene {
  const room = roomOf(scene);
  const view = viewOf(room, memory);
  if (view && surfaceId && sceneOf(view, memory)?.surfaces.some((s) => s.id === surfaceId))
    return view;
  return scene;
}

/** A surface named by what it is part of: "Office desk", "Bookcase · middle shelf". */
function surfaceLabel(scene: IsoScene | null, surface: IsoSurface): string {
  const owner = scene?.props.find((p) => p.id === surface.propId)?.label;
  if (!owner) return surface.label;
  // "Top", or the surface named as its prop is (a crisper lid's lid), says nothing more.
  return !surface.label ||
    surface.label === 'Top' ||
    owner.toLowerCase().includes(surface.label.toLowerCase())
    ? owner
    : `${owner} · ${surface.label.toLowerCase()}`;
}

export interface ThingRow {
  key: string;
  /** Its id, which its stats are kept under; null for what is drawn with the room. */
  id: string | null;
  label: string;
  target: Selection;
  /** Followed by the camera, placed by hand or a scan, or drawn with the room. */
  kind: 'followed' | 'placed' | 'built-in';
  /** Seen where it was last followed, missing from there, or not followed at all. */
  status: 'seen' | 'missing' | 'still';
  /** What it says when it has no stat yet; empty for nothing worth saying. */
  detail: string;
  lamp: boolean;
  /** When the camera last saw it, ms: what a followed thing says without a stat. */
  seenAt?: number;
  /** For its menu and for picking several: a placed fixture. */
  fixture?: Fixture;
  /** For its menu: a thing drawn with your own room, which can be taken out of the layout. */
  layout?: { group: string; label: string };
}
export interface ThingGroup {
  key: string;
  label: string;
  /** The surface they stand on; null for the floor. */
  surface: IsoSurface | null;
  pinned: boolean;
  things: ThingRow[];
}
interface RuleRow {
  id: string;
  label: string;
  detail: string;
  /** Whether it has switched anything yet. */
  ran: boolean;
  inside: boolean;
}
export interface SceneOutline {
  groups: ThingGroup[];
  rules: RuleRow[];
  /** The room's close view, listed as one row: what it holds. */
  view: { scene: WorkScene; label: string; things: number; rules: number } | null;
  /** Followed things in this scene, which a zone can count. */
  followed: string[];
}

interface OutlineInput {
  scene: WorkScene;
  memory?: DeskMemory | null;
  mode: Mode;
  /** The main light, which the main zone and a lamp without its own light switch. */
  mainLight: string;
  lightsOn: Set<string>;
}

/** Things and zones of every scene, keyed by the scene each is listed in. */
function everything({ memory, mode, mainLight, lightsOn }: Omit<OutlineInput, 'scene'>) {
  const pin = memory?.surface ?? (mode === 'demo' ? DEMO_SURFACE : null);
  const things: { home: WorkScene; surfaceId: string | null; row: ThingRow }[] = [];
  for (const f of memory?.fixtures ?? []) {
    const sighted = f.place === 'sightings';
    // A thing the camera places stands on the pinned surface; one placed by hand where it was put.
    const home = sighted
      ? pin
        ? homeOf(pin.scene, pin.surfaceId, memory)
        : null
      : f.scene === 'custom'
        ? homeOf('custom', f.surfaceId, memory)
        : f.scene;
    if (!home) continue;
    const status = f.track ? (f.track.status === 'missing' ? 'missing' : 'seen') : 'still';
    const mug = sighted && f.type === 'mug';
    things.push({
      home,
      surfaceId: sighted ? (pin?.surfaceId ?? null) : f.surfaceId,
      row: {
        key: f.id,
        id: f.id,
        label: f.label,
        target: sighted
          ? { kind: 'object', id: mug ? 'main' : f.id }
          : { kind: 'fixture', id: f.id },
        kind: f.track ? 'followed' : 'placed',
        status,
        detail:
          f.control.kind !== 'none'
            ? `${f.control.kind} · ${f.state ?? 'unknown'}`
            : status === 'missing'
              ? 'missing'
              : (foodNow(f.food)?.text.toLowerCase() ?? (f.track ? '' : (f.state ?? ''))),
        ...(f.track?.observation?.observedAt
          ? { seenAt: Date.parse(f.track.observation.observedAt) }
          : {}),
        lamp: f.control.kind === 'light',
        ...(sighted ? {} : { fixture: f }),
      },
    });
  }
  // What is drawn with each room: its lamps and its small things, each once.
  const kinds: WorkScene[] = sceneChoices(memory).map((c) => c.scene);
  for (const scene of kinds) {
    const drawn = sceneOf(scene, memory);
    if (!drawn) continue;
    const view = viewOf(roomOf(scene), memory);
    const inView =
      view && view !== scene ? new Set(sceneOf(view, memory)?.surfaces.map((s) => s.id)) : null;
    for (const prop of drawn.props) {
      const lamp = prop.role === 'lamp';
      if (!lamp && !isBuiltInThing(drawn, prop)) continue;
      // A group stands where its lowest part does: a lamp's shade glows above its base.
      const surface = surfaceUnder(drawn, groupBase(drawn, prop));
      // The close view draws what stands on its surfaces itself.
      if (surface && inView?.has(surface.id)) continue;
      const entity = prop.lightId ?? mainLight;
      const own = scene === 'custom' || scene === 'custom-desk';
      things.push({
        home: scene,
        surfaceId: surface?.id ?? null,
        row: {
          key: `${scene}~${prop.id}`,
          id: null,
          label: prop.label,
          target: lamp
            ? { kind: 'lamp', id: `${scene}~${prop.id}` }
            : { kind: 'built-in', id: `${scene}~${prop.group}` },
          kind: 'built-in',
          status: 'still',
          detail: lamp
            ? entity
              ? `light · ${lightsOn.has(entity) ? 'on' : 'off'}`
              : 'no light'
            : 'drawn with the room',
          lamp,
          ...(own ? { layout: { group: prop.group, label: prop.label } } : {}),
        },
      });
    }
  }
  const sceneOfThing = new Map(things.flatMap((t) => (t.row.id ? [[t.row.id, t.home]] : [])));
  const rules = (memory?.rules ?? []).map((r) => ({
    home: ruleHome(r, memory, sceneOfThing, pin),
    row: ruleRow(r, mainLight),
  }));
  return { things, rules, pin };
}

/** The scene a zone is listed in: where it was drawn, else where what it counts is. */
function ruleHome(
  r: PlacementRule,
  memory: DeskMemory | null | undefined,
  things: Map<string, WorkScene>,
  pin: { scene: IsoSceneKind | 'custom'; surfaceId: string } | null,
): WorkScene | null {
  const on = r.zone.onSurface;
  if (on) return homeOf(on.scene, on.surfaceId, memory);
  for (const id of r.objects === 'any' ? [] : r.objects) {
    const home = things.get(id);
    if (home) return home;
  }
  return pin ? homeOf(pin.scene, pin.surfaceId, memory) : null;
}
function ruleRow(r: PlacementRule, mainLight: string): RuleRow {
  const { onEnter, onLeave } = ruleActions(r);
  const switched = stepEntities([...onEnter, ...onLeave]).map(
    (e) => e || mainLight || 'the main lamp',
  );
  const entity =
    switched.length > 2 ? `${switched[0]} +${switched.length - 1}` : switched.join(', ');
  return {
    id: r.id,
    label: r.label,
    detail: `${entity ? `→ ${entity}` : '→ Home Assistant only'}${r.placement === 'inside' ? ' · occupied' : r.placement === 'outside' ? ' · empty' : ''}`,
    ran: Boolean(r.lastDecision),
    inside: r.placement === 'inside',
  };
}

/** One scene's sidebar: its things by the surface they stand on, its zones, and its close view. */
export function sceneOutline(input: OutlineInput): SceneOutline {
  const { scene, memory } = input;
  const { things, rules, pin } = everything(input);
  const drawn = sceneOf(scene, memory);
  const here = things.filter((t) => t.home === scene);
  const pinnedId =
    pin && pinFits(pin, pinScene(scene)) && drawn?.surfaces.some((s) => s.id === pin.surfaceId)
      ? pin.surfaceId
      : null;
  const groups: ThingGroup[] = [];
  // Surfaces in the scene's order, the pinned one first; one with nothing on it only when pinned.
  const surfaces = [...(drawn?.surfaces ?? [])].sort(
    (a, b) => Number(b.id === pinnedId) - Number(a.id === pinnedId),
  );
  const known = new Set(surfaces.map((s) => s.id));
  const view = viewOf(roomOf(scene), memory);
  const inView = new Set(
    view && view !== scene ? (sceneOf(view, memory)?.surfaces.map((s) => s.id) ?? []) : [],
  );
  for (const surface of surfaces) {
    const on = here.filter((t) => t.surfaceId === surface.id).map((t) => t.row);
    // An empty surface shows only when pinned, and not in a room whose close view lists it.
    if (!on.length && (surface.id !== pinnedId || inView.has(surface.id))) continue;
    groups.push({
      key: surface.id,
      label: surfaceLabel(drawn, surface),
      surface,
      pinned: surface.id === pinnedId,
      things: on,
    });
  }
  const floor = here.filter((t) => !t.surfaceId || !known.has(t.surfaceId)).map((t) => t.row);
  if (floor.length)
    groups.push({
      key: 'floor',
      label: scene === 'custom-desk' || roomOf(scene) !== scene ? 'Around it' : 'In the room',
      surface: null,
      pinned: false,
      things: floor,
    });
  return {
    groups,
    rules: rules
      .filter((r) => r.home === scene || (!r.home && roomOf(scene) === scene))
      .map((r) => r.row),
    view:
      view && view !== scene
        ? {
            scene: view,
            label: roomLabel(view, memory),
            things: things.filter((t) => t.home === view).length,
            rules: rules.filter((r) => r.home === view).length,
          }
        : null,
    followed: here.filter((t) => t.row.kind === 'followed' && t.row.id).map((t) => t.row.id!),
  };
}
/** The placed fixtures listed in a scene, in list order: what Select can pick. */
export const pickable = (outline: SceneOutline): Fixture[] =>
  outline.groups.flatMap((g) => g.things.flatMap((t) => (t.fixture ? [t.fixture] : [])));
