import { useEffect, useState } from 'react';
import type { ExposeView, Mode, WatchView } from '@livinglayer/domain';
import { usePageVisible } from './visible';

/**
 * What the server's watcher sees in one mode, live (its state, each followed
 * thing's box and how sure it is), and the entities the mode shows in Home
 * Assistant with their states and the broker's: both on one event stream,
 * one connection a tab. The server keeps watching when no tab is open; this
 * only shows it. The browser's EventSource reconnects by itself; a hidden
 * page lets it go (`usePageVisible`), keeping the last views, and the server
 * sends the newest again on reconnecting.
 */
export function useWatchStream(mode: Mode): { watch: WatchView | null; expose: ExposeView | null } {
  const [watch, setWatch] = useState<WatchView | null>(null);
  const [expose, setExpose] = useState<ExposeView | null>(null);
  const visible = usePageVisible();
  useEffect(() => {
    setWatch(null);
    setExpose(null);
  }, [mode]);
  useEffect(() => {
    if (!visible || typeof EventSource === 'undefined') return;
    const events = new EventSource(`/api/watch/${mode}/events`);
    const on =
      <T>(set: (view: T) => void) =>
      (e: MessageEvent<string>) => {
        try {
          set(JSON.parse(e.data) as T);
        } catch {
          // A garbled message is skipped; the next one replaces it.
        }
      };
    events.addEventListener('watch', on(setWatch));
    events.addEventListener('expose', on(setExpose));
    return () => events.close();
  }, [mode, visible]);
  return { watch, expose };
}
