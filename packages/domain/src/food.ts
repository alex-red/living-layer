import { z } from 'zod';
import { dayOf } from './stats.js';

/**
 * What a person keeps about a food thing: when it goes off, when it was
 * opened and how much is left. Unlike a stat, nothing here is seen by the
 * camera; the person sets it on the thing's card, and it is shown in the
 * Things list and over the thing in the room.
 */
export const FOOD_LEFT = ['full', 'most', 'half', 'low', 'empty'] as const;
export type FoodLeft = (typeof FOOD_LEFT)[number];
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A day as YYYY-MM-DD.');
export const foodSchema = z
  .object({
    /** Its use-by or best-before day. */
    expires: daySchema.optional(),
    /** The day it was opened. */
    opened: daySchema.optional(),
    left: z.enum(FOOD_LEFT).optional(),
  })
  .strict();
export type Food = z.infer<typeof foodSchema>;

/**
 * Days one usually keeps in the fridge by name, opened and as bought: the
 * card offers the first as its use-by when it is opened, and a thing made
 * from the room starts with the second. Leftovers keep as long either way.
 */
const KEEPS: [RegExp, { open: number; bought: number }][] = [
  [/\bmilk\b|\bcream\b/i, { open: 5, bought: 10 }],
  [/\bleftover|\btub\b|\bcontainer\b/i, { open: 3, bought: 3 }],
  [/\bbutter\b/i, { open: 30, bought: 60 }],
  [/\begg/i, { open: 21, bought: 28 }],
  [/\bpickle|\bjar\b|\bsauce\b|\bketchup\b|\bmustard\b|\bmayo/i, { open: 60, bought: 180 }],
  [/\bjuice\b/i, { open: 7, bought: 14 }],
  [/\byog(h)?urt\b|\bcheese\b/i, { open: 7, bought: 21 }],
];
/** Whether a thing of this name is kept as food, and how long it keeps opened. */
export function foodKeeps(label: string): number | null {
  return KEEPS.find(([re]) => re.test(label))?.[1].open ?? null;
}
/**
 * What a food thing starts with, bought `today`: full, with its usual use-by
 * day. A guess the card shows and the person corrects; null when the name
 * isn't food.
 */
export function foodDefaults(label: string, today: string): Food | null {
  const keeps = KEEPS.find(([re]) => re.test(label))?.[1];
  return keeps ? { expires: addDays(today, keeps.bought) } : null;
}

const DAY_MS = 86_400_000;
/** Whole days from `today` to `day`, both `YYYY-MM-DD`: negative when it is past. */
export function daysUntil(day: string, today: string): number {
  return Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY_MS);
}
/** `day` moved by `days`, as `YYYY-MM-DD`. */
export function addDays(day: string, days: number): string {
  const d = new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY_MS);
  return d.toISOString().slice(0, 10);
}

export interface FoodNow {
  /** "Expires in 3 days", "Expires today", "Expired 2 days ago", "Half left". */
  text: string;
  /** `bad` once past its day, `soon` within two days, `ok` otherwise. */
  tone: 'ok' | 'soon' | 'bad';
}
/** The one line a food thing shows: its expiry first, else how much is left; null when nothing is set. */
export function foodNow(food: Food | undefined, now = Date.now()): FoodNow | null {
  if (!food) return null;
  const left = food.left && food.left !== 'full' ? `${food.left} left` : null;
  if (food.left === 'empty') return { text: 'Empty', tone: 'bad' };
  if (!food.expires) return left ? { text: cap(left), tone: 'ok' } : null;
  const n = daysUntil(food.expires, dayOf(now));
  const when =
    n < 0
      ? `Expired ${-n} day${n === -1 ? '' : 's'} ago`
      : n === 0
        ? 'Expires today'
        : n === 1
          ? 'Expires tomorrow'
          : `Expires in ${n} days`;
  return {
    text: left ? `${when} · ${left}` : when,
    tone: n < 0 ? 'bad' : n <= 2 ? 'soon' : 'ok',
  };
}
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
