import type {
  ApiBody,
  ApiPath,
  ApiResponse,
  EvidenceRun,
  ProviderFailure,
} from '@livinglayer/domain';
import { ApiError, endCall, startCall } from './activity';

export { ApiError };

interface ApiOptions {
  signal?: AbortSignal;
  /** POST when there is a body, else GET; say it for a bodiless POST or a DELETE. */
  method?: 'GET' | 'POST' | 'DELETE';
}

/**
 * Call a route the lab's server has (`ApiRoutes` in domain): the body and the
 * answer take the route's types. A path built at run time goes through `apiAt`.
 */
export function api<P extends ApiPath>(
  path: P,
  body?: ApiBody<P>,
  options?: ApiOptions,
): Promise<ApiResponse<P>>;
export function api(path: string, body?: unknown, options?: ApiOptions): Promise<unknown> {
  return apiAt(path, body, options);
}

/** `api` for a path built at run time, whose answer the caller types. */
export async function apiAt<T>(path: string, body?: unknown, options: ApiOptions = {}): Promise<T> {
  const { data } = await send(path, body, options, async (response) => {
    const data = await response.json().catch(() => ({}));
    return { data, run: (data?.kind ? data : data?.run) as EvidenceRun | undefined };
  });
  return data as T;
}

/**
 * A GET that sends the entity tag of the answer the caller already has: the
 * new answer and its tag, or `null` when the server says nothing changed (304).
 */
export async function apiIfChanged<P extends ApiPath>(
  path: P,
  tag: string | undefined,
  options: Pick<ApiOptions, 'signal'> = {},
): Promise<{ data: ApiResponse<P>; tag: string | undefined } | null> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      signal: options.signal,
      cache: 'no-store',
      ...(tag ? { headers: { 'If-None-Match': tag } } : {}),
    });
  } catch {
    throw new ApiError(
      'The local server could not be reached. Is it running (bun run dev)?',
      'local_unreachable',
    );
  }
  if (response.status === 304) return null;
  if (!response.ok) return { data: await apiAt<ApiResponse<P>>(path), tag: undefined };
  return {
    data: (await response.json()) as ApiResponse<P>,
    tag: response.headers.get('ETag') ?? undefined,
  };
}

/** A route that answers with a file, not JSON (a stored photo): the bytes, with `api`'s error handling. */
export async function apiBlob(path: string, options: ApiOptions = {}): Promise<Blob> {
  const { data } = await send(path, undefined, options, async (response) => ({
    data: await response.blob(),
  }));
  return data;
}

async function send<D>(
  path: string,
  body: unknown,
  { signal, method }: ApiOptions,
  read: (response: Response) => Promise<{ data: D; run?: EvidenceRun | undefined }>,
): Promise<{ data: D; run?: EvidenceRun | undefined }> {
  const call = body ? startCall(path, body as Record<string, unknown>) : null;
  try {
    const response = await fetch(
      // A path the server gave (a camera's `snapshot`) already starts with /api/.
      path.startsWith('/api/') ? path : `/api/${path}`,
      body
        ? {
            method: method ?? 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
          }
        : { method: method ?? 'GET', signal },
    );
    if (!response.ok) {
      const failed = (await response.json().catch(() => ({}))) as {
        error?: {
          message?: string;
          code?: string;
          detail?: ProviderFailure;
          runId?: string;
          data?: Record<string, unknown>;
        };
      };
      // A gateway error with no answer of the server's own is the dev proxy's: the server went
      // away mid-request (it reloads when its code changes). Say so, and whether it is back.
      if (!failed.error && [502, 503, 504].includes(response.status)) throw await serverGone();
      // The server's error code rides along, so callers can tell e.g. a lost mug from a failure.
      throw new ApiError(
        failed.error?.message ??
          `The local server could not complete this request (HTTP ${response.status}).`,
        failed.error?.code,
        failed.error?.detail,
        failed.error?.runId,
        failed.error?.data,
      );
    }
    const result = await read(response);
    // A provider route answers with its run, or with a run inside a bigger result.
    endCall(call, { run: result.run });
    return result;
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
 * How long to wait for the server to come back after it went away
 * mid-request, and how often to ask. A module value so tests can shorten it.
 */
export const serverWait = { backWithinMs: 6000, pollMs: 1000 };
/**
 * What to say when the server stopped answering mid-request: it restarts
 * when its code changes, so it is usually back in a few seconds. Waits that
 * long for it, so the message can say whether trying again will work.
 */
async function serverGone(): Promise<ApiError> {
  const until = Date.now() + serverWait.backWithinMs;
  while (Date.now() < until) {
    const up = await fetch('/api/status')
      .then((r) => r.ok)
      .catch(() => false);
    if (up)
      return new ApiError(
        'The lab’s server restarted while this ran (it reloads when its code changes), so the request was dropped and nothing was saved. It is back now: try again.',
        'server_restarted',
      );
    await new Promise((r) => setTimeout(r, serverWait.pollMs));
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
