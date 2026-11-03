import { describe, expect, it } from 'bun:test';
import { testApp } from './lib/app.js';
import { demoIntent } from '../apps/server/src/demo-intent.js';
import { selectionRoom } from '../apps/server/src/select.js';
import {
  BASE_STATE,
  catItem,
  followStats,
  groupBounds,
  groupLabels,
  groupRecipe,
  ISO_PRESETS,
  ISO_TILE_CM,
  readIntent,
  relatedTargets,
  showVariant,
  variantRecipe,
  withVariant,
  type AssistDraft,
  type DeskMemory,
  type EvidenceRun,
  type IntentContext,
  type SelectResolve,
} from '@livinglayer/domain';
import { shapeOf } from '../scripts/lib/brush.js';

const office = ISO_PRESETS.office;
const top = office.surfaces.find((s) => s.id === 'desk:top')!;
const cat = { kind: 'fixture' as const, id: 'cat-1', label: 'Cat' };
const desk = { kind: 'prop' as const, id: 'desk', label: 'Desk' };
/** The cat asleep on the desk's top, in tiles. */
const catBox = { at: { x: 4.4, y: 2.2, z: top.z }, size: { w: 0.93, d: 0.87, h: 0.6 } };
const SENTENCE = "let's make a variant of the desk that's occupied";

describe('a variant of what the selection stands on', () => {
  it('reads what the selection stands on, and what stands on a piece of furniture', () => {
    const fixtures = [{ id: cat.id, label: cat.label, surfaceId: 'desk:top' }];
    const labels = groupLabels(office);
    expect(relatedTargets(office, fixtures, cat, labels)).toEqual([
      { target: desk, relation: 'holds', surfaceId: 'desk:top' },
    ]);
    expect(relatedTargets(office, fixtures, desk, labels)).toContainEqual({
      target: cat,
      relation: 'on',
      surfaceId: 'desk:top',
    });
    expect(relatedTargets(office, [], null, labels)).toEqual([]);
  });

  it('makes the variant of what the cat is on, and says why when it can’t', () => {
    const onDesk: IntentContext = {
      target: cat,
      recipe: null,
      entities: [],
      related: [{ target: desk, relation: 'holds', surfaceId: 'desk:top' }],
    };
    expect(readIntent(demoIntent(SENTENCE), onDesk).ops).toEqual([
      { op: 'add_state', subject: desk, state: 'occupied', occupant: cat },
    ]);
    // Selected on its own, with nothing related: a fixture has no variants yet.
    const alone = readIntent(demoIntent(SENTENCE), { ...onDesk, related: [] });
    expect(alone.ops[0]).toMatchObject({ op: 'clarify' });
    expect(alone.dropped[0]).toMatch(/Only furniture/);
    // The desk with nothing on it can't be shown occupied.
    const bare = readIntent(demoIntent(SENTENCE), { target: desk, recipe: null, entities: [] });
    expect(bare.dropped[0]).toMatch(/Nothing stands on the Desk/);
    // An occupant named that doesn't stand on the subject.
    const raw = demoIntent(SENTENCE);
    raw.ops[0] = { ...raw.ops[0]!, subject: 'prop:desk', occupant: 'fixture:elsewhere' };
    expect(readIntent(raw, onDesk).dropped[0]).toMatch(/isn't the selection/);
  });

  it('draws the occupant into a copy of the model, on the top where it lies', () => {
    const base = groupRecipe(office, 'desk')!;
    const made = variantRecipe(
      office,
      'desk',
      base,
      { label: 'Cat', box: catBox, colors: ['#d9822b', '#f2f0eb'] },
      'Desk (occupied)',
    );
    if (!('recipe' in made)) throw new Error(made.reason);
    const { recipe } = made;
    const body = recipe.parts.find((p) => p.name === 'occupant-body')!;
    const b = groupBounds(office, 'desk')!;
    // On the top, at the cat's spot in the desk's own centimetres.
    expect(body.atCm.z).toBeCloseTo((top.z - b.at.z) * ISO_TILE_CM, 0);
    expect(body.atCm.x + body.sizeCm.w / 2).toBeCloseTo((4.4 + 0.465 - b.at.x) * ISO_TILE_CM, 0);
    expect(body.color).toBe('#d9822b');
    expect(recipe.parts.length).toBe(base.parts.length + 2);
    // Taller by what lies on its top.
    expect(recipe.sizeCm.h).toBeGreaterThan(base.sizeCm.h);
  });

  it('keeps the variant beside its model, and shows the one its occupied stat says', () => {
    const base = groupRecipe(office, 'desk')!;
    const made = variantRecipe(
      office,
      'desk',
      base,
      { label: 'Cat', box: catBox, colors: [] },
      'x',
    );
    if (!('recipe' in made)) throw new Error(made.reason);
    const custom = { ...office, kind: 'custom' as const };
    const kept = withVariant(custom, 'desk', 'occupied', made.recipe, base, true);
    const main = kept.props.find((p) => p.group === 'desk' && p.recipe)!;
    expect(Object.keys(main.states!)).toEqual([BASE_STATE, 'occupied']);
    expect(main.follows).toEqual({ stat: 'occupied', state: 'occupied' });
    // Surfaces keep their ids, so what stands on them still does.
    expect(kept.surfaces.some((s) => s.id === 'desk:top')).toBe(true);

    const shown = showVariant(kept, 'desk', 'occupied');
    const drawn = shown.props.find((p) => p.id === main.id)!;
    expect(drawn.state).toBe('occupied');
    expect(drawn.recipe!.parts.length).toBe(base.parts.length + 2);
    expect(drawn.size.h).toBeGreaterThan(main.size.h);
    expect(showVariant(shown, 'desk', 'occupied')).toBe(shown);

    expect(followStats(kept, () => true)).toEqual(shown);
    expect(followStats(shown, () => null)).toBe(shown);
    const back = followStats(shown, () => false).props.find((p) => p.id === main.id)!;
    expect(back.state).toBeUndefined();
    expect(back.size.h).toBeCloseTo(main.size.h, 6);
  });
});

describe('the brush making a variant in the demo', () => {
  it('selects the cat on the desk, saves the desk’s occupied variant, and follows the stat', async () => {
    const s = await testApp({ name: 'brush-variant' });
    const saved = await s.post('fixtures/save', {
      fixture: {
        label: 'Cat',
        scene: 'office',
        surfaceId: 'desk:top',
        at: { x: catBox.at.x, y: catBox.at.y },
        turns: 0,
        size: catBox.size,
        model: { label: 'Cat', parts: catItem('Cat', 'sleeping').parts },
        reference: null,
        control: { kind: 'none' },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const memory = saved.json<DeskMemory>();
    const id = memory.fixtures!.find((f) => f.label === 'Cat')!.id;
    const shape = shapeOf({ around: `fixture:${id}` }, selectionRoom(memory));

    const resolved = (await s.post('select/resolve', { shape })).json<SelectResolve>();
    expect(resolved.target).toMatchObject({ kind: 'fixture', id });
    expect(resolved.related).toContainEqual({
      target: desk,
      relation: 'holds',
      surfaceId: 'desk:top',
    });

    const res = await s.post('assist', { shape, prompt: SENTENCE, jobId: crypto.randomUUID() });
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json<EvidenceRun<AssistDraft>>().output;
    expect(d.intent.ops[0]).toMatchObject({ op: 'add_state', subject: desk, state: 'occupied' });
    expect(d.variant).toMatchObject({ group: 'desk', state: 'occupied', follows: true });
    expect(d.recipe!.parts.map((p) => p.name)).toContain('occupant-head');
    expect(d.place).toMatchObject({ replaces: 'desk' });

    // A follow-up changes the variant, not the desk.
    const runId = res.json<EvidenceRun<AssistDraft>>().id;
    const next = await s.post('assist', { previous: runId, prompt: 'make it grey' });
    expect(next.statusCode, next.body).toBe(200);
    const after = next.json<EvidenceRun<AssistDraft>>();
    expect(after.output.variant?.state).toBe('occupied');
    expect(after.output.recipe!.parts.every((p) => p.color === '#8a8f98')).toBe(true);

    const put = await s.post('assist/save', { runId: res.json<EvidenceRun<AssistDraft>>().id });
    expect(put.statusCode, put.body).toBe(200);
    const room = put.json<{ memory: DeskMemory; group: string }>();
    expect(room.group).toBe('desk');
    const main = room.memory.scene!.props.find((p) => p.group === 'desk' && p.recipe)!;
    expect(Object.keys(main.states!)).toEqual([BASE_STATE, 'occupied']);
    expect(main.state).toBeUndefined();
    expect(room.memory.thingStats?.['prop:desk']).toEqual([{ key: 'occupied', concept: 'cat' }]);
    // The cat still stands on the desk's top.
    expect(room.memory.fixtures!.find((f) => f.id === id)!.surfaceId).toBe('desk:top');
    expect(
      followStats(room.memory.scene!, () => true).props.find((p) => p.id === main.id)!.state,
    ).toBe('occupied');
  });
});
