import { DEMO_FRIDGE, dayOf, demoFood, promoteBuiltIn } from '@livinglayer/domain';
import type { RouteDeps } from '../route-deps.js';
import { saveFixture } from './save.js';

/**
 * The demo's fridge stocked: each food thing drawn with it made a thing, as
 * _Make it a thing_ does, with its use-by day, when it was opened and how
 * much is left (`DEMO_FRIDGE`), counted from today, so its card, its health
 * bar and the room's answers about food agree. One already a thing is left
 * as it is. Marks the demo as stocked (`fridgeAt`), so a server starting
 * again doesn't bring back food someone deleted.
 */
export async function stockDemoFridge(deps: Pick<RouteDeps, 'store' | 'entities'>) {
  const mode = 'demo';
  deps.store.updateMemory(mode, (m) => void (m.fridgeAt ??= new Date().toISOString()));
  const today = dayOf(Date.now());
  for (const food of DEMO_FRIDGE) {
    const made = deps.store
      .memory(mode)
      .fixtures?.some((f) => f.scene === 'fridge' && f.builtIn === food.group);
    const fixture = promoteBuiltIn('fridge', food.group);
    if (made || !fixture) continue;
    await saveFixture(deps, { mode, fixture: { ...fixture, food: demoFood(food, today) } });
  }
  return deps.store.memory(mode);
}
