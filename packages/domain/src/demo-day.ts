/**
 * A sample day in the demo office: what the mug, the desk lamp, the cat tree
 * and the fridge did from morning to night. The day replay, "Ask your room"
 * and the nudges all read it. Times are minutes since midnight.
 *
 * `demoHistory` turns it into stats' events, with the six days before it
 * made up around it, so asking the demo room reads the same kind of history
 * a live room keeps.
 */
import { addDays, type Food, type FoodLeft } from './food.js';
import {
  HOUSEHOLD,
  HOUSEHOLD_DAY,
  doing,
  householdThingId,
  type HomeSpan,
} from './household-day.js';
import { DEMO_LITTER_CAT, DEMO_LITTER_EMPTIED, DEMO_LITTER_VISITS, LITTER } from './litter.js';
import type { MemberType } from './members.js';
import type { AskExample } from './room-ask.js';
import { dayOf, type StatEvent, type StatKey } from './stats.js';

/** Where the mug stands: on its coaster (inside the main zone), by the keyboard, at the desk's edge, or off the desk. */
export type MugSpot = 'coaster' | 'keyboard' | 'edge' | 'away';
export type DayThing = 'mug' | 'lamp' | 'cat' | 'fridge' | 'litter';

/** One change the camera or Home Assistant saw. */
export interface DayEvent {
  at: number;
  thing: DayThing;
  text: string;
  /** The mug moved here. */
  mug?: MugSpot;
  /** The mug was picked up and put back: used. */
  used?: true;
  lamp?: boolean;
  /** The cat is on its tree. */
  cat?: boolean;
  /** What was taken from the fridge. */
  food?: string;
  /** Minutes the cat spent in the litter box. */
  visit?: number;
}

export const DEMO_DAY: readonly DayEvent[] = [
  { at: 410, thing: 'cat', cat: true, text: 'The cat climbed its tree' },
  { at: 450, thing: 'fridge', food: 'Milk', text: 'Milk taken from the fridge' },
  { at: 462, thing: 'mug', mug: 'coaster', used: true, text: 'Mug set on its coaster' },
  { at: 462, thing: 'lamp', lamp: true, text: 'Desk lamp on: the mug entered the main zone' },
  { at: 495, thing: 'cat', cat: false, text: 'The cat left its tree' },
  { at: 500, thing: 'mug', used: true, text: 'Mug used' },
  { at: 550, thing: 'mug', mug: 'keyboard', used: true, text: 'Mug moved by the keyboard' },
  { at: 550, thing: 'lamp', lamp: false, text: 'Desk lamp off: the main zone emptied' },
  { at: 575, thing: 'mug', used: true, text: 'Mug used' },
  { at: 605, thing: 'mug', mug: 'away', text: 'Mug taken off the desk' },
  { at: 620, thing: 'mug', mug: 'coaster', used: true, text: 'Mug back on its coaster' },
  { at: 620, thing: 'lamp', lamp: true, text: 'Desk lamp on: the mug entered the main zone' },
  { at: 750, thing: 'fridge', food: 'Leftover chicken', text: 'Leftover chicken taken out' },
  { at: 765, thing: 'mug', mug: 'edge', used: true, text: 'Mug pushed to the desk’s edge' },
  { at: 765, thing: 'lamp', lamp: false, text: 'Desk lamp off: the main zone emptied' },
  { at: 840, thing: 'cat', cat: true, text: 'The cat climbed its tree' },
  { at: 965, thing: 'mug', mug: 'coaster', used: true, text: 'Mug back on its coaster' },
  { at: 965, thing: 'lamp', lamp: true, text: 'Desk lamp on: the mug entered the main zone' },
  { at: 990, thing: 'cat', cat: false, text: 'The cat left its tree' },
  { at: 1040, thing: 'mug', mug: 'away', text: 'Mug taken off the desk' },
  { at: 1040, thing: 'lamp', lamp: false, text: 'Desk lamp off: the main zone emptied' },
  { at: 1140, thing: 'lamp', lamp: true, text: 'Desk lamp switched on by hand' },
  { at: 1172, thing: 'lamp', lamp: false, text: 'Desk lamp turned off from the notification' },
  { at: 1270, thing: 'fridge', food: 'Spinach', text: 'Spinach taken out' },
  { at: 1290, thing: 'cat', cat: true, text: 'The cat climbed its tree' },
];

/** A thing whose history can be asked about: its id, its name and the stats it keeps. */
export interface AskThing {
  id: string;
  label: string;
  stats: StatKey[];
  /** A zone, whose occupied stat is something being in it. */
  zone?: true;
  /** Food: its card keeps food details, so its uses are being taken out. */
  food?: true;
  /** Its use-by day, `YYYY-MM-DD`, for food. */
  expires?: string;
  /** How much of it is left, for food that isn't full. */
  left?: FoodLeft;
  /**
   * A person or pet: its occupied stat is being home, and `places` says
   * where at home and how ("is asleep by the plant"), from when, oldest first.
   */
  member?: { type: MemberType; places: readonly { at: number; text: string }[] };
  /** A litter box: the cat who uses it, and its weight from the box's scale, oldest first. */
  litter?: { cat: string; weights?: readonly { at: number; kg: number }[] };
}

/** The demo litter box room's day: each of Juniper's visits, the box cleaning itself after. */
export const DEMO_LITTER_DAY: readonly DayEvent[] = DEMO_LITTER_VISITS.map(([at, visit]) => ({
  at,
  thing: 'litter',
  visit,
  text: `${DEMO_LITTER_CAT} used the litter robot (${visit} min); it cleaned itself ${LITTER.cycleWaitMin} min after`,
}));

/** The thing a zone is when asking about the room: its fillings and emptyings are its occupied stat. */
export const zoneThingId = (ruleId: string) => `zone:${ruleId}`;

/**
 * A thing in the demo fridge as the demo stocks it, in days from the sample
 * day: when it came in, when it was opened and when it goes off, and how
 * much of an opened one is left.
 */
interface DemoFood {
  /** Its group in the fridge preset. */
  group: string;
  label: string;
  useByDays: number;
  addedDaysAgo: number;
  openedDaysAgo?: number;
  left?: FoodLeft;
}
/**
 * What the sample day takes out of the demo fridge and asks about, soonest
 * gone first: the leftovers today, the milk tomorrow.
 */
export const DEMO_FOOD: readonly DemoFood[] = [
  { group: 'leftovers', label: 'Leftover chicken', useByDays: 0, addedDaysAgo: 3, left: 'half' },
  { group: 'milk', label: 'Milk', useByDays: 1, addedDaysAgo: 8, openedDaysAgo: 4, left: 'low' },
  { group: 'spinach', label: 'Spinach', useByDays: 4, addedDaysAgo: 1 },
  { group: 'eggs', label: 'Eggs', useByDays: 12, addedDaysAgo: 16, openedDaysAgo: 9, left: 'most' },
];
/**
 * Everything in the demo fridge: the day's food, then the butter, jars and
 * bottles, opened a while ago and keeping a good while yet, so none of them
 * is what to eat first.
 */
export const DEMO_FRIDGE: readonly DemoFood[] = [
  ...DEMO_FOOD,
  {
    group: 'butter',
    label: 'Butter',
    useByDays: 20,
    addedDaysAgo: 20,
    openedDaysAgo: 10,
    left: 'half',
  },
  {
    group: 'jar',
    label: 'Pickle jar',
    useByDays: 30,
    addedDaysAgo: 60,
    openedDaysAgo: 30,
    left: 'low',
  },
  {
    group: 'mustard',
    label: 'Mustard',
    useByDays: 15,
    addedDaysAgo: 90,
    openedDaysAgo: 45,
    left: 'half',
  },
  {
    group: 'mayo',
    label: 'Mayonnaise',
    useByDays: 48,
    addedDaysAgo: 20,
    openedDaysAgo: 12,
    left: 'most',
  },
  {
    group: 'hot-sauce',
    label: 'Hot sauce',
    useByDays: 10,
    addedDaysAgo: 120,
    openedDaysAgo: 50,
    left: 'low',
  },
  {
    group: 'juice',
    label: 'Orange juice',
    useByDays: 5,
    addedDaysAgo: 6,
    openedDaysAgo: 2,
    left: 'half',
  },
  {
    group: 'dressing',
    label: 'Salad dressing',
    useByDays: 40,
    addedDaysAgo: 30,
    openedDaysAgo: 20,
    left: 'most',
  },
  { group: 'jam', label: 'Jam', useByDays: 35, addedDaysAgo: 40, openedDaysAgo: 25, left: 'half' },
];
/** A demo fridge thing's food details, `today` being the sample day. */
export function demoFood(f: DemoFood, today: string): Food {
  return {
    added: addDays(today, -f.addedDaysAgo),
    ...(f.openedDaysAgo === undefined ? {} : { opened: addDays(today, -f.openedDaysAgo) }),
    expires: addDays(today, f.useByDays),
    ...(f.left ? { left: f.left } : {}),
  };
}

/**
 * Questions the dock offers: each has a number, a chart or a comparison to
 * show. `label` is the chip's short name; `thing` the demo thing it is about,
 * for its colour.
 */
export const DEMO_ASK_EXAMPLES: readonly AskExample[] = [
  {
    label: 'Drinks this hour',
    question: 'How many times did I drink in the last hour?',
    thing: 'mug',
    kind: 'drink',
  },
  {
    label: 'Screen time',
    question: 'How long was my screen on today?',
    thing: 'monitor',
    kind: 'screen',
  },
  {
    label: 'Longest dry spell',
    question: 'What was my longest stretch without a drink?',
    thing: 'mug',
    kind: 'drink',
  },
  {
    label: 'Cat vs yesterday',
    question: 'Did the cat nap more than yesterday?',
    thing: 'cat-tree',
    kind: 'cat',
  },
  {
    label: 'Desk time this week',
    question: 'How long did I work at my desk this week?',
    thing: 'mouse',
    kind: 'pointer',
  },
  {
    label: 'Lamp while away',
    question: 'Was the lamp on while I was away?',
    thing: 'lamp',
    kind: 'light',
  },
  {
    label: 'Mug in the zone',
    question: 'How long was the mug in the main zone today?',
    thing: 'zone:main',
    kind: 'zone',
  },
  { label: 'Eat first', question: 'What should I eat first?', thing: 'milk', kind: 'food' },
  { label: 'Today so far', question: 'What happened today?', thing: 'summary', kind: 'summary' },
];

/** Questions the dock offers at the fridge, about its food. */
export const DEMO_FRIDGE_ASK_EXAMPLES: readonly AskExample[] = [
  { label: 'Eat first', question: 'What should I eat first?', thing: 'milk', kind: 'food' },
  {
    label: 'Milk goes off?',
    question: 'When does the milk go off?',
    thing: 'milk',
    kind: 'food',
  },
  {
    label: 'Milk last out',
    question: 'When did I last take the milk out?',
    thing: 'milk',
    kind: 'food',
  },
  {
    label: 'Chicken last out',
    question: 'When did I last take the leftover chicken out?',
    thing: 'leftover-chicken',
    kind: 'food',
  },
  { label: 'Today so far', question: 'What happened today?', thing: 'summary', kind: 'summary' },
];

/** Questions the dock offers in the litter box room, about Juniper and her litter robot. */
export const DEMO_LITTER_ASK_EXAMPLES: readonly AskExample[] = [
  {
    label: 'Visits today',
    question: 'How many times did Juniper use the litter robot today?',
    thing: 'litter-robot',
    kind: 'litter',
  },
  {
    label: 'Visits vs usual',
    question: 'Did Juniper use the litter robot more than usual today?',
    thing: 'litter-robot',
    kind: 'litter',
  },
  {
    label: 'Visits this week',
    question: 'How many times was the litter robot used this week?',
    thing: 'litter-robot',
    kind: 'litter',
  },
  {
    label: 'Last visit',
    question: 'When did Juniper last use the litter robot?',
    thing: 'litter-robot',
    kind: 'litter',
  },
  {
    label: 'Drawer emptied',
    question: 'When did I last empty the waste drawer?',
    thing: 'litter-drawer',
    kind: 'litter',
  },
  { label: 'Today so far', question: 'What happened today?', thing: 'summary', kind: 'summary' },
];

/** Questions the dock offers in the Home room, about the household. */
export const DEMO_HOME_ASK_EXAMPLES: readonly AskExample[] = [
  {
    label: 'Where’s Miso?',
    question: 'Where is Miso now?',
    thing: householdThingId('Miso'),
    kind: 'member',
  },
  {
    label: 'Robin home since',
    question: 'When did Robin last come home?',
    thing: householdThingId('Robin'),
    kind: 'member',
  },
  {
    label: 'Sam at home',
    question: 'How long was Sam home today?',
    thing: householdThingId('Sam'),
    kind: 'member',
  },
  {
    label: 'Biscuit vs usual',
    question: 'Was Biscuit home longer than usual today?',
    thing: householdThingId('Biscuit'),
    kind: 'member',
  },
  { label: 'Today so far', question: 'What happened today?', thing: 'summary', kind: 'summary' },
];

/** The demo room's things that keep stats, as asking it sees them. */
const DEMO_ASK_THINGS: readonly AskThing[] = [
  { id: 'mug', label: 'My desk mug', stats: ['lastUsed'] },
  { id: 'monitor', label: 'Monitor', stats: ['power'] },
  { id: 'mouse', label: 'Computer mouse', stats: ['activity'] },
  { id: 'lamp', label: 'Desk lamp', stats: ['power'] },
  { id: 'cat-tree', label: 'Cat tree', stats: ['occupied'] },
  { id: 'milk', label: 'Milk', stats: ['lastUsed'] },
  { id: 'leftover-chicken', label: 'Leftover chicken', stats: ['lastUsed'] },
  { id: 'spinach', label: 'Spinach', stats: ['lastUsed'] },
  { id: 'eggs', label: 'Eggs', stats: ['lastUsed'] },
  { id: zoneThingId('main'), label: 'Main zone', stats: ['occupied'], zone: true },
  {
    id: 'litter-robot',
    label: 'Litter robot',
    stats: ['occupied'],
    litter: { cat: DEMO_LITTER_CAT },
  },
  { id: 'litter-drawer', label: 'Waste drawer', stats: ['lastUsed'] },
];
/** Juniper's weight on the litter robot's scale, kg, over the sample week, oldest first: steady. */
const LITTER_KG = [5.42, 5.4, 5.41, 5.39, 5.41, 5.4, 5.39];
/** The household's day `back` days before the sample day: the same, a little earlier or later. */
function householdSpans(
  name: (typeof HOUSEHOLD)[number]['name'],
  back: number,
): readonly HomeSpan[] {
  const spans = HOUSEHOLD_DAY[name];
  if (!back) return spans;
  const r = seeded(back * 31 + name.length * 977);
  return spans.map((s, i) => (i ? { ...s, from: s.from + between(r, -25, 25) } : s));
}
const FOOD_IDS: Record<string, string> = {
  Milk: 'milk',
  'Leftover chicken': 'leftover-chicken',
  Spinach: 'spinach',
  Eggs: 'eggs',
};
/** The monitor's sessions on the sample day, in minutes: it is on while the person works. */
const SCREEN_DAY: [number, number][] = [
  [465, 750],
  [795, 1040],
  [1140, 1150],
];

/** A small seeded generator, so the made-up days are the same on every run. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One made-up day: when the mug was used, the screen and lamp on, the cat up, the milk out. */
interface MadeDay {
  mug: number[];
  screen: [number, number][];
  lamp: [number, number][];
  cat: [number, number][];
  food: [number, string][];
  /** The mug in the main zone (on its coaster). */
  zone: [number, number][];
  /** The cat's litter box visits: when it went in, minutes inside. */
  litter: (readonly [number, number])[];
}
const between = (r: () => number, a: number, b: number) => Math.round(a + r() * (b - a));

function madeDay(back: number): MadeDay {
  const r = seeded(back * 7919);
  // One quiet day in the week: a short session and few drinks.
  const quiet = back === 3;
  const screen: [number, number][] = [];
  let t = between(r, 450, 520);
  for (let i = 0; i < (quiet ? 1 : 3) && t < 1260; i++) {
    const end = Math.min(t + between(r, quiet ? 60 : 110, quiet ? 120 : 260), 1290);
    screen.push([t, end]);
    t = end + between(r, 25, 90);
  }
  const mug: number[] = [];
  for (let m = between(r, 430, 480); m < (quiet ? 900 : 1260); m += between(r, 35, 150))
    mug.push(m);
  const lamp = screen.slice(0, 2).map(([a, b]): [number, number] => [a, a + (b - a) * 0.7]);
  const cat: [number, number][] = [];
  for (let m = between(r, 380, 500); cat.length < 3 && m < 1300; m += between(r, 160, 300))
    cat.push([m, m + between(r, 25, 140)]);
  const food: [number, string][] = [[between(r, 430, 470), 'Milk']];
  if (r() > 0.5) food.push([between(r, 740, 790), 'Leftover chicken']);
  // A usual day's litter visits: four or five, morning to night, two or three minutes each.
  const litter: [number, number][] = [];
  for (let m = between(r, 380, 460); m < 1380 && litter.length < 5; m += between(r, 200, 300))
    litter.push([m, between(r, 2, 4)]);
  return { mug, screen, lamp, cat, food, zone: lamp, litter };
}

/** The sample day as a made day, with the screen's sessions it doesn't script. */
function sampleDay(): MadeDay {
  const spans = (on: (e: DayEvent) => boolean | undefined) => {
    const out: [number, number][] = [];
    for (const e of DEMO_DAY) {
      const v = on(e);
      if (v === true) out.push([e.at, Infinity]);
      if (v === false && out.at(-1)?.[1] === Infinity) out.at(-1)![1] = e.at;
    }
    return out;
  };
  return {
    mug: DEMO_DAY.filter((e) => e.used).map((e) => e.at),
    screen: SCREEN_DAY,
    lamp: spans((e) => e.lamp),
    cat: spans((e) => e.cat),
    food: DEMO_DAY.filter((e) => e.food).map((e): [number, string] => [e.at, e.food!]),
    zone: spans((e) => (e.mug ? e.mug === 'coaster' : undefined)),
    litter: [...DEMO_LITTER_VISITS],
  };
}

/** Midnight, local time, of the day `ms` falls on. */
export function midnightOf(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The demo room's history up to `at`: the sample day on `at`'s own date and
 * six made-up days before it, as the stats would have stored them. The mouse
 * is busy in steps through each screen session, as its activity level reads;
 * the main zone is full while the mug is on its coaster; the food goes off
 * as `DEMO_FOOD` says, counted from `at`'s day.
 */
export function demoHistory(at: number): { things: readonly AskThing[]; events: StatEvent[] } {
  const events: StatEvent[] = [];
  const today = midnightOf(at);
  const push = (thingId: string, key: StatKey, ms: number, value: StatEvent['value']) =>
    events.push({ thingId, key, at: ms, value, source: 'camera', confidence: 0.9 });
  for (let back = 6; back >= 0; back--) {
    // Midnight `back` days before, through a date so a clock change doesn't shift it.
    const d = new Date(today);
    d.setDate(d.getDate() - back);
    const day = d.getTime();
    const ms = (minute: number) => day + Math.round(minute * 60_000);
    const made = back === 0 ? sampleDay() : madeDay(back);
    const r = seeded(back * 104_729 + 1);
    for (const m of made.mug) push('mug', 'lastUsed', ms(m), ms(m));
    for (const [m, food] of made.food) push(FOOD_IDS[food]!, 'lastUsed', ms(m), ms(m));
    const onOff = (thingId: string, key: StatKey, spans: [number, number][]) => {
      for (const [a, b] of spans) {
        push(thingId, key, ms(a), true);
        if (Number.isFinite(b)) push(thingId, key, ms(b), false);
      }
    };
    onOff('monitor', 'power', made.screen);
    onOff('lamp', 'power', made.lamp);
    onOff('cat-tree', 'occupied', made.cat);
    onOff(zoneThingId('main'), 'occupied', made.zone);
    onOff(
      'litter-robot',
      'occupied',
      made.litter.map(([m, n]): [number, number] => [m, m + n]),
    );
    if (back === DEMO_LITTER_EMPTIED.daysAgo)
      push(
        'litter-drawer',
        'lastUsed',
        ms(DEMO_LITTER_EMPTIED.minute),
        ms(DEMO_LITTER_EMPTIED.minute),
      );
    for (const { name } of HOUSEHOLD) {
      // Home is occupied: pushed when they come or go, and once at midnight.
      let home: boolean | null = null;
      for (const s of householdSpans(name, back)) {
        const now = s.spot !== 'away';
        if (now !== home) push(householdThingId(name), 'occupied', ms(s.from), now);
        home = now;
      }
    }
    for (const [a, b] of made.screen) {
      // Busy in steps through the session, with a lull or two, then idle once it ends.
      for (let m = a + 2; m < b - 5; m += between(r, 8, 22))
        push('mouse', 'activity', ms(m), r() < 0.15 ? 0 : Math.round(3 + r() * 6) / 10);
      push('mouse', 'activity', ms(b), 0);
    }
  }
  const household = HOUSEHOLD.map(({ name, type }): AskThing => {
    const places: { at: number; text: string }[] = [];
    for (let back = 6; back >= 0; back--) {
      const d = new Date(today);
      d.setDate(d.getDate() - back);
      for (const s of householdSpans(name, back)) {
        const ms = d.getTime() + s.from * 60_000;
        if (ms <= at) places.push({ at: ms, text: doing(s) });
      }
    }
    return {
      id: householdThingId(name),
      label: name,
      stats: ['occupied'],
      member: { type, places },
    };
  });
  // One reading from the scale each day, at the day's first visit; oldest first.
  const weights = LITTER_KG.flatMap((kg, i) => {
    const back = LITTER_KG.length - 1 - i;
    const d = new Date(today);
    d.setDate(d.getDate() - back);
    const first = back ? madeDay(back).litter[0]![0] : DEMO_LITTER_VISITS[0]![0];
    const when = d.getTime() + first * 60_000;
    return when <= at ? [{ at: when, kg }] : [];
  });
  return {
    things: [
      ...DEMO_ASK_THINGS.map((t) => {
        if (t.litter) return { ...t, litter: { ...t.litter, weights } };
        const food = DEMO_FOOD.find((f) => f.label === t.label);
        return food
          ? {
              ...t,
              expires: addDays(dayOf(at), food.useByDays),
              ...(food.left ? { left: food.left } : {}),
            }
          : t;
      }),
      ...household,
    ],
    events: events.filter((e) => e.at <= at).sort((a, b) => a.at - b.at),
  };
}
