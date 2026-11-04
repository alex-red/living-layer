import type { StageView } from '../session';

/** Where a zone's rectangle is dragged: on the camera picture, or in the room. */
type DrawOn = 'picture' | 'room';
/** What a zone being set up needs to know about itself to be drawn. */
interface Drawn {
  motion?: unknown;
  anchor?: unknown;
  onSurface?: unknown;
  drawOn?: DrawOn;
}

/**
 * Where a new or edited zone's rectangle is dragged. A zone that is a thing
 * isn't dragged at all, and a motion zone is on the camera picture. Any other
 * is where the person chose while there is a live view (the camera, or the
 * demo's): the picture to start with, or the room for one drawn there before.
 * Without a live view it is in the room.
 */
export function zoneDrawnOn(draft: Drawn, liveView: boolean): DrawOn | 'thing' {
  if (draft.anchor) return 'thing';
  if (draft.motion) return 'picture';
  if (!liveView) return 'room';
  return draft.drawOn ?? (draft.onSurface ? 'room' : 'picture');
}

/** The stage to show while a zone is drawn: one with the picture, or the room, it is dragged on. */
export function stageForZone(draft: Drawn, liveView: boolean, stageView: StageView): StageView {
  const on = zoneDrawnOn(draft, liveView);
  if (on === 'picture') return stageView === 'iso' ? 'split' : stageView;
  return stageView === 'photo' ? 'iso' : stageView;
}

/** The zone drawn somewhere else: its rectangle is dragged again there. */
export function drawZoneOn<T extends Drawn & { rect: unknown }>(draft: T, on: DrawOn): T {
  const { onSurface: _, ...rest } = draft;
  return { ...rest, rect: null, drawOn: on } as T;
}
