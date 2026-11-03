import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig } from '../apps/server/src/config.js';
import { Jobs } from '../apps/server/src/jobs.js';

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
});
