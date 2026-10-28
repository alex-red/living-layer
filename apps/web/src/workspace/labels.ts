import {
  FIXTURE_SURFACE,
  ISO_PRESETS,
  pinFits,
  type DeskMemory,
  type IsoSurface,
  type Mode,
} from '@livinglayer/domain';
import type { Lab } from './useLabState';
import type { Selection, WorkScene } from './progress';

/** The scene a preset kind or the person's own scene stands for. */
export function sceneOf(kind: WorkScene, memory?: DeskMemory | null) {
  return kind === 'custom' ? (memory?.scene ?? null) : ISO_PRESETS[kind];
}
export function roomLabel(room: WorkScene | null, memory?: DeskMemory | null): string {
  if (!room) return '';
  return room === 'custom' ? (memory?.scene?.label ?? 'My room') : ISO_PRESETS[room].label;
}

/** The surface pin this mode uses: the saved one, or the demo desk's. */
export const pinOf = (mode: Mode, memory?: DeskMemory | null) =>
  memory?.surface ?? (mode === 'fixture' ? FIXTURE_SURFACE : null);

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
    pinned: Boolean(pin && pinFits(pin, scene) && pin.surfaceId === surface.id),
  });
  if (!progress.room) return { view: [], room: [] };
  const view = progress.view ? ISO_PRESETS[progress.view].surfaces.map(row(progress.view)) : [];
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
        ? ISO_PRESETS[progress.view].label
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
        ? 'Mug zone'
        : (memory?.rules?.find((r) => r.id === s.id)?.label ?? 'Rule');
    case 'new-rule':
      return 'New rule';
  }
}

/** "40 s ago", "6 min ago". */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
