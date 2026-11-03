import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig } from '../apps/server/src/config.js';
import Fastify from 'fastify';
import { jobRoutes, Jobs, type JobHistory } from '../apps/server/src/jobs.js';

afterEach(() => setSystemTime());

describe('jobs', () => {
  it('keeps a finished job stoppable, and sweeps a stale one after ten minutes', () => {
    const jobs = new Jobs();
    const one = crypto.randomUUID();
    const two = crypto.randomUUID();
    const steps = [{ id: 'a', label: 'A' }];
    jobs.start(one, steps).finish();
    const running = jobs.start(two, steps);
    // A finished job can still be asked to stop: it answers, unchanged, until it is swept.
    expect(jobs.stop(one)).toBe(true);
    expect(jobs.get(one)).toMatchObject({ done: true, outcome: 'done' });
    expect(jobs.stop(crypto.randomUUID())).toBe(false);
    // Eleven minutes on, the next start sweeps the abandoned one.
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    jobs.start(undefined, steps);
    expect(jobs.get(two)).toBeNull();
    expect((jobs as unknown as { trackers: Map<string, unknown> }).trackers.has(two)).toBe(false);
    expect(running.stopped).toBe(false);
  });

  it('are kept per app, with the routes in jobs.ts', async () => {
    const dirs = [0, 1].map(() => mkdtempSync(join(tmpdir(), 'livinglayer-jobs-')));
    const [a, b] = await Promise.all(
      dirs.map((dataDir) => buildApp(parseConfig({ DATA_DIR: dataDir }), { serveWeb: false })),
    );
    const id = crypto.randomUUID();
    // Not running in either app: both answer the same, and neither knows the other's jobs.
    expect((await a!.inject(`/api/jobs/${id}`)).statusCode).toBe(404);
    expect((await b!.inject({ method: 'POST', url: `/api/jobs/${id}/stop` })).statusCode).toBe(404);
    await a!.close();
    await b!.close();
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  describe('event stream', () => {
    const history: JobHistory = { saveJob() {}, getJob: () => undefined, listJobs: () => [] };
    async function serve(jobs: Jobs) {
      const app = Fastify();
      await app.register((scope) => jobRoutes(scope, jobs, history), { prefix: '/api/jobs' });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as { port: number };
      return { app, url: `http://127.0.0.1:${port}/api/jobs` };
    }
    /** Read data frames from the stream until it ends. */
    async function frames(response: Response, onFrame: (job: { done: boolean }) => void) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let rest = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        rest += decoder.decode(value);
        const parts = rest.split('\n\n');
        rest = parts.pop() ?? '';
        for (const part of parts) if (part.startsWith('data: ')) onFrame(JSON.parse(part.slice(6)));
      }
    }

    it('sends the job as it changes and ends with it', async () => {
      const jobs = new Jobs();
      const { app, url } = await serve(jobs);
      const id = crypto.randomUUID();
      const tracker = jobs.start(id, [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ]);
      const response = await fetch(`${url}/${id}/events`);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const seen: string[] = [];
      const reading = frames(response, (job) =>
        seen.push(
          (job as unknown as { steps: { state: string }[] }).steps.map((s) => s.state[0]).join('') +
            (job.done ? '!' : ''),
        ),
      );
      await Bun.sleep(30);
      tracker.run('a');
      await tracker.done('a');
      tracker.run('b');
      tracker.finish();
      await reading;
      expect(seen[0]).toBe('ww');
      expect(seen).toContain('rw');
      expect(seen).toContain('dr');
      expect(seen.at(-1)).toBe('dr!');
      await app.close();
    });

    it('answers a finished job once, 404s an unknown one, and lets go when the reader leaves', async () => {
      const jobs = new Jobs();
      const { app, url } = await serve(jobs);
      const ended = crypto.randomUUID();
      jobs.start(ended, [{ id: 'a', label: 'A' }]).finish();
      const seen: boolean[] = [];
      await frames(await fetch(`${url}/${ended}/events`), (job) => seen.push(job.done));
      expect(seen).toEqual([true]);
      expect((await fetch(`${url}/${crypto.randomUUID()}/events`)).status).toBe(404);

      const running = crypto.randomUUID();
      const tracker = jobs.start(running, [{ id: 'a', label: 'A' }]);
      const controller = new AbortController();
      const response = await fetch(`${url}/${running}/events`, { signal: controller.signal });
      await response.body!.getReader().read();
      const listeners = () => (tracker as unknown as { listeners: Set<unknown> }).listeners.size;
      expect(listeners()).toBe(1);
      controller.abort();
      await Bun.sleep(50);
      expect(listeners()).toBe(0);
      await app.close();
    });
  });
});
