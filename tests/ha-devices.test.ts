import { describe, expect, it } from 'bun:test';
import {
  DEMO_DESKTOP_NODE,
  DEMO_LIGHTS,
  DEMO_SWITCHES,
  desktopNodeEntity,
  type Fixture,
} from '@livinglayer/domain';
import { deviceGroups } from '../apps/web/src/workspace/haDevices.js';

const entities = [...DEMO_LIGHTS, ...DEMO_SWITCHES, desktopNodeEntity(DEMO_DESKTOP_NODE.id)];
// What the grouping reads of a thing: its label, what it switches, and its state.
const fan = {
  id: 'fan-1',
  label: 'Desk fan',
  control: { kind: 'switch', entityId: 'switch.demo_fan' },
  state: 'on',
} as unknown as Fixture;

describe('deviceGroups', () => {
  it('lists lights then switches, leaving desktop displays to the Desktops section', () => {
    const groups = deviceGroups({ entities, states: new Map(), fixtures: [] });
    expect(groups.map((g) => g.label)).toEqual(['Lights', 'Switches']);
    expect(groups.flatMap((g) => g.devices).map((d) => d.entityId)).not.toContain(
      desktopNodeEntity(DEMO_DESKTOP_NODE.id),
    );
    expect(groups[0]!.devices).toHaveLength(DEMO_LIGHTS.length);
  });

  it('counts the devices on in each group from their known states', () => {
    const states = new Map([
      ['light.demo_desk', 'on'],
      ['light.demo_shelf', 'off'],
    ]);
    const [lights] = deviceGroups({ entities, states, fixtures: [] });
    expect(lights!.on).toBe(1);
    const byId = new Map(lights!.devices.map((d) => [d.entityId, d.state]));
    expect(byId.get('light.demo_desk')).toBe('on');
    expect(byId.get('light.demo_shelf')).toBe('off');
    expect(byId.get('light.demo_fridge')).toBe('unknown');
  });

  it('names a device after the thing it switches and takes its state from it', () => {
    const switches = deviceGroups({ entities, states: new Map(), fixtures: [fan] })[1]!;
    const device = switches.devices.find((d) => d.entityId === 'switch.demo_fan')!;
    expect(device).toMatchObject({ name: 'Desk fan', state: 'on', fixtureIds: ['fan-1'] });
  });

  it('prefers what Home Assistant reports over the thing’s last state', () => {
    const states = new Map([['switch.demo_fan', 'off']]);
    const switches = deviceGroups({ entities, states, fixtures: [fan] })[1]!;
    expect(switches.devices.find((d) => d.entityId === 'switch.demo_fan')!.state).toBe('off');
  });

  it('shows a device Home Assistant marks unavailable as such', () => {
    const states = new Map([['light.demo_desk', 'unavailable']]);
    const [lights] = deviceGroups({ entities, states, fixtures: [] });
    expect(lights!.devices.find((d) => d.entityId === 'light.demo_desk')!.state).toBe(
      'unavailable',
    );
  });

  it('counts a demo device never switched as off', () => {
    const [lights] = deviceGroups({
      entities,
      states: new Map(),
      fixtures: [],
      unknownIsOff: true,
    });
    expect(lights!.devices.every((d) => d.state === 'off')).toBe(true);
  });
});
