import {
  runOutput,
  fixturesControlBodySchema,
  linkedFixtures,
  fixtureEntity,
  type DeskMemory,
  type LampResult,
} from '@livinglayer/domain';
import { LabError } from '../errors.js';
import { type RouteDeps } from '../route-deps.js';
import { type Parsed } from './shared.js';

/** What a confirmed action says about every fixture on that entity; unconfirmed says nothing. */
export function noteControl(memory: DeskMemory, result: LampResult): void {
  for (const f of memory.fixtures ?? []) {
    if (fixtureEntity(f) === result.entityId)
      f.state = result.stateConfirmed ? (result.action ?? 'on') : null;
    for (const l of f.lights ?? []) {
      if (l.entityId !== result.entityId) continue;
      const { [l.part]: _was, ...lit } = f.lit ?? {};
      f.lit = result.stateConfirmed ? { ...lit, [l.part]: result.action !== 'off' } : lit;
    }
  }
}

/**
 * Switch a fixture's light or switch, a fixture's state/pose, or a configured
 * entity directly: a lamp that is part of the room's layout has no fixture of its own.
 */
export async function controlFixture(
  { store, run, control, entities }: Pick<RouteDeps, 'store' | 'run' | 'control' | 'entities'>,
  { mode, fixtureId, entityId, part, action }: Parsed<typeof fixturesControlBodySchema>,
) {
  let entity = entityId ?? null;
  if (fixtureId) {
    const memory = store.memory(mode);
    const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
    if (!fixture)
      throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
    if (part) {
      const light = fixture.lights?.find((l) => l.part === part);
      if (!light)
        throw new LabError(
          'fixture_control',
          `That light source of the ${fixture.label} switches nothing.`,
          400,
        );
      entity = light.entityId;
    } else entity = fixtureEntity(fixture);
    if (part && action !== 'on' && action !== 'off')
      throw new LabError('fixture_control', 'A light source can only be switched on or off.', 400);
    if (!entity || (action !== 'on' && action !== 'off')) {
      if (!fixture.states || !(action in fixture.states))
        throw new LabError('fixture_control', `The ${fixture.label} has nothing to switch.`, 400);
      const now = new Date().toISOString();
      const group = new Set([
        fixture.id,
        ...linkedFixtures(memory.fixtures ?? [], fixture).map((f) => f.id),
      ]);
      for (const f of memory.fixtures ?? [])
        if (group.has(f.id)) {
          f.state = action;
          f.updatedAt = now;
        }
      store.saveMemory(memory);
      return { memory, event: null };
    }
  } else if (!entities(mode).includes(entity!))
    throw new LabError('lamp_unknown', 'That entity is not one of the configured ones.', 409);
  if (action !== 'on' && action !== 'off')
    throw new LabError('fixture_control', 'An entity can only be switched on or off.', 400);
  const event = await run('lamp', mode, async () => ({
    output: await control(mode, entity!, action),
  }));
  // Read again: the action took a while, and the memory may have changed meanwhile.
  const memory = store.memory(mode);
  noteControl(memory, runOutput(event, 'lamp')!);
  store.saveMemory(memory);
  return { memory, event };
}
