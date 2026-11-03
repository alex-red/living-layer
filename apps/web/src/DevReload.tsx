import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/controls';
import './dev-reload.css';

/** What `scripts/dev.ts` has seen change since it started. */
type DevState = {
  /** Edits to the page's code, counted. */
  web: number;
  server: 'running' | 'changed' | 'stopped' | 'restarting';
  /** The latest files changed, newest first. */
  files: string[];
};

/**
 * In development, `Reload now` once code has changed, since nothing reloads by
 * itself: it restarts the API server when its code changed (or it stopped),
 * then reloads the page. Shows nothing unless `bun run dev` started Vite.
 */
export function DevReload() {
  const [state, setState] = useState<DevState | null>(null);
  const loadedWith = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const events = new EventSource('/__dev/events');
    events.onmessage = (e) => {
      const next = JSON.parse(e.data as string) as DevState;
      loadedWith.current ??= next.web;
      setState(next);
    };
    return () => events.close();
  }, []);

  if (!state) return null;
  const web = state.web !== loadedWith.current;
  if (!web && state.server === 'running') return null;

  const reload = async () => {
    setBusy(true);
    try {
      await fetch('/__dev/reload', { method: 'POST' });
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

  return (
    <div className="dev-reload" role="status">
      <div className="dev-reload-text">
        <strong>{what}</strong>
        {state.files.length > 0 && (
          <span className="dev-reload-files" title={state.files.join('\n')}>
            {state.files[0]}
            {state.files.length > 1 && ` +${state.files.length - 1}`}
          </span>
        )}
      </div>
      <Button
        variant="primary"
        size="sm"
        busy={(busy || state.server === 'restarting') && 'Restarting…'}
        onClick={() => void reload()}
      >
        Reload now
      </Button>
    </div>
  );
}
