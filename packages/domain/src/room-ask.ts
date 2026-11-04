/**
 * Asking the room about its history ([plan](../../../docs/plans/ask-room.md)).
 * Spark reads a question as one `AskQuery`, from closed lists; `readAsk`
 * checks it against the things that keep stats, and `answerAsk` works the
 * number out from their stored events and words it. Spark never counts.
 * `demoAsk` reads a question offline in Spark's shape, for the demo.
 */
import { z } from 'zod';
import { midnightOf, zoneThingId, type AskThing } from './demo-day.js';
import { daysUntil } from './food.js';
import type { DeskMemory } from './memory.js';
import { STAT_KEYS, STAT_KINDS, dayOf, type StatEvent, type StatKey } from './stats.js';

const ASK_MEASURES = [
  'count',
  'duration',
  'last',
  'first',
  'longestGap',
  'longest',
  'now',
  'summary',
  'useBy',
] as const;
type AskMeasure = (typeof ASK_MEASURES)[number];
/** Each measure in a line, for Spark's prompt and the tests. */
export const ASK_MEASURE_ABOUT: Record<AskMeasure, string> = {
  count: 'how many times: uses, drinks, switchings on, visits, busy stretches',
  duration: 'how long in all: on, occupied, in use',
  last: 'when it last happened (window ignored)',
  first: 'when it first happened in the window',
  longestGap: 'the longest stretch without it: without a drink, off, empty, idle',
  longest: 'the longest single stretch of it: on, a nap, a focus stretch',
  now: 'what it is now and since when',
  summary: 'what happened, one line per thing (thing and stat null)',
  useBy:
    'when food goes off, soonest first: what to eat first (stat null; thing null for all food)',
};
const ASK_WINDOWS = ['minutes', 'today', 'yesterday', 'days'] as const;
const ASK_COMPARES = ['none', 'previous', 'average'] as const;

/** What Spark answers: one query, every field present, null when unused. */
export const askQuerySchema = z
  .object({
    /** A thing's id from the list, or null for every thing. */
    thing: z.string().nullable(),
    stat: z.enum(STAT_KEYS).nullable(),
    measure: z.enum(ASK_MEASURES),
    /** The last `amount` minutes, today so far, yesterday, or the last `amount` days. */
    window: z.enum(ASK_WINDOWS),
    amount: z.number().nullable(),
    /** Against the window before it (yesterday by this time), or the week before's average. */
    compare: z.enum(ASK_COMPARES),
    /** Only while another thing (its id) was on, or off when `whileOn` is false: "while I was away". */
    while: z.string().nullable(),
    whileOn: z.boolean().nullable(),
    /** A short question back, when the question can't be read as one query. */
    clarify: z.string().nullable(),
  })
  .strict();
export type AskQuery = z.infer<typeof askQuerySchema>;

/** What the history holds for asking: the things, their events, and when the camera watched. */
export interface AskHistory {
  things: readonly AskThing[];
  /** Oldest first; each thing's last change before the span asked about included. */
  events: readonly StatEvent[];
  /** When the camera watched, oldest first; null when it is unknown or always (the demo). */
  watched: readonly { from: number; to: number }[] | null;
  /** Day totals, kept for good: what a window past the events' 30 days is read from. */
  totals?: readonly { day: string; thingId: string; key: StatKey; total: number }[];
}

/** What kind of thing it is, for the dot it is drawn with; `summary` is the whole room. */
export type AskKind =
  | 'drink'
  | 'food'
  | 'screen'
  | 'cat'
  | 'pointer'
  | 'light'
  | 'zone'
  | 'other'
  | 'summary';
/** One event an answer rests on. */
export interface AskCite {
  at: number;
  thingId: string;
  kind: AskKind;
  text: string;
}
/** An answer about the room, with what it rests on. */
export interface RoomAnswer {
  text: string;
  /** What a number really counts, and how much of the window the camera watched. */
  notes: string[];
  cites: AskCite[];
  /** A count or a time per hour or per day, when the window is long enough to draw. */
  bars: {
    unit: 'times' | 'minutes';
    values: { label: string; from: number; value: number }[];
  } | null;
  /** The answer's one number, to show large: "3 drinks", "5 h 3 min", "9:42". */
  figure: string | null;
  /** The same measure over the window it was compared with, and which way it went since. */
  compared: {
    label: string;
    value: number;
    words: string;
    trend: 'more' | 'less' | 'same';
  } | null;
  /** Food by its use-by day, soonest first: days left, below 0 once gone off. */
  foods: { thingId: string; label: string; days: number }[] | null;
  /** The query it answered, after `readAsk`; null when it asks back. */
  query: AskQuery | null;
  /** A question back, when the question couldn't be read. */
  clarify: string | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 9:05, local time. */
export function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** 2 h 10 min. */
function spanOf(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Check a query against the things: a thing named by id or label, a stat it
 * keeps, a measure that means something for that stat, an amount in range.
 * A query that can't be answered comes back with `clarify` set.
 */
export function readAsk(raw: AskQuery, things: readonly AskThing[]): AskQuery {
  const names = things.map((t) => t.label.toLowerCase()).join(', ');
  const ask = (clarify: string): AskQuery => ({ ...raw, clarify });
  if (!things.length)
    return ask('No thing in this room keeps stats yet. Switch one on in its card first.');
  if (raw.clarify?.trim()) return { ...raw, clarify: raw.clarify.trim() };
  const q: AskQuery = { ...raw, clarify: null };
  const find = (name: string) =>
    things.find((t) => t.id === name) ??
    things.find((t) => t.label.toLowerCase() === name.toLowerCase());
  if (q.measure === 'useBy') {
    const thing = q.thing === null ? null : find(q.thing);
    if (q.thing !== null && !thing)
      return ask(`I keep stats for ${names}. Which one did you mean?`);
    if (thing && !thing.expires)
      return ask(
        `I don’t know when ${thing.label.toLowerCase()} goes off. Set its use-by on its card.`,
      );
    if (!things.some((t) => t.expires))
      return ask('No food here has a use-by day yet. Set one on a food thing’s card.');
    return { ...q, thing: thing?.id ?? null, stat: null, while: null, whileOn: null, amount: null };
  }
  if (q.thing !== null) {
    const thing = find(q.thing);
    if (!thing) return ask(`I keep stats for ${names}. Which one did you mean?`);
    q.thing = thing.id;
    if (!thing.stats.length)
      return thing.expires
        ? { ...q, measure: 'useBy', stat: null, while: null, whileOn: null, amount: null }
        : ask(`${thing.label} keeps no stats yet. Switch one on in its card.`);
    if (!q.stat || !thing.stats.includes(q.stat)) q.stat = thing.stats[0] ?? null;
  } else if (q.stat !== null && !things.some((t) => t.stats.includes(q.stat!)))
    return ask(
      `Nothing here keeps ${STAT_KINDS[q.stat].label.toLowerCase()}. I keep stats for ${names}.`,
    );
  if (q.thing === null && q.stat === null && q.measure !== 'summary') q.measure = 'summary';
  // A use is a moment: it has no length of its own.
  if (q.stat === 'lastUsed' && q.measure === 'duration') q.measure = 'count';
  if (q.stat === 'lastUsed' && q.measure === 'longest') q.measure = 'longestGap';
  if (q.while !== null) {
    const other = find(q.while);
    const key = other?.stats.find((k) => k !== 'lastUsed');
    if (!other || !key || other.id === q.thing)
      return ask(
        `I can count or add up time only while something that is on or off was so: ${things
          .filter((t) => t.stats.some((k) => k !== 'lastUsed'))
          .map((t) => t.label.toLowerCase())
          .join(', ')}.`,
      );
    q.while = other.id;
    q.whileOn ??= true;
  } else q.whileOn = null;
  if (q.window === 'minutes')
    q.amount = Math.round(Math.min(Math.max(q.amount ?? 60, 1), 30 * 24 * 60));
  else if (q.window === 'days') q.amount = Math.round(Math.min(Math.max(q.amount ?? 7, 1), 90));
  else q.amount = null;
  return q;
}

/** The span a query's window covers, and its words. */
function windowOf(q: AskQuery, now: number): { from: number; to: number; words: string } {
  const midnight = midnightOf(now);
  if (q.window === 'minutes') {
    const m = q.amount ?? 60;
    const words =
      m === 60
        ? 'in the last hour'
        : m % 60 === 0
          ? `in the last ${m / 60} hours`
          : `in the last ${m} min`;
    return { from: now - m * MINUTE, to: now, words };
  }
  if (q.window === 'yesterday')
    return { from: shiftDays(midnight, -1), to: midnight, words: 'yesterday' };
  if (q.window === 'days') {
    const n = q.amount ?? 7;
    return {
      from: shiftDays(midnight, -(n - 1)),
      to: now,
      words: n === 1 ? 'today' : `in the last ${n} days`,
    };
  }
  return { from: midnight, to: now, words: 'today' };
}
/** The same clock time `n` days on, through a date so a clock change doesn't shift it. */
function shiftDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** One thing's one stat over time. */
interface Track {
  thing: AskThing;
  key: StatKey;
  events: StatEvent[];
}
/** A stretch it was on (or busy, at `level`), clipped to the span asked about. */
interface Stretch {
  from: number;
  to: number;
  /** Seconds-weighted level: 1 for on, the busy share for activity. */
  weight: number;
  /** It began inside the span, rather than running into it. */
  began: boolean;
}

const isOn = (key: StatKey, v: StatEvent['value']) =>
  key === 'activity' ? typeof v === 'number' && v > 0 : v === true;
const weightOf = (key: StatKey, v: StatEvent['value']) =>
  key === 'activity' ? (typeof v === 'number' ? v : 0) : v === true ? 1 : 0;

/** The stretches a track was on between `from` and `to`, adjacent busy levels merged. */
function stretches(t: Track, from: number, to: number): Stretch[] {
  const out: Stretch[] = [];
  let value: StatEvent['value'] = null;
  const later: StatEvent[] = [];
  for (const e of t.events) {
    if (e.at <= from) value = e.value;
    else if (e.at <= to) later.push(e);
    else break;
  }
  let open = isOn(t.key, value) ? { from, began: false, weighted: 0 } : null;
  let since = from;
  const add = (at: number) => {
    if (open) open.weighted += weightOf(t.key, value) * (at - since);
    since = at;
  };
  const close = (o: NonNullable<typeof open>, at: number) =>
    out.push({
      from: o.from,
      to: at,
      weight: o.weighted / Math.max(at - o.from, 1),
      began: o.began,
    });
  for (const e of later) {
    add(e.at);
    const on = isOn(t.key, e.value);
    if (open && !on) (close(open, e.at), (open = null));
    else if (!open && on) open = { from: e.at, began: true, weighted: 0 };
    value = e.value;
  }
  add(to);
  if (open) close(open, to);
  return out.filter((s) => s.to > s.from);
}
/** The moments a track switched on (or got busy), or each use of a Last used track. */
const risings = (t: Track) =>
  t.events.filter((e, i) =>
    t.key === 'lastUsed'
      ? e.value !== null
      : isOn(t.key, e.value) && !isOn(t.key, t.events[i - 1]?.value ?? null),
  );
/** The uses of a Last used track between `from` and `to`. */
const usesOf = (t: Track, from: number, to: number) =>
  t.events.filter((e) => e.at > from && e.at <= to && e.value !== null);
/** The time a track was on in a span, weighted by its level, ms. */
const onMs = (t: Track, from: number, to: number) =>
  stretches(t, from, to).reduce((sum, s) => sum + (s.to - s.from) * s.weight, 0);
/** The count of a track in a span: uses, or stretches that began in it. */
const countOf = (t: Track, from: number, to: number) =>
  t.key === 'lastUsed'
    ? usesOf(t, from, to).length
    : stretches(t, from, to).filter((s) => s.began).length;

/** What kind of thing it is, for the words. */
type Voice = 'drink' | 'food' | 'screen' | 'cat' | 'pointer' | 'zone' | 'other';
function voiceOf(thing: AskThing, key: StatKey): Voice {
  const l = thing.label.toLowerCase();
  if (thing.zone) return 'zone';
  if (key === 'lastUsed' && /\b(mug|cup|glass|bottle|tumbler|flask)\b/.test(l)) return 'drink';
  if (
    key === 'lastUsed' &&
    (thing.food ||
      thing.expires ||
      /\b(milk|egg|chicken|spinach|cheese|butter|juice|leftover|yog|pickle|jam|sauce|bread|fruit|soup|ham)/.test(
        l,
      ))
  )
    return 'food';
  if (key === 'power' && /\b(monitor|screen|display|tv|television)\b/.test(l)) return 'screen';
  if (key === 'occupied' && /\bcat\b/.test(l)) return 'cat';
  if (key === 'activity') return 'pointer';
  return 'other';
}
/** The kind a thing's dot shows: its voice, with lights told apart. */
export function thingKind(thing: AskThing, key: StatKey | undefined): AskKind {
  if (thing.food || thing.expires) return 'food';
  if (!key) return 'other';
  const voice = voiceOf(thing, key);
  if (voice !== 'other') return voice;
  return /\b(lamp|light|bulb|led|strip)\b/i.test(thing.label) ? 'light' : 'other';
}
/** "your desk mug", "the monitor". */
function nameOf(thing: AskThing): string {
  const l = thing.label.trim();
  return /^my\s/i.test(l) ? `your ${l.slice(3)}` : `the ${l.charAt(0).toLowerCase()}${l.slice(1)}`;
}
/** What one event says, as a cite. */
function eventText(t: Track, e: StatEvent): string {
  const voice = voiceOf(t.thing, t.key);
  const on = isOn(t.key, e.value);
  if (t.key === 'lastUsed')
    return voice === 'drink'
      ? `Drink from ${nameOf(t.thing)}`
      : voice === 'food'
        ? `${t.thing.label} taken out`
        : `${cap(nameOf(t.thing))} used`;
  if (voice === 'cat') return on ? 'The cat climbed its tree' : 'The cat left its tree';
  if (voice === 'zone')
    return on ? `Something came into ${nameOf(t.thing)}` : `${cap(nameOf(t.thing))} emptied`;
  if (t.key === 'activity') return on ? `${t.thing.label} busy` : `${t.thing.label} idle`;
  const words = STAT_KINDS[t.key].words;
  return `${t.thing.label} ${on ? (words?.on ?? 'on') : (words?.off ?? 'off')}`.replace(
    / (On|Off|Occupied|Empty)$/,
    (_, w: string) => ` ${w.toLowerCase()}`,
  );
}
const cite = (t: Track, e: StatEvent): AskCite => ({
  at: e.at,
  thingId: t.thing.id,
  kind: thingKind(t.thing, t.key),
  text: eventText(t, e),
});

/** "4 drinks from your desk mug today", as a sentence. */
function countSentence(t: Track, n: number, win: string): string {
  const name = nameOf(t.thing);
  switch (voiceOf(t.thing, t.key)) {
    case 'drink':
      return n
        ? `You had ${n} drink${n === 1 ? '' : 's'} from ${name} ${win}.`
        : `No drinks from ${name} ${win}.`;
    case 'food':
      return n
        ? `${cap(name)} was taken out ${times(n)} ${win}.`
        : `${cap(name)} stayed in ${win}.`;
    case 'cat':
      return n
        ? `The cat went up its tree ${times(n)} ${win}.`
        : `The cat didn’t climb its tree ${win}.`;
    case 'pointer':
      return `${cap(name)} had ${n} busy stretch${n === 1 ? '' : 'es'} ${win}.`;
    case 'zone':
      return n
        ? `Something came into ${name} ${times(n)} ${win}.`
        : `Nothing came into ${name} ${win}.`;
    default:
      return t.key === 'lastUsed'
        ? `${cap(name)} was used ${times(n)} ${win}.`
        : n
          ? `${cap(name)} came on ${times(n)} ${win}.`
          : `${cap(name)} didn’t come on ${win}.`;
  }
}
/** "Your screen was on for 5 h 10 min today", as a sentence. */
function durationSentence(t: Track, ms: number, win: string): string {
  const name = nameOf(t.thing);
  if (ms < MINUTE && voiceOf(t.thing, t.key) === 'zone') return `${cap(name)} stayed empty ${win}.`;
  if (ms < MINUTE)
    return voiceOf(t.thing, t.key) === 'cat'
      ? `The cat wasn’t on its tree ${win}.`
      : `${cap(name)} wasn’t ${t.key === 'activity' ? 'in use' : t.key === 'occupied' ? 'occupied' : 'on'} ${win}.`;
  switch (voiceOf(t.thing, t.key)) {
    case 'screen':
      return `Your screen was on for ${spanOf(ms)} ${win}.`;
    case 'cat':
      return `The cat spent ${spanOf(ms)} on its tree ${win}.`;
    case 'pointer':
      return `${cap(name)} was in use for ${spanOf(ms)} ${win}.`;
    case 'zone':
      return `Something was in ${name} for ${spanOf(ms)} ${win}.`;
    default:
      return `${cap(name)} was ${t.key === 'occupied' ? 'occupied' : 'on'} for ${spanOf(ms)} ${win}.`;
  }
}
const ago = (at: number, now: number) =>
  now - at < MINUTE ? 'just now' : `${spanOf(now - at)} ago`;

/** The bars of a count or a time: per hour for up to a day, per day beyond. */
function barsOf(t: Track, from: number, to: number, unit: 'times' | 'minutes'): RoomAnswer['bars'] {
  if (to - from < 2 * HOUR) return null;
  const perDay = to - from > 26 * HOUR;
  const values: { label: string; from: number; value: number }[] = [];
  let start = perDay ? midnightOf(from) : from - (from % HOUR);
  while (start < to) {
    const end = perDay ? shiftDays(start, 1) : start + HOUR;
    const a = Math.max(start, from);
    const b = Math.min(end, to);
    const value = unit === 'times' ? countOf(t, a, b) : Math.round(onMs(t, a, b) / MINUTE);
    const d = new Date(start);
    values.push({
      label: perDay ? d.toLocaleDateString('en-GB', { weekday: 'short' }) : String(d.getHours()),
      from: start,
      value,
    });
    start = end;
  }
  // The chart starts at its first busy hour or day: not the night, nor before the history began.
  const first = values.findIndex((v) => v.value > 0);
  if (first > 0) values.splice(0, first);
  return values.some((v) => v.value > 0) ? { unit, values } : null;
}

/** The camera stats' note on how much of the window it watched. */
function watchedNote(
  history: AskHistory,
  tracks: Track[],
  from: number,
  to: number,
): string | null {
  if (!history.watched || to <= from) return null;
  // A power stat read from Home Assistant needs no camera.
  const camera = tracks.some(
    (t) => t.key !== 'power' || !t.events.some((e) => e.source === 'entity'),
  );
  if (!camera) return null;
  let ms = 0;
  for (const w of history.watched) ms += Math.max(0, Math.min(w.to, to) - Math.max(w.from, from));
  if (ms >= 0.95 * (to - from)) return null;
  return ms < MINUTE
    ? 'The camera wasn’t watching then, so this may miss what happened.'
    : `The camera watched for ${spanOf(ms)} of those ${spanOf(to - from)}.`;
}

/** One track's answer to a measure over a span. */
function answerTrack(
  t: Track,
  q: AskQuery,
  span: { from: number; to: number; words: string },
  now: number,
): Pick<RoomAnswer, 'text' | 'cites' | 'bars'> & { value: number | null } {
  const { from, to, words: win } = span;
  const name = nameOf(t.thing);
  const voice = voiceOf(t.thing, t.key);
  const lastN = (es: StatEvent[]) => es.slice(-4).map((e) => cite(t, e));
  const inSpan = t.events.filter((e) => e.at > from && e.at <= to);
  switch (q.measure) {
    case 'count': {
      const n = countOf(t, from, to);
      const shown =
        t.key === 'lastUsed' ? usesOf(t, from, to) : inSpan.filter((e) => isOn(t.key, e.value));
      return {
        text: countSentence(t, n, win),
        value: n,
        cites: lastN(shown),
        bars: barsOf(t, from, to, 'times'),
      };
    }
    case 'duration': {
      const ms = onMs(t, from, to);
      return {
        text: durationSentence(t, ms, win),
        value: Math.round(ms / MINUTE),
        cites: lastN(inSpan),
        bars: barsOf(t, from, to, 'minutes'),
      };
    }
    case 'last':
    case 'first': {
      const ons = risings(t).filter((e) =>
        q.measure === 'last' ? e.at <= to : e.at > from && e.at <= to,
      );
      const e = q.measure === 'last' ? ons.at(-1) : ons[0];
      const which = q.measure === 'last' ? 'last' : 'first';
      const Name = cap(name);
      // "Your last drink was", "The milk was first taken out", "The monitor last came on".
      const lead =
        voice === 'drink'
          ? `Your ${which} drink from ${name} was`
          : voice === 'food'
            ? `${Name} was ${which} taken out`
            : voice === 'cat'
              ? `The cat ${which} climbed its tree`
              : voice === 'zone'
                ? `Something ${which} came into ${name}`
                : t.key === 'lastUsed'
                  ? `${Name} was ${which} used`
                  : `${Name} ${which} ${t.key === 'activity' ? 'got busy' : 'came on'}`;
      const inWin = q.measure === 'first' ? ` ${win}` : '';
      if (!e)
        return {
          text: `I haven’t seen that ${q.measure === 'last' ? 'yet' : win}.`,
          value: null,
          cites: [],
          bars: null,
        };
      const state =
        t.key !== 'lastUsed' && q.measure === 'last' && isOn(t.key, valueAt(t, to))
          ? ' It’s still on.'
          : '';
      const when = midnightOf(e.at) === midnightOf(now) ? '' : ` ${dayName(e.at, now)}`;
      return {
        text: `${lead}${inWin} at ${clockOf(e.at)}${when}, ${ago(e.at, now)}.${state}`,
        value: e.at,
        cites: [cite(t, e)],
        bars: null,
      };
    }
    case 'longestGap': {
      // Between one use (or stretch) and the next, and from the last to now.
      const marks: { end: number; next: number; a?: StatEvent; b?: StatEvent }[] = [];
      if (t.key === 'lastUsed') {
        const uses = usesOf(t, from, to);
        for (let i = 1; i < uses.length; i++)
          marks.push({ end: uses[i - 1]!.at, next: uses[i]!.at, a: uses[i - 1], b: uses[i] });
        if (uses.length && to >= now - MINUTE)
          marks.push({ end: uses.at(-1)!.at, next: to, a: uses.at(-1) });
      } else {
        const s = stretches(t, from, to);
        for (let i = 1; i < s.length; i++) marks.push({ end: s[i - 1]!.to, next: s[i]!.from });
        if (s.length && s.at(-1)!.to < to && to >= now - MINUTE)
          marks.push({ end: s.at(-1)!.to, next: to });
      }
      const best = marks.sort((a, b) => b.next - b.end - (a.next - a.end))[0];
      if (!best)
        return {
          text: `There isn’t a gap to measure ${win} yet.`,
          value: null,
          cites: [],
          bars: null,
        };
      const until = best.next >= now - MINUTE ? 'now' : clockOf(best.next);
      const what =
        voice === 'drink'
          ? 'without a drink'
          : voice === 'cat'
            ? 'with the cat off its tree'
            : voice === 'zone'
              ? `with ${name} empty`
              : t.key === 'lastUsed'
                ? `without using ${name}`
                : `with ${name} ${t.key === 'activity' ? 'idle' : 'off'}`;
      const near = (at: number) => t.events.filter((e) => Math.abs(e.at - at) < 1000);
      return {
        text: `Your longest stretch ${what} ${win} was ${spanOf(best.next - best.end)}, from ${clockOf(best.end)} to ${until}.`,
        value: Math.round((best.next - best.end) / MINUTE),
        cites: [...near(best.end), ...near(best.next)].slice(0, 4).map((e) => cite(t, e)),
        bars: null,
      };
    }
    case 'longest': {
      const best = stretches(t, from, to).sort((a, b) => b.to - b.from - (a.to - a.from))[0];
      if (!best)
        return {
          text: durationSentence(t, 0, win),
          value: 0,
          cites: [],
          bars: null,
        };
      const what =
        voice === 'cat'
          ? 'The cat’s longest nap on its tree'
          : voice === 'pointer'
            ? 'Your longest focus stretch'
            : voice === 'zone'
              ? `The longest anything stayed in ${name}`
              : `The longest ${name} stayed ${t.key === 'occupied' ? 'occupied' : 'on'}`;
      const until = best.to >= now - MINUTE ? 'now' : clockOf(best.to);
      const near = t.events.filter((e) => e.at === best.from || e.at === best.to);
      return {
        text: `${what} ${win} was ${spanOf(best.to - best.from)}, from ${clockOf(best.from)} to ${until}.`,
        value: Math.round((best.to - best.from) / MINUTE),
        cites: near.slice(0, 4).map((e) => cite(t, e)),
        bars: null,
      };
    }
    case 'useBy':
      // Answered from the things' use-by days, before any track (`foodAnswer`).
      return { text: '', value: null, cites: [], bars: null };
    case 'now':
    case 'summary': {
      if (t.key === 'lastUsed') return answerTrack(t, { ...q, measure: 'last' }, span, now);
      const last = [...t.events].reverse().find((e) => e.at <= to);
      const on = isOn(t.key, last?.value ?? null);
      const subject = voice === 'cat' ? 'The cat' : cap(name);
      const state =
        voice === 'cat'
          ? on
            ? 'is on its tree'
            : 'isn’t on its tree'
          : voice === 'zone'
            ? on
              ? 'has something in it'
              : 'is empty'
            : t.key === 'activity'
              ? on
                ? 'is in use'
                : 'is idle'
              : on
                ? 'is on'
                : 'is off';
      return {
        text: last
          ? `${subject} ${state}, since ${clockOf(last.at)}.`
          : `I haven’t seen ${name} yet.`,
        value: on ? 1 : 0,
        cites: last ? [cite(t, last)] : [],
        bars: null,
      };
    }
  }
}
function valueAt(t: Track, at: number): StatEvent['value'] {
  let v: StatEvent['value'] = null;
  for (const e of t.events) {
    if (e.at > at) break;
    v = e.value;
  }
  return v;
}
function dayName(at: number, now: number): string {
  const days = Math.round((midnightOf(now) - midnightOf(at)) / DAY);
  return days === 1
    ? 'yesterday'
    : `on ${new Date(at).toLocaleDateString('en-GB', { weekday: 'long' })}`;
}

/** The words for a compared value. */
function comparedWords(t: Track, q: AskQuery, value: number): string {
  if (q.measure === 'count')
    return voiceOf(t.thing, t.key) === 'drink'
      ? `${Math.round(value * 10) / 10} drink${value === 1 ? '' : 's'}`
      : times(Math.round(value * 10) / 10);
  return spanOf(value * MINUTE);
}
/** One clause comparing now with before: "2 more than yesterday by this time (4)". */
function compareClause(now: number, before: number, label: string, words: string): string {
  const trend = trendOf(now, before);
  if (trend === 'same') return `About the same as ${label} (${words}).`;
  return `That’s ${trend} than ${label} (${words}).`;
}
function trendOf(now: number, before: number): 'more' | 'less' | 'same' {
  const d = Math.round((now - before) * 10) / 10;
  return Math.abs(d) < 0.5 ? 'same' : d > 0 ? 'more' : 'less';
}
/** A count, as the figure shows it: "3 drinks", "1 visit", "4 times". */
function countFigure(t: Track, n: number): string {
  const voice = voiceOf(t.thing, t.key);
  const [one, many] =
    voice === 'drink'
      ? ['drink', 'drinks']
      : voice === 'cat'
        ? ['visit', 'visits']
        : voice === 'pointer'
          ? ['stretch', 'stretches']
          : ['time', 'times'];
  return `${n} ${n === 1 ? one : many}`;
}
/** The figure of one track's answer, from its value. */
function figureOf(t: Track, q: AskQuery, value: number | null): string | null {
  if (value === null) return null;
  switch (q.measure) {
    case 'count':
      return countFigure(t, value);
    case 'duration':
    case 'longest':
    case 'longestGap':
      return spanOf(value * MINUTE);
    case 'last':
    case 'first':
      return clockOf(value);
    default:
      return null;
  }
}

/**
 * Answer a read query from the history, as of `now`: the number worked out
 * from the events, in words, with the events it rests on, bars to draw, and
 * the window it was compared with.
 */
export function answerAsk(q: AskQuery, history: AskHistory, now: number): RoomAnswer {
  const empty = { notes: [], cites: [], bars: null, compared: null, figure: null, foods: null };
  if (q.clarify) return { ...empty, text: q.clarify, query: null, clarify: q.clarify };
  if (q.measure === 'useBy')
    return { ...empty, ...foodAnswer(q, history, now), query: q, clarify: null };
  const span = windowOf(q, now);
  const trackOf = (thing: AskThing, key: StatKey): Track => ({
    thing,
    key,
    events: history.events.filter((e) => e.thingId === thing.id && e.key === key),
  });
  const tracks: Track[] =
    q.thing !== null
      ? [
          trackOf(
            history.things.find((t) => t.id === q.thing)!,
            q.stat!,
          ),
        ]
      : history.things.flatMap((thing) =>
          thing.stats.filter((k) => q.stat === null || k === q.stat).map((k) => trackOf(thing, k)),
        );
  const notes: string[] = [];
  const watched = watchedNote(history, tracks, span.from, span.to);
  if (q.measure === 'summary') {
    const lines = tracks.flatMap((t) => {
      const voice = voiceOf(t.thing, t.key);
      if (t.key === 'lastUsed') {
        const n = countOf(t, span.from, span.to);
        if (!n && voice === 'food') return [];
        return [countSentence(t, n, '').replace(/ \.$/, '.')];
      }
      const ms = onMs(t, span.from, span.to);
      return ms >= MINUTE ? [durationSentence(t, ms, '').replace(/ \.$/, '.')] : [];
    });
    const cites = tracks
      .flatMap((t) =>
        t.events
          .filter(
            (e) =>
              e.at > span.from && e.at <= span.to && (t.key === 'lastUsed' || isOn(t.key, e.value)),
          )
          .map((e) => cite(t, e)),
      )
      .sort((a, b) => a.at - b.at)
      .slice(-4);
    if (watched) notes.push(watched);
    return {
      ...empty,
      text: lines.length
        ? `${cap(span.words)}: ${lines.map((l) => l.charAt(0).toLowerCase() + l.slice(1).replace(/\.$/, '')).join('; ')}.`
        : `Nothing has happened ${span.words} yet.`,
      notes,
      cites,
      query: q,
      clarify: null,
    };
  }
  if (tracks.some((t) => voiceOf(t.thing, t.key) === 'drink') && q.measure !== 'now')
    notes.push('A drink is the mug picked up and put back: the camera can’t see a sip.');
  if (q.while !== null && tracks.length === 1) {
    if (q.measure === 'count' || q.measure === 'duration') {
      const other = history.things.find((t) => t.id === q.while)!;
      const w = trackOf(
        other,
        other.stats.find((k) => k !== 'lastUsed')!,
      );
      return {
        ...empty,
        ...whileAnswer(tracks[0]!, w, q, span),
        notes: watched ? [...notes, watched] : notes,
        query: q,
        clarify: null,
      };
    }
    notes.push('Only a count or a time can be limited to while another thing was on or off.');
  }
  const t0 = tracks[0];
  if (
    t0 &&
    tracks.length === 1 &&
    history.totals &&
    q.window === 'days' &&
    (q.amount ?? 7) > 30 &&
    (q.measure === 'duration' || STAT_KINDS[t0.key].daily === 'count') &&
    (q.measure === 'count' || q.measure === 'duration')
  ) {
    const totals = totalsAnswer(t0, q, span, history.totals);
    return { ...empty, ...totals, notes: [...notes, ...totals.notes], query: q, clarify: null };
  }
  const answers = tracks.map((t) => ({ t, ...answerTrack(t, q, span, now) }));
  const first = answers[0]!;
  if (watched && q.measure !== 'last' && q.measure !== 'now') notes.push(watched);
  let compared: RoomAnswer['compared'] = null;
  let text = answers.map((a) => a.text).join(' ');
  if (
    answers.length === 1 &&
    q.compare !== 'none' &&
    first.value !== null &&
    ['count', 'duration', 'longest', 'longestGap'].includes(q.measure)
  ) {
    const len = span.to - span.from;
    const shifted = (back: number) =>
      q.window === 'minutes'
        ? { from: span.from - back * len, to: span.to - back * len }
        : {
            from: shiftDays(span.from, q.window === 'days' ? -back * (q.amount ?? 7) : -back),
            to: shiftDays(span.to, q.window === 'days' ? -back * (q.amount ?? 7) : -back),
          };
    const valueIn = (s: { from: number; to: number }) =>
      answerTrack(first.t, { ...q, compare: 'none' }, { ...s, words: '' }, s.to).value ?? 0;
    let before: number;
    let label: string;
    if (q.compare === 'average' && q.window !== 'days') {
      // The same span on each of the week's days before, from when it was first seen.
      const start = first.t.events[0]?.at ?? Infinity;
      const spans = [1, 2, 3, 4, 5, 6, 7]
        .map((k) => ({
          from: shiftDays(span.from, -k),
          to: shiftDays(span.to, -k),
        }))
        .filter((s) => s.to > start);
      before = spans.length ? spans.reduce((sum, s) => sum + valueIn(s), 0) / spans.length : 0;
      label =
        q.window === 'minutes'
          ? 'the same time on an average day this past week'
          : 'an average day this past week';
      if (q.window === 'today') label = 'an average day this past week by this time';
    } else {
      before = valueIn(shifted(1));
      label =
        q.window === 'minutes'
          ? `the ${span.words.replace(/^in the last /, '')} before`
          : q.window === 'today'
            ? 'yesterday by this time'
            : q.window === 'yesterday'
              ? 'the day before'
              : `the ${q.amount} days before`;
    }
    const words = comparedWords(first.t, q, before);
    compared = {
      label,
      value: Math.round(before * 10) / 10,
      words,
      trend: trendOf(first.value, before),
    };
    text += ` ${compareClause(first.value, before, label, words)}`;
  }
  return {
    text,
    notes,
    cites: answers.flatMap((a) => a.cites).slice(-6),
    bars: answers.length === 1 ? first.bars : null,
    figure: answers.length === 1 ? figureOf(first.t, q, first.value) : null,
    compared,
    foods: null,
    query: q,
    clarify: null,
  };
}

/** "your screen was off", "the cat was on its tree": another thing's state, for `while`. */
function stateWords(t: Track, on: boolean): string {
  const name = nameOf(t.thing);
  switch (voiceOf(t.thing, t.key)) {
    case 'cat':
      return on ? 'the cat was on its tree' : 'the cat was off its tree';
    case 'zone':
      return on ? `something was in ${name}` : `${name} was empty`;
    case 'screen':
      return `your screen was ${on ? 'on' : 'off'}`;
    case 'pointer':
      return `${name} was ${on ? 'in use' : 'idle'}`;
    default:
      return `${name} was ${t.key === 'occupied' ? (on ? 'occupied' : 'empty') : on ? 'on' : 'off'}`;
  }
}
/** The spans in `from`–`to` a track was on, or off when `on` is false. */
function spansOf(t: Track, from: number, to: number, on: boolean): { from: number; to: number }[] {
  const s = stretches(t, from, to);
  if (on) return s;
  const out: { from: number; to: number }[] = [];
  let at = from;
  for (const x of s) {
    if (x.from > at) out.push({ from: at, to: x.from });
    at = x.to;
  }
  if (at < to) out.push({ from: at, to });
  return out;
}
/** A count or a time only while another thing was on (or off): "the lamp while I was away". */
function whileAnswer(
  t: Track,
  w: Track,
  q: AskQuery,
  span: { from: number; to: number; words: string },
): Pick<RoomAnswer, 'text' | 'cites' | 'figure'> {
  const on = q.whileOn !== false;
  const spans = spansOf(w, span.from, span.to, on);
  const win = `${span.words} while ${stateWords(w, on)}`;
  const inside = (at: number) => spans.some((s) => at > s.from && at <= s.to);
  if (q.measure === 'count') {
    const n = spans.reduce((sum, s) => sum + countOf(t, s.from, s.to), 0);
    const shown = risings(t).filter((e) => inside(e.at));
    return {
      text: countSentence(t, n, win),
      figure: countFigure(t, n),
      cites: shown.slice(-4).map((e) => cite(t, e)),
    };
  }
  const ms = spans.reduce((sum, s) => sum + onMs(t, s.from, s.to), 0);
  // What it rests on: when each overlap began and ended, from either thing.
  const overlap = spans.flatMap((s) => stretches(t, s.from, s.to));
  const edges = [...t.events, ...w.events]
    .filter((e) =>
      overlap.some((o) => Math.abs(e.at - o.from) < 1000 || Math.abs(e.at - o.to) < 1000),
    )
    .sort((a, b) => a.at - b.at);
  const tracks = [t, w];
  return {
    text: durationSentence(t, ms, win),
    figure: spanOf(ms),
    cites: edges.slice(-4).map((e) =>
      cite(
        tracks.find((x) => x.thing.id === e.thingId && x.key === e.key)!,
        e,
      ),
    ),
  };
}
/** A count or a time past the events' 30 days, from the day totals, drawn a bar a week. */
function totalsAnswer(
  t: Track,
  q: AskQuery,
  span: { from: number; to: number; words: string },
  totals: NonNullable<AskHistory['totals']>,
): Pick<RoomAnswer, 'text' | 'bars' | 'notes' | 'figure'> {
  const first = dayOf(span.from);
  const rows = totals.filter((r) => r.thingId === t.thing.id && r.key === t.key && r.day >= first);
  // A count is a count; seconds on or active are minutes.
  const daily = STAT_KINDS[t.key].daily;
  const valueOf = (total: number) => (daily === 'count' ? total : total / 60);
  const sum = rows.reduce((s, r) => s + valueOf(r.total), 0);
  const weeks = new Map<number, number>();
  for (const r of rows) {
    const d = new Date(`${r.day}T12:00:00`);
    const monday = midnightOf(shiftDays(d.getTime(), -((d.getDay() + 6) % 7)));
    weeks.set(monday, (weeks.get(monday) ?? 0) + valueOf(r.total));
  }
  const values = [...weeks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([from, v]) => ({
      label: new Date(from).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
      from,
      value: Math.round(v),
    }));
  return {
    text:
      q.measure === 'count' || daily === 'count'
        ? countSentence(t, Math.round(sum), span.words)
        : durationSentence(t, sum * MINUTE, span.words),
    figure:
      q.measure === 'count' || daily === 'count'
        ? countFigure(t, Math.round(sum))
        : spanOf(sum * MINUTE),
    bars: values.length > 1 ? { unit: daily === 'count' ? 'times' : 'minutes', values } : null,
    notes: ['Added up from the day totals, which are kept for good; a bar is a week.'],
  };
}
/** When food goes off, soonest first, from the use-by days on its cards. */
function foodAnswer(
  q: AskQuery,
  history: AskHistory,
  now: number,
): Pick<RoomAnswer, 'text' | 'cites' | 'notes' | 'foods'> {
  const today = dayOf(now);
  const foods = history.things
    .filter((t) => t.expires && (q.thing === null || t.id === q.thing))
    .map((t) => ({ t, n: daysUntil(t.expires!, today) }))
    .sort((a, b) => a.n - b.n);
  const when = (n: number) =>
    n < -1
      ? `went off ${-n} days ago`
      : n === -1
        ? 'went off yesterday'
        : n === 0
          ? 'goes off today'
          : n === 1
            ? 'goes off tomorrow'
            : `keeps ${n} more days`;
  // When each was last taken out, from its Last used.
  const taken = foods.flatMap(({ t }) =>
    history.events
      .filter((e) => e.thingId === t.id && e.key === 'lastUsed' && e.at <= now)
      .slice(-1)
      .map((e): AskCite => ({
        at: e.at,
        thingId: t.id,
        kind: 'food',
        text: `${t.label} taken out`,
      })),
  );
  const all = foods.map(({ t, n }) => ({ thingId: t.id, label: t.label, days: n }));
  if (q.thing !== null) {
    const { t, n } = foods[0]!;
    return { text: `${cap(nameOf(t))} ${when(n)}.`, cites: taken, notes: [], foods: all };
  }
  const gone = foods.filter((f) => f.n < 0);
  const good = foods.filter((f) => f.n >= 0);
  const short = (t: AskThing) => nameOf(t).replace(/^the /, '');
  const parts = [
    ...gone.map(({ t, n }) => `${cap(nameOf(t))} ${when(n)}: check it before eating it.`),
    good[0] ? `Eat ${nameOf(good[0].t)} first: it ${when(good[0].n)}.` : '',
    good.length > 1
      ? `Then ${good
          .slice(1)
          .map(({ t, n }) => `${short(t)} (${n === 1 ? 'tomorrow' : `in ${n} days`})`)
          .join(', ')}.`
      : '',
  ];
  return {
    text: parts.filter(Boolean).join(' '),
    cites: taken.sort((a, b) => a.at - b.at).slice(-4),
    notes: ['Use-by days come from each food’s card, not the camera.'],
    foods: all,
  };
}

/**
 * The things a room can be asked about: each fixture with a stat switched on
 * or a use-by day, and each zone, whose fillings are its occupied stat.
 */
export function askThingsOf(memory: DeskMemory): AskThing[] {
  const things: AskThing[] = (memory.fixtures ?? []).flatMap((f) => {
    const stats = (memory.thingStats?.[f.id] ?? []).map((s) => s.key);
    const expires = f.food?.expires;
    return stats.length || expires
      ? [
          {
            id: f.id,
            label: f.label,
            stats,
            ...(f.food ? { food: true as const } : {}),
            ...(expires ? { expires } : {}),
          },
        ]
      : [];
  });
  for (const r of memory.rules ?? [])
    things.push({ id: zoneThingId(r.id), label: r.label, stats: ['occupied'], zone: true });
  return things;
}

/** An example question for the ask panel: the chip's short name, the question, the thing it's about. */
export interface AskExample {
  label: string;
  question: string;
  thing: string;
  kind: AskKind;
}

/**
 * Example questions about a room's own things, one per kind of thing (its
 * first stat), up to `max` in all, then what to eat first when any food has a use-by day, and
 * the day so far. Worded as a person would ask, so Spark reads them easily.
 */
export function askExamples(things: readonly AskThing[], max = 6): AskExample[] {
  // "my desk mug", "the desk lamp": the person's own words for a thing.
  const mine = (t: AskThing) => nameOf(t).replace(/^your /, 'my ');
  const Label = (t: AskThing) => cap(t.label.replace(/^my\s+/i, ''));
  const out: AskExample[] = [];
  const kinds = new Set<AskKind>();
  for (const t of things) {
    const key = t.stats[0];
    // One of each kind, so three foods don't crowd out the lamp.
    if (!key || kinds.has(thingKind(t, key))) continue;
    kinds.add(thingKind(t, key));
    const ex = (label: string, question: string) =>
      out.push({ label, question, thing: t.id, kind: thingKind(t, key) });
    switch (voiceOf(t, key)) {
      case 'drink':
        ex('Drinks today', `How many times did I drink from ${mine(t)} today?`);
        break;
      case 'food':
        ex(`${Label(t)} last out`, `When was ${mine(t)} last taken out?`);
        break;
      case 'screen':
        ex('Screen time', `How long was ${mine(t)} on today?`);
        break;
      case 'cat':
        ex('Cat on its tree', `How long was the cat on ${mine(t)} today?`);
        break;
      case 'pointer':
        ex(`${Label(t)} in use`, `How long was ${mine(t)} in use today?`);
        break;
      case 'zone':
        ex(`In ${t.label.toLowerCase()}`, `How long was something in ${mine(t)} today?`);
        break;
      default:
        if (key === 'lastUsed') ex(`${Label(t)} last used`, `When did I last use ${mine(t)}?`);
        else if (key === 'occupied')
          ex(`${Label(t)} occupied`, `How long was ${mine(t)} occupied today?`);
        else ex(`${Label(t)} on today`, `How long was ${mine(t)} on today?`);
    }
  }
  const food = things.find((t) => t.expires);
  const extra: AskExample[] = [
    ...(food
      ? [
          {
            label: 'Eat first',
            question: 'What should I eat first?',
            thing: food.id,
            kind: 'food' as const,
          },
        ]
      : []),
    ...(things.length
      ? [
          {
            label: 'Today so far',
            question: 'What happened today?',
            thing: 'summary',
            kind: 'summary' as const,
          },
        ]
      : []),
  ];
  return [...out.slice(0, max - extra.length), ...extra];
}

/** How far back a query reads events, ms: what `answerAsk` needs and no more. */
export function askSince(q: AskQuery, now: number): number {
  if (q.measure === 'last' || q.measure === 'now' || q.measure === 'useBy') return 0;
  const { from } = windowOf(q, now);
  const back = q.compare === 'none' ? 0 : q.window === 'days' ? (q.amount ?? 7) : 7;
  // A day more, for a clock change and for what each stat was as the span began.
  return from - (back + 1) * DAY;
}

/** Words that name each kind of thing in a question, for the demo's reader. */
const THING_WORDS: [RegExp, RegExp][] = [
  [
    /\b(mug|cup|glass|bottle)\b/i,
    /\b(drinks?|drank|drinking|sips?|coffee|tea|water|thirst|hydrat|mug|cup)/i,
  ],
  [/\b(monitor|screen|display)\b/i, /\b(screen|monitor|display|computer)\b/i],
  [
    /\b(mouse|keyboard|trackpad)\b/i,
    /\b(mouse|keyboard|work(ed|ing)?|desk time|focus|busy|at (my|the) desk)\b/i,
  ],
  [/\blamp\b|\blight\b/i, /\b(lamp|lights?)\b/i],
  [/\bcat\b/i, /\b(cat|kitty|nap(s|ped)?)\b/i],
];

/** The thing a piece of a question names: by its own words, else by what it is called. */
function thingIn(text: string, things: readonly AskThing[], except?: string): AskThing | undefined {
  const pool = things.filter((t) => t.id !== except);
  const own = pool.find((t) =>
    t.label
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3 && !['desk', 'computer'].includes(w))
      .some((w) => text.includes(w)),
  );
  if (own) return own;
  for (const [label, words] of THING_WORDS)
    if (words.test(text)) {
      const found = pool.find((t) => label.test(t.label));
      if (found) return found;
    }
  return undefined;
}

/**
 * Read a question offline, in Spark's shape: the thing its words name, the
 * measure ("how many", "how long", "when … last", "longest … without",
 * "what should I eat first"), the window ("in the last hour", "yesterday",
 * "this week"), a comparison ("more than yesterday", "than usual") and
 * another thing's state ("while I was away"). The demo's stand-in for Spark.
 */
export function demoAsk(question: string, things: readonly AskThing[]): AskQuery {
  const q = question.toLowerCase();
  const [main = q, during] = q.split(/\bwhile\b/);
  const useBy = /eat first|go(es)? off|going off|expir|use.?by|spoil|going bad|best before/.test(q);
  let thing = thingIn(main, things);
  if (useBy && thing && !thing.expires) thing = undefined;
  if (!thing && !useBy && /\bfridge\b|\bfood\b/.test(q))
    thing = things.find((t) => /milk/i.test(t.label));
  // "While I was away": the screen off, unless another thing is named.
  let whileThing: AskThing | undefined;
  let whileOn: boolean | null = null;
  if (during !== undefined) {
    whileThing =
      thingIn(during, things, thing?.id) ??
      (/\baway|gone|out\b|not (at|here)|left/.test(during)
        ? things.find((t) => /\b(monitor|screen)\b/i.test(t.label))
        : undefined);
    whileOn = !/\b(off|idle|empty|away|gone|out|asleep|not|left)\b/.test(during);
  }

  const number = (s: string) =>
    /^(an?|one)$/.test(s) ? 1 : s === 'half an' || s === 'half' ? 0.5 : Number(s);
  const lastSpan = q.match(
    /\b(?:last|past)\s+(\d+|an?|one|half an?)?\s*(minutes?|mins?|hours?|hrs?|h|days?|weeks?|months?)\b/,
  );
  let window: AskQuery['window'] = 'today';
  let amount: number | null = null;
  if (lastSpan) {
    const n = lastSpan[1] ? number(lastSpan[1]) : 1;
    const unit = lastSpan[2]!;
    if (/^d/.test(unit)) ((window = 'days'), (amount = n));
    else if (/^w/.test(unit)) ((window = 'days'), (amount = n * 7));
    else if (/^mo/.test(unit)) ((window = 'days'), (amount = n * 30));
    else ((window = 'minutes'), (amount = /^m/.test(unit) ? n : n * 60));
  } else if (/\byesterday\b/.test(q) && !/than yesterday|vs\.? yesterday/.test(q))
    window = 'yesterday';
  else if (/\bthis month\b|\bmonth\b/.test(q)) ((window = 'days'), (amount = 30));
  else if (/\bthis week\b|\bweek\b/.test(q)) ((window = 'days'), (amount = 7));

  const summary = /what happened|summary|so far|my day|how was (my|the) day|anything/.test(q);
  const measure: AskMeasure = useBy
    ? 'useBy'
    : summary
      ? 'summary'
      : /\blongest\b.*\b(without|between|gap|off|idle|empty)\b|\bwithout\b.*\blongest\b|\blongest gap\b/.test(
            q,
          )
        ? 'longestGap'
        : /\blongest\b|\bbiggest\b/.test(q)
          ? 'longest'
          : /\bfirst\b/.test(q)
            ? 'first'
            : /\b(last|latest)\b/.test(q) && /\bwhen\b/.test(q)
              ? 'last'
              : /\bhow many\b|\bhow often\b|\btimes\b|\bcount\b/.test(q)
                ? 'count'
                : /\bhow long\b|\bhow much time\b|\bscreen time\b|\bduration\b/.test(q)
                  ? 'duration'
                  : /\b(is|are)\b.*\b(on|now|there|up)\b|\bright now\b|\bcurrently\b/.test(main) &&
                      during === undefined
                    ? 'now'
                    : thing?.stats[0] === 'lastUsed'
                      ? 'count'
                      : thing
                        ? 'duration'
                        : 'summary';
  const compare: AskQuery['compare'] = /\busual(ly)?\b|\baverage\b|\bnormal(ly)?\b|\btypical/.test(
    q,
  )
    ? 'average'
    : /\bthan\b|\bcompared?\b|\bvs\.?\b/.test(q)
      ? 'previous'
      : 'none';
  const base = {
    measure,
    window,
    amount,
    compare,
    while: whileThing?.id ?? null,
    whileOn: whileThing ? whileOn : null,
  };
  if (!thing && !summary && !useBy)
    return {
      ...base,
      thing: null,
      stat: null,
      clarify: `I can tell you about ${things.map((t) => t.label.toLowerCase()).join(', ')}. Which one did you mean?`,
    };
  return { ...base, thing: thing?.id ?? null, stat: thing?.stats[0] ?? null, clarify: null };
}
