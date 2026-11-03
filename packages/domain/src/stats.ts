/**
 * Stats: small typed values about one thing, worked out from the camera or
 * from Home Assistant, kept as a history ([plan](../../../docs/plans/things-and-stats.md)).
 * A monitor's power, when the mug was last used, how busy the mouse is,
 * whether the cat is on its tree. Everything here is pure: each detector is
 * a step over a small state, so the watcher runs it frame by frame and a test
 * replays it. The server's `StatRunner` owns the states, the cadence and the
 * storage.
 */
import { z } from 'zod';
import type { UnitBox } from './tracker.js';
import { nextOccupied } from './occupancy.js';

export const STAT_KEYS = ['power', 'lastUsed', 'activity', 'occupied'] as const;
export type StatKey = (typeof STAT_KEYS)[number];
/** On/off, a time in ms, a level 0–1, or null while it is unavailable. */
type StatValue = boolean | number | null;
/** A look a person shows once: off and on for power, empty for occupied. */
export const STAT_LOOKS = ['off', 'on', 'empty'] as const;
export type StatLook = (typeof STAT_LOOKS)[number];

interface StatKind {
  label: string;
  value: 'onOff' | 'time' | 'level';
  /** What the person shows once before it has a value from the camera. */
  learn: readonly StatLook[];
  /** How often it runs, ms; 0 for every frame. */
  everyMs: number;
  /** What a day adds up: seconds it was on, times it happened, seconds it was active. */
  daily: 'onSeconds' | 'count' | 'activeSeconds';
  /** Its words for being on and off, where it is on/off. */
  words?: { on: string; off: string };
}
/** The registry: one entry and a detector make a new stat. */
export const STAT_KINDS: Record<StatKey, StatKind> = {
  power: {
    label: 'Power',
    value: 'onOff',
    learn: ['off', 'on'],
    everyMs: 1000,
    daily: 'onSeconds',
    words: { on: 'On', off: 'Off' },
  },
  lastUsed: { label: 'Last used', value: 'time', learn: [], everyMs: 0, daily: 'count' },
  activity: { label: 'Activity', value: 'level', learn: [], everyMs: 0, daily: 'activeSeconds' },
  occupied: {
    label: 'Occupied',
    value: 'onOff',
    learn: ['empty'],
    everyMs: 3000,
    daily: 'onSeconds',
    words: { on: 'Occupied', off: 'Empty' },
  },
};

export const STATS = {
  /** The grey sample of a thing's region: small and fixed, so a frame allocates nothing. */
  sample: { width: 16, height: 12 },
  /** A value must hold this long before it counts, ms, so it doesn't flicker. */
  dwellMs: 2000,
  /** How much nearer the other look must be, as a share of the looks' distance apart, to change. */
  powerMargin: 0.2,
  /** Looks closer than this (in mean grey over the frame's mean) can't be told apart. */
  powerSeparation: 0.04,
  /** Motion share in a thing's surroundings that counts as it being used. */
  activeShare: 0.03,
  /** The window activity's level is a share of, ms. */
  activityWindowMs: 60_000,
  /** Activity's level travels in steps of this. */
  activityStep: 0.1,
  /** Gone from its spot at least this long, ms, to count as used when it comes back. */
  usedAwayMs: 3000,
  /** Moved this far from its spot, in its own widths, counts as being moved, not seen again. */
  usedMovedWidths: 0.5,
  /** Writes of events and day totals are batched this often, ms. */
  flushMs: 5000,
  /** A thing has at most this many stats. */
  max: 4,
};

export const thingStatSchema = z
  .object({
    key: z.enum(STAT_KEYS),
    /** Opt-in, billed: SAM confirms a change (only while tracking may call AI). */
    samConfirm: z.boolean().optional(),
    /** What SAM is asked to see, for occupied: `cat` for a cat tree. */
    concept: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
export type ThingStat = z.infer<typeof thingStatSchema>;

/** The stats a thing of this type or name usually has, ticked when it is added. */
const TYPE_STATS: [RegExp, StatKey[]][] = [
  [/\b(monitor|screen|display|tv|television)\b/i, ['power']],
  [/\blamp\b|\blight\b/i, ['power']],
  [/\b(mug|cup)\b/i, ['lastUsed']],
  // Food: when it was last taken out, once a camera watches the fridge.
  [
    /\b(milk|eggs?|butter|leftovers?|pickles?|jar|sauce|juice|yog(h)?urt|cheese|mayonnaise|mustard|jam|dressing)\b/i,
    ['lastUsed'],
  ],
  [/\b(mouse|trackpad|keyboard)\b/i, ['activity']],
  [/\bcat[ -]?tree\b|\bcat tower\b|\bbed\b|\bchair\b|\bsofa\b|\bcouch\b/i, ['occupied']],
];
export function suggestedStats(thing: { type?: string | undefined; label: string }): StatKey[] {
  const name = `${thing.type ?? ''} ${thing.label}`.replace(/-/g, ' ');
  return TYPE_STATS.find(([re]) => re.test(name))?.[1] ?? [];
}
/** What occupied asks SAM to see on a thing, by its name. */
export function occupantOf(label: string): string {
  return /\bcat\b/i.test(label) ? 'cat' : /\bdog\b/i.test(label) ? 'dog' : 'person';
}

/** A stat's value now, as the lab, the overlay and Home Assistant read it. */
export interface StatNow {
  value: StatValue;
  /** When it took this value, ms; null when unknown. */
  since: number | null;
  /** `person`: set by hand (when it was last used). */
  source: 'camera' | 'entity' | 'sam' | 'person';
  /** 0–1: how far past the line the evidence is. */
  confidence: number;
  /** Looks still to learn before the camera can say. */
  needs: StatLook[];
  /** Why it is unavailable, when it is. */
  reason?: string;
  /** Nobody is looking now (watching is off): the value is the last one seen. */
  stale?: boolean;
  /** Where the thing is in the frame when the watcher doesn't follow it, for the overlay. */
  region?: UnitBox;
  /** Today's total so far: seconds on or active, or times used. */
  today: number;
}
/** Every thing's stats now, by thing id. */
export type StatsNow = Record<string, Partial<Record<StatKey, StatNow>>>;
/** One change of a stat's value, as stored. */
export interface StatEvent {
  thingId: string;
  key: StatKey;
  at: number;
  value: StatValue;
  source: StatNow['source'];
  confidence: number;
}
/** What `GET /api/things/:mode/:id/stats` answers for one thing. */
export interface ThingStatsView {
  id: string;
  now: Partial<Record<StatKey, StatNow>>;
  /** The last day's changes, oldest first. */
  events: StatEvent[];
  /** Day totals, oldest first, `YYYY-MM-DD` in the server's own time zone. */
  days: { day: string; key: StatKey; total: number }[];
}

/** A value that waits `dwellMs` before a new reading counts. */
export interface Settled<V> {
  value: V;
  /** When it took its value, ms. */
  since: number | null;
  /** The reading waiting to count, and since when. */
  next: V;
  nextSince: number;
}
export const settled = <V>(value: V): Settled<V> => ({
  value,
  since: null,
  next: value,
  nextSince: 0,
});
/** The settled value after one reading; changed only once a new reading has held for `dwellMs`. */
export function settle<V>(s: Settled<V>, reading: V, now: number, dwellMs = STATS.dwellMs) {
  if (reading === s.value) {
    s.next = reading;
    return false;
  }
  if (reading !== s.next) {
    s.next = reading;
    s.nextSince = now;
  }
  if (now - s.nextSince < dwellMs) return false;
  s.value = reading;
  s.since = s.nextSince;
  return true;
}

/** A region's look for power: its mean grey and contrast, each over the frame's mean. */
export interface PowerLook {
  mean: number;
  contrast: number;
}
/** The frame's mean grey, from every fourth pixel: what a room light changes. */
export function frameMean(data: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += data[i]!;
    n++;
  }
  return n ? Math.max(1, sum / n) : 1;
}
/** A sample's look, as shares of the frame's mean, so the room's own lights going on don't count. */
export function powerLook(sample: Uint8Array, mean: number): PowerLook {
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < sample.length; i++) {
    const v = sample[i]!;
    sum += v;
    sq += v * v;
  }
  const m = sum / sample.length;
  const sd = Math.sqrt(Math.max(0, sq / sample.length - m * m));
  return { mean: m / mean, contrast: sd / mean };
}
const lookDistance = (a: PowerLook, b: PowerLook) =>
  // A screen's picture changes its contrast more than its brightness: brightness weighs most.
  Math.hypot(a.mean - b.mean, (a.contrast - b.contrast) / 2);
/**
 * On or off, from a look and the two the person showed. The nearer one wins,
 * by `powerMargin` of their distance apart once it has a value; while
 * something moves in front of it, it holds. Null when the looks can't be told
 * apart.
 */
export function powerReading(
  look: PowerLook,
  looks: { on: PowerLook; off: PowerLook },
  was: boolean | null,
): { reading: boolean | null; confidence: number } {
  const apart = lookDistance(looks.on, looks.off);
  if (apart < STATS.powerSeparation) return { reading: null, confidence: 0 };
  const toOn = lookDistance(look, looks.on);
  const toOff = lookDistance(look, looks.off);
  const lead = (toOff - toOn) / apart;
  const confidence = Math.min(1, Math.abs(lead));
  if (was === null) return { reading: lead > 0, confidence };
  if (was ? lead < -STATS.powerMargin : lead > STATS.powerMargin)
    return { reading: !was, confidence };
  return { reading: was, confidence };
}

/**
 * Activity: a level 0–1, how much something moved where the thing is lately:
 * a running average over about a minute (`activityWindowMs`), so it keeps no
 * window of frames. A minute of steady motion reads about two thirds.
 */
export interface Activity {
  level: number;
  /** The level as last told, in steps of `activityStep`. */
  shown: number;
}
/** One frame's worth of activity, `dt` ms after the last; true when the shown level changed. */
export function activityStep(a: Activity, active: boolean, dt: number): boolean {
  const k = Math.min(1, dt / STATS.activityWindowMs);
  a.level += ((active ? 1 : 0) - a.level) * k;
  const shown = Math.round(a.level / STATS.activityStep) * STATS.activityStep;
  if (Math.abs(shown - a.shown) < 1e-9) return false;
  a.shown = Math.round(shown * 10) / 10;
  return true;
}

/**
 * Last used: where it stood, and since when it has been away from there. It
 * was used when it comes back, still, after being away (lost, or moved off
 * its spot) for `usedAwayMs`: picked up and put back.
 */
export interface UseSpot {
  spot: UnitBox | null;
  awaySince: number | null;
}
export function usedStep(
  u: UseSpot,
  seen: { following: boolean; box: UnitBox; still: boolean },
  now: number,
  awayMs = STATS.usedAwayMs,
): boolean {
  if (!u.spot) {
    if (seen.following && seen.still) u.spot = { ...seen.box };
    return false;
  }
  const off =
    Math.hypot(seen.box.x - u.spot.x, seen.box.y - u.spot.y) > STATS.usedMovedWidths * u.spot.width;
  if (!seen.following || off) u.awaySince ??= now;
  if (!seen.following || !seen.still || u.awaySince === null) return false;
  const used = now - u.awaySince >= awayMs;
  // Back where it was too soon is a hand passing; anywhere new is its spot from now on.
  if (used || off) u.spot = { ...seen.box };
  u.awaySince = null;
  return used;
}

/** Occupied from a region's difference from its empty look, with the zones' own gap and the dwell. */
export function occupiedStep(
  s: Settled<boolean | null>,
  score: number,
  now: number,
  dwellMs = STATS.dwellMs,
): boolean {
  return settle(s, nextOccupied(s.value === true, score), now, dwellMs);
}

/** A day as `YYYY-MM-DD` in this machine's own time zone. */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** A stat's value in words: "On", "12 min ago", "Busy". */
export function statWords(key: StatKey, value: StatValue, now = Date.now()): string {
  if (value === null) return '—';
  const kind = STAT_KINDS[key];
  if (kind.words && typeof value === 'boolean') return value ? kind.words.on : kind.words.off;
  if (kind.value === 'time' && typeof value === 'number') return `${ago(now - value)} ago`;
  if (kind.value === 'level' && typeof value === 'number')
    return value >= 0.5 ? 'Busy' : value >= 0.2 ? 'In use' : value > 0 ? 'Now and then' : 'Idle';
  return String(value);
}
/** A span in words: "40 s", "12 min", "2 h 10 min", "3 d". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}
/** A day's total in words: "2 h 10 min on", "3 times". */
export function totalWords(key: StatKey, total: number): string {
  const kind = STAT_KINDS[key];
  if (kind.daily === 'count') return `${total} time${total === 1 ? '' : 's'}`;
  return ago(total * 1000);
}
