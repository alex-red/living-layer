import type { EvidenceRun } from '@livinglayer/domain';
import { ApiError, endCall, startCall } from './activity';

export { ApiError };

export async function api<T>(
  path: string,
  body?: unknown,
  { signal }: { signal?: AbortSignal } = {},
): Promise<T> {
  const call = body ? startCall(path, body as Record<string, unknown>) : null;
  try {
    const response = await fetch(
      `/api/${path}`,
      body
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
          }
        : { signal },
    );
    const data = await response.json().catch(() => ({}));
    // A gateway error with no answer of the server's own is the dev proxy's: the server went
    // away mid-request (it reloads when its code changes). Say so, and whether it is back.
    if (!response.ok && !data.error && [502, 503, 504].includes(response.status))
      throw await serverGone();
    // The server's error code rides along, so callers can tell e.g. a lost mug from a failure.
    if (!response.ok)
      throw new ApiError(
        data.error?.message ??
          `The local server could not complete this request (HTTP ${response.status}).`,
        data.error?.code,
        data.error?.detail,
        data.error?.runId,
        data.error?.data,
      );
    // A provider route answers with its run, or with a run inside a bigger result.
    const run = (data?.kind ? data : data?.run) as EvidenceRun | undefined;
    endCall(call, { run });
    return data as T;
  } catch (e) {
    const error =
      e instanceof ApiError
        ? e
        : signal?.aborted
          ? new ApiError('Stopped. Nothing was saved.', 'stopped')
          : new ApiError(
              'The local server could not be reached. Is it running (bun run dev)?',
              'local_unreachable',
            );
    endCall(call, { error: error.message });
    throw error;
  }
}

/** How long to wait for the server to come back after it went away mid-request. */
const BACK_WITHIN_MS = 6000;
/**
 * What to say when the server stopped answering mid-request: it restarts
 * when its code changes, so it is usually back in a few seconds. Waits that
 * long for it, so the message can say whether trying again will work.
 */
async function serverGone(): Promise<ApiError> {
  const until = Date.now() + BACK_WITHIN_MS;
  while (Date.now() < until) {
    const up = await fetch('/api/status')
      .then((r) => r.ok)
      .catch(() => false);
    if (up)
      return new ApiError(
        'The lab’s server restarted while this ran (it reloads when its code changes), so the request was dropped and nothing was saved. It is back now: try again.',
        'server_restarted',
      );
    await new Promise((r) => setTimeout(r, 1000));
  }
  return new ApiError(
    'The lab’s server stopped while this ran and isn’t back yet. Nothing was saved. If it doesn’t come back in a moment, check its terminal or start it again (bun run dev).',
    'server_down',
  );
}

/**
 * Run an AI call that reports its steps under a job id, followed in the AI
 * dialog until it ends, where it can be stopped. Resolves to its answer, or
 * null when it was stopped.
 */
export type AiFollow = <T>(
  task: { title: string; description?: string },
  call: (jobId: string, signal: AbortSignal) => Promise<T>,
) => Promise<T | null>;
