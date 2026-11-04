import {
  DEMO_LITTER_CAT,
  ISO_PRESETS,
  groupBounds,
  memberInput,
  promoteBuiltIn,
} from '@livinglayer/domain';
import type { RouteDeps } from '../route-deps.js';
import { saveFixture } from './save.js';

/**
 * The demo's litter box room set up: the litter robot made a thing, as _Make
 * it a thing_ does, so its card shows the visits and the drawer, and Juniper,
 * a long-haired tabby, sitting beside its mat. Each only when it isn't there
 * already. Marks the demo as set up (`litterAt`), so a server starting again
 * doesn't bring back what someone deleted.
 */
export async function addDemoLitterRoom(deps: Pick<RouteDeps, 'store' | 'entities'>) {
  const mode = 'demo';
  deps.store.updateMemory(mode, (m) => void (m.litterAt ??= new Date().toISOString()));
  const here = () => deps.store.memory(mode).fixtures?.filter((f) => f.scene === 'litter') ?? [];
  const robot = promoteBuiltIn('litter', 'litter-robot');
  if (robot && !here().some((f) => f.builtIn === 'litter-robot'))
    await saveFixture(deps, { mode, fixture: robot });
  if (!here().some((f) => f.type === 'cat')) {
    // On the floor to the right of the mat, facing the room.
    const mat = groupBounds(ISO_PRESETS.litter, 'litter-mat');
    const at = mat ? { x: mat.at.x + mat.size.w + 0.15, y: mat.at.y + 0.1 } : { x: 3.9, y: 2.6 };
    await saveFixture(deps, {
      mode,
      fixture: memberInput('cat', DEMO_LITTER_CAT, { scene: 'litter', at }, 'cat-tabby'),
    });
  }
  return deps.store.memory(mode);
}
