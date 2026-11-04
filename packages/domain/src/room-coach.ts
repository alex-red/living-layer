/**
 * The room coach: every few minutes it looks at what the room's stats say now
 * and, when something is worth a word, nudges the person with a joke. Code
 * works out the facts (how long since a drink, how long the screen has been
 * on); Spark, cheaply, only picks one and words it, so the numbers in a nudge
 * are always the room's own. The demo words them offline.
 */
import { z } from 'zod';
import type { AskThing } from './demo-day.js';
import { daysUntil } from './food.js';
import { clockOf, thingKind, type AskCite, type AskHistory } from './room-ask.js';
import { dayOf, type StatEvent, type StatKey } from './stats.js';

/** How often the coach looks, how long it keeps quiet about one thing, and when each fact is due. */
export const COACH = {
  everyMin: 5,
  /** After a nudge about a fact, minutes before the same fact may nudge again. */
  cooldownMin: 45,
  /** Food, and a pet home alone: said once a stretch. */
  foodCooldownMin: 720,
  /** Minutes between any two nudges, so it never nags twice in a row. */
  gapMin: 20,
  /** Minutes since a drink, while someone is at the desk. */
  thirstyMin: 20,
  /** Minutes the screen has been on without a break. */
  screenMin: 90,
  /** Minutes a light has been on with nobody at the desk. */
  awayMin: 15,
  /** Minutes the cat has been on its tree. */
  catMin: 120,
  /** Minutes a dog has been home with nobody else; a cat minds twice as long. */
  aloneMin: 180,
  /** Hours counted as late at night, while the screen is on. */
  late: { from: 23, to: 5 },
  /** Nudges kept, newest last. */
  kept: 20,
} as const;

const MINUTE = 60_000;

export type CoachTopic = 'drink' | 'screen' | 'late' | 'lampAway' | 'cat' | 'food' | 'alone';

/** One thing the coach could nudge about, worked out from the stats. */
export interface CoachFact {
  /** The topic and the thing: a nudge about it keeps the same fact quiet a while. */
  id: string;
  topic: CoachTopic;
  thingId: string;
  label: string;
  /** How long it has been so, in minutes; 0 for food. */
  minutes: number;
  /** The fact in plain words, with its numbers: what Spark words a nudge from. */
  text: string;
  /** How due it is: 1 is due now, more is overdue. */
  weight: number;
  cites: AskCite[];
}

/** A nudge the coach sent. */
export interface CoachNudge {
  id: string;
  at: number;
  factId: string;
  topic: CoachTopic;
  title: string;
  body: string;
  /** Who worded it: Spark, or the offline lines (the demo, or when Spark failed). */
  by: 'spark' | 'offline';
  cites: AskCite[];
}

/** One look at the room: the nudge it sent, or why it kept quiet, and the facts it saw. */
export interface CoachCheck {
  at: number;
  nudge: CoachNudge | null;
  quiet: string | null;
  /** Anything worth knowing about how it looked: Spark failed and the line is offline. */
  note: string | null;
  facts: CoachFact[];
}

/** The coach as the page shows it: on or off (live), when it looks next, what it said lately. */
export interface CoachView {
  on: boolean;
  everyMin: number;
  /** When it looks next, ms; null while off or in the demo. */
  nextAt: number | null;
  /** Newest last. */
  nudges: CoachNudge[];
}

/** 3 h 5 min. */
function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}
/** "20 minutes", "an hour and a half", "3 hours": as a friend says it. */
function said(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  if (m < 75) return 'an hour';
  if (m < 105) return 'an hour and a half';
  return `${Math.round(m / 60)} hours`;
}
const isOn = (key: StatKey, v: StatEvent['value']) =>
  key === 'activity' ? typeof v === 'number' && v > 0 : v === true;

/** One thing's events of one stat up to `now`, oldest first. */
function eventsOf(history: AskHistory, thingId: string, key: StatKey, now: number) {
  return history.events.filter((e) => e.thingId === thingId && e.key === key && e.at <= now);
}
/** When it came on, if it is on now: the first event of the run of ons it is in. */
function onSince(events: readonly StatEvent[], key: StatKey): StatEvent | null {
  let first: StatEvent | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (!isOn(key, events[i]!.value)) break;
    first = events[i]!;
  }
  return first;
}
const citeOf = (thing: AskThing, key: StatKey, e: StatEvent, text: string): AskCite => ({
  at: e.at,
  thingId: thing.id,
  kind: thingKind(thing, key),
  text,
});
/** "the desk lamp", "your desk mug". */
const nameOf = (t: AskThing) =>
  /^my\s/i.test(t.label) ? `your ${t.label.slice(3)}` : `the ${t.label.toLowerCase()}`;

/**
 * What the room's stats say now that the coach might nudge about, most due
 * first: a drink overdue while someone is at the desk, the screen on a long
 * while or late at night, a light left on with nobody there, the cat long on
 * its tree, food that goes off today or has.
 */
export function coachFacts(history: AskHistory, now: number): CoachFact[] {
  const facts: CoachFact[] = [];
  const of = (kind: string) =>
    history.things.filter((t) => t.stats.some((k) => thingKind(t, k) === kind));
  const screens = of('screen').map((t) => ({ t, events: eventsOf(history, t.id, 'power', now) }));
  const pointers = of('pointer').map((t) => eventsOf(history, t.id, 'activity', now));
  const screenOn = screens.some(({ events }) => isOn('power', events.at(-1)?.value ?? null));
  // Someone is at the desk: the screen is on or the mouse moved lately; with neither kept, assume so.
  const present =
    (!screens.length && !pointers.length) ||
    screenOn ||
    pointers.some((es) => es.some((e) => isOn('activity', e.value) && now - e.at < 15 * MINUTE));

  for (const t of of('drink')) {
    const last = eventsOf(history, t.id, 'lastUsed', now).at(-1);
    if (!last || !present) continue;
    const minutes = (now - last.at) / MINUTE;
    // Half a day without one is somebody else's morning, not thirst.
    if (minutes > 12 * 60) continue;
    facts.push({
      id: `drink:${t.id}`,
      topic: 'drink',
      thingId: t.id,
      label: t.label,
      minutes,
      text: `No drink from ${nameOf(t)} for ${hm(minutes)} (the last at ${clockOf(last.at)}), and someone is at the desk.`,
      weight: minutes / COACH.thirstyMin,
      cites: [citeOf(t, 'lastUsed', last, 'Last drink')],
    });
  }
  const hour = new Date(now).getHours();
  const late = hour >= COACH.late.from || hour < COACH.late.to;
  for (const { t, events } of screens) {
    const since = onSince(events, 'power');
    if (!since) continue;
    const minutes = (now - since.at) / MINUTE;
    const cites = [citeOf(t, 'power', since, `${t.label} on`)];
    facts.push({
      id: `screen:${t.id}`,
      topic: 'screen',
      thingId: t.id,
      label: t.label,
      minutes,
      text: `${t.label} has been on for ${hm(minutes)} without a break, since ${clockOf(since.at)}.`,
      weight: minutes / COACH.screenMin,
      cites,
    });
    if (late)
      facts.push({
        id: `late:${t.id}`,
        topic: 'late',
        thingId: t.id,
        label: t.label,
        minutes,
        text: `It is ${clockOf(now)}, late at night, and ${nameOf(t)} is still on (for ${hm(minutes)}).`,
        weight: 1.2,
        cites,
      });
  }
  // Nobody at the desk since the last screen went off.
  const awayFrom =
    screens.length && !screenOn
      ? Math.max(...screens.map(({ events }) => events.at(-1)?.at ?? 0))
      : null;
  for (const t of of('light')) {
    const since = onSince(eventsOf(history, t.id, 'power', now), 'power');
    if (!since || awayFrom === null) continue;
    const minutes = (now - Math.max(since.at, awayFrom)) / MINUTE;
    facts.push({
      id: `lampAway:${t.id}`,
      topic: 'lampAway',
      thingId: t.id,
      label: t.label,
      minutes,
      text: `${t.label} has been on for ${hm(minutes)} with nobody at the desk (the screen is off).`,
      weight: minutes / COACH.awayMin,
      cites: [citeOf(t, 'power', since, `${t.label} on`)],
    });
  }
  for (const t of of('cat')) {
    if (!present) continue;
    const since = onSince(eventsOf(history, t.id, 'occupied', now), 'occupied');
    if (!since) continue;
    const minutes = (now - since.at) / MINUTE;
    facts.push({
      id: `cat:${t.id}`,
      topic: 'cat',
      thingId: t.id,
      label: t.label,
      minutes,
      text: `The cat has been on ${nameOf(t)} for ${hm(minutes)}, since ${clockOf(since.at)}.`,
      // A cat is never urgent: only when nothing else is.
      weight: (0.9 * minutes) / COACH.catMin,
      cites: [citeOf(t, 'occupied', since, 'The cat climbed its tree')],
    });
  }
  // A pet home with nobody else: since the last person went out, or the pet came home.
  const people = history.things
    .filter((t) => t.member?.type === 'person')
    .map((t) => ({ t, events: eventsOf(history, t.id, 'occupied', now) }));
  // Each went out (home, then not): the first stretch of the day doesn't count as leaving.
  const left = people.map(({ events }) => {
    const [before, last] = [events.at(-2), events.at(-1)];
    return last && last.value === false && before?.value === true ? last : null;
  });
  if (people.length && left.every((e) => e !== null)) {
    const last = left.reduce((a, b) => (b!.at > a!.at ? b : a))!;
    const who = people.find(({ t }) => t.id === last.thingId)!.t;
    for (const pet of history.things) {
      if (!pet.member || pet.member.type === 'person') continue;
      const since = onSince(eventsOf(history, pet.id, 'occupied', now), 'occupied');
      if (!since) continue;
      const from = Math.max(since.at, last.at);
      const minutes = (now - from) / MINUTE;
      facts.push({
        id: `alone:${pet.id}`,
        topic: 'alone',
        thingId: pet.id,
        label: pet.label,
        minutes,
        text: `${pet.label} has been home alone for ${hm(minutes)}, since ${clockOf(from)}, when ${who.label} went out.`,
        weight: minutes / (pet.member.type === 'dog' ? COACH.aloneMin : 2 * COACH.aloneMin),
        cites: [citeOf(who, 'occupied', last, `${who.label} went out`)],
      });
    }
  }
  for (const t of history.things) {
    // Food can wait until someone is around to read about it.
    if (!t.expires || !present) continue;
    const n = daysUntil(t.expires, dayOf(now));
    if (n > 0) continue;
    facts.push({
      id: `food:${t.id}`,
      topic: 'food',
      thingId: t.id,
      label: t.label,
      minutes: 0,
      text:
        n === 0
          ? `${t.label} goes off today.`
          : `${t.label} went off ${-n} day${n === -1 ? '' : 's'} ago and is still in the fridge.`,
      weight: n < 0 ? 1.3 : 1.1,
      cites: [],
    });
  }
  return facts.sort((a, b) => b.weight - a.weight);
}

/**
 * Whether a nudge belongs over a room: the household's (a pet home alone) over
 * the Home room, the desk's (drinks, the screen, the lamp) over the others.
 */
export const topicInRoom = (topic: CoachTopic, scene: string | null) =>
  (topic === 'alone') === (scene === 'home');

/** Minutes the coach keeps quiet about a fact after nudging about it. */
const cooldownOf = (f: CoachFact) =>
  f.topic === 'food' || f.topic === 'alone' ? COACH.foodCooldownMin : COACH.cooldownMin;

/**
 * The facts worth a nudge now, most due first: due, not nudged about within
 * its cooldown, and none within `COACH.gapMin` of the last nudge; `force` (as
 * "Check now" is) skips both waits.
 */
export function dueFacts(
  facts: readonly CoachFact[],
  recent: readonly CoachNudge[],
  now: number,
  force = false,
): CoachFact[] {
  const last = recent.at(-1);
  if (!force && last && now - last.at < COACH.gapMin * MINUTE) return [];
  return facts.filter(
    (f) =>
      f.weight >= 1 &&
      (force || !recent.some((n) => n.factId === f.id && now - n.at < cooldownOf(f) * MINUTE)),
  );
}

/** Lines per topic, `{span}` the time said as a friend would, `{label}` the thing. */
const LINES: Record<CoachTopic, [string, string][]> = {
  drink: [
    [
      'Hydration check 💧',
      'It’s been {span} since your last sip. Your mug is starting to think it’s decor.',
    ],
    [
      'Drink something',
      'You should probably drink something, it’s been {span}. Even the plant got watered today.',
    ],
    [
      'Your mug misses you',
      '{span} without a drink. The mug has started writing sad poetry about it.',
    ],
    ['Sip o’clock', '{span} dry. Camels are impressed. Your kidneys are not.'],
  ],
  screen: [
    [
      'Blink, maybe?',
      'Hey, you’ve been staring at that monitor for like {span}, dude. It’s not going to blink first.',
    ],
    [
      'Screen marathon 🏃',
      '{span} of unbroken screen time. Your eyes have filed a formal complaint.',
    ],
    [
      'Look at a far thing',
      '{span} at the screen. Look at something far away for 20 seconds. The bookshelf counts.',
    ],
    [
      'Stand up, champ',
      'The monitor’s been on for {span}. Stand up, stretch, mildly alarm the cat.',
    ],
  ],
  late: [
    [
      'It’s {clock}',
      'It’s {clock} and the monitor’s still glowing. Whatever it is, it’ll still be broken tomorrow.',
    ],
    ['Bedtime, legally', '{clock}. The screen is on. The owls are asking if you’re okay.'],
  ],
  lampAway: [
    [
      'Lights on, nobody home',
      'The {label} has been lighting an empty desk for {span}. Very atmospheric. Very billable.',
    ],
    [
      'The lamp is lonely',
      'You left {span} ago and the {label} is still on, bravely guarding the keyboard.',
    ],
  ],
  cat: [
    [
      'Cat status: elevated',
      'The cat has been up its tree for {span}. At this point it’s less a cat, more an ornament.',
    ],
    [
      'Throne occupied 👑',
      '{span} on the tree. The cat has not moved. The cat has no plans to move.',
    ],
  ],
  alone: [
    [
      '{name} misses you',
      '{name} has been home alone for {span}. The front door is being stared at, very hard.',
    ],
    [
      'Home alone 🐾',
      '{span} since anyone was home. {name} has started reorganising the cushions.',
    ],
  ],
  food: [
    [
      'About the {label}…',
      'The {label} goes off today. Eat it tonight, or say goodbye with dignity.',
    ],
    ['Fridge alert', 'The {label} is on its last day. It’s now or never, and never smells worse.'],
  ],
};
const GONE: [string, string][] = [
  [
    'About the {label}…',
    'The {label} went off {days} ago. It’s not leftovers any more, it’s a science project.',
  ],
];

/** A nudge about a fact in the offline lines, picked by `seed` so a replay says the same each time. */
export function coachLine(fact: CoachFact, at: number, seed = 0): { title: string; body: string } {
  const gone = fact.topic === 'food' && fact.text.includes('went off');
  const lines = gone ? GONE : LINES[fact.topic];
  const [title, body] = lines[Math.abs(seed) % lines.length]!;
  const goneDays = /went off (\d+ days?)/.exec(fact.text)?.[1] ?? 'a day';
  const fill = (s: string) =>
    s
      .replaceAll('{span}', said(fact.minutes))
      .replaceAll('{clock}', clockOf(at))
      .replaceAll('{label}', fact.label.replace(/^my\s+/i, '').toLowerCase())
      .replaceAll('{name}', fact.label)
      .replaceAll('{days}', goneDays);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return { title: cap(fill(title)), body: cap(fill(body)) };
}

/** The nudge a fact makes, worded by Spark or offline. */
export function coachNudge(
  fact: CoachFact,
  words: { title: string; body: string },
  at: number,
  by: CoachNudge['by'],
): CoachNudge {
  return {
    id: `${fact.id}@${at}`,
    at,
    factId: fact.id,
    topic: fact.topic,
    title: words.title,
    body: words.body,
    by,
    cites: fact.cites,
  };
}

/** Why the coach kept quiet: nothing due, or nothing due it hasn't just said. */
export function quietWords(facts: readonly CoachFact[]): string {
  return facts.some((f) => f.weight >= 1)
    ? 'Already said that one. Giving you some space.'
    : 'Nothing to nag about. You’re doing suspiciously well.';
}

/**
 * The coach over a stretch of time, offline: a look every `COACH.everyMin`
 * minutes from `from` to `to`, each nudging about its most due fact unless
 * it nudged about that one lately or its topic is snoozed. What the demo's
 * replay shows.
 */
export function coachDay(
  history: AskHistory,
  from: number,
  to: number,
  snoozes: readonly CoachSnooze[] = [],
): CoachNudge[] {
  const nudges: CoachNudge[] = [];
  // Only the last day's events matter to any look in it, and filtering fewer is faster.
  const recentHistory = {
    ...history,
    events: history.events.filter((e) => e.at > from - 86_400_000),
  };
  for (let at = from; at <= to; at += COACH.everyMin * MINUTE) {
    const due = dueFacts(coachFacts(recentHistory, at), nudges, at).filter(
      (f) => !snoozes.some((z) => z.topic === f.topic && at >= z.from && at < z.to),
    );
    const fact = due[0];
    if (fact) nudges.push(coachNudge(fact, coachLine(fact, at, nudges.length), at, 'offline'));
  }
  return nudges;
}

/** What a nudge's button does: log a sip, take a break, switch something off, ask, or nothing. */
type CoachDoes = 'drink' | 'break' | 'screenOff' | 'lampOff' | 'ask' | 'none';

/**
 * Each topic's button, what it does and what the nudge says once done. For
 * now only the demo acts (`actionEvents`); live, the buttons wait.
 */
export const COACH_ACTIONS: Record<CoachTopic, { label: string; does: CoachDoes; done: string }> = {
  drink: { label: 'Log a sip', does: 'drink', done: 'Sip logged. Your mug feels seen.' },
  screen: {
    label: 'Take 5',
    does: 'break',
    done: 'Screen off for 5 minutes. Go look at a tree.',
  },
  late: { label: 'Bed, fine', does: 'screenOff', done: 'Screen off. Sleep well, night owl.' },
  lampAway: {
    label: 'Turn it off',
    does: 'lampOff',
    done: 'Lamp off. The electricity bill sends its regards.',
  },
  cat: { label: 'Respect the cat', does: 'none', done: 'The cat acknowledges you. Barely.' },
  food: { label: 'What do I eat?', does: 'ask', done: 'Asked the room what to eat first.' },
  alone: { label: 'On my way', does: 'none', done: 'Noted. Tail wagging has begun in advance.' },
};
/** Minutes a snoozed topic keeps quiet. */
export const COACH_SNOOZE_MIN = 30;
/** A topic kept quiet from a time until another, ms. */
export interface CoachSnooze {
  topic: CoachTopic;
  from: number;
  to: number;
}

/**
 * What doing a nudge's action at `when` adds to the room's history, as the
 * person's own events: a sip from the mug, the screen off for a 5-minute
 * break (or for the night), the light off. Nothing for an action that only
 * answers.
 */
export function actionEvents(nudge: CoachNudge, when: number): StatEvent[] {
  // Done after the nudge it answers, so the nudge itself still stands.
  const at = Math.max(when, nudge.at + MINUTE);
  const thingId = nudge.factId.slice(nudge.factId.indexOf(':') + 1);
  const ev = (key: StatKey, ms: number, value: StatEvent['value']): StatEvent => ({
    thingId,
    key,
    at: ms,
    value,
    source: 'person',
    confidence: 1,
  });
  switch (COACH_ACTIONS[nudge.topic].does) {
    case 'drink':
      return [ev('lastUsed', at, at)];
    case 'break':
      return [ev('power', at, false), ev('power', at + 5 * MINUTE, true)];
    case 'screenOff':
    case 'lampOff':
      return [ev('power', at, false)];
    default:
      return [];
  }
}

/** What Spark answers: which fact, and the nudge in its words. Flat and strict. */
export const coachWordsSchema = z
  .object({
    factId: z.string().nullable(),
    title: z.string(),
    body: z.string(),
  })
  .strict();
export type CoachWords = z.infer<typeof coachWordsSchema>;

/**
 * Spark's answer checked against the facts it was given: a fact it named and
 * a short title and body, else null (it chose quiet, or named no such fact).
 */
export function readCoachWords(
  words: CoachWords,
  facts: readonly CoachFact[],
): { fact: CoachFact; title: string; body: string } | null {
  const fact = facts.find((f) => f.id === words.factId);
  const title = words.title.trim();
  const body = words.body.trim();
  if (!fact || !title || !body) return null;
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  return { fact, title: clip(title, 60), body: clip(body, 220) };
}
