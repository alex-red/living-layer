import type { z } from 'zod';

export class LabError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}

export function safeError(error: unknown): LabError {
  if (error instanceof LabError) return error;
  // Never serialize upstream exception messages: they can include tokens, URLs, or inputs.
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
  const known: Record<number, [string, string]> = {
    400: [
      'upstream_request',
      'The provider rejected the request. Check the pinned model and input format.',
    ],
    401: ['authentication', 'The provider rejected the credential. Check the server-side key.'],
    402: ['billing', 'The provider declined the request for billing reasons.'],
    403: ['entitlement', 'This account cannot access the requested model or resource.'],
    429: ['rate_limit', 'The provider rate-limited this request. Wait before trying again.'],
  };
  const mapped = known[status];
  if (mapped) return new LabError(mapped[0], mapped[1], 502);
  if (error instanceof Error && /timeout|abort/i.test(error.name)) {
    return new LabError(
      'timeout',
      'The request timed out. Its result was not accepted; no automatic retry was made.',
      504,
    );
  }
  return new LabError(
    'upstream_failure',
    'The operation failed. Check configuration and connectivity; sensitive provider details were not logged.',
    502,
  );
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new LabError('invalid_input', 'Request fields do not match this operation.');
  return parsed.data;
}
