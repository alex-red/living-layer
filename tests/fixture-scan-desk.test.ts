import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { demoSegmentation } from '../apps/server/src/demo.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import {
  drawnRound,
  fixtureInFrame,
  fixtureOutlineBox,
  LOCAL_OUTLINE_MODEL,
  mugOf,
  type DeskMemory,
  type EvidenceRun,
  type Job,
  type Segmentation,
} from '@livinglayer/domain';
import { DEMO_SURFACE, fixture, setup, type Scanned } from './lib/fixture-scan.js';

describe('scanning the demo desk', () => {
  // The demo's first scan is the same every time and takes most of a second: do it once, and let
  // each test that starts from "the desk, scanned" copy that store instead of scanning again.
  // Nothing here is shared as it is changed: every test gets its own copy and its own app.
  let seed: { dir: string; first: Scanned; jobId: string };
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livinglayer-scan-seed-'));
    const jobId = crypto.randomUUID();
    const app = await buildApp(parseConfig({ DATA_DIR: dir }), {
      fetcher: mock<Fetcher>(),
      serveWeb: false,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/fixtures/scan',
      payload: { mode: 'demo', jobId },
    });
    expect(res.statusCode, res.body).toBe(200);
    seed = { dir, first: res.json<Scanned>(), jobId };
    await app.close();
  });
  afterAll(() => rmSync(seed.dir, { recursive: true, force: true }));
  /** An app whose desk has had the demo scan, with that scan's answer. */
  const scanned = async () => ({
    ...(await setup({}, undefined, seed.dir)),
    one: structuredClone(seed.first),
  });
  it('reports each step with a picture while the page follows it, and keeps it to review', async () => {
    // The seed's own scan was followed under a job id; the job is kept with the store.
    const { one, ...s } = await scanned();
    const { jobId } = seed;
    const job = (await s.app.inject(`/api/jobs/${jobId}`)).json<Job>();
    expect(job).toMatchObject({ title: 'Scanning and mapping', mode: 'demo', outcome: 'done' });
    expect(job.steps.map((x) => [x.id, x.state])).toEqual([
      ['photo', 'done'],
      ['list', 'done'],
      ['outline', 'done'],
      ['model', 'done'],
      ['map', 'done'],
      ['save', 'done'],
    ]);
    for (const id of ['photo', 'list', 'outline', 'map'])
      expect(job.steps.find((x) => x.id === id)!.image).toMatch(/^data:image\/webp;base64,/);
    expect(job.steps.find((x) => x.id === 'list')!.detail).toBe(
      '2 things: green book, sage bottle',
    );
    expect(job.steps.find((x) => x.id === 'map')!.detail).toBe('2 added');
    expect(job.runIds).toEqual([one.run.id]);
    const history = (await s.app.inject('/api/jobs')).json<Job[]>();
    expect(history.map((j) => j.id)).toContain(jobId);
  });
  it('adds what stays put with models fitted to their outlines, then finds it there', async () => {
    const { one, ...s } = await scanned();
    expect(one.run).toMatchObject({ kind: 'fixture', mode: 'demo', status: 'completed' });
    expect(one.mapped.map((m) => [m.label, m.match])).toEqual([
      ['Green book', 'fitted'],
      ['Sage bottle', 'fitted'],
    ]);
    expect(one.memory.fixtures).toHaveLength(2);
    // The demo camera sees the office, so that is the room a scan maps into.
    expect(one.memory.fixtures![0]).toMatchObject({
      scene: 'office',
      surfaceId: 'desk:top',
      model: { source: 'sampled', fit: { crop: `${one.run.id}/item-crop-1.png` } },
      control: { kind: 'none' },
      scanned: true,
    });
    expect(one.memory.fixtures![0]!.model.fit!.iou).toBeGreaterThan(0.5);
    const two = (await s.post('fixtures/scan')).json<Scanned>();
    expect(two.mapped.map((m) => m.match)).toEqual(['existing', 'existing']);
    expect(two.memory.fixtures).toHaveLength(2);
  });
  it('places a thing with the model of a fixture saved in another scene', async () => {
    const s = await setup();
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      state: _s,
      model,
      ...rest
    } = fixture({
      label: 'Green book',
      control: { kind: 'none' },
      scene: 'desk',
    });
    const saved = await s.post('fixtures/save', {
      fixture: { ...rest, model: { label: model.label, parts: model.parts } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const r = (await s.post('fixtures/scan')).json<Scanned>();
    expect(r.mapped[0]).toMatchObject({ label: 'Green book', match: 'library' });
    const book = r.memory.fixtures!.find((f) => f.scene === 'office' && f.label === 'Green book')!;
    expect(book.model.parts.length).toBe(model.parts.length);
    expect(book.model.source).toBe('demo');
  });
  it('maps the desk’s close view too, linking each thing with the room’s, and edits both', async () => {
    const { one: desk, ...s } = await scanned();
    const office = await s.post('fixtures/scan', { scene: 'desk' });
    expect(office.statusCode, office.body).toBe(200);
    const r = office.json<Scanned>();
    expect(r.mapped.map((m) => m.match)).toEqual(['library', 'library']);
    expect(r.memory.fixtures).toHaveLength(4);
    const books = r.memory.fixtures!.filter((f) => f.label === 'Green book');
    expect(books.map((f) => f.scene).sort()).toEqual(['desk', 'office']);
    expect(books[0]!.link).toBeTruthy();
    expect(books[0]!.link).toBe(books[1]!.link!);
    expect(books[0]!.link).toBe(desk.memory.fixtures!.find((f) => f.label === 'Green book')!.id);
    // Scanning again finds both there, still linked.
    const again = (await s.post('fixtures/scan', { scene: 'desk' })).json<Scanned>();
    expect(again.mapped.map((m) => m.match)).toEqual(['existing', 'existing']);
    expect(again.memory.fixtures).toHaveLength(4);
    // A rename in one scene is a rename in the other.
    const officeBook = books.find((f) => f.scene === 'office')!;
    const {
      id,
      label: _l,
      createdAt: _c,
      updatedAt: _u,
      state: _s,
      scanned: _n,
      seen: _e,
      link: _k,
      model,
      ...rest
    } = officeBook;
    const saved = await s.post('fixtures/save', {
      fixture: {
        ...rest,
        id,
        label: 'Field guide',
        model: { label: model.label, parts: model.parts },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const renamed = saved.json<DeskMemory>().fixtures!.filter((f) => f.link === officeBook.link);
    expect(renamed.map((f) => f.label)).toEqual(['Field guide', 'Field guide']);
    expect((await s.post('fixtures/scan', { scene: 'fridge' })).statusCode).toBe(409);
    // Two scans and their edits: slow on a busy machine.
  }, 15_000);
  it('re-places what a scan left as it was, and keeps what a person moved', async () => {
    const { one, ...s } = await scanned();
    const book = one.memory.fixtures!.find((f) => f.label === 'Green book')!;
    const {
      id,
      createdAt: _c,
      updatedAt: _u,
      state: _s,
      scanned: _n,
      seen: _e,
      model,
      ...rest
    } = book;
    await s.post('fixtures/save', {
      fixture: {
        ...rest,
        id,
        surfaceId: null,
        at: { x: 0, y: 0 },
        model: { label: model.label, parts: model.parts },
      },
    });
    const two = (await s.post('fixtures/scan')).json<Scanned>();
    expect(two.mapped[0]!.note).not.toMatch(/moved/);
    expect(two.memory.fixtures!.find((f) => f.id === id)).toMatchObject({
      surfaceId: null,
      at: { x: 0, y: 0 },
    });
    expect(two.mapped[1]!.note).toMatch(
      /moved to where the scan found it, modelled from its outline/,
    );
  });
  it('skips what the person said isn’t a fixture, until they take it back', async () => {
    const { one, ...s } = await scanned();
    const bottle = one.memory.fixtures!.find((f) => f.label === 'Sage bottle')!;
    const gone = (
      await s.post('fixtures/delete', { fixtureId: bottle.id, dismiss: true })
    ).json<DeskMemory>();
    expect(gone.dismissed).toEqual(['Sage bottle']);
    const two = (await s.post('fixtures/scan')).json<Scanned>();
    expect(two.mapped.map((m) => m.match)).toEqual(['existing', 'dismissed']);
    expect(two.memory.fixtures).toHaveLength(1);
    await s.post('fixtures/undismiss', { label: 'Sage bottle' });
    const three = (await s.post('fixtures/scan')).json<Scanned>();
    expect(three.memory.fixtures).toHaveLength(2);
  });
  it('hands a fixture’s place back to scans when asked', async () => {
    const { one, ...s } = await scanned();
    const book = one.memory.fixtures![0]!;
    const { createdAt: _c, updatedAt: _u, state: _s, scanned: _n, seen: _e, model, ...rest } = book;
    const input = { ...rest, model: { label: model.label, parts: model.parts } };
    const mine = (await s.post('fixtures/save', { fixture: input })).json<DeskMemory>();
    expect(mine.fixtures![0]!.scanned).toBeUndefined();
    const back = (
      await s.post('fixtures/save', { fixture: { ...input, scanned: true } })
    ).json<DeskMemory>();
    expect(back.fixtures![0]!.scanned).toBe(true);
  });
  it('stands what a scan placed again under a corrected pin, and leaves what you placed', async () => {
    const { one, ...s } = await scanned();
    const [book, bottle] = one.memory.fixtures!;
    expect(book!.seen).toBeTruthy();
    // Take the bottle over by hand.
    const {
      createdAt: _c,
      updatedAt: _u,
      state: _s,
      scanned: _n,
      seen: _e,
      model,
      ...rest
    } = bottle!;
    await s.post('fixtures/save', {
      fixture: { ...rest, model: { label: model.label, parts: model.parts } },
    });
    // The desk really fills only the right half of the frame.
    const pinned = await s.post('desk/surface', {
      pin: {
        ...DEMO_SURFACE,
        corners: [
          { x: 480, y: 0 },
          { x: 960, y: 0 },
          { x: 960, y: 640 },
          { x: 480, y: 640 },
        ],
      },
    });
    expect(pinned.statusCode, pinned.body).toBe(200);
    const after = pinned.json<DeskMemory>().fixtures!;
    const movedBook = after.find((f) => f.id === book!.id)!;
    expect(movedBook.at).not.toEqual(book!.at);
    expect(after.find((f) => f.id === bottle!.id)!.at).toEqual(bottle!.at);
    // Handing them all back lets scans place the bottle too.
    const released = (await s.post('fixtures/release', { scene: book!.scene })).json<DeskMemory>();
    expect(released.fixtures!.every((f) => f.scanned)).toBe(true);
  });
  it('follows each scanned thing from where the scan saw it, outlined with no model call', async () => {
    const { one, ...s } = await scanned();
    for (const f of one.memory.fixtures!) {
      const shape = fixtureOutlineBox(f, DEMO_SURFACE, null);
      expect(shape, f.label).not.toBeNull();
      const run = (await s.post('segment', { concept: f.label.toLowerCase(), shape })).json<
        EvidenceRun<Segmentation>
      >();
      expect(run.model).toBe(LOCAL_OUTLINE_MODEL);
      expect(run.output.detections.length, f.label).toBe(1);
      // On the thing the scan saw, not on something else inside the box.
      const seen = fixtureInFrame(f, DEMO_SURFACE, null)!;
      const got = run.output.detections[0]!.box;
      const w = Math.min(seen.x + seen.width, got.x + got.width) - Math.max(seen.x, got.x);
      const h = Math.min(seen.y + seen.height, got.y + got.height) - Math.max(seen.y, got.y);
      const both = Math.max(0, w) * Math.max(0, h);
      const iou = both / (seen.width * seen.height + got.width * got.height - both);
      expect(iou, f.label).toBeGreaterThan(0.5);
      const anchored = await s.post('fixtures/anchor', {
        id: f.id,
        segmentRunId: run.id,
        detectionId: run.output.detections[0]!.objectId,
      });
      expect(anchored.statusCode, anchored.body).toBe(200);
    }
    const memory = (await s.app.inject('/api/desk/demo')).json<DeskMemory>();
    expect(memory.fixtures!.map((f) => f.track?.status)).toEqual(['seen', 'seen']);
  });
  it('lists the mug as a thing that moves, never a fixture, and it can be the desk’s mug', async () => {
    const { one, ...s } = await scanned();
    const { moving } = one;
    expect(moving.map((m) => m.label)).toEqual(['mug']);
    expect(one.memory.fixtures!.map((f) => f.label)).not.toContain('Mug');
    const shape = drawnRound(moving[0]!.box);
    const run = (await s.post('segment', { concept: 'mug', shape })).json<
      EvidenceRun<Segmentation>
    >();
    expect(run.model).toBe(LOCAL_OUTLINE_MODEL);
    const truth = (await demoSegmentation('mug')).output.detections[0]!.box;
    const got = run.output.detections[0]!.box;
    expect(Math.abs(got.x - truth.x) + Math.abs(got.y - truth.y)).toBeLessThan(6);
    const selected = await s.post('desk/select', {
      segmentRunId: run.id,
      detectionId: run.output.detections[0]!.objectId,
    });
    expect(selected.statusCode, selected.body).toBe(200);
    expect(mugOf(selected.json<DeskMemory>())?.label).toBeTruthy();
  });
});
