import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { api, apiAt, apiBlob, serverWait, type ApiError } from '../apps/web/src/api.js';

const real = globalThis.fetch;
const wait = { ...serverWait };
// The server never comes back in these tests: don't wait six real seconds to say so.
beforeEach(() => Object.assign(serverWait, { backWithinMs: 30, pollMs: 5 }));
afterEach(() => {
  globalThis.fetch = real;
  Object.assign(serverWait, wait);
});
/** The page's fetch: the request answered with `first`, then /api/status with `status`. */
const serve = (first: Response, status: () => Response | Promise<Response>) => {
  globalThis.fetch = mock(async (url: string | URL | Request) =>
    String(url) === '/api/status' ? status() : first,
  ) as unknown as typeof fetch;
};

describe('the page’s API client', () => {
  it('says the server restarted mid-request, not a bare 502, once it answers again', async () => {
    serve(new Response('', { status: 502 }), () => Response.json({ ok: true }));
    const e = (await apiAt('assist', { prompt: 'x' }).catch((x: ApiError) => x)) as ApiError;
    expect(e.code).toBe('server_restarted');
    expect(e.message).toContain('restarted while this ran');
    expect(e.message).toContain('try again');
  });

  it('says it isn’t back when it doesn’t answer', async () => {
    serve(new Response('', { status: 502 }), () => Promise.reject(new Error('refused')));
    const e = (await apiAt('assist', { prompt: 'x' }).catch((x: ApiError) => x)) as ApiError;
    expect(e.code).toBe('server_down');
  });

  it('keeps the server’s own error when it sent one', async () => {
    serve(
      Response.json(
        { error: { message: 'Spark is overloaded.', code: 'upstream_failure' } },
        { status: 502 },
      ),
      () => Response.json({ ok: true }),
    );
    const e = (await apiAt('assist', { prompt: 'x' }).catch((x: ApiError) => x)) as ApiError;
    expect([e.code, e.message]).toEqual(['upstream_failure', 'Spark is overloaded.']);
  });

  it('sends the method asked for, and a path the server gave starts at /api/ already', async () => {
    const seen: [string, string | undefined][] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push([String(url), init?.method]);
      return Response.json({ pairing: null });
    }) as unknown as typeof fetch;
    await api('remote', undefined, { method: 'DELETE' });
    await api('remote');
    await api('remote/pair', {});
    await apiBlob('/api/cameras/a/snapshot');
    expect(seen).toEqual([
      ['/api/remote', 'DELETE'],
      ['/api/remote', 'GET'],
      ['/api/remote/pair', 'POST'],
      ['/api/cameras/a/snapshot', 'GET'],
    ]);
  });

  it('gives a file route the same errors', async () => {
    serve(
      Response.json(
        { error: { message: 'No photo kept.', code: 'photo_missing' } },
        { status: 404 },
      ),
      () => Response.json({ ok: true }),
    );
    const e = (await apiBlob('scene/photo?mode=live').catch((x: ApiError) => x)) as ApiError;
    expect([e.code, e.message]).toEqual(['photo_missing', 'No photo kept.']);
  });
});
