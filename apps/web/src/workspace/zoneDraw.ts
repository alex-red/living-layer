import type { StageView } from '../session';

/** What a zone being set up needs to know about itself to be drawn. */
interface Drawn {
  motion?: unknown;
  anchor?: unknown;
}

/**
 * Where a new or edited zone's rectangle is dragged: a zone that is a thing
 * isn't dragged at all; a motion zone, and any other while there is a live
 * view (the camera, or the demo's), on the camera picture; else on the room.
 */
export function zoneDrawnOn(draft: Drawn, liveView: boolean): 'picture' | 'room' | 'thing' {
  if (draft.anchor) return 'thing';
  return draft.motion || liveView ? 'picture' : 'room';
}

/** The stage to show while a zone is drawn: one with the picture, or the room, it is dragged on. */
export function stageForZone(draft: Drawn, liveView: boolean, stageView: StageView): StageView {
  const on = zoneDrawnOn(draft, liveView);
  if (on === 'picture') return stageView === 'iso' ? 'split' : stageView;
  return stageView === 'photo' ? 'iso' : stageView;
}
