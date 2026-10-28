export async function api<T>(path: string, body?: unknown): Promise<T> {
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
  const data = await response.json();
  // The server's error code rides along, so callers can tell e.g. a lost mug from a failure.
  if (!response.ok)
    throw Object.assign(
      new Error(data.error?.message ?? 'The local server could not complete this request.'),
      { code: data.error?.code as string | undefined },
    );
  return data as T;
}
