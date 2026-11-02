import { afterEach, describe, expect, it, mock } from 'bun:test';
import { api, type ApiError } from '../apps/web/src/api.js';

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
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
    const e = (await api('assist', { prompt: 'x' }).catch((x: ApiError) => x)) as ApiError;
    expect(e.code).toBe('server_restarted');
    expect(e.message).toContain('restarted while this ran');
    expect(e.message).toContain('try again');
  });

  it('says it isn’t back when it doesn’t answer', async () => {
    serve(new Response('', { status: 502 }), () => Promise.reject(new Error('refused')));
    const e = (await api('assist', { prompt: 'x' }).catch((x: ApiError) => x)) as ApiError;
    expect(e.code).toBe('server_down');
  }, 15_000);

  it('keeps the server’s own error when it sent one', async () => {
    serve(
      Response.json(
        { error: { message: 'Spark is overloaded.', code: 'upstream_failure' } },
        { status: 502 },
      ),
      () => Response.json({ ok: true }),
    );
    const e = (await api('assist', { prompt: 'x' }).catch((x: ApiError) => x)) as ApiError;
    expect([e.code, e.message]).toEqual(['upstream_failure', 'Spark is overloaded.']);
  });
});
