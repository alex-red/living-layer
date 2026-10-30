import { useEffect, useState } from 'react';
import type { ExposeView, Mode, WatchView } from '@livinglayer/domain';

/** The newest message of a server event stream. The browser's EventSource reconnects by itself. */
function useEvents<T>(url: string): T | null {
  const [view, setView] = useState<T | null>(null);
  useEffect(() => {
    setView(null);
    if (typeof EventSource === 'undefined') return;
    const events = new EventSource(url);
    events.onmessage = (e) => {
      try {
        setView(JSON.parse(e.data) as T);
      } catch {
        // A garbled message is skipped; the next one replaces it.
      }
    };
    return () => events.close();
  }, [url]);
  return view;
}

/**
 * What the server's watcher sees in one mode, live: its state, each followed
 * thing's box and how sure it is. The server keeps watching when no tab is
 * open; this only shows it.
 */
export function useWatch(mode: Mode): WatchView | null {
  return useEvents<WatchView>(`/api/watch/${mode}/events`);
}
/** The entities this mode shows in Home Assistant, each with its state, and the broker's. */
export function useExpose(mode: Mode): ExposeView | null {
  return useEvents<ExposeView>(`/api/expose/${mode}/events`);
}
