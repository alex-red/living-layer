import { describe, expect, it } from 'bun:test';
import { testApp } from './lib/app.js';
import {
  ISO_PRESETS,
  addDays,
  dayOf,
  daysUntil,
  fixtureInput,
  foodDefaults,
  foodHealth,
  foodKeeps,
  foodNow,
  promoteBuiltIn,
  sampleFood,
  foodSchema,
  type StatNow,
  suggestedStats,
  withoutPromoted,
  type DeskMemory,
} from '@livinglayer/domain';
import { calloutDensity, layoutCallouts } from '../apps/web/src/iso/Callouts.js';

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
    // Bought today, a thing starts with its usual use-by day.
    expect(foodDefaults('Milk carton', '2026-11-03')).toEqual({
      added: '2026-11-03',
      expires: '2026-11-13',
    });
    expect(foodDefaults('Egg carton', '2026-11-03')?.expires).toBe('2026-12-01');
    expect(foodDefaults('Green book', '2026-11-03')).toBeNull();
    // Health: the share of its keeping time to go, from opened, else from when it came in.
    // Opened 3 days ago, good for 5: 3 of its 6 days (today counts) to go.
    expect(foodHealth({ opened: '2026-10-31', expires: '2026-11-05' }, NOON)).toBeCloseTo(0.5);
    expect(foodHealth({ added: '2026-10-20', expires: '2026-11-17' }, NOON)).toBeCloseTo(15 / 29);
    expect(foodHealth({ expires: '2026-11-08' }, NOON)).toBe(1);
    // Its last day is still a day; past it, nothing.
    expect(foodHealth({ opened: '2026-11-01', expires: '2026-11-03' }, NOON)).toBeCloseTo(1 / 3);
    expect(foodHealth({ expires: '2026-11-02' }, NOON)).toBe(0);
    expect(foodHealth({ expires: '2026-12-01', left: 'empty' }, NOON)).toBe(0);
    expect(foodHealth({ left: 'half' }, NOON)).toBeNull();
    // Food keeps when it was last taken out, once a camera watches the fridge.
    expect(suggestedStats({ label: 'Milk carton' })).toEqual(['lastUsed']);
    expect(suggestedStats({ label: 'Leftovers' })).toEqual(['lastUsed']);
  });
  it('makes a preset’s built-in thing a thing that stands in for it', () => {
    const milk = promoteBuiltIn('fridge', 'milk')!;
    expect(milk).toMatchObject({ label: 'Milk', scene: 'fridge', builtIn: 'milk' });
    // It stands on the crisper lid, where the preset drew it.
    expect(milk.surfaceId).toBe('fridge:shelf-3');
    expect(milk.food).toBeUndefined();
    expect(promoteBuiltIn('fridge', 'eggs', '2026-11-03')?.food).toEqual({
      added: '2026-11-03',
      expires: '2026-12-01',
    });
    const fridge = ISO_PRESETS.fridge;
    const without = withoutPromoted(fridge, [{ scene: 'fridge', builtIn: 'milk' }]);
    expect(without.props.some((p) => p.group === 'milk')).toBe(false);
    expect(without.props.length).toBeLessThan(fridge.props.length);
    // Another room's fixture, or one made by hand, leaves it drawn.
    expect(withoutPromoted(fridge, [{ scene: 'office', builtIn: 'milk' }])).toBe(fridge);
    expect(withoutPromoted(fridge, [{ scene: 'fridge' }])).toBe(fridge);
  });
  it('gives believable sample values for a demo', () => {
    // A fixed sequence of "random" numbers, so the sample is known.
    const seq = (...xs: number[]) => {
      let i = 0;
      return () => xs[i++ % xs.length]!;
    };
    // Opened: in a while, opened since, its use-by its usual days from opening.
    expect(sampleFood('Milk carton', '2026-11-03', seq(0.5, 0.9, 0.5, 0.5))).toEqual({
      added: '2026-10-29',
      opened: '2026-11-01',
      expires: '2026-11-06',
      left: 'low',
    });
    // Not opened: its use-by as bought.
    expect(sampleFood('Egg carton', '2026-11-03', seq(0.5, 0.1))).toEqual({
      added: '2026-10-21',
      expires: '2026-11-18',
    });
    expect(sampleFood('Desk lamp', '2026-11-03')).toBeNull();
    for (let i = 0; i < 50; i++) {
      const s = sampleFood('Leftovers', '2026-11-03')!;
      expect(s.added! <= '2026-11-03').toBe(true);
      expect(foodSchema.safeParse(s).success).toBe(true);
    }
  });
  it('takes when a thing was last used from the person', async () => {
    const t = await testApp({ name: 'food-used' });
    const saved = (
      await t.post('fixtures/save', { fixture: promoteBuiltIn('fridge', 'milk')! })
    ).json<DeskMemory>();
    const id = saved.fixtures!.find((f) => f.builtIn === 'milk')!.id;
    const at = Date.now() - 3_600_000;
    expect((await t.post('things/used', { id, at })).statusCode).toBe(409);
    await t.post('things/stats', { id, stats: [{ key: 'lastUsed' }] });
    const used = (await t.post('things/used', { id, at })).json<{ now: StatNow }>();
    expect(used.now).toMatchObject({ value: at, since: at, source: 'person' });
    const later = await t.post('things/used', { id, at: Date.now() + 3_600_000 });
    expect(later.statusCode).toBe(400);
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

describe('stats cards', () => {
  it('say less as they are drawn smaller, and step back up only with room to spare', () => {
    expect(calloutDensity(200, 'full')).toBe('full');
    expect(calloutDensity(140, 'full')).toBe('compact');
    // Between the two lines a density holds, so a pane at the edge doesn't flicker.
    expect(calloutDensity(160, 'compact')).toBe('compact');
    expect(calloutDensity(160, 'full')).toBe('full');
    expect(calloutDensity(180, 'compact')).toBe('full');
    expect(calloutDensity(70, 'compact')).toBe('pips');
    // Without columns the room is drawn larger, so pips need more to come back.
    expect(calloutDensity(120, 'pips')).toBe('pips');
    expect(calloutDensity(140, 'pips')).toBe('compact');
  });
  it('split the cards between the sides by height, left to right', () => {
    const at = (x: number) => ({ x, y: 0, z: 0 });
    const cards = [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      id: `c${i}`,
      label: `Thing ${i}`,
      anchor: at(i),
      food: { expires: '2026-12-01' },
    }));
    const bounds = { minX: -300, maxX: 300, minY: -200, maxY: 200 };
    const { placed, extent } = layoutCallouts(cards, bounds);
    const left = placed.filter((p) => p.side === 'left').map((p) => p.c.id);
    const right = placed.filter((p) => p.side === 'right').map((p) => p.c.id);
    expect(Math.abs(left.length - right.length)).toBeLessThanOrEqual(1);
    // Further right on screen is further right in the split: no line crosses another.
    const sx = (id: string) => placed.find((p) => p.c.id === id)!.at.sx;
    expect(Math.max(...left.map(sx))).toBeLessThanOrEqual(Math.min(...right.map(sx)));
    // No two cards in a column overlap, and the view reaches every card.
    for (const side of ['left', 'right'] as const) {
      const col = placed.filter((p) => p.side === side).sort((a, b) => a.y - b.y);
      col.slice(1).forEach((p, i) => expect(p.y).toBeGreaterThanOrEqual(col[i]!.y + col[i]!.h));
      for (const p of col) {
        expect(p.y).toBeGreaterThanOrEqual(extent.minY);
        expect(p.y + p.h).toBeLessThanOrEqual(extent.maxY);
      }
    }
    // A compact card keeps two lines, in larger type: shorter than a full card with every line.
    const rich = [
      {
        ...cards[0]!,
        food: { expires: '2026-12-01', opened: '2026-11-01', left: 'half' as const },
      },
    ];
    const full = layoutCallouts(rich, bounds).placed[0]!.h;
    expect(layoutCallouts(rich, bounds, 'compact').placed[0]!.h).toBeLessThan(full);
  });
});
