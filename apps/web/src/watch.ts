import { useEffect } from 'react';
import type { ExposeView, HaView, Mode, WatchView } from '@livinglayer/domain';
import { usePageVisible } from './visible';
import { createStore } from './workspace/state/store';
import { feedStats } from './workspace/state/stats';

/**
 * What the server's watcher sees in the mode shown, as it last sent it. Kept
 * in a store, not lab state: it changes up to ten times a second, and only
 * the components that read it (`useStore(watchStore, …)`) render for it.
 */
export const watchStore = createStore<WatchView | null>(null);
/** The entities the mode shows in Home Assistant, with their states and the broker's. */
export const exposeStore = createStore<ExposeView | null>(null);
/**
 * Live only: the devices it may switch, as Home Assistant reports them now
 * (the server's websocket to it). Sent first on every connect, so a reload
 * shows the lights as they are rather than as they were last switched.
 */
export const haStore = createStore<HaView | null>(null);

/**
 * Keeps `watchStore` and `exposeStore` up to date for one mode, live (the
 * watcher's state, each followed thing's box and how sure it is, and the
 * entities shown in Home Assistant): both on one event stream, one
 * connection a tab. The server keeps watching when no tab is open; this
 * only shows it. The browser's EventSource reconnects by itself; a hidden
 * page lets it go (`usePageVisible`), keeping the last views, and the server
 * sends the newest again on reconnecting.
 */
export function useWatchStream(mode: Mode): void {
  const visible = usePageVisible();
  useEffect(() => {
    watchStore.set(null);
    exposeStore.set(null);
    haStore.set(null);
    feedStats(undefined);
  }, [mode]);
  useEffect(() => {
    if (!visible || typeof EventSource === 'undefined') return;
    const events = new EventSource(`/api/watch/${mode}/events`);
    const on =
      <T>(set: (view: T) => void) =>
      (e: MessageEvent<string>) => {
        let view: T;
        try {
          view = JSON.parse(e.data) as T;
        } catch {
          // A garbled message is skipped; the next one replaces it.
          return;
        }
        set(view);
      };
    events.addEventListener(
      'watch',
      on<WatchView>((view) => {
        feedStats(view.stats);
        watchStore.set(view);
      }),
    );
    events.addEventListener(
      'expose',
      on<ExposeView>((view) => exposeStore.set(view)),
    );
    events.addEventListener(
      'ha',
      on<HaView>((view) => haStore.set(view)),
    );
    return () => events.close();
  }, [mode, visible]);
}
