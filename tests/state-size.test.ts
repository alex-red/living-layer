import { describe, expect, it } from 'bun:test';
import {
  catItem,
  fixtureInput,
  fixtureSize,
  restOn,
  starterTemplateModel,
  stateFollowing,
  stateSizeFor,
  topOf,
  type DeskMemory,
  type IsoItem,
} from '@livinglayer/domain';
import { testApp } from './lib/app.js';
import { fixture } from './lib/fixture-scan.js';

const tree = starterTemplateModel('cat-tree');
/** The tree with a sleeping cat lying on its top. */
const withCat: IsoItem = {
  label: 'Cat tree (sleeping)',
  parts: [
    ...tree.parts,
    ...restOn(
      catItem('Cat', 'sleeping').parts.map((p) => ({
        ...p,
        id: `cat-${p.id}`,
        at: { ...p.at, x: p.at.x * 0.4 + 0.45 },
        size: { w: p.size.w * 0.4, d: p.size.d * 0.4, h: p.size.h * 0.4 },
      })),
      topOf(tree.parts),
    ),
  ],
};
const size = { w: 1.67, d: 1.67, h: 4 };

describe('the size a state takes for its model', () => {
  it('grows by what lies above the model it had', () => {
    const grown = stateSizeFor({ size, model: tree }, withCat)!;
    expect(grown.w).toBe(size.w);
    expect(grown.d).toBe(size.d);
    expect(grown.h).toBeCloseTo((size.h * topOf(withCat.parts)) / topOf(tree.parts), 2);
  });

  it('stays as it was for a model as tall as the one it had', () => {
    expect(stateSizeFor({ size, model: tree }, tree)).toBeNull();
  });
});

describe('saving a state’s model', () => {
  async function addTree() {
    const app = await testApp();
    const { id: _id, ...input } = fixtureInput(
      fixture({
        label: 'Cat tree',
        size,
        model: { ...fixture().model, ...tree },
        control: { kind: 'none' },
      }),
    );
    const saved = await app.post('fixtures/save', { mode: 'live', fixture: input });
    expect(saved.statusCode, saved.body).toBe(200);
    return { app, id: saved.json<DeskMemory>().fixtures!.at(-1)!.id };
  }

  it('makes the state as tall as its model when no size is given', async () => {
    const { app, id } = await addTree();
    const res = await app.post('fixtures/state', {
      mode: 'live',
      fixtureId: id,
      state: 'sleeping',
      fixture: { model: withCat },
    });
    expect(res.statusCode, res.body).toBe(200);
    const f = res.json<DeskMemory>().fixtures!.find((x) => x.id === id)!;
    expect(fixtureSize(f, 'sleeping').h).toBeGreaterThan(size.h);
    expect(fixtureSize(f, null)).toEqual(size);
  });

  it('keeps a size it is given', async () => {
    const { app, id } = await addTree();
    const given = { w: 1.67, d: 1.67, h: 4.2 };
    const res = await app.post('fixtures/state', {
      mode: 'live',
      fixtureId: id,
      state: 'sleeping',
      fixture: { model: withCat, size: given },
    });
    const f = res.json<DeskMemory>().fixtures!.find((x) => x.id === id)!;
    expect(fixtureSize(f, 'sleeping')).toEqual(given);
  });
});

describe('a state that follows a stat', () => {
  async function withSleeping() {
    const app = await testApp();
    const { id: _id, ...input } = fixtureInput(
      fixture({
        label: 'Cat tree',
        size,
        model: { ...fixture().model, ...tree },
        control: { kind: 'none' },
      }),
    );
    const id = (await app.post('fixtures/save', { mode: 'live', fixture: input }))
      .json<DeskMemory>()
      .fixtures!.at(-1)!.id;
    await app.post('fixtures/state', {
      mode: 'live',
      fixtureId: id,
      state: 'sleeping',
      fixture: { model: withCat },
    });
    await app.post('fixtures/state', { mode: 'live', fixtureId: id, state: null });
    const follow = async (state: string, stat: 'occupied' | 'power' | null) =>
      app.post('fixtures/state', { mode: 'live', fixtureId: id, follow: { state, stat } });
    const thing = async () => (await app.memory('live')).fixtures!.find((f) => f.id === id)!;
    return { app, id, follow, thing };
  }

  it('is set without changing the state shown', async () => {
    const { follow, thing } = await withSleeping();
    expect((await follow('sleeping', 'occupied')).statusCode).toBe(200);
    const f = await thing();
    expect(f.states?.sleeping?.follows).toBe('occupied');
    expect(f.state).toBeNull();
    expect(stateFollowing(f, 'occupied')).toBe('sleeping');
  });

  it('keeps following when its model is replaced', async () => {
    const { app, id, follow, thing } = await withSleeping();
    await follow('sleeping', 'occupied');
    await app.post('fixtures/state', {
      mode: 'live',
      fixtureId: id,
      state: 'sleeping',
      fixture: { model: tree },
    });
    expect((await thing()).states?.sleeping?.follows).toBe('occupied');
  });

  it('takes the stat from any other state that followed it, and lets go with null', async () => {
    const { app, id, follow, thing } = await withSleeping();
    await app.post('fixtures/state', {
      mode: 'live',
      fixtureId: id,
      state: 'napping',
      fixture: { model: tree },
    });
    await follow('napping', 'occupied');
    await follow('sleeping', 'occupied');
    const f = await thing();
    expect(f.states?.sleeping?.follows).toBe('occupied');
    expect(f.states?.napping?.follows).toBeUndefined();
    await follow('sleeping', null);
    expect(stateFollowing(await thing(), 'occupied')).toBeNull();
  });

  it('refuses a state the thing doesn’t have', async () => {
    const { follow } = await withSleeping();
    const res = await follow('dancing', 'occupied');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('no “dancing” state');
  });
});
