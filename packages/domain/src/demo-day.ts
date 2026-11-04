/**
 * A sample day in the demo office: what the mug, the desk lamp, the cat tree
 * and the fridge did from morning to night. The day replay, "Ask your room"
 * and the nudges all read it. Times are minutes since midnight.
 *
 * `demoHistory` turns it into stats' events, with the six days before it
 * made up around it, so asking the demo room reads the same kind of history
 * a live room keeps.
 */
import { addDays } from './food.js';
import type { AskExample } from './room-ask.js';
import { dayOf, type StatEvent, type StatKey } from './stats.js';

/** Where the mug stands: on its coaster (inside the main zone), by the keyboard, at the desk's edge, or off the desk. */
export type MugSpot = 'coaster' | 'keyboard' | 'edge' | 'away';
export type DayThing = 'mug' | 'lamp' | 'cat' | 'fridge';

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
}

/** The thing a zone is when asking about the room: its fillings and emptyings are its occupied stat. */
export const zoneThingId = (ruleId: string) => `zone:${ruleId}`;

/** What is in the demo fridge, and in how many days from the sample day each goes off. */
export const DEMO_FOOD: readonly { label: string; useByDays: number }[] = [
  { label: 'Leftover chicken', useByDays: 0 },
  { label: 'Milk', useByDays: 1 },
  { label: 'Spinach', useByDays: 4 },
  { label: 'Eggs', useByDays: 12 },
];

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
];
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
  return { mug, screen, lamp, cat, food, zone: lamp };
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
    for (const [a, b] of made.screen) {
      // Busy in steps through the session, with a lull or two, then idle once it ends.
      for (let m = a + 2; m < b - 5; m += between(r, 8, 22))
        push('mouse', 'activity', ms(m), r() < 0.15 ? 0 : Math.round(3 + r() * 6) / 10);
      push('mouse', 'activity', ms(b), 0);
    }
  }
  return {
    things: DEMO_ASK_THINGS.map((t) => {
      const food = DEMO_FOOD.find((f) => f.label === t.label);
      return food ? { ...t, expires: addDays(dayOf(at), food.useByDays) } : t;
    }),
    events: events.filter((e) => e.at <= at).sort((a, b) => a.at - b.at),
  };
}
