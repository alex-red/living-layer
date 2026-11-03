import { describe, expect, it } from 'bun:test';
import Fastify from 'fastify';
import { requestSignal, watchRequest } from '../apps/server/src/request-signal.js';

describe('requestSignal', () => {
  it('aborts when the client goes away, and not when the reply goes out', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (request, reply) => watchRequest(request, reply));
    const seen: AbortSignal[] = [];
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    app.get('/slow', async (request) => {
      const signal = requestSignal(request);
      seen.push(signal);
      started();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return 'done';
    });
    app.get('/quick', async (request) => {
      seen.push(requestSignal(request));
      return 'ok';
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    await (await fetch(`${base}/quick`)).text();
    expect(seen[0]!.aborted).toBe(false);

    const client = new AbortController();
    const call = fetch(`${base}/slow`, { signal: client.signal }).catch(() => null);
    await running;
    expect(seen[1]!.aborted).toBe(false);
    client.abort();
    await call;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen[1]!.aborted).toBe(true);
    await app.close();
  });

  it('gives a signal that never aborts when the request was not watched', () => {
    expect(requestSignal({} as never).aborted).toBe(false);
  });
});
