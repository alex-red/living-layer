import { useEffect, useRef, useState } from 'react';
import type { Mode, StatsNow, ThingStatsView } from '@livinglayer/domain';
import { apiAt } from '../../api';
import { createStore, useStore } from './store';

/**
 * Every thing's stats now, as the server's watcher last sent them. Kept in a
 * store, not lab state: the overlay, the room's badges and the cards read the
 * part they show, and only they render when a stat changes.
 */
export const statsStore = createStore<StatsNow>({});

/** Keep the store in step with the watch stream, replacing it only when a stat changed. */
export function useFeedStats(stats: StatsNow | undefined) {
  const last = useRef('');
  useEffect(() => {
    const text = JSON.stringify(stats ?? {});
    if (text === last.current) return;
    last.current = text;
    statsStore.set(stats ?? {});
  }, [stats]);
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
