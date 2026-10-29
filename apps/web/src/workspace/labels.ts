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
} from '@livinglayer/domain';
import type { Lab } from './useLabState';
import { pinScene, viewLabel, type Selection, type WorkScene } from './progress';

/** The scene a preset kind or the person's own scene stands for. */
export function sceneOf(kind: WorkScene, memory?: DeskMemory | null) {
  if (kind === 'custom-desk') return memory?.scene ? closeViewOf(memory.scene) : null;
  return kind === 'custom' ? (memory?.scene ?? null) : ISO_PRESETS[kind];
}
export function roomLabel(room: WorkScene | null, memory?: DeskMemory | null): string {
  if (!room) return '';
  if (room === 'custom-desk') return viewLabel(room);
  return room === 'custom' ? (memory?.scene?.label ?? 'My room') : ISO_PRESETS[room].label;
}

/** The surface pin this mode uses: the saved one, or the demo desk's. */
export const pinOf = (mode: Mode, memory?: DeskMemory | null) =>
  memory?.surface ?? (mode === 'demo' ? DEMO_SURFACE : null);

export interface SurfaceRow {
  surface: IsoSurface;
  /** The scene the surface is drawn in. */
  scene: WorkScene;
  pinned: boolean;
}
/**
 * Every surface of the room, each listed once: the close view's surfaces under
 * the close view, and the rest under the room.
 */
export function surfaceRows(lab: Lab): { view: SurfaceRow[]; room: SurfaceRow[] } {
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
export function mainSurface(lab: Lab): SurfaceRow | null {
  const { room } = surfaceRows(lab);
  return room.find((r) => r.pinned) ?? room[0] ?? null;
}

/** A short name for an outline node, for the breadcrumb and the inspector title. */
export function selectionLabel(lab: Lab, s: Selection): string {
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
        ? (memory?.object?.label ?? 'The mug')
        : (memory?.others?.find((o) => o.id === s.id)?.label ?? 'Object');
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
  }
}
/** What a fixture is and, for a light or switch, its last confirmed state. */
export function controlLabel(f: Pick<Fixture, 'control' | 'state'>): string {
  if (f.control.kind === 'none') return 'just a thing';
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
 * inspector or the lamp test (a `lamp` run), a rule turning it on, or the
 * mug's zone turning the main light on. Unconfirmed actions say nothing.
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
    if (run.kind !== 'lamp' || run.mode !== memory?.mode) continue;
    const out = run.output as Partial<LampResult> | null;
    if (out?.stateConfirmed) note(out.entityId, out.action ?? 'on', run.createdAt);
  }
  for (const d of [memory?.lastDecision, ...(memory?.rules ?? []).map((r) => r.lastDecision)])
    if (d?.output.action === 'confirmed' && d.output.lamp?.stateConfirmed)
      note(d.output.lamp.entityId, 'on', d.createdAt);
  return new Map([...latest].map(([entity, { state }]) => [entity, state]));
}
/** A lamp drawn as part of a room's layout, and the light it stands for. */
export interface BuiltInLamp {
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
export function builtInLamps(lab: Lab): BuiltInLamp[] {
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
