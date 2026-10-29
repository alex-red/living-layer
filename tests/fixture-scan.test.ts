import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { syntheticStream } from '../apps/server/src/sam.js';
import {
  DEMO_SURFACE,
  ISO_PRESETS,
  fixtureProblem,
  libraryScore,
  mapScan,
  mugItem,
  placeTemplate,
  pictureToScene,
  pictureToSceneAt,
  isDismissed,
  scenePointInPicture,
  placeholderModel,
  type DeskMemory,
  type EvidenceRun,
  type Fixture,
  type FixtureScan,
  type MappedThing,
  type Point,
  type SurfacePin,
  type ScannedThing,
} from '@livinglayer/domain';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    id: crypto.randomUUID(),
    label: 'Desk lamp',
    scene: 'office',
    surfaceId: null,
    at: { x: 1, y: 1 },
    turns: 0,
    size: { w: 0.5, d: 0.5, h: 1.2 },
    model: { ...mugItem(), source: 'demo', segmentRunId: null, swatches: [], updatedAt: '' },
    reference: null,
    control: { kind: 'light', entityId: 'light.demo_shelf' },
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    ...over,
  };
}
const thing = (over: Partial<ScannedThing> = {}): ScannedThing => ({
  label: 'green book',
  archetype: 'book',
  material: 'matte',
  control: 'none',
  color: '#5f8a5a',
  box: { x1: 80, y1: 300, x2: 300, y2: 760 },
  sizeCm: { w: 15, d: 22, h: 3 },
  ...over,
});

describe('matching a scanned thing to the library', () => {
  it('takes the same name, or the same last word and shape, and nothing looser', () => {
    const lamp = fixture({ label: 'Desk lamp' });
    expect(libraryScore({ label: 'desk lamps', archetype: 'lamp' }, lamp)).toBe(1);
    expect(libraryScore({ label: 'brass lamp', archetype: 'lamp' }, lamp)).toBe(0.8);
    expect(libraryScore({ label: 'desk fan', archetype: 'device' }, lamp)).toBe(0);
    const fitted = fixture({
      label: 'Desk lamp',
      model: {
        ...lamp.model,
        fit: { ...({} as NonNullable<Fixture['model']['fit']>), archetype: 'lamp' },
      },
    });
    // A drafted model knows its shape: a "lamp" drawn as a bottle is not this one.
    expect(libraryScore({ label: 'brass lamp', archetype: 'bottle' }, fitted)).toBe(0);
  });
  it('builds a placeholder in the thing’s colour from its shape', () => {
    const book = placeholderModel('Green book', 'book', '#5f8a5a', 'matte');
    expect(book.label).toBe('Green book');
    expect(JSON.stringify(book.parts)).toContain('#5f8a5a');
  });
});

describe('mapping a scan through the pin', () => {
  const scan: FixtureScan = { things: [thing()] };
  const map = (library: Fixture[] = [], room = 12) =>
    mapScan({
      scan,
      pin: DEMO_SURFACE,
      custom: null,
      library,
      room,
      entities: ['light.demo_shelf'],
    });
  it('stands what it finds on the pinned surface, with a placeholder model', () => {
    const [book] = map();
    expect(book).toMatchObject({ label: 'Green book', match: 'placeholder' });
    expect(book!.fixture).toMatchObject({ scene: 'desk', surfaceId: 'desk:top', reference: null });
    expect(fixtureProblem(book!.fixture!)).toBeNull();
    // The book's box is on the left of the photo, so it stands on the left of the desk.
    const top = ISO_PRESETS.desk.surfaces.find((s) => s.id === 'desk:top')!.rect;
    expect(book!.fixture!.at.x).toBeLessThan(top.x + top.w / 2);
  });
  it('leaves a fixture the scene has alone, and reuses one from another scene', () => {
    const here = fixture({ label: 'Green book', scene: 'desk', surfaceId: 'desk:top' });
    expect(map([here])[0]).toMatchObject({ match: 'existing', fixtureId: here.id, fixture: null });
    const elsewhere = fixture({ label: 'Green book', scene: 'office' });
    const [reused] = map([elsewhere]);
    expect(reused).toMatchObject({ match: 'library', fixtureId: elsewhere.id });
    expect(reused!.fixture!.model.parts).toEqual(elsewhere.model.parts);
    expect(reused!.fixture!.control).toEqual(elsewhere.control);
    // Another scene has another scale.
    expect(reused!.fixture!.size.w).not.toBe(elsewhere.size.w);
  });
  it('drops a reused fixture’s light when it is no longer configured, and stops when full', () => {
    const elsewhere = fixture({
      label: 'Green book',
      control: { kind: 'light', entityId: 'light.gone' },
    });
    expect(map([elsewhere])[0]!.fixture!.control).toEqual({ kind: 'none' });
    expect(map([], 0)[0]).toMatchObject({ fixture: null, note: 'No room for more fixtures.' });
  });
});

describe('mapping a scan into the room the view is part of', () => {
  const scan: FixtureScan = { things: [thing()] };
  const map = (library: Fixture[] = []) =>
    mapScan({
      scan,
      pin: DEMO_SURFACE,
      scene: 'office',
      custom: null,
      library,
      room: 12,
      entities: [],
    });
  it('stands the thing on the same desk top in the office', () => {
    const [book] = map();
    expect(book!.fixture).toMatchObject({ scene: 'office', surfaceId: 'desk:top' });
    expect(fixtureProblem(book!.fixture!)).toBeNull();
    const top = ISO_PRESETS.office.surfaces.find((s) => s.id === 'desk:top')!.rect;
    expect(book!.fixture!.at.x).toBeLessThan(top.x + top.w / 2);
  });
  it('links with the same thing in the close view, once', () => {
    const desk = fixture({ label: 'Green book', scene: 'desk', surfaceId: 'desk:top' });
    const [linked] = map([desk]);
    expect(linked).toMatchObject({ match: 'library', fixtureId: desk.id, linkTo: desk.id });
    const office = fixture({ label: 'Green book', scene: 'office', link: desk.id });
    // Already linked: it is just there.
    expect(map([{ ...desk, link: desk.id }, office])[0]).toMatchObject({
      match: 'existing',
      fixtureId: office.id,
    });
    expect(map([{ ...desk, link: desk.id }, office])[0]!.linkTo).toBeUndefined();
    // Both there but apart: they are joined.
    const apart = fixture({ label: 'Green book', scene: 'office' });
    expect(map([desk, apart])[0]).toMatchObject({
      match: 'existing',
      fixtureId: apart.id,
      linkTo: desk.id,
    });
  });
  it('refuses a scene the pin doesn’t fit', () => {
    expect(
      mapScan({
        scan,
        pin: DEMO_SURFACE,
        scene: 'fridge',
        custom: null,
        library: [],
        room: 12,
        entities: [],
      }),
    ).toEqual([]);
  });
});

describe('fixtures on the room picture', () => {
  it('places scene points on the drawn desk, raised by their height', () => {
    const pin = { ...DEMO_SURFACE, scene: 'office' as const };
    const top = ISO_PRESETS.office.surfaces.find((s) => s.id === 'desk:top')!;
    const picture = {
      asset: 'x/illustration.png',
      frame: { width: 1000, height: 800 },
      surfaceId: 'desk:top',
      desk: [
        { x: 100, y: 400 },
        { x: 600, y: 150 },
        { x: 900, y: 300 },
        { x: 400, y: 550 },
      ] as [Point, Point, Point, Point],
      createdAt: '',
    };
    const at = (x: number, y: number, z: number) =>
      scenePointInPicture(pin, picture, null, { x, y, z })!;
    expect(at(top.rect.x, top.rect.y, top.z)).toEqual({ x: 100, y: 400 });
    const far = at(top.rect.x + top.rect.w, top.rect.y + top.rect.d, top.z);
    expect(far.x).toBeCloseTo(900);
    expect(far.y).toBeCloseTo(300);
    // Off the desk it stays on the same plane, without running off to a horizon.
    const floor = at(0, 0, 0);
    expect(Math.abs(floor.x)).toBeLessThan(2000);
    expect(floor.y).toBeGreaterThan(at(0, 0, top.z).y);
  });
});

describe('moving a fixture on the room picture', () => {
  const pin = { ...DEMO_SURFACE, scene: 'office' as const };
  const picture = {
    asset: 'x/illustration.png',
    frame: { width: 1000, height: 800 },
    surfaceId: 'desk:top',
    desk: [
      { x: 100, y: 400 },
      { x: 600, y: 150 },
      { x: 900, y: 300 },
      { x: 400, y: 550 },
    ] as [Point, Point, Point, Point],
    createdAt: '',
  };
  it('maps a picture point back to the scene and the surface it is on', () => {
    const top = ISO_PRESETS.office.surfaces.find((s) => s.id === 'desk:top')!;
    const onDesk = { x: top.rect.x + 1, y: top.rect.y + 1, z: top.z };
    const back = pictureToScene(
      pin,
      picture,
      null,
      scenePointInPicture(pin, picture, null, onDesk)!,
    )!;
    expect(back.surfaceId).toBe('desk:top');
    expect(back.x).toBeCloseTo(onDesk.x);
    expect(back.y).toBeCloseTo(onDesk.y);
    const onFloor = { x: 8.5, y: 6.5, z: 0 };
    const down = pictureToScene(
      pin,
      picture,
      null,
      scenePointInPicture(pin, picture, null, onFloor)!,
    )!;
    expect(down.surfaceId).toBeNull();
    expect(down.x).toBeCloseTo(onFloor.x);
    expect(down.y).toBeCloseTo(onFloor.y);
  });
  it('follows a point across a plane at any height, for stretching a base', () => {
    for (const p of [
      { x: 2.25, y: 1.5, z: 0 },
      { x: 4.1, y: 2.7, z: 1.8 },
    ]) {
      const back = pictureToSceneAt(
        pin,
        picture,
        null,
        scenePointInPicture(pin, picture, null, p)!,
        p.z,
      )!;
      expect(back.x).toBeCloseTo(p.x);
      expect(back.y).toBeCloseTo(p.y);
    }
  });
  it('doesn’t map back on a picture redrawn from a frame', () => {
    expect(
      pictureToScene(
        pin,
        { ...picture, desk: null, drawnFrom: { width: 960, height: 640 } },
        null,
        {
          x: 10,
          y: 10,
        },
      ),
    ).toBeNull();
  });
});

describe('dismissed names', () => {
  it('skips the same name or the same last word', () => {
    expect(isDismissed('Tall water filter pitcher', ['water pitcher'])).toBe(true);
    expect(isDismissed('Water filter', ['water pitcher'])).toBe(false);
    const [skipped] = mapScan({
      scan: { things: [thing()] },
      pin: DEMO_SURFACE,
      custom: null,
      library: [],
      room: 12,
      entities: [],
      dismissed: ['book'],
    });
    expect(skipped).toMatchObject({ match: 'dismissed', fixture: null });
  });
});

describe('standing on what is nearby', () => {
  it('snaps a flat thing just past the pinned edge onto the surface', () => {
    // The mouse's box ends a little above the desk's back edge in the photo.
    const scan: FixtureScan = {
      things: [
        thing({ label: 'mouse', archetype: 'device', box: { x1: 450, y1: 0, x2: 550, y2: 2 } }),
      ],
    };
    const pin = {
      ...DEMO_SURFACE,
      corners: [
        { x: 0, y: 20 },
        { x: 960, y: 20 },
        { x: 960, y: 640 },
        { x: 0, y: 640 },
      ] as SurfacePin['corners'],
    };
    const [mouse] = mapScan({ scan, pin, custom: null, library: [], room: 12, entities: [] });
    expect(mouse!.fixture!.surfaceId).toBe('desk:top');
  });
});

async function setup(env: Record<string, string> = {}, fetcher: Fetcher = mock<Fetcher>()) {
  const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-scan-'));
  dirs.push(dataDir);
  const app = await buildApp(parseConfig({ DATA_DIR: dataDir, ...env }), {
    fetcher,
    serveWeb: false,
  });
  const post = (path: string, body: object = {}) =>
    app.inject({ method: 'POST', url: `/api/${path}`, payload: { mode: 'demo', ...body } });
  return { app, post, dataDir };
}
type Scanned = { run: EvidenceRun; mapped: MappedThing[]; memory: DeskMemory };

describe('scanning the demo desk', () => {
  it('adds what stays put with models fitted to their outlines, then finds it there', async () => {
    const s = await setup();
    const first = await s.post('fixtures/scan');
    expect(first.statusCode, first.body).toBe(200);
    const one = first.json<Scanned>();
    expect(one.run).toMatchObject({ kind: 'fixture', mode: 'demo', status: 'completed' });
    expect(one.mapped.map((m) => [m.label, m.match])).toEqual([
      ['Green book', 'fitted'],
      ['Sage bottle', 'fitted'],
    ]);
    expect(one.memory.fixtures).toHaveLength(2);
    expect(one.memory.fixtures![0]).toMatchObject({
      scene: 'desk',
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
    });
    const saved = await s.post('fixtures/save', {
      fixture: { ...rest, model: { label: model.label, parts: model.parts } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const r = (await s.post('fixtures/scan')).json<Scanned>();
    expect(r.mapped[0]).toMatchObject({ label: 'Green book', match: 'library' });
    const book = r.memory.fixtures!.find((f) => f.scene === 'desk' && f.label === 'Green book')!;
    expect(book.model.parts.length).toBe(model.parts.length);
    expect(book.model.source).toBe('demo');
  });
  it('maps the office too, linking each thing with its close view, and edits both', async () => {
    const s = await setup();
    const desk = (await s.post('fixtures/scan')).json<Scanned>();
    const office = await s.post('fixtures/scan', { scene: 'office' });
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
    const again = (await s.post('fixtures/scan', { scene: 'office' })).json<Scanned>();
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
  });
  it('re-places what a scan left as it was, and keeps what a person moved', async () => {
    const s = await setup();
    const one = (await s.post('fixtures/scan')).json<Scanned>();
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
    const s = await setup();
    const one = (await s.post('fixtures/scan')).json<Scanned>();
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
    const s = await setup();
    const one = (await s.post('fixtures/scan')).json<Scanned>();
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
    const s = await setup();
    const one = (await s.post('fixtures/scan')).json<Scanned>();
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
    const released = (await s.post('fixtures/release', { scene: 'desk' })).json<DeskMemory>();
    expect(released.fixtures!.every((f) => f.scanned)).toBe(true);
  });
  it('takes no photo in the demo', async () => {
    const s = await setup();
    expect((await s.post('fixtures/scan', { imageDataUrl: 'data:' })).statusCode).toBe(400);
  });
});

describe('scanning live, with a mocked Meta API', () => {
  const sparkResponse = (output: object) =>
    new Response(
      JSON.stringify({
        id: 'resp_spark',
        object: 'response',
        model: 'muse-spark-1.3',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      }),
      { headers: { 'content-type': 'application/json', 'x-request-id': 'req-spark' } },
    );
  const sam = JSON.parse(readFileSync('testdata/sam-mug.json', 'utf8')) as { wire: string };
  async function samResponse(wire: string) {
    const events = [];
    for await (const event of syntheticStream(wire))
      events.push(
        event.type === 'response.completed'
          ? { ...event, response: { id: 'resp_sam', model: 'sam-3.1', status: 'completed' } }
          : event,
      );
    const body =
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') +
      'data: [DONE]\n\n';
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }
  async function live(env: Record<string, string> = {}) {
    const prompts: string[] = [];
    const fetcher = mock<Fetcher>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      // SAM outlines the lamp from Spark's box: the mug's mask stands in for it.
      if (body.model === 'sam-3.1') {
        prompts.push('sam');
        return samResponse(`<0f>1${sam.wire.replace(/^<0f>7/, '')}`);
      }
      prompts.push(`${body.text.format.name}: ${body.input[0].content[0].text}`);
      return sparkResponse({
        things: [
          thing({
            label: 'desk lamp',
            archetype: 'lamp',
            control: 'light',
            box: { x1: 360, y1: 270, x2: 640, y2: 730 },
          }),
        ],
      });
    });
    const s = await setup(
      { MODEL_API_KEY: 'test-key', META_LIVE_ENABLED: 'true', ...env },
      fetcher,
    );
    const photo = await sharp(readFileSync('apps/web/public/desk.svg')).png().toBuffer();
    const imageDataUrl = `data:image/png;base64,${photo.toString('base64')}`;
    const scan = () => s.post('fixtures/scan', { mode: 'live', imageDataUrl });
    return { ...s, prompts, scan };
  }
  const pin = async (s: Awaited<ReturnType<typeof live>>) => {
    const memory = (await s.app.inject('/api/desk/live')).json<DeskMemory>();
    const r = await s.post('desk/restore', {
      mode: 'live',
      memory: {
        ...memory,
        surface: DEMO_SURFACE,
        object: { id: 'mug', label: 'Mug', createdAt: '2026-10-28T00:00:00.000Z' },
      },
    });
    expect(r.statusCode, r.body).toBe(200);
  };
  it('asks Spark once, leaving out what the camera follows, and maps what it finds', async () => {
    const s = await live();
    await pin(s);
    const res = await s.scan();
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json<Scanned>();
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[0]).toMatch(/^fixture_scan: /);
    expect(s.prompts[0]).toContain('followed separately: Mug');
    expect(s.prompts[1]).toBe('sam');
    expect(r.run).toMatchObject({ kind: 'fixture', mode: 'live', status: 'completed' });
    expect(r.run.assets).toEqual(
      expect.arrayContaining([
        `${r.run.id}/source.png`,
        `${r.run.id}/sam-output.txt`,
        `${r.run.id}/item-crop-1.png`,
      ]),
    );
    expect(r.memory.fixtures).toHaveLength(1);
    expect(r.memory.fixtures![0]).toMatchObject({
      label: 'Desk lamp',
      surfaceId: 'desk:top',
      model: { source: 'sampled' },
    });
  });
  it('scans a drafted room from the photo it was drafted from when none is sent', async () => {
    const s = await live();
    const memory = (await s.app.inject('/api/desk/live')).json<DeskMemory>();
    // Without a photo of its own, a preset's pin has nothing to scan.
    await pin(s);
    expect((await s.post('fixtures/scan', { mode: 'live' })).statusCode).toBe(400);
    const runId = crypto.randomUUID();
    const photo = await sharp(readFileSync('apps/web/public/desk.svg')).png().toBuffer();
    const dir = join(s.dataDir, 'evidence', runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'source.png'), photo);
    const desk = placeTemplate('desk', 'desk', 1, 1);
    const scene = { kind: 'custom', label: 'Mine', grid: { w: 8, d: 8 }, ...desk };
    const restored = await s.post('desk/restore', {
      mode: 'live',
      memory: {
        ...memory,
        scene,
        scenePhoto: `${runId}/source.png`,
        surface: { ...DEMO_SURFACE, scene: 'custom' },
      },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const res = await s.post('fixtures/scan', { mode: 'live' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Scanned>().memory.fixtures![0]).toMatchObject({ scene: 'custom' });
    expect(s.prompts).toEqual([expect.stringMatching(/^fixture_scan/), 'sam']);
  });
  it('serves a drafted room’s photo at its pin’s size, and nothing for a preset', async () => {
    const s = await live();
    await pin(s);
    expect((await s.app.inject('/api/scene/photo?mode=live')).statusCode).toBe(404);
    const memory = (await s.app.inject('/api/desk/live')).json<DeskMemory>();
    const runId = crypto.randomUUID();
    const dir = join(s.dataDir, 'evidence', runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'source.png'),
      await sharp(readFileSync('apps/web/public/desk.svg')).resize(640, 480).png().toBuffer(),
    );
    const desk = placeTemplate('desk', 'desk', 1, 1);
    await s.post('desk/restore', {
      mode: 'live',
      memory: {
        ...memory,
        scene: { kind: 'custom', label: 'Mine', grid: { w: 8, d: 8 }, ...desk },
        scenePhoto: `${runId}/source.png`,
        surface: { ...DEMO_SURFACE, scene: 'custom' },
      },
    });
    const res = await s.app.inject('/api/scene/photo?mode=live');
    expect(res.statusCode).toBe(200);
    const size = await sharp(res.rawPayload).metadata();
    expect([size.width, size.height]).toEqual([960, 640]);
  });
  it('needs a pin, and refuses before any call past today’s limit', async () => {
    const s = await live();
    expect((await s.scan()).statusCode).toBe(409);
    const poor = await live({ META_DAILY_SPEND_LIMIT_USD: '0.0001' });
    await pin(poor);
    expect((await poor.scan()).statusCode).toBe(429);
    expect(poor.prompts).toEqual([]);
  });
});
