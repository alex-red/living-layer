/**
 * A sample day in the demo office: what the mug, the desk lamp, the cat tree
 * and the fridge did from morning to night (`DEMO_DAY`, in domain): the
 * replay and the nudges read it here, and the server's demo answers
 * "Ask your room" from it. Times are minutes since midnight.
 */

import {
  DEMO_DAY,
  DEMO_FOOD,
  type DayEvent,
  type DayThing,
  type MugSpot,
} from '@livinglayer/domain';

export const DAY_THINGS: Record<DayThing, string> = {
  mug: 'My desk mug',
  lamp: 'Desk lamp',
  cat: 'Cat tree',
  fridge: 'Fridge',
};

/** Where the replay starts and ends. */
export const DAY_START = 6 * 60;
export const DAY_END = 23 * 60;

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
