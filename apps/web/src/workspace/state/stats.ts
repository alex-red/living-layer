import { useEffect, useState } from 'react';
import type { Mode, StatsNow, ThingStatsView } from '@livinglayer/domain';
import { apiAt } from '../../api';
import { createStore, useStore } from './store';

/**
 * Every thing's stats now, as the server's watcher last sent them. Kept in a
 * store, not lab state: the overlay, the room's badges and the cards read the
 * part they show, and only they render when a stat changes.
 */
export const statsStore = createStore<StatsNow>({});

/** Each thing's stats as last fed, as JSON, to tell which ones changed. */
let fedText = new Map<string, string>();

/**
 * Keep the store in step with the watch stream. A thing whose stats didn't
 * change keeps its object, so `useThingStats(id)` renders only for a change
 * to that thing; the store is replaced only when some stat changed.
 */
export function feedStats(stats: StatsNow | undefined) {
  const before = statsStore.get();
  const next: StatsNow = {};
  const text = new Map<string, string>();
  let changed = false;
  for (const [id, now] of Object.entries(stats ?? {})) {
    const json = JSON.stringify(now);
    text.set(id, json);
    const kept = before[id];
    if (kept && fedText.get(id) === json) next[id] = kept;
    else {
      next[id] = now;
      changed = true;
    }
  }
  if (Object.keys(before).length !== text.size) changed = true;
  fedText = text;
  if (changed) statsStore.set(next);
}

/** One thing's stats now. */
export function useThingStats(id: string) {
  return useStore(statsStore, (s) => s[id]);
}

/**
 * A thing's last day of changes and its day totals, fetched again whenever
 * one of its stats changes (`version`), not on a timer.
 */
export function useStatHistory(mode: Mode, id: string, version: string) {
  const [view, setView] = useState<ThingStatsView | null>(null);
  useEffect(() => {
    let live = true;
    apiAt<ThingStatsView>(`things/${mode}/${id}/stats?days=7`)
      .then((v) => live && setView(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [mode, id, version]);
  return view;
}
