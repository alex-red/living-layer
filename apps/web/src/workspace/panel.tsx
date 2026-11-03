import { useEffect, useRef, useState, type ReactNode } from 'react';
import { apiAt } from '../api';
import { readUi, writeUi } from '../session';
import { useNow } from '../useNow';
import { useFeedback, useLabCalls, useView } from './LabContext';
import { ago } from './labels';

export type Tone = 'ok' | 'seen' | 'chosen' | 'unsure' | 'blocked' | 'warm' | 'idle';
const TONE_GLYPH: Record<Tone, string> = {
  ok: '✓',
  seen: '●',
  chosen: '◆',
  unsure: '◌',
  blocked: '×',
  warm: '●',
  idle: '○',
};
/** Every inspector panel has the same three parts: status, the next action, details. */
export function Panel({
  tiny,
  title,
  status,
  tone = 'idle',
  aside,
  children,
}: {
  tiny: string;
  title: string;
  status: ReactNode;
  tone?: Tone;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="insp-panel" aria-label={title}>
      <header className="insp-head">
        <span className="tiny">{tiny}</span>
        <h2>{title}</h2>
        <p className={`insp-status ${tone}`}>
          <span aria-hidden="true">{TONE_GLYPH[tone]}</span>
          <span>{status}</span>
          {aside}
        </p>
      </header>
      {children}
    </section>
  );
}
/** Folds that hold a destructive button start closed every time. */
const NEVER_KEPT = new Set(['Delete', 'Forget']);
/**
 * Folded details. `open` only sets how it starts; after that the person
 * decides, and this browser remembers it by the summary (less any count).
 */
export function Details({
  summary,
  children,
  open = false,
}: {
  summary: string;
  children: ReactNode;
  open?: boolean;
}) {
  const name = summary.split(' · ')[0]!;
  const key = NEVER_KEPT.has(name) ? null : `fold:${name}`;
  const [isOpen, setOpen] = useState(() => {
    const kept = key ? readUi(key) : undefined;
    return typeof kept === 'boolean' ? kept : open;
  });
  return (
    <details
      className="insp-details"
      open={isOpen}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        if (key && next !== isOpen) writeUi(key, next);
      }}
    >
      <summary>{summary}</summary>
      <div>{children}</div>
    </details>
  );
}
/**
 * One request from the inspector, with its own busy flag. It reads only the
 * lab's busy flag and its fixed calls, so the panel renders for neither the
 * view nor the desk changing; its busy flag isn't set after the panel closed.
 */
export function useCall() {
  const { busy } = useFeedback();
  const calls = useLabCalls();
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function call<T>(path: string, body: object, done: (r: T) => void) {
    setPending(true);
    calls.setError('');
    try {
      done(await apiAt<T>(path, { mode: calls.mode(), ...body }));
      void calls.refresh().catch(() => {});
    } catch (e) {
      calls.setError(e instanceof Error ? e : 'The request failed.');
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  return { pending, call, off: pending || Boolean(busy) };
}
/** How long ago `at` was, as words, ticking once a second in this text alone. */
export function Ago({ at }: { at: string }) {
  const now = useNow();
  return <>{ago(at, now)}</>;
}
/**
 * Whether `at` is more than `ms` ago. It renders its caller once more when
 * that time comes, not every second meanwhile.
 */
export function useOlderThan(at: string | undefined, ms: number): boolean {
  const due = at ? Date.parse(at) + ms : Number.NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (Number.isNaN(due)) return;
    const wait = due - Date.now();
    // Already past: say so on the next render, not a second later.
    if (wait <= 0) return void setNow(Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), wait + 1);
    return () => window.clearTimeout(timer);
  }, [due]);
  return !Number.isNaN(due) && now > due;
}
/** Prices only matter when they are spent: live mode only. */
export function Cost({ children }: { children: string }) {
  const { mode } = useView();
  return mode === 'live' ? <p className="micro cost">{children}</p> : null;
}
