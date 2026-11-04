import { describe, expect, it } from 'bun:test';
import {
  drawnFixtures,
  householdAt,
  householdEvents,
  householdReplay,
  memberCard,
  type DeskMemory,
  type Fixture,
} from '@livinglayer/domain';
import { testApp } from './lib/app.js';

/** The demo's Home room as a reset leaves it. */
async function home(): Promise<Fixture[]> {
  const { app } = await testApp({ name: 'household-day', appearance: async () => null });
  const res = await app.inject({ method: 'POST', url: '/api/desk/demo/reset' });
  return res.json<DeskMemory>().fixtures!.filter((f) => f.scene === 'home');
}
const byLabel = (fixtures: Fixture[], label: string) => fixtures.find((f) => f.label === label);

describe('the household’s day', () => {
  it('says where each of them is and since when', () => {
    expect(householdAt('Robin', 500)).toMatchObject({ spot: 'chair', since: 440 });
    expect(householdAt('Robin', 900)).toMatchObject({ spot: 'away', since: 745 });
    expect(householdAt('Miso', 600)).toMatchObject({ spot: 'plant', pose: 'sleeping' });
  });

  it('lists its changes in order, comings and goings marked', () => {
    const events = householdEvents();
    expect(events.map((e) => e.at)).toEqual(events.map((e) => e.at).toSorted((a, b) => a - b));
    expect(events).toContainEqual({ at: 420, name: 'Robin', text: 'Robin came home', home: true });
    expect(events).toContainEqual({
      at: 1065,
      name: 'Biscuit',
      text: 'Biscuit went out for a walk',
      home: false,
    });
  });
});

describe('the Home room replayed', () => {
  it('seats Robin in the chair at the table mid-morning, drawn by the chair', async () => {
    const room = householdReplay(await home(), 500);
    const robin = byLabel(room, 'Robin')!;
    const chair = room.find((f) => f.id === robin.seatedOn)!;
    expect(chair.state).toBe('seated');
    expect(drawnFixtures(room).map((f) => f.id)).not.toContain(robin.id);
  });

  it('seats Sam in the chair by the wall at lunch, made a thing for the replay only', async () => {
    const before = await home();
    const room = householdReplay(before, 720);
    const sam = byLabel(room, 'Sam')!;
    expect(room.find((f) => f.id === sam.seatedOn)?.builtIn).toBe('chair-back');
    expect(before.some((f) => f.builtIn === 'chair-back')).toBe(false);
  });

  it('leaves out whoever is out, and puts the cat to sleep by the plant', async () => {
    const room = householdReplay(await home(), 900);
    expect(byLabel(room, 'Robin')).toBeUndefined();
    expect(byLabel(room, 'Biscuit')?.state).toBe('lying');
    expect(byLabel(room, 'Miso')?.state).toBe('idle');
    expect(byLabel(householdReplay(await home(), 600), 'Miso')?.state).toBe('sleeping');
  });

  it('stands everyone up again: no chair stays seated when its person is out', async () => {
    const room = householdReplay(await home(), 1300);
    expect(room.filter((f) => f.state === 'seated')).toEqual([]);
  });
});

describe('a person’s or pet’s card', () => {
  it('says where they are and how, and since when while the day is replayed', async () => {
    const room = householdReplay(await home(), 600);
    const miso = byLabel(room, 'Miso')!;
    expect(memberCard({ ...miso, type: 'cat' }, room, 600)).toEqual({
      place: 'Asleep by the plant',
      detail: 'Cat · since 8:00',
    });
  });

  it('says what the room holds otherwise: Robin in the chair, as the demo starts', async () => {
    const room = await home();
    const robin = byLabel(room, 'Robin')!;
    expect(memberCard({ ...robin, type: 'person' }, room, null)).toEqual({
      place: 'Sitting in the chair',
      detail: 'Lives here',
    });
  });
});
