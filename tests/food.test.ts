import { describe, expect, it } from 'bun:test';
import { testApp } from './lib/app.js';
import {
  ISO_PRESETS,
  addDays,
  dayOf,
  daysUntil,
  fixtureInput,
  foodKeeps,
  foodNow,
  promoteBuiltIn,
  withoutPromoted,
  type DeskMemory,
} from '@livinglayer/domain';

const NOON = Date.parse('2026-11-03T12:00:00');

describe('food things', () => {
  it('says when food goes off, then how much is left', () => {
    expect(daysUntil('2026-11-06', '2026-11-03')).toBe(3);
    expect(addDays('2026-11-30', 2)).toBe('2026-12-02');
    expect(foodNow(undefined, NOON)).toBeNull();
    expect(foodNow({}, NOON)).toBeNull();
    expect(foodNow({ expires: '2026-11-08' }, NOON)).toEqual({
      text: 'Expires in 5 days',
      tone: 'ok',
    });
    expect(foodNow({ expires: '2026-11-04', left: 'half' }, NOON)).toEqual({
      text: 'Expires tomorrow · half left',
      tone: 'soon',
    });
    expect(foodNow({ expires: dayOf(NOON) }, NOON)?.text).toBe('Expires today');
    expect(foodNow({ expires: '2026-11-01' }, NOON)).toEqual({
      text: 'Expired 2 days ago',
      tone: 'bad',
    });
    expect(foodNow({ left: 'low' }, NOON)).toEqual({ text: 'Low left', tone: 'ok' });
    expect(foodNow({ expires: '2026-12-01', left: 'empty' }, NOON)?.tone).toBe('bad');
    expect(foodKeeps('Milk carton')).toBe(5);
    expect(foodKeeps('Leftovers')).toBe(3);
    expect(foodKeeps('Desk lamp')).toBeNull();
  });
  it('makes a preset’s built-in thing a thing that stands in for it', () => {
    const milk = promoteBuiltIn('fridge', 'milk')!;
    expect(milk).toMatchObject({ label: 'Milk carton', scene: 'fridge', builtIn: 'milk' });
    // It stands on the crisper lid, where the preset drew it.
    expect(milk.surfaceId).toBe('fridge:shelf-3');
    const fridge = ISO_PRESETS.fridge;
    const without = withoutPromoted(fridge, [{ scene: 'fridge', builtIn: 'milk' }]);
    expect(without.props.some((p) => p.group === 'milk')).toBe(false);
    expect(without.props.length).toBeLessThan(fridge.props.length);
    // Another room's fixture, or one made by hand, leaves it drawn.
    expect(withoutPromoted(fridge, [{ scene: 'office', builtIn: 'milk' }])).toBe(fridge);
    expect(withoutPromoted(fridge, [{ scene: 'fridge' }])).toBe(fridge);
  });
  it('keeps a thing’s food through a save, and drops it when cleared', async () => {
    const t = await testApp({ name: 'food' });
    const input = promoteBuiltIn('fridge', 'milk')!;
    const saved = (await t.post('fixtures/save', { fixture: input })).json<DeskMemory>();
    const milk = saved.fixtures!.find((f) => f.builtIn === 'milk')!;
    expect(milk.scene).toBe('fridge');
    const food = { expires: '2026-11-08', opened: '2026-11-03', left: 'most' as const };
    const kept = (
      await t.post('fixtures/save', { fixture: { ...fixtureInput(milk), food } })
    ).json<DeskMemory>();
    const after = kept.fixtures!.find((f) => f.id === milk.id)!;
    expect(after.food).toEqual(food);
    expect(fixtureInput(after)).toMatchObject({ builtIn: 'milk', food });
    const { food: _, ...cleared } = fixtureInput(after);
    const gone = (await t.post('fixtures/save', { fixture: cleared })).json<DeskMemory>();
    expect(gone.fixtures!.find((f) => f.id === milk.id)!.food).toBeUndefined();
    const bad = await t.post('fixtures/save', {
      fixture: { ...cleared, food: { expires: 'next week' } },
    });
    expect(bad.statusCode).toBe(400);
  });
});
