import { useEffect, useState } from 'react';
import type { Mode, WatchView } from '@livinglayer/domain';

/**
 * What the server's watcher sees in one mode, live: its state, each followed
 * thing's box and how sure it is. The server keeps watching when no tab is
 * open; this only shows it. The browser's EventSource reconnects by itself.
 */
export function useWatch(mode: Mode): WatchView | null {
  const [view, setView] = useState<WatchView | null>(null);
  useEffect(() => {
    setView(null);
    if (typeof EventSource === 'undefined') return;
    const events = new EventSource(`/api/watch/${mode}/events`);
    events.onmessage = (e) => {
      try {
        setView(JSON.parse(e.data) as WatchView);
      } catch {
        // A garbled message is skipped; the next one replaces it.
      }
    };
    return () => events.close();
  }, [mode]);
  return view;
}
