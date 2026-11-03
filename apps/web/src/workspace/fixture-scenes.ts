import { ISO_PRESETS, type IsoSceneKind } from '@livinglayer/domain';
import { useDesk, useLabParts, useObservation } from './LabContext';
import { roomLabel } from './labels';
import { pinScene } from './progress';

/** Fixtures stand in a room or a preset close view; a photographed room's desk view is the room's own. */
export type WorkScene = IsoSceneKind | 'custom';

/** The scenes a fixture can go in: the room, and its close view when it has one. */
export function useScenes(): { id: WorkScene; label: string }[] {
  const { progress, memory } = useLabParts(useDesk(), useObservation());
  return [
    ...(progress.room
      ? [{ id: pinScene(progress.room), label: roomLabel(progress.room, memory) }]
      : []),
    ...(progress.view && progress.view !== 'custom-desk'
      ? [{ id: progress.view, label: ISO_PRESETS[progress.view].label }]
      : []),
  ];
}
