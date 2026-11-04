import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/controls';
import { usePageVisible } from './visible';
import { useRecording } from './Recorder';
import './dev-reload.css';

/** What `scripts/dev.ts` has seen change since it started. */
type DevState = {
  /** Edits to the page's code, counted. */
  web: number;
  server: 'running' | 'changed' | 'stopped' | 'restarting';
  /** The latest files changed, newest first. */
  files: string[];
  /** What the API server is still working on: running jobs' titles, and requests that change something. */
  busy: { jobs: string[]; requests: number };
  /** A reload is waiting for that to end. */
  waiting: boolean;
};

/**
 * In development, `Reload now` once code has changed, since nothing reloads by
 * itself: it restarts the API server when its code changed (or it stopped),
 * then reloads the page. While an AI task runs it waits for it, so a reload
 * never cuts one off, unless asked to `Reload anyway`. Shows nothing unless
 * `bun run dev` started Vite.
 */
export function DevReload() {
  // A take of the page never shows this card.
  const recording = useRecording();
  const [state, setState] = useState<DevState | null>(null);
  const loadedWith = useRef<number | null>(null);
  const [asked, setAsked] = useState(false);

  // Only while the page shows: see `usePageVisible`.
  const visible = usePageVisible();
  useEffect(() => {
    if (!visible) return;
    const events = new EventSource('/__dev/events');
    events.onmessage = (e) => {
      const next = JSON.parse(e.data as string) as DevState;
      loadedWith.current ??= next.web;
      setState(next);
    };
    return () => events.close();
  }, [visible]);

  if (!state || recording) return null;
  const web = state.web !== loadedWith.current;
  if (!web && state.server === 'running') return null;

  const reload = async (now = false) => {
    setAsked(true);
    try {
      await fetch(now ? '/__dev/reload?now' : '/__dev/reload', { method: 'POST' });
    } finally {
      window.location.reload();
    }
  };
  const what =
    state.server === 'stopped'
      ? 'The API server stopped'
      : state.server === 'changed' || state.server === 'restarting'
        ? web
          ? 'Code changed'
          : 'Server code changed'
        : 'Page code changed';
  const { jobs, requests } = state.busy;
  const busy = jobs.length > 0 || requests > 0;
  const working = jobs.length
    ? `${jobs[0]}${jobs.length > 1 ? ` and ${jobs.length - 1} more` : ''}`
    : `${requests} request${requests === 1 ? '' : 's'}`;
  const waiting = state.waiting || (asked && busy);

  return (
    <div className="dev-reload" role="status">
      <div className="dev-reload-text">
        <strong>{what}</strong>
        {busy ? (
          <span className="dev-reload-busy">
            {waiting ? 'Reloads once this ends: ' : 'Running: '}
            {working}
          </span>
        ) : (
          state.files.length > 0 && (
            <span className="dev-reload-files" title={state.files.join('\n')}>
              {state.files[0]}
              {state.files.length > 1 && ` +${state.files.length - 1}`}
            </span>
          )
        )}
      </div>
      {waiting ? (
        <Button variant="ghost" size="sm" onClick={() => void reload(true)}>
          Reload anyway
        </Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          busy={(asked || state.server === 'restarting') && 'Restarting…'}
          onClick={() => void reload()}
        >
          {busy ? 'Reload when done' : 'Reload now'}
        </Button>
      )}
    </div>
  );
}
