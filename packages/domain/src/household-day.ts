import { fixtureBox, type Fixture, type FixtureInput } from './fixture.js';
import { isMember } from './members.js';
import { promoteBuiltIn } from './promote.js';
import { seatPerson, standUp } from './seating.js';

/**
 * The demo household's day in its Home room ([plan](../../../docs/plans/people-and-pets.md)):
 * where Robin, Sam, Miso and Biscuit are from morning to night, and how they
 * are (sitting, asleep, lying down). The day replay draws the room from it,
 * the dock lists its changes, and asking the room and its nudges read it.
 * Times are minutes since midnight; each span lasts until the next.
 */
export type HomeSpot = 'chair' | 'chair-back' | 'shelf' | 'table' | 'plant' | 'door' | 'away';
interface SpotInfo {
  /** Where they are, as words after their name: "Robin is at the table". */
  label: string;
  /** The middle of where they stand, in the Home room's tiles. */
  at?: { x: number; y: number };
  /** The chair of the Home room they sit in. */
  seat?: string;
}
export const HOME_SPOTS: Record<HomeSpot, SpotInfo> = {
  chair: { label: 'at the table', seat: 'chair' },
  'chair-back': { label: 'at the table, by the wall', seat: 'chair-back' },
  table: { label: 'by the table', at: { x: 2.1, y: 4.4 } },
  shelf: { label: 'by the bookshelf', at: { x: 8.3, y: 2.2 } },
  plant: { label: 'by the plant', at: { x: 2.4, y: 6.7 } },
  door: { label: 'by the door', at: { x: 8.8, y: 6.6 } },
  away: { label: 'out' },
};

/** One stretch of a member's day: from `from`, at `spot`, in `pose` (their own default when unset). */
export interface HomeSpan {
  from: number;
  spot: HomeSpot;
  pose?: 'sleeping' | 'idle' | 'lying' | 'standing';
}
/** The household by name: the people and pets the demo brings in (`addDemoHousehold`). */
export const HOUSEHOLD = [
  { name: 'Robin', type: 'person' },
  { name: 'Sam', type: 'person' },
  { name: 'Miso', type: 'cat' },
  { name: 'Biscuit', type: 'dog' },
] as const;
export type HouseholdName = (typeof HOUSEHOLD)[number]['name'];

export const HOUSEHOLD_DAY: Record<HouseholdName, readonly HomeSpan[]> = {
  Robin: [
    { from: 0, spot: 'away' },
    { from: 420, spot: 'shelf' },
    { from: 440, spot: 'chair' },
    { from: 735, spot: 'shelf' },
    { from: 745, spot: 'away' },
    { from: 1050, spot: 'door' },
    { from: 1056, spot: 'chair' },
    { from: 1200, spot: 'shelf' },
    { from: 1230, spot: 'away' },
  ],
  Sam: [
    { from: 0, spot: 'away' },
    { from: 480, spot: 'table' },
    { from: 500, spot: 'away' },
    { from: 700, spot: 'chair-back' },
    { from: 735, spot: 'door' },
    { from: 740, spot: 'away' },
    { from: 1080, spot: 'chair-back' },
    { from: 1170, spot: 'table' },
    { from: 1185, spot: 'away' },
  ],
  Miso: [
    { from: 0, spot: 'plant', pose: 'sleeping' },
    { from: 410, spot: 'table', pose: 'idle' },
    { from: 480, spot: 'plant', pose: 'sleeping' },
    { from: 840, spot: 'shelf', pose: 'idle' },
    { from: 905, spot: 'door', pose: 'idle' },
    { from: 990, spot: 'plant', pose: 'sleeping' },
  ],
  // Home alone all afternoon, waiting by the door, then a walk once Robin is back.
  Biscuit: [
    { from: 0, spot: 'door', pose: 'lying' },
    { from: 420, spot: 'shelf', pose: 'standing' },
    { from: 445, spot: 'table', pose: 'lying' },
    { from: 750, spot: 'door', pose: 'lying' },
    { from: 1050, spot: 'door', pose: 'standing' },
    { from: 1065, spot: 'away' },
    { from: 1100, spot: 'table', pose: 'lying' },
    { from: 1235, spot: 'door', pose: 'lying' },
  ],
};

/** Where a member of the household is at `minute`, and since when. */
export function householdAt(
  name: HouseholdName,
  minute: number,
): HomeSpan & { since: number; until: number } {
  const spans = HOUSEHOLD_DAY[name];
  let i = 0;
  while (i + 1 < spans.length && spans[i + 1]!.from <= minute) i++;
  return { ...spans[i]!, since: spans[i]!.from, until: spans[i + 1]?.from ?? 24 * 60 };
}

/** What a member is doing in a span, as a sentence's middle: "is asleep by the plant". */
export function doing(span: Pick<HomeSpan, 'spot' | 'pose'>): string {
  const where = HOME_SPOTS[span.spot].label;
  if (span.spot === 'away') return 'is out';
  if (HOME_SPOTS[span.spot].seat) return `is sitting ${where}`;
  if (span.pose === 'sleeping') return `is asleep ${where}`;
  if (span.pose === 'lying') return `is lying ${where}`;
  return `is ${where}`;
}

/** One change in the household's day, for the dock's timeline and the nudges. */
export interface HomeEvent {
  at: number;
  name: HouseholdName;
  text: string;
  /** Came home (true), went out (false), or moved about at home (unset). */
  home?: boolean;
}
/** The household's day as changes, in order: who came home, went out, sat down, fell asleep. */
export function householdEvents(): HomeEvent[] {
  const out: HomeEvent[] = [];
  for (const { name, type } of HOUSEHOLD) {
    const spans = HOUSEHOLD_DAY[name];
    for (let i = 1; i < spans.length; i++) {
      const was = spans[i - 1]!;
      const now = spans[i]!;
      const where = HOME_SPOTS[now.spot].label;
      const text =
        now.spot === 'away'
          ? type === 'dog'
            ? `${name} went out for a walk`
            : `${name} went out`
          : was.spot === 'away'
            ? `${name} came home`
            : HOME_SPOTS[now.spot].seat
              ? `${name} sat down ${where}`
              : now.pose === 'sleeping'
                ? `${name} curled up for a nap ${where}`
                : now.pose === 'lying'
                  ? `${name} lay down ${where}`
                  : was.pose === 'sleeping'
                    ? `${name} woke up and went ${where}`
                    : `${name} went ${where}`;
      out.push({
        at: now.from,
        name,
        text,
        ...(now.spot === 'away' ? { home: false } : was.spot === 'away' ? { home: true } : {}),
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The thing a member of the household is when asking the demo about it. */
export const householdThingId = (name: HouseholdName) => `household:${name}`;

/** The household's members among the Home room's things, by name. */
export function householdThings(fixtures: readonly Fixture[]): Map<HouseholdName, Fixture> {
  const out = new Map<HouseholdName, Fixture>();
  for (const { name, type } of HOUSEHOLD) {
    const f = fixtures.find(
      (x) => x.scene === 'home' && isMember(x) && x.type === type && x.label === name,
    );
    if (f) out.set(name, f);
  }
  return out;
}

/**
 * The Home room's things as the household's day has them at `minute`:
 * each member where the day puts them, in its pose, sitting in their chair
 * (made a thing for the replay when it isn't one), and the ones out of the
 * house left out. For drawing only: nothing here is saved.
 */
export function householdReplay(fixtures: readonly Fixture[], minute: number): Fixture[] {
  const now = new Date(0).toISOString();
  const members = householdThings(fixtures);
  let next = [...fixtures];
  // Everyone stands first, so each chair shows its own model before the day seats anyone.
  for (const f of members.values()) if (f.seatedOn) next = standUp(next, f.id, now);
  const away = new Set<string>();
  for (const [name, f] of members) {
    const span = householdAt(name, minute);
    const spot = HOME_SPOTS[span.spot];
    if (span.spot === 'away') {
      away.add(f.id);
      continue;
    }
    if (spot.seat && f.type === 'person') {
      let seat = next.find((x) => x.scene === 'home' && x.builtIn === spot.seat);
      if (!seat) {
        const made = promoteBuiltIn('home', spot.seat);
        if (!made) continue;
        seat = replayFixture(made, `replay:${spot.seat}`);
        next.push(seat);
      }
      const seated = seatPerson(next, f.id, seat.id, now);
      if (!('reason' in seated)) next = seated;
      continue;
    }
    const at = spot.at;
    if (!at) continue;
    next = next.map((x) => {
      if (x.id !== f.id) return x;
      const state = span.pose && x.states?.[span.pose] ? span.pose : (x.state ?? null);
      const box = fixtureBox({ ...x, surfaceId: null, state });
      return {
        ...x,
        surfaceId: null,
        state,
        at: { x: at.x - box.size.w / 2, y: at.y - box.size.d / 2 },
      };
    });
  }
  return next.filter((x) => !away.has(x.id));
}

/** A promoted chair as a thing, for the replay to seat someone in: never saved. */
function replayFixture(input: FixtureInput, id: string): Fixture {
  const at = new Date(0).toISOString();
  const { states: _none, ...rest } = input;
  const model = {
    ...input.model,
    source: 'placeholder' as const,
    segmentRunId: null,
    swatches: [],
    updatedAt: at,
    fit: null,
  };
  return { ...rest, id, model, createdAt: at, updatedAt: at };
}
