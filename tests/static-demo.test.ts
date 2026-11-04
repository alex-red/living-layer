import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_LIGHTS, type DeskMemory, type EvidenceRun, type Fixture } from '@livinglayer/domain';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig } from '../apps/server/src/config.js';
import { staticBackend, type StaticSeed } from '../apps/web/src/static-demo/backend.js';
import { captureSeed } from '../scripts/lib/static-demo-seed.js';

// The web demo answers in the page what the lab server answers on the same demo.

const AT = Date.parse('2026-11-04T15:30:00');

// One server for the file, its demo put back before each test: a fresh one per test took 14 s.
const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-static-demo-'));
let app: Awaited<ReturnType<typeof buildApp>>;
let seed: StaticSeed;
beforeAll(async () => {
  app = await buildApp(parseConfig({ DATA_DIR: dataDir }), { serveWeb: false, vision: null });
  seed = await captureSeed(app, AT);
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function both() {
  const post = (path: string, body: object = {}) =>
    app.inject({ method: 'POST', url: `/api/${path}`, payload: { mode: 'demo', ...body } });
  const memory = async () =>
    (await app.inject({ method: 'GET', url: '/api/desk/demo' })).json<DeskMemory>();
  await post('desk/restore', { memory: seed.get['desk/demo'] });
  return { lab: { post, memory }, page: staticBackend(seed, { now: () => AT }) };
}

/** A desk's things without the moments they were saved, which differ between the two. */
const things = (memory: DeskMemory) =>
  (memory.fixtures ?? []).map(({ updatedAt: _u, createdAt: _c, ...f }) => f);
const named = (memory: DeskMemory, label: string) =>
  memory.fixtures!.find((f) => f.label === label) as Fixture;

describe('static demo', () => {
  it('starts from the demo as a reset leaves it', async () => {
    const { lab, page } = await both();
    expect(page.handle('GET', 'desk/demo').body).toEqual(await lab.memory());
  });

  it('answers an unchanged desk with 304 for its tag', async () => {
    const { page } = await both();
    const first = page.handle('GET', 'desk/demo');
    const again = page.handle('GET', 'desk/demo', undefined, { ifNoneMatch: first.headers!.ETag });
    expect(again.status).toBe(304);
  });

  it('answers a question about the demo day as the server does', async () => {
    const { lab, page } = await both();
    const body = { mode: 'demo', question: 'Where is Miso?', at: AT };
    const server = (await lab.post('things/ask', body)).json<EvidenceRun>();
    const here = page.handle('POST', 'things/ask', body).body as EvidenceRun;
    expect(here.output).toEqual(server.output);
  });

  it('nudges from the coach as the server does', async () => {
    const { lab, page } = await both();
    const body = { mode: 'demo', at: AT, scene: 'home' };
    const server = (await lab.post('coach/check', body)).json();
    expect(page.handle('POST', 'coach/check', body).body).toEqual(server);
  });

  it('records switching a demo light as a lamp run, which changes the runs tag', async () => {
    const { page } = await both();
    const before = page.handle('GET', 'runs').headers!.ETag;
    page.handle('POST', 'fixtures/control', {
      mode: 'demo',
      entityId: DEMO_LIGHTS[1],
      action: 'on',
    });
    const runs = page.handle('GET', 'runs');
    expect(runs.headers!.ETag).not.toBe(before);
    expect((runs.body as EvidenceRun[])[0]).toMatchObject({
      kind: 'lamp',
      output: { entityId: DEMO_LIGHTS[1], state: 'on' },
    });
  });

  it('switches a demo light by hand as the server does', async () => {
    const { lab, page } = await both();
    const body = { mode: 'demo', entityId: DEMO_LIGHTS[2], action: 'off' };
    const server = (await lab.post('lamp', body)).json<EvidenceRun>();
    const here = page.handle('POST', 'lamp', body).body as EvidenceRun;
    expect(here.output).toEqual(server.output);
  });

  it('sends a seated person out as the server does', async () => {
    const { lab, page } = await both();
    const robin = named(await lab.memory(), 'Robin');
    const body = { mode: 'demo', id: robin.id, away: true };
    const server = (await lab.post('fixtures/away', body)).json<DeskMemory>();
    expect(things(page.handle('POST', 'fixtures/away', body).body as DeskMemory)).toEqual(
      things(server),
    );
  });

  it('switches a pet’s state as the server does', async () => {
    const { lab, page } = await both();
    const miso = named(await lab.memory(), 'Miso');
    const body = { mode: 'demo', fixtureId: miso.id, state: 'idle' };
    const server = (await lab.post('fixtures/state', body)).json<DeskMemory>();
    expect(things(page.handle('POST', 'fixtures/state', body).body as DeskMemory)).toEqual(
      things(server),
    );
  });

  it('moves a thing as the server does', async () => {
    const { lab, page } = await both();
    const { id, label, type, scene, surfaceId, at, turns, size, model, control, lights } = named(
      await lab.memory(),
      'Sam',
    );
    const body = {
      mode: 'demo',
      fixture: {
        id,
        label,
        type,
        scene,
        surfaceId,
        turns,
        size,
        model,
        control,
        lights,
        at: { x: at.x - 1, y: at.y },
      },
    };
    const server = (await lab.post('fixtures/save', body)).json<DeskMemory>();
    expect(things(page.handle('POST', 'fixtures/save', body).body as DeskMemory)).toEqual(
      things(server),
    );
  });

  it('deletes a seat with its sitter standing up, as the server does', async () => {
    const { lab, page } = await both();
    const chair = named(await lab.memory(), 'Chair');
    const body = { mode: 'demo', fixtureId: chair.id };
    const server = (await lab.post('fixtures/delete', body)).json<DeskMemory>();
    expect(things(page.handle('POST', 'fixtures/delete', body).body as DeskMemory)).toEqual(
      things(server),
    );
  });

  it('puts the demo back on reset', async () => {
    const { lab, page } = await both();
    const chair = named(await lab.memory(), 'Chair');
    page.handle('POST', 'fixtures/delete', { mode: 'demo', fixtureId: chair.id });
    page.handle('POST', 'desk/demo/reset');
    expect(page.handle('GET', 'desk/demo').body).toEqual(await lab.memory());
  });

  it('refuses what needs the server with 409 static_demo', async () => {
    const { page } = await both();
    const refused = [
      page.handle('POST', 'fixtures/scan', { mode: 'demo' }),
      page.handle('POST', 'things/ask', { mode: 'live', question: 'Where is my mug?' }),
      page.handle('GET', 'scene/photo?mode=demo'),
    ];
    for (const reply of refused)
      expect(reply).toMatchObject({ status: 409, body: { error: { code: 'static_demo' } } });
  });
});
