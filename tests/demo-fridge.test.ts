import { describe, expect, it } from 'bun:test';
import {
  DEMO_FOOD,
  DEMO_FRIDGE,
  ISO_PRESETS,
  dayOf,
  demoFood,
  foodKeeps,
  foodNow,
  type DeskMemory,
} from '@livinglayer/domain';
import { testApp } from './lib/app.js';

/** The demo memory as a reset leaves it. */
async function reset(): Promise<DeskMemory> {
  const { app } = await testApp({ name: 'demo-fridge', appearance: async () => null });
  const res = await app.inject({ method: 'POST', url: '/api/desk/demo/reset' });
  return res.json<DeskMemory>();
}

describe('the demo fridge', () => {
  it('draws everything it stocks, under the name the sample day uses', () => {
    const props = ISO_PRESETS.fridge.props;
    for (const f of DEMO_FRIDGE)
      expect(props.find((p) => p.group === f.group)?.label).toBe(f.label);
  });

  it('keeps each of its things as food', () => {
    for (const f of DEMO_FRIDGE) expect(foodKeeps(f.label)).not.toBeNull();
  });

  it('dates its food from the sample day', () => {
    const milk = DEMO_FOOD.find((f) => f.label === 'Milk')!;
    expect(demoFood(milk, '2026-11-04')).toEqual({
      added: '2026-10-27',
      opened: '2026-10-31',
      expires: '2026-11-05',
      left: 'low',
    });
  });

  it('has nothing but the day’s food to eat first', () => {
    const soon = DEMO_FRIDGE.filter((f) => f.useByDays <= 2).map((f) => f.label);
    expect(soon).toEqual(['Leftover chicken', 'Milk']);
  });

  it('is stocked by a reset, each thing with its food details from today', async () => {
    const memory = await reset();
    const fridge = memory.fixtures!.filter((f) => f.scene === 'fridge');
    expect(fridge.map((f) => f.builtIn).toSorted()).toEqual(
      DEMO_FRIDGE.map((f) => f.group).toSorted(),
    );
    const chicken = fridge.find((f) => f.builtIn === 'leftovers')!;
    expect(chicken.food?.expires).toBe(dayOf(Date.now()));
    expect(foodNow(chicken.food)?.text).toBe('Expires today · half left');
    expect(memory.fridgeAt).toBeString();
  });
});
