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
    // The server's error code rides along, so callers can tell e.g. a lost mug from a failure.
    if (!response.ok)
      throw new ApiError(
        data.error?.message ??
          `The local server could not complete this request (HTTP ${response.status}).`,
        data.error?.code,
        data.error?.detail,
        data.error?.runId,
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

/**
 * Run an AI call that reports its steps under a job id, followed in the AI
 * dialog until it ends, where it can be stopped. Resolves to its answer, or
 * null when it was stopped.
 */
export type AiFollow = <T>(
  task: { title: string; description?: string },
  call: (jobId: string, signal: AbortSignal) => Promise<T>,
) => Promise<T | null>;
