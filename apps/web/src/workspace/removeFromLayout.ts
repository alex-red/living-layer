import { removeGroup, type DeskMemory } from '@livinglayer/domain';
import type { Lab } from './useLabState';
import type { useCall } from './panel';

/** What taking a thing out of the layout, or changing its layer, reads of the lab. */
export type LayoutLab = Pick<Lab, 'memory' | 'setMemory' | 'selection' | 'select' | 'setMessage'>;

/**
 * Take a built-in thing (the office's book, bottle or lamp) out of the
 * person's own layout, in the room and its close view at once.
 */
export function removeFromLayout(
  lab: LayoutLab,
  call: ReturnType<typeof useCall>['call'],
  group: string,
  label: string,
) {
  const scene = lab.memory?.scene;
  if (!scene) return Promise.resolve();
  return call<DeskMemory>('scene/save', { scene: removeGroup(scene, group) }, (m) => {
    lab.setMemory(m);
    const s = lab.selection;
    if ((s?.kind === 'lamp' || s?.kind === 'built-in') && s.id.endsWith(`~${group}`))
      lab.select(null);
    lab.setMessage(`Removed the ${label.toLowerCase()} from the room.`);
  });
}
