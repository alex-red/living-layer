import type { z } from 'zod';
import type { ProviderFailure } from '@livinglayer/domain';

export class LabError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
    /** For a provider call: what the provider said, safe to show. */
    public detail?: ProviderFailure,
    /** What the page needs to carry on by hand, such as the marks a setup found. */
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const DEMO_IMAGE = 'Demo mode uses only the demo room’s camera.';
/** Demo mode draws its own picture: an uploaded image there is a mistake, not something to ignore. */
export function liveImage(mode: string, imageDataUrl: string | undefined, message = DEMO_IMAGE) {
  if (mode !== 'live' && imageDataUrl) throw new LabError('demo_image', message);
}

/**
 * A provider's code or type when it is an identifier (insufficient_quota,
 * model_not_found…). Free text never passes: it can echo keys or inputs.
 */
export function ident(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}
type UpstreamError = Error & {
  status?: number;
  code?: string | null;
  type?: string;
  requestID?: string | null;
  error?: { code?: string; type?: string } | null;
  cause?: { code?: string };
};

/** Writes a non-LabError's stack to the server's log; the client only gets a generic message. */
export function logError(error: unknown, where?: string) {
  if (error instanceof LabError) return;
  const text = error instanceof Error ? (error.stack ?? String(error)) : String(error);
  console.error(`[server] ${where ? `${where}: ` : ''}${text}`);
}

const NETWORK_CODE = /^(E[A-Z]+|ConnectionRefused|ConnectionClosed|FailedToOpenSocket|UND_ERR)/;

/** Whether an error is the SDK's or the platform's timeout or abort, by its name or class. */
export function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timeout|abort/i.test(`${error.name} ${error.constructor.name}`);
}

/** Whether an error came from the provider call or the network, not from our own code. */
function isUpstream(error: unknown, status: number): boolean {
  if (status) return true;
  if (!(error instanceof Error)) return false;
  const e = error as UpstreamError;
  if (isTimeout(e)) return true;
  if (/^API|connection/i.test(`${e.name} ${e.constructor.name}`)) return true;
  const code = e.code ?? e.cause?.code;
  return typeof code === 'string' && NETWORK_CODE.test(code);
}

export function safeError(error: unknown, step?: string): LabError {
  if (error instanceof LabError) return error;
  logError(error, step);
  // Never serialize upstream exception messages: they can include tokens, URLs, or inputs.
  // Only the HTTP status, identifier-like codes and the request id are kept.
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
  const e = (error instanceof Error ? error : null) as UpstreamError | null;
  const code = ident(e?.error?.code ?? e?.code ?? e?.cause?.code);
  const type = ident(e?.error?.type ?? e?.type);
  const detail: ProviderFailure | undefined = e
    ? {
        provider: 'Meta',
        ...(step ? { step } : {}),
        ...(status ? { httpStatus: status } : {}),
        requestId: ident(e.requestID) ?? null,
        ...(code || type ? { providerCode: [code, type].filter(Boolean).join(' · ') } : {}),
      }
    : undefined;
  // The status and the provider's code, appended so the sentence says exactly what came back.
  const facts = [status && `HTTP ${status}`, code ?? type].filter(Boolean).join(', ');
  const exact = (message: string) =>
    facts ? `${message.replace(/\.$/, '')} (${facts}).` : message;
  const known: Record<number, [string, string]> = {
    400: [
      'upstream_request',
      'The provider rejected the request. Check the pinned model and input format.',
    ],
    401: ['authentication', 'The provider rejected the credential. Check the server-side key.'],
    402: ['billing', 'The provider declined the request for billing reasons.'],
    403: ['entitlement', 'This account cannot access the requested model or resource.'],
    404: [
      'not_found',
      'The provider does not know this model or endpoint. Check the pinned model.',
    ],
    413: ['too_large', 'The provider refused the request as too large. Try a smaller photo.'],
    429: ['rate_limit', 'The provider rate-limited this request. Wait before trying again.'],
  };
  if (!isUpstream(error, status))
    return new LabError('internal', 'The server hit an unexpected error. See the server log.', 500);
  const mapped = known[status];
  if (mapped) return new LabError(mapped[0], exact(mapped[1]), 502, detail);
  // The SDK's timeout error keeps the name `Error`; its class says what it is.
  if (isTimeout(error)) {
    return new LabError(
      'timeout',
      'The request timed out. Its result was not accepted; no automatic retry was made.',
      504,
      detail,
    );
  }
  if (status >= 500)
    return new LabError(
      'provider_error',
      exact('The provider had an internal error. Try again in a moment.'),
      502,
      detail,
    );
  if (e && /connection/i.test(e.name))
    return new LabError(
      'connection',
      exact('The provider could not be reached. Check the network connection.'),
      502,
      detail,
    );
  return new LabError(
    'upstream_failure',
    exact(
      `The operation failed${e?.name && e.name !== 'Error' ? ` (${e.name})` : ''}. Check configuration and connectivity; sensitive provider details were not logged.`,
    ),
    502,
    detail,
  );
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new LabError('invalid_input', 'Request fields do not match this operation.');
  return parsed.data;
}
