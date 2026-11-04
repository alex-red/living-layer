import { staticBackend, type StaticSeed } from './backend';

/**
 * The static demo (a build with `VITE_STATIC_DEMO`, as GitHub Pages serves it):
 * every `/api/` call is answered in the page by `staticBackend`, from the seed
 * `bun run static-demo` saved beside the build. Server-sent events are left
 * out, so what follows them falls back to asking (`watch.ts`, `follow-job.ts`).
 */
export async function installStaticDemo() {
  const seed = (await (
    await fetch(`${import.meta.env.BASE_URL}static-demo/seed.json`)
  ).json()) as StaticSeed;
  const backend = staticBackend(seed);
  const pass = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/'))
      return pass(input, init);
    const text = request.method === 'GET' ? '' : await request.text();
    const reply = backend.handle(
      request.method,
      url.pathname.slice('/api/'.length) + url.search,
      text ? JSON.parse(text) : undefined,
      { ifNoneMatch: request.headers.get('If-None-Match') ?? undefined },
    );
    // Answered after a tick, as a server would, so a save doesn't land inside the render that asked.
    await new Promise((r) => setTimeout(r, 0));
    return new Response(reply.status === 304 ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json', ...reply.headers },
    });
  }) as typeof fetch;
  Object.defineProperty(window, 'EventSource', { value: undefined, configurable: true });
}
