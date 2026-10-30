import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { readUi, writeUi } from '../session';
import { useLab } from './LabContext';

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
/** One request from the inspector, with its own busy flag. */
export function useCall() {
  const lab = useLab();
  const [pending, setPending] = useState(false);
  async function call<T>(path: string, body: object, done: (r: T) => void) {
    setPending(true);
    lab.setError('');
    try {
      done(await api<T>(path, { mode: lab.mode, ...body }));
      void lab.refresh().catch(() => {});
    } catch (e) {
      lab.setError(e instanceof Error ? e : 'The request failed.');
    } finally {
      setPending(false);
    }
  }
  return { pending, call, off: pending || Boolean(lab.busy) };
}
/** Prices only matter when they are spent: live mode only. */
export function Cost({ children }: { children: string }) {
  const { mode } = useLab();
  return mode === 'live' ? <p className="micro cost">{children}</p> : null;
}
