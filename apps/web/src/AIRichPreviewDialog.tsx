import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton } from './ui/controls';
import './ai-rich-preview.css';

/** A step's picture narrower than this is enlarged with crisp pixels. */
const SMALL_PICTURE_PX = 160;

export type AIStepState = 'pending' | 'running' | 'done' | 'failed' | 'stopped';
export type AITaskStatus = 'running' | 'done' | 'failed' | 'stopped';

/** One step of a long AI action, as the dialog lists it. */
export interface AIStep {
  id: string;
  label: string;
  state: AIStepState;
  /** What the step found or is doing, in a short line. */
  detail?: string;
  /** A picture of what the step sent or made, as a URL. */
  image?: string;
  /** When it started and ended: ISO strings or epoch milliseconds. */
  startedAt?: string | number;
  endedAt?: string | number;
}

export interface AIRichPreviewDialogProps {
  open: boolean;
  title: string;
  /** One line under the title: what the action is and what it costs. */
  description?: string;
  steps: AIStep[];
  status: AITaskStatus;
  /** The step the preview follows; by default the running one, else the last with a picture. */
  currentStepId?: string;
  /** Replaces the preview of the current step's picture. */
  preview?: ReactNode;
  /** Why it failed, shown when `status` is failed. */
  error?: string;
  /** When the action started, for the total time. */
  startedAt?: string | number;
  /** Cancel the work. Called from the Stop button, or Escape while it runs. */
  onStop: () => void;
  /** Close the dialog once the work has ended. */
  onClose: () => void;
  /** Hide the dialog and let the work go on; without it the dialog stays until the end. */
  onHide?: () => void;
  /** A past run opened to look back at: read-only, dated, with nothing to stop. */
  review?: boolean;
  /** Replaces the foot's note once the work has ended, such as links to the runs it made. */
  footer?: ReactNode;
  /**
   * What to do next once the work has ended, such as finishing by hand what it
   * couldn't. A `quiet` one, such as taking the work back, sits beside Close
   * and takes no focus, so Enter never runs it.
   */
  action?: { label: string; onClick: () => void; quiet?: boolean };
}

const time = (t: string | number | undefined) =>
  t === undefined ? null : typeof t === 'number' ? t : Date.parse(t);
const seconds = (ms: number) => (ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000));
const when = (t: number) =>
  new Date(t).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const HEADLINE: Record<AITaskStatus, string> = {
  running: 'Working',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

/**
 * What the AI is doing during a long action, step by step: each step's state
 * and time, a live preview of what it sent or made, and a Stop that works at
 * any moment. A modal `<dialog>`, so focus stays inside it; Escape stops the
 * work while it runs and closes the dialog after.
 */
export function AIRichPreviewDialog({
  open,
  title,
  description,
  steps,
  status,
  currentStepId,
  preview,
  error,
  startedAt,
  onStop,
  onClose,
  action,
  onHide,
  review = false,
  footer,
}: AIRichPreviewDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const running = status === 'running' && !review;
  // Only the clocks tick (`Elapsed`), so the dialog and its steps render when the work changes.
  const ticking = open && running;
  // A step the person picked to look at, until they go back to following.
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    if (!open) setPicked(null);
  }, [open]);

  const { live, shown, picture, finished, index, lastEnd } = useMemo(() => {
    const live =
      steps.find((s) => s.id === currentStepId) ??
      steps.find((s) => s.state === 'running') ??
      steps.findLast((s) => s.image) ??
      steps.find((s) => s.state === 'failed' || s.state === 'stopped');
    const shown = steps.find((s) => s.id === picked) ?? live;
    const index = shown ? steps.indexOf(shown) + 1 : 0;
    return {
      live,
      shown,
      // The newest picture up to the shown step, so a step without one keeps the last.
      picture: steps.slice(0, index).findLast((s) => s.image),
      finished: steps.filter((s) => s.state === 'done').length,
      index,
      lastEnd: Math.max(0, ...steps.map((s) => time(s.endedAt) ?? 0)),
    };
  }, [steps, currentStepId, picked]);
  const start = time(startedAt) ?? time(steps[0]?.startedAt);
  const announce = running
    ? live
      ? `Step ${steps.indexOf(live) + 1} of ${steps.length}: ${live.label}`
      : 'Starting'
    : status === 'done'
      ? `${title}: done`
      : status === 'stopped'
        ? `${title}: stopped`
        : `${title} failed${error ? `: ${error}` : ''}`;

  return (
    <dialog
      ref={ref}
      className={`aip-dialog ${status} ${review ? 'review' : ''}`}
      aria-labelledby={titleId}
      aria-busy={running}
      onKeyDown={(e) => {
        // Keys stay in the dialog, so the page's shortcuts don't act behind it.
        e.stopPropagation();
        if (e.key !== 'Escape') return;
        // Escape: stop the work first; once it has ended, close.
        e.preventDefault();
        if (running) onStop();
        else onClose();
      }}
      onCancel={(e) => {
        // The browser's own close request (Escape) goes the same way.
        e.preventDefault();
        if (running) onStop();
        else onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop closes only once nothing is running.
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div className="aip-dialog-body">
        <header className="aip-head">
          <div className="aip-head-text">
            <span className="tiny aip-kicker">
              <span className="aip-kicker-dot" aria-hidden="true" />
              {review ? `Past run · ${HEADLINE[status]}` : HEADLINE[status]}
              {review && start !== null && <span className="aip-clock">{when(start)}</span>}
              {start !== null && (
                <span className="aip-clock">
                  <Elapsed from={start} to={running ? null : lastEnd || null} live={ticking} />
                </span>
              )}
            </span>
            <h2 id={titleId}>{title}</h2>
            {description && <p className="micro">{description}</p>}
          </div>
          {!running && (
            <IconButton label="Close" onClick={onClose}>
              ×
            </IconButton>
          )}
        </header>
        <div
          className="aip-meter"
          role="progressbar"
          aria-label="Steps done"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={finished}
          aria-valuetext={`${finished} of ${steps.length} steps done`}
        >
          {steps.map((s) => (
            <span key={s.id} className={`aip-meter-seg ${s.state}`} />
          ))}
        </div>

        <div className="aip-main">
          <figure className={`aip-stage ${shown?.state ?? 'pending'}`}>
            <div className="aip-stage-frame">
              {preview ??
                (picture?.image ? (
                  <img
                    key={picture.image}
                    className="aip-stage-image"
                    src={picture.image}
                    onLoad={(e) =>
                      e.currentTarget.classList.toggle(
                        'small',
                        e.currentTarget.naturalWidth < SMALL_PICTURE_PX,
                      )
                    }
                    alt={`${picture.label}${picture.detail ? `: ${picture.detail}` : ''}`}
                  />
                ) : (
                  <div className="aip-stage-empty" aria-hidden="true">
                    <span className="aip-stage-grid" />
                  </div>
                ))}
              {running && shown?.state === 'running' && (
                <span className="aip-scan" aria-hidden="true" />
              )}
              <span className="aip-corners" aria-hidden="true" />
            </div>
            <figcaption>
              <span className="tiny">
                {shown ? `Step ${index} / ${steps.length}` : 'Starting'}
                {picked && live && picked !== live.id && running && (
                  <button className="aip-follow" onClick={() => setPicked(null)}>
                    Follow live
                  </button>
                )}
              </span>
              <span className="aip-caption">
                {shown?.label ?? 'Waiting for the first step'}
                {shown?.detail && <small>{shown.detail}</small>}
              </span>
            </figcaption>
          </figure>

          <StepList
            steps={steps}
            shownId={shown?.id}
            liveId={live?.id}
            ticking={ticking}
            onPick={setPicked}
          />
        </div>

        {status === 'failed' && error && (
          <p className="aip-error" role="alert">
            {error}
          </p>
        )}
        <p className="aip-sr" aria-live="polite">
          {announce}
        </p>

        <footer className="aip-foot">
          <span className="micro aip-foot-note">
            {!running && footer
              ? footer
              : running
                ? 'Esc or Stop cancels it. Nothing is saved until the last step.'
                : status === 'stopped'
                  ? 'Stopped. Nothing was saved.'
                  : status === 'done'
                    ? 'Saved.'
                    : 'Nothing was saved.'}
          </span>
          <span className="aip-actions">
            {running ? (
              <>
                {onHide && (
                  <Button variant="ghost" onClick={onHide}>
                    Hide
                  </Button>
                )}
                <Button className="aip-stop" onClick={onStop} autoFocus>
                  <span className="aip-stop-glyph" aria-hidden="true" />
                  Stop
                </Button>
              </>
            ) : action?.quiet ? (
              <>
                <Button onClick={action.onClick}>{action.label}</Button>
                <Button variant="primary" onClick={onClose} autoFocus>
                  {status === 'done' && !review ? 'Done' : 'Close'}
                </Button>
              </>
            ) : action ? (
              <>
                <Button onClick={onClose}>Close</Button>
                <Button variant="primary" onClick={action.onClick} autoFocus>
                  {action.label}
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={onClose} autoFocus>
                {status === 'done' && !review ? 'Done' : 'Close'}
              </Button>
            )}
          </span>
        </footer>
      </div>
    </dialog>
  );
}

/** The steps, each with its state and time. Drawn again when the work changes, not as the clock ticks. */
const StepList = memo(function StepList({
  steps,
  shownId,
  liveId,
  ticking,
  onPick,
}: {
  steps: AIStep[];
  shownId?: string;
  liveId?: string;
  ticking: boolean;
  onPick: (id: string | null) => void;
}) {
  return (
    <ol className="aip-steps">
      {steps.map((s, i) => {
        const from = time(s.startedAt);
        const to = time(s.endedAt);
        const body = (
          <>
            <span className="aip-mark" aria-hidden="true">
              {s.state === 'done'
                ? '✓'
                : s.state === 'failed'
                  ? '✕'
                  : s.state === 'stopped'
                    ? '■'
                    : s.state === 'pending'
                      ? i + 1
                      : ''}
            </span>
            <span className="aip-step-text">
              <strong>{s.label}</strong>
              {s.detail && <small>{s.detail}</small>}
            </span>
            <span className="aip-step-side">
              {s.image && <img src={s.image} alt="" />}
              <span className="aip-step-time">
                {from !== null &&
                  s.state !== 'pending' &&
                  (to !== null || s.state === 'running') && (
                    <Elapsed from={from} to={to} live={ticking} />
                  )}
              </span>
            </span>
            <span className="aip-sr">, {s.state}</span>
          </>
        );
        return (
          <li
            key={s.id}
            className={`aip-step ${s.state} ${shownId === s.id ? 'shown' : ''}`}
            aria-current={s.state === 'running' ? 'step' : undefined}
          >
            {s.image ? (
              <button
                className="aip-step-row"
                aria-pressed={shownId === s.id}
                onClick={() => onPick(s.id === liveId ? null : s.id)}
              >
                {body}
              </button>
            ) : (
              <div className="aip-step-row">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
});

/** Seconds from `from` to `to`, or to now, ticking while `live`, when `to` is null. */
function Elapsed({ from, to, live }: { from: number; to: number | null; live: boolean }) {
  const now = useClock(live && to === null);
  return <>{seconds(Math.max(0, (to ?? now) - from))}s</>;
}

/** The time now, ticking while `on`, for the running step's clock. */
function useClock(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}
