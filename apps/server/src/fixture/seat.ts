import {
  fixturesSeatBodySchema,
  groupBounds,
  isMember,
  ISO_PRESETS,
  memberInput,
  type FixtureInput,
  seatPerson,
  standUp,
  type DeskMemory,
} from '@livinglayer/domain';
import { LabError } from '../errors.js';
import type { RouteDeps } from '../route-deps.js';
import { promoteFixture } from './promote.js';
import { saveFixture } from './save.js';
import type { Parsed } from './shared.js';

/**
 * Sit a person down in a seat, or stand them up ([plan](../../../../docs/plans/people-and-pets.md)).
 * A chair of the layout is made a thing first, as _Make it a thing_ does, so
 * it can show them drawn into its model.
 */
export async function seatFixture(
  deps: Pick<RouteDeps, 'store' | 'entities'>,
  { mode, id, seat }: Parsed<typeof fixturesSeatBodySchema>,
): Promise<DeskMemory> {
  const { store } = deps;
  const person = store.memory(mode).fixtures?.find((f) => f.id === id);
  if (!person)
    throw new LabError('fixture_unknown', 'That person is not in this desk memory.', 404);
  if (person.type !== 'person') throw new LabError('fixture_seat', 'Only a person sits.', 400);
  const now = new Date().toISOString();
  if (!seat)
    return store.updateMemory(mode, (m) => {
      m.fixtures = standUp(m.fixtures ?? [], id, now);
      return m;
    });
  let seatId: string;
  if ('group' in seat) {
    // A preset's chair made a thing before stands in for it already.
    const made = store
      .memory(mode)
      .fixtures?.find((f) => f.scene === person.scene && f.builtIn === seat.group);
    seatId =
      made?.id ??
      (await promoteFixture(deps, { mode, scene: person.scene, group: seat.group })).fixtureId;
  } else seatId = seat.fixtureId;
  return store.updateMemory(mode, (m) => {
    const next = seatPerson(m.fixtures ?? [], id, seatId, now);
    if ('reason' in next) throw new LabError('fixture_seat', next.reason, 422);
    m.fixtures = next;
    return m;
  });
}

/**
 * The demo's household in its Home room: Robin at the table, sitting in its
 * chair, Sam standing by the shelf, Miso the cat asleep by the plant and
 * Biscuit the dog lying by the table. Through the same saves the lab makes,
 * so it is what adding them by hand gives. Nothing when someone is home there
 * already.
 */
export async function addDemoHousehold(deps: Pick<RouteDeps, 'store' | 'entities'>) {
  const mode = 'demo';
  if (deps.store.memory(mode).fixtures?.some((f) => f.scene === 'home' && isMember(f)))
    return deps.store.memory(mode);
  const chair = groupBounds(ISO_PRESETS.home, 'chair');
  const at = (x: number, y: number) => ({ scene: 'home' as const, at: { x, y } });
  const robin = memberInput('person', 'Robin', at(0, 0));
  if (chair)
    robin.at = {
      x: chair.at.x + (chair.size.w - robin.size.w) / 2,
      y: chair.at.y + (chair.size.d - robin.size.d) / 2,
    };
  const household: [FixtureInput, string | null][] = [
    [robin, null],
    [memberInput('person', 'Sam', at(7.6, 3.4)), null],
    [memberInput('cat', 'Miso', at(1.6, 5.6)), 'sleeping'],
    [memberInput('dog', 'Biscuit', at(7.2, 5.8)), 'lying'],
  ];
  let robinId = '';
  for (const [fixture, state] of household) {
    const saved = (await saveFixture(deps, { mode, fixture })).fixtures!.at(-1)!;
    if (fixture === robin) robinId = saved.id;
    if (state)
      deps.store.updateMemory(mode, (m) => {
        const f = m.fixtures?.find((x) => x.id === saved.id);
        if (f) f.state = state;
      });
  }
  return chair
    ? seatFixture(deps, { mode, id: robinId, seat: { group: 'chair' } })
    : deps.store.memory(mode);
}
