import {
  fixturesSeatBodySchema,
  ISO_PRESETS,
  memberInput,
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
 * The demo's household: Robin at the office desk, sitting in its chair, and
 * Miso the cat asleep in front of the bookshelf. Through the same saves the
 * lab makes, so it is what a person adding them by hand gets.
 */
export async function addDemoHousehold(deps: Pick<RouteDeps, 'store' | 'entities'>) {
  const office = ISO_PRESETS.office;
  const bounds = (group: string) => {
    const props = office.props.filter((p) => p.group === group);
    const x = Math.min(...props.map((p) => p.at.x));
    const y = Math.min(...props.map((p) => p.at.y));
    return {
      x,
      y,
      w: Math.max(...props.map((p) => p.at.x + p.size.w)) - x,
      d: Math.max(...props.map((p) => p.at.y + p.size.d)) - y,
    };
  };
  const chair = bounds('chair');
  const shelf = bounds('shelf');
  const person = memberInput('person', 'Robin', { scene: 'office', at: { x: 0, y: 0 } });
  person.at = {
    x: chair.x + (chair.w - person.size.w) / 2,
    y: chair.y + (chair.d - person.size.d) / 2,
  };
  const cat = memberInput('cat', 'Miso', { scene: 'office', at: { x: 0, y: 0 } });
  cat.at = { x: shelf.x + shelf.w / 2 - cat.size.w / 2, y: shelf.y + shelf.d + 0.3 };
  const mode = 'demo';
  let memory = await saveFixture(deps, { mode, fixture: person });
  const robin = memory.fixtures!.at(-1)!;
  memory = await saveFixture(deps, { mode, fixture: cat });
  const miso = memory.fixtures!.at(-1)!;
  deps.store.updateMemory(mode, (m) => {
    const f = m.fixtures?.find((x) => x.id === miso.id);
    if (f) f.state = 'sleeping';
  });
  await seatFixture(deps, { mode, id: robin.id, seat: { group: 'chair' } });
}
