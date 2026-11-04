import { describe, expect, it } from 'bun:test';
import {
  detailResolution,
  drawnFixtures,
  memberItem,
  promoteBuiltIn,
  renderSprite,
  seatedModel,
  voxelize,
  fixtureBox,
  fixtureInput,
  fixtureType,
  lookFor,
  MAX_ITEM_PARTS,
  memberDraft,
  memberInput,
  retypeFixture,
  seatAt,
  starterTemplateModel,
  ISO_PRESETS,
  type DeskMemory,
  type Fixture,
} from '@livinglayer/domain';
import { testApp } from './lib/app.js';
import { expectGolden } from './lib/golden.js';

/** A member as the panel places it, put down at `at` on the office's floor. */
const placed = (type: 'person' | 'dog' | 'cat', name: string, at: { x: number; y: number }) =>
  memberInput(type, name, { scene: 'office', at });

describe('a person or pet added by name', () => {
  it('is a person at a person’s real size, from the name alone', () => {
    const d = memberDraft('person', 'Robin');
    expect(d).toMatchObject({
      label: 'Robin',
      type: 'person',
      size: { w: 1.67, d: 1.67, h: 5.87 },
    });
    expect(fixtureType({ model: d.model })).toBe('person');
  });

  it('gets the same look for the same name, and not one look for every name', () => {
    expect(memberDraft('person', 'Robin').look).toBe(memberDraft('person', ' robin ').look);
    const looks = new Set(
      ['Robin', 'Sam', 'Alex', 'Jo', 'Kai', 'Mia'].map((n) => lookFor('person', n)),
    );
    expect(looks.size).toBeGreaterThan(1);
  });

  it('is a dog that stands and lies down, each at its own size', () => {
    const d = memberDraft('dog', 'Biscuit');
    expect(d.state).toBe('standing');
    expect(Object.keys(d.states ?? {})).toEqual(['standing', 'lying']);
    expect(d.states!.lying!.size!.h).toBeLessThan(d.states!.standing!.size!.h);
    expect(fixtureType({ model: d.model })).toBe('dog');
  });

  it('keeps its look when the starter draws it again under another name', () => {
    const d = memberDraft('person', 'Robin');
    const again = starterTemplateModel('person', { label: 'Rob', look: d.look });
    expect(again.parts.map((p) => p.color)).toEqual(d.model.parts.map((p) => p.color));
  });
});

describe('sitting down', () => {
  async function office() {
    const lab = await testApp({ name: 'members-seat', appearance: async () => null });
    const saved = await lab.post('fixtures/save', {
      fixture: placed('person', 'Robin', { x: 2.9, y: 4.8 }),
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const person = saved.json<DeskMemory>().fixtures!.find((f) => f.label === 'Robin')!;
    return { ...lab, person };
  }

  it('finds the office’s chair under a point on it, and nothing beside it', () => {
    const scene = ISO_PRESETS.office;
    const box = (f: Fixture) => fixtureBox(f);
    expect(seatAt(scene, [], 'office', { x: 3.7, y: 5.6 }, box)).toEqual({ group: 'chair' });
    expect(seatAt(scene, [], 'office', { x: 8, y: 6 }, box)).toBeNull();
  });

  it('draws the person into the chair, made a thing, and not on their own', async () => {
    const { post, person } = await office();
    const res = await post('fixtures/seat', { id: person.id, seat: { group: 'chair' } });
    expect(res.statusCode, res.body).toBe(200);
    const memory = res.json<DeskMemory>();
    const chair = memory.fixtures!.find((f) => f.builtIn === 'chair')!;
    const robin = memory.fixtures!.find((f) => f.id === person.id)!;
    expect(robin.seatedOn).toBe(chair.id);
    expect(chair.state).toBe('seated');
    const seated = chair.states!.seated!;
    expect(seated.model.parts.length).toBeLessThanOrEqual(MAX_ITEM_PARTS);
    expect(seated.model.parts.filter((p) => p.id.startsWith('on-')).length).toBeGreaterThan(8);
    // Taller than the chair: their head is over its back.
    expect(seated.size!.h).toBeGreaterThan(chair.size.h);
    expect(drawnFixtures(memory.fixtures!).map((f) => f.id)).not.toContain(person.id);
  });

  it('stands them up in front of the chair, which shows its own model again', async () => {
    const { post, person } = await office();
    await post('fixtures/seat', { id: person.id, seat: { group: 'chair' } });
    const res = await post('fixtures/seat', { id: person.id, seat: null });
    expect(res.statusCode, res.body).toBe(200);
    const memory = res.json<DeskMemory>();
    const chair = memory.fixtures!.find((f) => f.builtIn === 'chair')!;
    const robin = memory.fixtures!.find((f) => f.id === person.id)!;
    expect(robin.seatedOn).toBeUndefined();
    expect(chair.state ?? null).toBeNull();
    expect(chair.states?.seated).toBeUndefined();
    // The office chair faces the desk, towards -y: they stand on that side of it.
    expect(robin.at.y + robin.size.d).toBeLessThanOrEqual(chair.at.y + 0.01);
  });

  it('frees the chair when the person sitting in it is deleted', async () => {
    const { post, person } = await office();
    await post('fixtures/seat', { id: person.id, seat: { group: 'chair' } });
    const res = await post('fixtures/delete', { fixtureId: person.id });
    const chair = res.json<DeskMemory>().fixtures!.find((f) => f.builtIn === 'chair')!;
    expect(chair.state ?? null).toBeNull();
    expect(chair.states?.seated).toBeUndefined();
  });

  it('refuses to sit a pet down', async () => {
    const { post } = await office();
    const saved = await post('fixtures/save', {
      fixture: placed('dog', 'Biscuit', { x: 7, y: 5 }),
    });
    const dog = saved.json<DeskMemory>().fixtures!.find((f) => f.label === 'Biscuit')!;
    const res = await post('fixtures/seat', { id: dog.id, seat: { group: 'chair' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('changing what a member is', () => {
  it('turns a cat into a dog where it stood, with a dog’s poses and a look', () => {
    const now = new Date().toISOString();
    const cat: Fixture = {
      ...placed('cat', 'Miso', { x: 6, y: 5 }),
      id: crypto.randomUUID(),
      type: 'cat',
      model: starterTemplateModel('cat', { label: 'Miso' }),
      createdAt: now,
      updatedAt: now,
    } as Fixture;
    const before = fixtureBox(cat);
    const dog = retypeFixture(cat, 'dog');
    const after = fixtureBox({ ...cat, ...dog, states: undefined } as Fixture);
    const mid = (b: typeof before) => ({ x: b.at.x + b.size.w / 2, y: b.at.y + b.size.d / 2 });
    expect(mid(after).x).toBeCloseTo(mid(before).x, 1);
    expect(mid(after).y).toBeCloseTo(mid(before).y, 1);
    expect(dog.type).toBe('dog');
    expect(dog.look).toStartWith('dog-');
    expect(Object.keys(dog.states ?? {})).toEqual(['standing', 'lying']);
    expect(fixtureInput({ ...cat, look: 'cat-grey' } as Fixture).look).toBe('cat-grey');
  });
});

describe('the demo’s household', () => {
  it('seats Robin in the office chair and puts Miso to sleep by the shelf, when asked', async () => {
    const { app } = await testApp({ name: 'members-household', appearance: async () => null });
    const plain = await app.inject({ method: 'POST', url: '/api/desk/demo/reset' });
    expect(plain.json<DeskMemory>().fixtures ?? []).toEqual([]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/desk/demo/reset',
      payload: { household: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    const fixtures = res.json<DeskMemory>().fixtures!;
    const robin = fixtures.find((f) => f.label === 'Robin')!;
    const chair = fixtures.find((f) => f.builtIn === 'chair')!;
    expect(robin.seatedOn).toBe(chair.id);
    expect(chair.state).toBe('seated');
    expect(fixtures.find((f) => f.label === 'Miso')).toMatchObject({
      type: 'cat',
      state: 'sleeping',
    });
  });
});

/** The household's reference sprites, as the room draws them: UPDATE_GOLDEN=1 accepts a new look. */
describe('the household’s reference sprites', () => {
  const draw = (parts: Parameters<typeof voxelize>[0]) =>
    renderSprite(voxelize(parts, { resolution: detailResolution(parts, 32) }), {
      scale: 1,
      finish: 'clean',
    });
  for (const look of ['person-blue', 'person-coral'])
    it(`draws a person in ${look} as before`, async () => {
      await expectGolden(`people/${look}`, draw(memberItem('person', 'Person', look).parts));
    });
  for (const pose of ['standing', 'lying'])
    it(`draws a dog ${pose} as before`, async () => {
      await expectGolden(
        `people/dog-${pose}`,
        draw(memberItem('dog', 'Dog', 'dog-golden', pose).parts),
      );
    });
  it('draws a person sitting in the office chair as before', async () => {
    const chair = promoteBuiltIn('office', 'chair')!;
    const seated = seatedModel(
      { label: chair.label, model: chair.model, size: chair.size },
      { label: 'Robin', look: 'person-mustard' },
    )!;
    await expectGolden('people/seated-chair', draw(seated.model.parts));
  });
});
