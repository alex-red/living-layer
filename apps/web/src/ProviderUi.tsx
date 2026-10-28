import { useEffect, useState } from 'react';
import { runCost, type ProviderFailure } from '@livinglayer/domain';
import { dismissCall, useProviderCalls, type ProviderCall } from './activity';
import { usd } from './cost';

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** One provider call: its steps, a live clock, and how it ended. */
function CallRow({ call }: { call: ProviderCall }) {
  const running = !call.endedAt;
  // The tray re-renders while a call runs; the clock reads the time itself so it never starts stale.
  const elapsed = (call.endedAt ?? Date.now()) - call.startedAt;
  const cost = call.run ? runCost(call.run) : null;
  const usage = call.run?.usage;
  return (
    <li className={`ai-call ${running ? 'running' : call.outcome}`}>
      <div className="ai-call-head">
        <span className="ai-dot" aria-hidden="true" />
        <strong>{call.title}</strong>
        <span className={`ai-mode ${call.mode}`}>{call.mode === 'live' ? 'LIVE' : 'FIXTURE'}</span>
        <span className="ai-time">{seconds(elapsed)}</span>
        {!running && (
          <button className="ai-close" aria-label="Dismiss" onClick={() => dismissCall(call.id)}>
            ×
          </button>
        )}
      </div>
      <ol className="ai-steps">
        {call.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="ai-foot">
        {running
          ? call.mode === 'live'
            ? 'Waiting on Meta. Results are only kept once every step finishes.'
            : 'Fixture: answered offline, nothing is billed.'
          : call.outcome === 'failed'
            ? (call.message ?? 'Failed.')
            : [
                'Done',
                call.run?.model,
                usage && `${tokens(usage.inputTokens)} in · ${tokens(usage.outputTokens)} out`,
                cost != null && `≈ ${usd(cost)}`,
              ]
                .filter(Boolean)
                .join(' · ')}
      </p>
    </li>
  );
}

/**
 * Every call to an AI provider in one place, wherever it was started: what
 * it is doing, how long it has taken, and what it cost or why it failed.
 */
export function ProviderActivity() {
  const calls = useProviderCalls();
  const [, setTick] = useState(0);
  const running = calls.some((c) => !c.endedAt);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 100);
    return () => window.clearInterval(timer);
  }, [running]);
  // A finished call fades after a while; a failure lingers longer, and its
  // full story stays in the error card.
  useEffect(() => {
    const timers = calls
      .filter((c) => c.endedAt)
      .map((c) =>
        window.setTimeout(
          () => dismissCall(c.id),
          Math.max(0, c.endedAt! + (c.outcome === 'failed' ? 15000 : 6000) - Date.now()),
        ),
      );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [calls]);
  if (!calls.length) return null;
  return (
    <ul className="ai-activity" aria-label="AI provider calls" aria-live="polite">
      {calls.map((c) => (
        <CallRow key={c.id} call={c} />
      ))}
    </ul>
  );
}

/** What to try next, by the provider's stop reason or the error code. */
function hintFor(code?: string, detail?: ProviderFailure): string | null {
  switch (detail?.reason ?? code) {
    case 'max_output_tokens':
      return 'Try a closer photo with fewer things in it, or run it again.';
    case 'content_filter':
      return 'Try another photo.';
    case 'schema_mismatch':
    case 'invalid_json':
      return 'Run it again: Spark usually answers in the right shape on a second try.';
  }
  switch (code) {
    case 'rate_limit':
      return 'Wait a minute, then try again.';
    case 'authentication':
      return 'Check MODEL_API_KEY in the server’s .env.';
    case 'entitlement':
      return 'Check that this key can use the pinned model (META_SPARK_MODEL, META_SAM_MODEL).';
    case 'billing':
      return 'Check the Meta account’s billing.';
    case 'timeout':
      return 'Try a smaller photo, or raise META_TIMEOUT_MS in .env.';
    case 'connection':
    case 'local_unreachable':
      return 'Check the network and that the local server is running.';
    case 'spend_limit':
      return 'Raise the daily spending limit in Setup, or wait until midnight UTC.';
    case 'meta_not_ready':
      return 'Set MODEL_API_KEY and META_LIVE_ENABLED, or switch to Fixture.';
    case 'provider_error':
      return 'The provider had a problem on its side. Try again shortly.';
  }
  return null;
}

export interface Issue {
  message: string;
  code?: string;
  detail?: ProviderFailure;
  runId?: string;
}

/** An error as the person needs it: what failed, the provider's exact reason, and what to try. */
export function ErrorCard({
  issue,
  onInspect,
  onDismiss,
}: {
  issue: Issue;
  onInspect?: (runId: string) => void;
  onDismiss: () => void;
}) {
  const { detail } = issue;
  const hint = hintFor(issue.code, detail);
  const used = detail?.usage?.outputTokens;
  const [copied, setCopied] = useState(false);
  const facts: [string, string][] = [];
  if (detail) {
    facts.push(['PROVIDER', [detail.provider, detail.model].filter(Boolean).join(' · ')]);
    if (detail.step) facts.push(['STEP', detail.step]);
    if (detail.reason) facts.push(['STOPPED', detail.reason]);
    if (detail.httpStatus) facts.push(['HTTP', String(detail.httpStatus)]);
    if (detail.providerCode) facts.push(['CODE', detail.providerCode]);
    if (used != null)
      facts.push([
        'OUTPUT',
        `${used.toLocaleString()}${detail.maxOutputTokens ? ` / ${detail.maxOutputTokens.toLocaleString()}` : ''} tokens`,
      ]);
    if (detail.requestId) facts.push(['REQUEST', detail.requestId]);
  }
  return (
    <div className="error error-card" role="alert">
      <div className="error-head">
        <p>{issue.message}</p>
        <button className="ai-close" aria-label="Dismiss error" onClick={onDismiss}>
          ×
        </button>
      </div>
      {facts.length > 0 && (
        <dl className="error-facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {used != null && detail?.maxOutputTokens ? (
        <span className="token-meter" aria-hidden="true">
          <span style={{ width: `${Math.min(100, (used / detail.maxOutputTokens) * 100)}%` }} />
        </span>
      ) : null}
      {hint && <p className="error-hint">{hint}</p>}
      <div className="error-actions">
        {issue.runId && onInspect && (
          <button className="text-button" onClick={() => onInspect(issue.runId!)}>
            Inspect the failed run
          </button>
        )}
        <button
          className="text-button"
          onClick={() =>
            void navigator.clipboard
              .writeText(JSON.stringify(issue, null, 2))
              .then(() => setCopied(true))
              .catch(() => {})
          }
        >
          {copied ? 'Copied' : 'Copy details'}
        </button>
      </div>
    </div>
  );
}
