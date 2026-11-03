import {
  DEMO_SURFACE,
  ISO_PRESETS,
  closeViewOf,
  pinFits,
  type DeskMemory,
  type EvidenceRun,
  type Fixture,
  type IsoProp,
  type LampResult,
  type IsoSurface,
  type Mode,
  mugOf,
  otherObjects,
  withoutPromoted,
} from '@livinglayer/domain';
import { isRun } from '@livinglayer/domain';
import type { Lab } from './useLabState';

/** What the outline's helpers read of the lab. */
export type LabRead = Pick<Lab, 'progress' | 'memory' | 'mode' | 'lights' | 'scene'>;
import { pinScene, viewLabel, type Selection, type WorkScene } from './progress';

/** The scene a preset kind or the person's own scene stands for. */
export function sceneOf(kind: WorkScene, memory?: DeskMemory | null) {
  if (kind === 'custom-desk') return memory?.scene ? closeViewOf(memory.scene) : null;
  // A preset's built-in thing made a thing of its own is drawn as that thing.
  return kind === 'custom'
    ? (memory?.scene ?? null)
    : withoutPromoted(ISO_PRESETS[kind], memory?.fixtures);
}
export function roomLabel(room: WorkScene | null, memory?: DeskMemory | null): string {
  if (!room) return '';
  if (room === 'custom-desk') return viewLabel(room);
  return room === 'custom' ? (memory?.scene?.label ?? 'My room') : ISO_PRESETS[room].label;
}

/** The surface pin this mode uses: the saved one, or the demo desk's. */
const pinOf = (mode: Mode, memory?: DeskMemory | null) =>
  memory?.surface ?? (mode === 'demo' ? DEMO_SURFACE : null);

interface SurfaceRow {
  surface: IsoSurface;
  /** The scene the surface is drawn in. */
  scene: WorkScene;
  pinned: boolean;
}
/**
 * Every surface of the room, each listed once: the close view's surfaces under
 * the close view, and the rest under the room.
 */
export function surfaceRows(lab: LabRead): { view: SurfaceRow[]; room: SurfaceRow[] } {
  const { progress, memory, mode } = lab;
  const pin = pinOf(mode, memory);
  const row = (scene: WorkScene) => (surface: IsoSurface) => ({
    surface,
    scene,
    pinned: Boolean(pin && pinFits(pin, pinScene(scene)) && pin.surfaceId === surface.id),
  });
  if (!progress.room) return { view: [], room: [] };
  const view = progress.view
    ? (sceneOf(progress.view, memory)?.surfaces ?? []).map(row(progress.view))
    : [];
  const ids = new Set(view.map((r) => r.surface.id));
  const room = (sceneOf(progress.room, memory)?.surfaces ?? [])
    .filter((s) => !ids.has(s.id))
    .map(row(progress.room));
  return { view, room };
}
/** The surface a room without a close view is pinned on: the pinned one, or its first. */
export function mainSurface(lab: LabRead): SurfaceRow | null {
  const { room } = surfaceRows(lab);
  return room.find((r) => r.pinned) ?? room[0] ?? null;
}

/** A short name for an outline node, for the breadcrumb and the inspector title. */
export function selectionLabel(lab: LabRead, s: Selection): string {
  const { memory, progress } = lab;
  switch (s.kind) {
    case 'room':
      return roomLabel(progress.room, memory);
    case 'view':
      return progress.view
        ? viewLabel(progress.view)
        : (mainSurface(lab)?.surface.label ?? 'Surface');
    case 'surface': {
      const rows = surfaceRows(lab);
      return (
        [...rows.view, ...rows.room].find((r) => r.surface.id === s.id)?.surface.label ?? 'Surface'
      );
    }
    case 'object':
      return s.id === 'main'
        ? (mugOf(memory)?.label ?? 'The mug')
        : (otherObjects(memory)?.find((o) => o.id === s.id)?.label ?? 'Object');
    case 'suggested':
      return lab.scene?.objects[s.index]?.label ?? 'Suggested object';
    case 'add':
      return 'Add an object';
    case 'rule':
      return s.id === 'main'
        ? 'Main zone'
        : (memory?.rules?.find((r) => r.id === s.id)?.label ?? 'Rule');
    case 'new-rule':
      return 'New rule';
    case 'fixture':
      return memory?.fixtures?.find((f) => f.id === s.id)?.label ?? 'Fixture';
    case 'new-fixture':
      return 'Add a fixture';
    case 'lamp':
      return builtInLamps(lab).find((l) => l.id === s.id)?.prop.label ?? 'Lamp';
    case 'built-in':
      return builtInThings(lab).find((t) => t.id === s.id)?.prop.label ?? 'Built-in thing';
    case 'entity':
      return memory?.exposed?.find((e) => e.id === s.id)?.name ?? 'Entity';
    case 'new-entity':
      return 'Show in Home Assistant';
    case 'devices':
      return 'Devices it can switch';
  }
}
/** What a fixture is and, for a light or switch, its last confirmed state. */
export function controlLabel(f: Pick<Fixture, 'control' | 'state'>): string {
  if (f.control.kind === 'none') return f.state ? `thing · ${f.state}` : 'just a thing';
  return `${f.control.kind} · ${f.state ?? 'unknown'}`;
}

/** "40 s ago", "6 min ago". */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/**
 * Each light's last confirmed state, from the newest of: a switch from the
 * inspector or the lamp test (a `lamp` run), or a rule or the mug's zone
 * switching it on or, when the mug leaves, off. Unconfirmed actions say nothing.
 */
export function lightStates(
  memory: DeskMemory | null | undefined,
  runs: EvidenceRun[],
): Map<string, 'on' | 'off'> {
  const latest = new Map<string, { state: 'on' | 'off'; at: string }>();
  const note = (entity: string | undefined, state: 'on' | 'off', at: string) => {
    if (!entity) return;
    const seen = latest.get(entity);
    if (!seen || seen.at < at) latest.set(entity, { state, at });
  };
  for (const run of runs) {
    if (!isRun(run, 'lamp') || run.mode !== memory?.mode) continue;
    const out: Partial<LampResult> | null = run.output;
    if (out?.stateConfirmed) note(out.entityId, out.action ?? 'on', run.createdAt);
  }
  for (const d of [memory?.lastDecision, ...(memory?.rules ?? []).map((r) => r.lastDecision)])
    if (d?.output.action === 'confirmed' && d.output.lamp?.stateConfirmed)
      note(d.output.lamp.entityId, d.output.lamp.action ?? 'on', d.createdAt);
  return new Map([...latest].map(([entity, { state }]) => [entity, state]));
}
/** A lamp drawn as part of a room's layout, and the light it stands for. */
interface BuiltInLamp {
  /** `scene~propId`, the outline's id for it. */
  id: string;
  scene: WorkScene;
  prop: IsoProp;
  /** Its own light, else the main one; empty when none is configured. */
  entity: string;
}
/**
 * The lamps in the room and its close view. The office desk's lamp is in
 * both scenes, so a lamp of the same name and light is listed once.
 */
export function builtInLamps(lab: LabRead): BuiltInLamp[] {
  const { progress, memory } = lab;
  const kinds = [progress.view, progress.room].filter((k): k is WorkScene => Boolean(k));
  const seen = new Set<string>();
  const lamps: BuiltInLamp[] = [];
  for (const scene of kinds)
    for (const prop of sceneOf(scene, memory)?.props ?? []) {
      if (prop.role !== 'lamp') continue;
      const entity = prop.lightId ?? lab.lights[0] ?? '';
      const key = `${prop.label}|${entity}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lamps.push({ id: `${scene}~${prop.id}`, scene, prop, entity });
    }
  return lamps;
}
/** The small templates drawn standing on a desk or shelf: a book, a bottle, the fridge's eggs. */
export const DESK_THINGS = new Set(['book', 'bottle', 'jar', 'carton', 'eggs', 'butter', 'tub']);
/** A small thing drawn as part of a room's layout, such as the office's book. */
interface BuiltInThing {
  /** `scene~group`, the outline's id for it. */
  id: string;
  scene: WorkScene;
  /** Its main prop, whose label names it. */
  prop: IsoProp;
}
/**
 * The small things in the room and its close view that aren't lamps, listed
 * once when both scenes draw the same one.
 */
export function builtInThings(lab: LabRead): BuiltInThing[] {
  const { progress, memory } = lab;
  const kinds = [progress.view, progress.room].filter((k): k is WorkScene => Boolean(k));
  const seen = new Set<string>();
  const things: BuiltInThing[] = [];
  for (const scene of kinds)
    for (const prop of sceneOf(scene, memory)?.props ?? []) {
      if (prop.id !== prop.group || !prop.template || !DESK_THINGS.has(prop.template)) continue;
      if (seen.has(prop.group)) continue;
      seen.add(prop.group);
      things.push({ id: `${scene}~${prop.group}`, scene, prop });
    }
  return things;
}
/** Whether a built-in thing's scene is the person's own, whose layout can lose it. */
export const ownLayout = (scene: WorkScene) => scene === 'custom' || scene === 'custom-desk';
