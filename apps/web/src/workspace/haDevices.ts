import {
  fixtureEntities,
  fixtureEntity,
  isDesktopNodeEntity,
  type Fixture,
  type HaEntity,
} from '@livinglayer/domain';
import { entityName } from './sceneOutline';

/** What the outline knows of a device's state: on, off, or nothing confirmed yet. */
export type DeviceState = 'on' | 'off' | 'unknown' | 'unavailable';

/** One device Living Layer may switch, as the outline lists it. */
export interface DeviceRow {
  entityId: string;
  /** The Thing it is, else Home Assistant's name, else its id in words. */
  name: string;
  state: DeviceState;
  /** The Things in the room it switches, first the one it is. */
  fixtureIds: string[];
}
interface DeviceGroup {
  domain: HaEntity['domain'];
  label: string;
  devices: DeviceRow[];
  /** How many of them are on now. */
  on: number;
}

const GROUPS: { domain: HaEntity['domain']; label: string }[] = [
  { domain: 'light', label: 'Lights' },
  { domain: 'switch', label: 'Switches' },
  { domain: 'fan', label: 'Fans' },
  { domain: 'input_boolean', label: 'Helper toggles' },
];

function stateOf(raw: string | null | undefined): DeviceState {
  if (raw === 'on' || raw === 'off') return raw;
  return raw === 'unavailable' ? 'unavailable' : 'unknown';
}

/**
 * The devices Living Layer may switch, by kind, named and with their state,
 * for the outline's Home Assistant section. A desktop's display is left to
 * the Desktops section: its node switches it, not Home Assistant.
 */
export function deviceGroups({
  entities,
  states,
  fixtures,
  names,
  unknownIsOff = false,
}: {
  entities: readonly string[];
  /** Each entity's state as last known (`deviceStates`). */
  states: ReadonlyMap<string, string>;
  fixtures: readonly Fixture[];
  /** Home Assistant's own names, by entity id, when they are known. */
  names?: ReadonlyMap<string, string>;
  /** The demo's virtual devices start off: one never switched is off, not unknown. */
  unknownIsOff?: boolean;
}): DeviceGroup[] {
  const rows = [...new Set(entities)]
    .filter((id) => !isDesktopNodeEntity(id))
    .map((entityId): DeviceRow & { domain: string } => {
      const things = fixtures.filter((f) => fixtureEntities(f).includes(entityId));
      // A thing switched by it alone takes its name; a lamp with several sources keeps the device's.
      const own = things.find((f) => fixtureEntity(f) === entityId);
      const thingState = own?.state === 'on' || own?.state === 'off' ? own.state : null;
      const domain = entityId.slice(0, entityId.indexOf('.'));
      return {
        entityId,
        // Anything else Home Assistant switches on and off is listed with the switches.
        domain: GROUPS.some((g) => g.domain === domain) ? domain : 'switch',
        name: own?.label ?? names?.get(entityId) ?? entityName(entityId),
        state: stateOf(states.get(entityId) ?? thingState ?? (unknownIsOff ? 'off' : null)),
        fixtureIds: (own ? [own, ...things.filter((f) => f !== own)] : things).map((f) => f.id),
      };
    });
  return GROUPS.map(({ domain, label }) => {
    const devices = rows
      .filter((r) => r.domain === domain)
      .map(({ domain: _domain, ...r }) => r)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { domain, label, devices, on: devices.filter((d) => d.state === 'on').length };
  }).filter((g) => g.devices.length);
}
