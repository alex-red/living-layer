/**
 * A litter box's stats, worked out from what the room already keeps: the box's
 * occupied stat is the cat's visits (on as it goes in, off as it comes out),
 * and a waste drawer kept as a thing with Last used counts as emptied each
 * time it is pulled out and put back. From those: visits today against the
 * usual by this time of day, how long they last, how long since the last,
 * and how full the drawer is by the visits since it was emptied. The coach
 * nudges from these and the litter box's card shows them.
 */
import type { AskThing } from './demo-day.js';
import type { AskHistory } from './room-ask.js';
import type { StatEvent } from './stats.js';

export const LITTER = {
  /** Visits a waste drawer holds for one cat, from empty to full. */
  drawerVisits: 30,
  /** The share of the drawer that is worth emptying. */
  drawerFull: 0.8,
  /** Visits today against the usual by this time that are worth a word: this many times as many, and at least this many more. */
  busyShare: 1.6,
  busyMore: 2,
  /** Minutes without a visit that are worth checking on the cat. */
  quietMin: 12 * 60,
  /** Days before today that make the usual, and how many of them must have visits. */
  usualDays: 6,
  usualMinDays: 3,
  /** Minutes the box waits after the cat comes out before it cleans itself. */
  cycleWaitMin: 7,
} as const;

const MINUTE = 60_000;

/** A litter box by its name: not its drawer, mat, bags or scoop. */
export const isLitterBox = (label: string) =>
  /\blitter\b/i.test(label) && !/\b(drawer|mat|bags?|liners?|scoop|treats?)\b/i.test(label);
/** A litter box's waste drawer by its name. */
export const isWasteDrawer = (label: string) => /\b(waste|litter)\s+drawer\b/i.test(label);

/** One visit: when the cat went in, and minutes inside (null while it still is). */
interface LitterVisit {
  at: number;
  minutes: number | null;
}
/** A litter box now, as its card shows it and the coach reads it. */
export interface LitterNow {
  boxId: string;
  label: string;
  /** Who uses it: the cat's name, or "The cat". */
  cat: string;
  /** Today's visits so far, oldest first. */
  visits: LitterVisit[];
  /** Visits by this time of day on a usual day, and in a whole usual day; null with too few days kept. */
  usualByNow: number | null;
  usualDay: number | null;
  lastVisit: LitterVisit | null;
  /** Minutes since the cat last came out: 0 while it is in, null before any visit. */
  sinceLast: number | null;
  /** Today's visits' mean length, minutes. */
  meanMinutes: number | null;
  /** Today's visits per hour, midnight first. */
  hours: number[];
  /** The last seven days' visits, oldest first, today (so far) last. */
  week: { day: number; visits: number }[];
  /** The waste drawer: how full, from the visits since it was last emptied; share null until it has been. */
  drawer: {
    id: string;
    label: string;
    share: number | null;
    visits: number;
    emptiedAt: number | null;
  } | null;
  /** The cat's weight from the box's scale, kg: the latest, and the first in the week before it. */
  weight: { kg: number; at: number; weekAgo: number | null } | null;
}

/** Midnight, local time, `back` days before the day `ms` falls on. */
function midnight(ms: number, back = 0): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** The visits that began after `from` and by `to`, from one box's occupied events, oldest first. */
function litterVisits(events: readonly StatEvent[], from: number, to: number): LitterVisit[] {
  const out: LitterVisit[] = [];
  let open: LitterVisit | null = null;
  for (const e of events) {
    if (e.at > to) break;
    const on = e.value === true;
    if (on && !open) {
      open = { at: e.at, minutes: null };
      if (e.at > from) out.push(open);
    } else if (!on && open) {
      open.minutes = (e.at - open.at) / MINUTE;
      open = null;
    }
  }
  return out;
}

const mean = (ns: readonly number[]) =>
  ns.length ? Math.round((ns.reduce((a, b) => a + b, 0) / ns.length) * 10) / 10 : null;

/** A litter box (a thing kept with occupied) as of `now`, or null when it isn't one. */
export function litterNow(history: AskHistory, box: AskThing, now: number): LitterNow | null {
  if (!isLitterBox(box.label) || !box.stats.includes('occupied')) return null;
  const events = history.events.filter(
    (e) => e.thingId === box.id && e.key === 'occupied' && e.at <= now,
  );
  const today = midnight(now);
  const visits = litterVisits(events, today - 1, now);
  const all = litterVisits(events, -Infinity, now);
  const lastVisit = all.at(-1) ?? null;
  // A usual day: the days before today that had a visit, to this time of day and whole.
  const byNow: number[] = [];
  const whole: number[] = [];
  for (let back = 1; back <= LITTER.usualDays; back++) {
    const from = midnight(now, back);
    const day = litterVisits(events, from - 1, midnight(now, back - 1) - 1);
    if (!day.length) continue;
    whole.push(day.length);
    byNow.push(day.filter((v) => v.at <= from + (now - today)).length);
  }
  const enough = whole.length >= LITTER.usualMinDays;
  const hours = Array.from({ length: 24 }, () => 0);
  for (const v of visits) hours[new Date(v.at).getHours()]!++;
  const week = Array.from({ length: 7 }, (_, i) => {
    const day = midnight(now, 6 - i);
    return {
      day,
      visits: litterVisits(events, day - 1, Math.min(midnight(now, 5 - i) - 1, now)).length,
    };
  });
  const drawerThing = history.things.find(
    (t) => isWasteDrawer(t.label) && t.stats.includes('lastUsed'),
  );
  let drawer: LitterNow['drawer'] = null;
  if (drawerThing) {
    const emptied = history.events
      .filter(
        (e) =>
          e.thingId === drawerThing.id && e.key === 'lastUsed' && e.at <= now && e.value !== null,
      )
      .at(-1);
    const since = emptied ? litterVisits(events, emptied.at, now).length : all.length;
    drawer = {
      id: drawerThing.id,
      label: drawerThing.label,
      share: emptied ? Math.min(since / LITTER.drawerVisits, 1) : null,
      visits: since,
      emptiedAt: emptied?.at ?? null,
    };
  }
  const weights = (box.litter?.weights ?? []).filter((w) => w.at <= now);
  const latest = weights.at(-1);
  // The week's first reading, when the week has one before the latest.
  const weekAgo = latest
    ? weights.find((w) => w.at >= latest.at - 7 * 86_400_000 && w.at < latest.at)
    : undefined;
  return {
    boxId: box.id,
    label: box.label,
    cat: box.litter?.cat ?? 'The cat',
    visits,
    usualByNow: enough ? mean(byNow) : null,
    usualDay: enough ? mean(whole) : null,
    lastVisit,
    sinceLast: !lastVisit
      ? null
      : lastVisit.minutes === null
        ? 0
        : (now - lastVisit.at) / MINUTE - lastVisit.minutes,
    meanMinutes: mean(visits.flatMap((v) => (v.minutes === null ? [] : [v.minutes]))),
    hours,
    week,
    drawer,
    weight: latest ? { kg: latest.kg, at: latest.at, weekAgo: weekAgo?.kg ?? null } : null,
  };
}

/** Whether today's visits are well above the usual by this time of day. */
export const litterBusy = (n: LitterNow) =>
  n.usualByNow !== null &&
  n.visits.length >= Math.max(n.usualByNow * LITTER.busyShare, n.usualByNow + LITTER.busyMore);

/**
 * The demo's litter box room on its sample day: Juniper's visits, as the
 * minute she went in and the minutes she stayed. A busy day: about twice her
 * usual by mid-afternoon, and short visits, what the coach is there to notice.
 */
export const DEMO_LITTER_CAT = 'Juniper';
export const DEMO_LITTER_VISITS: readonly (readonly [number, number])[] = [
  [395, 3],
  [545, 2],
  [700, 2],
  [785, 1],
  [842, 1],
  [905, 1],
  [985, 2],
  [1065, 2],
  [1190, 3],
  [1300, 2],
];
/** The demo's waste drawer was last emptied this many days before the sample day, at this minute. */
export const DEMO_LITTER_EMPTIED = { daysAgo: 5, minute: 19 * 60 + 30 } as const;
