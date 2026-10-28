import type { EvidenceRun } from '@livinglayer/domain';
import { ApiError, endCall, startCall } from './activity';

export { ApiError };

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const call = body ? startCall(path, body as Record<string, unknown>) : null;
  try {
    const response = await fetch(
      `/api/${path}`,
      body
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {},
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
        : new ApiError(
            'The local server could not be reached. Is it running (bun run dev)?',
            'local_unreachable',
          );
    endCall(call, { error: error.message });
    throw error;
  }
}
