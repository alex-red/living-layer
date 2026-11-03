/**
 * A sample day in the demo office: what the mug, the desk lamp, the cat tree
 * and the fridge did from morning to night. The day replay, "Ask your room"
 * and the nudges all read it, so each can be shown before it reads the
 * things' real history. Times are minutes since midnight.
 */

/** Where the mug stands: on its coaster (inside the main zone), by the keyboard, at the desk's edge, or off the desk. */
export type MugSpot = 'coaster' | 'keyboard' | 'edge' | 'away';
type DayThing = 'mug' | 'lamp' | 'cat' | 'fridge';

export const DAY_THINGS: Record<DayThing, string> = {
  mug: 'My desk mug',
  lamp: 'Desk lamp',
  cat: 'Cat tree',
  fridge: 'Fridge',
};

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

/** Where the replay starts and ends. */
export const DAY_START = 6 * 60;
export const DAY_END = 23 * 60;

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

/** What is in the fridge, and in how many days from the sample day each goes off. */
const DEMO_FOOD: readonly { label: string; useByDays: number }[] = [
  { label: 'Leftover chicken', useByDays: 0 },
  { label: 'Milk', useByDays: 1 },
  { label: 'Spinach', useByDays: 4 },
  { label: 'Eggs', useByDays: 12 },
];

/** The room at one minute of the day. */
interface DayState {
  mug: MugSpot;
  lamp: boolean;
  cat: boolean;
  /** When the mug was last used, or null before its first use. */
  lastUsed: number | null;
  /** Times the mug was used so far. */
  uses: number;
}

const MORNING: DayState = { mug: 'away', lamp: false, cat: false, lastUsed: null, uses: 0 };

function apply(state: DayState, e: DayEvent): DayState {
  return {
    mug: e.mug ?? state.mug,
    lamp: e.lamp ?? state.lamp,
    cat: e.cat ?? state.cat,
    lastUsed: e.used ? e.at : state.lastUsed,
    uses: state.uses + (e.used ? 1 : 0),
  };
}

/** The events up to and including `minute`. */
export function eventsUntil(minute: number, day: readonly DayEvent[] = DEMO_DAY): DayEvent[] {
  return day.filter((e) => e.at <= minute);
}

export function dayAt(minute: number, day: readonly DayEvent[] = DEMO_DAY): DayState {
  return eventsUntil(minute, day).reduce(apply, MORNING);
}

/** A notification Living Layer sends through Home Assistant. */
interface Nudge {
  id: string;
  at: number;
  title: string;
  body: string;
  /** The button it offers on the phone. */
  action?: string;
  /** The events it was worked out from. */
  cites: DayEvent[];
}

/** Hours awake: no drink reminders outside them. */
const AWAKE = { from: 7 * 60, to: 22 * 60 };
/** How long the mug may stand unused before a drink reminder. */
const THIRSTY_MIN = 180;
/** How long a lamp may stay on with the desk empty. */
const LAMP_IDLE_MIN = 30;
/** When the day's food summary is sent. */
const FOOD_AT = 8 * 60;

/**
 * The nudges a day gives, in order: a drink reminder when the mug has stood
 * unused too long, a lamp left on with the mug gone, and the morning's food
 * that goes off soon. Each is worked out from the events alone.
 */
export function dayNudges(
  day: readonly DayEvent[] = DEMO_DAY,
  food: readonly { label: string; useByDays: number }[] = DEMO_FOOD,
): Nudge[] {
  const nudges: Nudge[] = [];
  let state = MORNING;
  let next = 0;
  let lampSince: number | null = null;
  let thirstyFor: number | null = null;
  let idleFor: number | null = null;
  const lastOf = (pred: (e: DayEvent) => boolean, until: number) =>
    day.filter((e) => e.at <= until && pred(e)).slice(-1);
  for (let m = DAY_START; m <= DAY_END; m++) {
    while (next < day.length && day[next]!.at <= m) {
      const e = day[next++]!;
      if (e.lamp && !state.lamp) lampSince = e.at;
      state = apply(state, e);
    }
    if (!state.lamp) lampSince = null;

    // Standing on the desk unused since its last use; a mug taken away may be in use elsewhere.
    const last = state.lastUsed;
    const awake = m >= AWAKE.from && m <= AWAKE.to;
    if (last !== null && state.mug !== 'away' && m - last >= THIRSTY_MIN && awake) {
      if (thirstyFor !== last) {
        thirstyFor = last;
        nudges.push({
          id: `drink-${m}`,
          at: m,
          title: 'Time for a drink?',
          body: `Your mug hasn’t moved since ${clock(last)}, ${span(m - last)} ago.`,
          action: 'Remind me in 30 min',
          cites: lastOf((e) => e.thing === 'mug' && Boolean(e.used), m),
        });
      }
    }

    if (lampSince !== null && state.mug === 'away') {
      const quiet = Math.max(lampSince, lastOf((e) => e.mug === 'away', m)[0]?.at ?? lampSince);
      if (m - quiet >= LAMP_IDLE_MIN && idleFor !== lampSince) {
        idleFor = lampSince;
        nudges.push({
          id: `lamp-${m}`,
          at: m,
          title: 'Desk lamp left on',
          body: `It has been on ${span(m - lampSince)} with nothing at the desk.`,
          action: 'Turn it off',
          cites: [...lastOf((e) => e.mug === 'away', m), ...lastOf((e) => e.thing === 'lamp', m)],
        });
      }
    }

    if (m === FOOD_AT) {
      const soon = [...food]
        .filter((f) => f.useByDays <= 1)
        .sort((a, b) => a.useByDays - b.useByDays);
      if (soon.length)
        nudges.push({
          id: 'food',
          at: m,
          title: 'Use these first',
          body: soon.map((f) => `${f.label} ${goesOff(f.useByDays)}`).join(' · '),
          action: 'Show the fridge',
          cites: [],
        });
    }
  }
  return nudges;
}

/** An answer about the room, with the events it rests on. */
export interface RoomAnswer {
  text: string;
  cites: DayEvent[];
}

/** Questions the demo answers, offered under the box. */
export const ASK_EXAMPLES = [
  'When did I last drink from my mug?',
  'What should I eat first?',
  'How long was the lamp on today?',
  'Was the cat on its tree?',
  'What happened today?',
];

const SPOT_WORDS: Record<MugSpot, string> = {
  coaster: 'on its coaster, inside the main zone',
  keyboard: 'by the keyboard',
  edge: 'at the desk’s edge',
  away: 'off the desk',
};

/**
 * Answer a question about the day so far, from the events up to `minute`.
 * A demo stand-in for Spark reading the things' history: it matches what the
 * question is about and answers from the same events Spark would be given.
 */
export function askRoom(
  question: string,
  minute: number,
  day: readonly DayEvent[] = DEMO_DAY,
  food: readonly { label: string; useByDays: number }[] = DEMO_FOOD,
): RoomAnswer {
  const q = question.toLowerCase();
  const seen = eventsUntil(minute, day);
  const state = seen.reduce(apply, MORNING);
  const of = (thing: DayThing) => seen.filter((e) => e.thing === thing);

  if (/\bwhere\b/.test(q) && /mug|cup/.test(q)) {
    const moved = seen.filter((e) => e.mug).slice(-1);
    return {
      text: `Your mug is ${SPOT_WORDS[state.mug]}${moved[0] ? `, since ${clock(moved[0].at)}` : ''}.`,
      cites: moved,
    };
  }
  if (/fridge|food|\beat\b|expir|go(es)? off|use.?by|milk|chicken|spinach|egg/.test(q)) {
    const sorted = [...food].sort((a, b) => a.useByDays - b.useByDays);
    const taken = of('fridge').slice(-2);
    return {
      text: `Eat the ${sorted[0]!.label.toLowerCase()} first: it ${goesOff(sorted[0]!.useByDays)}. Then ${sorted
        .slice(1)
        .map((f) => `${f.label.toLowerCase()} (${goesOff(f.useByDays)})`)
        .join(
          ', ',
        )}.${taken.length ? ` Last taken out: ${taken.map((e) => `${e.food!.toLowerCase()} at ${clock(e.at)}`).join(', ')}.` : ''}`,
      cites: taken,
    };
  }
  if (/lamp|light/.test(q)) {
    const lamp = of('lamp');
    const on = onFor(lamp, (e) => e.lamp, minute);
    const times = lamp.filter((e) => e.lamp).length;
    return {
      text: times
        ? `The desk lamp was on ${span(on)} today, switched on ${times} time${times === 1 ? '' : 's'}. It is ${state.lamp ? 'on' : 'off'} now.`
        : 'The desk lamp hasn’t been on today.',
      cites: lamp.slice(-3),
    };
  }
  if (/cat/.test(q)) {
    const cat = of('cat');
    const on = onFor(cat, (e) => e.cat, minute);
    const visits = cat.filter((e) => e.cat).length;
    return {
      text: visits
        ? `Yes, ${visits} time${visits === 1 ? '' : 's'} today, ${span(on)} in all. ${state.cat ? 'It’s up there now.' : 'It isn’t on it now.'}`
        : 'Not yet today.',
      cites: cat.filter((e) => e.cat).slice(-3),
    };
  }
  if (/mug|cup|drink|drank|coffee|tea|water|thirst/.test(q)) {
    const uses = of('mug').filter((e) => e.used);
    const last = uses.at(-1);
    return {
      text: last
        ? `At ${clock(last.at)}, ${minute === last.at ? 'just now' : `${span(minute - last.at)} ago`}. You’ve used it ${uses.length} time${uses.length === 1 ? '' : 's'} today, first at ${clock(uses[0]!.at)}. It’s ${SPOT_WORDS[state.mug]} now.`
        : 'You haven’t used your mug yet today.',
      cites: uses.slice(-3),
    };
  }
  if (/today|day|happen|summary|so far/.test(q)) {
    const uses = of('mug').filter((e) => e.used).length;
    const lampOn = of('lamp').filter((e) => e.lamp).length;
    const fridge = of('fridge');
    return {
      text: `${seen.length} changes since morning. Your mug was used ${uses} time${uses === 1 ? '' : 's'}, the desk lamp came on ${lampOn} time${lampOn === 1 ? '' : 's'}, and ${fridge.length ? `you took ${fridge.map((e) => e.food!.toLowerCase()).join(', ')} from the fridge` : 'the fridge stayed shut'}.`,
      cites: seen.slice(-3),
    };
  }
  return {
    text: 'In this demo I can answer about your mug, the desk lamp, the fridge and the cat tree.',
    cites: [],
  };
}

/** Minutes something was on, from its events up to `minute`. */
function onFor(events: DayEvent[], on: (e: DayEvent) => boolean | undefined, minute: number) {
  let total = 0;
  let since: number | null = null;
  for (const e of events) {
    const v = on(e);
    if (v && since === null) since = e.at;
    if (v === false && since !== null) {
      total += e.at - since;
      since = null;
    }
  }
  return since === null ? total : total + minute - since;
}

/** 14:05. */
export function clock(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = Math.round(minute % 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** 2 h 10 min. */
export function span(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

function goesOff(days: number): string {
  return days <= 0
    ? 'goes off today'
    : days === 1
      ? 'goes off tomorrow'
      : `keeps ${days} more days`;
}
