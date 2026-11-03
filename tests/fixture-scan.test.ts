import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { testApp } from './lib/app.js';
import { productSize } from '../apps/server/src/fixture.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { syntheticStream } from '../apps/server/src/sam.js';
import {
  sculptPrompt,
  DEMO_CAMERA,
  DEMO_SURFACE as ROOM_SURFACE,
  ISO_PRESETS,
  projectRoom,
  fixtureProblem,
  layoutThings,
  libraryScore,
  mapScan,
  withLayoutMoves,
  mugItem,
  placeTemplate,
  pictureToScene,
  pictureToSceneAt,
  isoToPicture,
  toIso,
  spriteBox,
  isDismissed,
  scenePointInPicture,
  placeholderModel,
  cameraFromPin,
  cameraScale,
  pinCamera,
  convexHull,
  detectionFromBits,
  fillRings,
  isoSurface,
  newBits,
  outlineOf,
  placeSeen,
  projectPoint,
  sizeInTiles,
  type DeskMemory,
  type EvidenceRun,
  type Fixture,
  type FixtureScan,
  type Job,
  type MappedThing,
  type PhotoDraft,
  type Point,
  type SurfacePin,
  type ScannedThing,
} from '@livinglayer/domain';

/** A pin that fills the frame with the office desk's top, to test the mapping on. */
const DEMO_SURFACE: SurfacePin = {
  scene: 'desk',
  surfaceId: 'desk:top',
  corners: [
    { x: 0, y: 0 },
    { x: 960, y: 0 },
    { x: 960, y: 640 },
    { x: 0, y: 640 },
  ],
  frame: { width: 960, height: 640 },
};

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
    // Every scene is at real size, so it keeps its size.
    expect(reused!.fixture!.size).toEqual(elsewhere.size);
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

describe('sizing a scanned thing by the camera', () => {
  // A box standing in the middle of the office desk, as the demo camera draws it.
  const pinned = isoSurface('office', ROOM_SURFACE.surfaceId, null)!;
  const camera = pinCamera(ROOM_SURFACE.corners, ROOM_SURFACE.frame, pinned.rect.w, pinned.rect.d)!;
  const centre = { x: pinned.rect.x + pinned.rect.w / 2, y: pinned.rect.y + pinned.rect.d / 2 };
  const outlineOf = (s: { w: number; d: number; h: number }) => {
    const ps: Point[] = [];
    for (const dx of [-s.w / 2, s.w / 2])
      for (const dy of [-s.d / 2, s.d / 2])
        for (const dz of [0, s.h])
          ps.push(projectPoint(camera, pinned.rect.w / 2 + dx, pinned.rect.d / 2 + dy, dz)!);
    return convexHull(ps);
  };
  const usual = { w: 0.3, d: 0.3, h: 0.4 };
  const found = { centre, surfaceId: pinned.id };
  it('reads how much bigger it is than Spark’s usual size from its outline', () => {
    const seen = outlineOf({ w: 0.45, d: 0.45, h: 0.6 });
    expect(cameraScale(ROOM_SURFACE, 'office', null, found, usual, seen)).toBeCloseTo(1.5, 1);
    expect(cameraScale(ROOM_SURFACE, 'office', null, found, usual, outlineOf(usual))).toBeCloseTo(
      1,
      2,
    );
  });
  it('says nothing past half or double, where the outline is likelier wrong', () => {
    const huge = outlineOf({ w: 0.9, d: 0.9, h: 1.2 });
    expect(cameraScale(ROOM_SURFACE, 'office', null, found, usual, huge)).toBeNull();
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
    // On the office's desk top, as the close view's is.
    const onTop = { scene: 'office' as const, surfaceId: 'desk:top', at: { x: 2, y: 2 } };
    const office = fixture({ label: 'Green book', ...onTop, link: desk.id });
    // Already linked: it is just there.
    expect(map([{ ...desk, link: desk.id }, office])[0]).toMatchObject({
      match: 'existing',
      fixtureId: office.id,
    });
    expect(map([{ ...desk, link: desk.id }, office])[0]!.linkTo).toBeUndefined();
    // Both there but apart: they are joined.
    const apart = fixture({ label: 'Green book', ...onTop });
    expect(map([desk, apart])[0]).toMatchObject({
      match: 'existing',
      fixtureId: apart.id,
      linkTo: desk.id,
    });
  });
  it('leaves what stands off the desk alone: the floor’s and the shelf’s', () => {
    const floor = fixture({ label: 'Green book', scene: 'office', at: { x: 1, y: 5 } });
    const shelf = fixture({
      label: 'Green book',
      scene: 'office',
      surfaceId: 'shelf:top',
      at: { x: 7.5, y: 0.4 },
    });
    for (const there of [floor, shelf]) {
      const [book] = mapScan({
        scan,
        pin: DEMO_SURFACE,
        scene: 'office',
        custom: null,
        library: [there],
        room: 12,
        entities: [],
        replace: true,
      });
      // Added on the desk with its model, never moved there.
      expect(book).toMatchObject({ match: 'library', fixtureId: there.id });
      expect(book!.moveTo).toBeUndefined();
      expect(book!.linkTo).toBeUndefined();
      expect(book!.fixture).toMatchObject({ surfaceId: 'desk:top' });
    }
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

/**
 * The demo room's picture: the camera's frame redrawn at twice its size,
 * keeping its framing, as Muse Image is asked to.
 */
const roomPicture = {
  asset: 'x/illustration.png',
  frame: { width: 1920, height: 1280 },
  surfaceId: 'desk:top',
  desk: null,
  drawnFrom: { width: 960, height: 640 },
  createdAt: '',
};
const roomPin = ROOM_SURFACE;

describe('fixtures on the room picture', () => {
  it('places scene points where the room’s camera sees them, at the picture’s scale', () => {
    const top = ISO_PRESETS.office.surfaces.find((s) => s.id === 'desk:top')!;
    for (const p of [
      { x: top.rect.x, y: top.rect.y, z: top.z },
      { x: top.rect.x + top.rect.w, y: top.rect.y + top.rect.d, z: top.z },
      { x: top.rect.x + 1, y: top.rect.y + 0.5, z: top.z + 1.5 },
      { x: 3, y: 5, z: 0 },
    ]) {
      const at = scenePointInPicture(roomPin, roomPicture, null, p)!;
      const seen = projectRoom(DEMO_CAMERA, p)!;
      expect(Math.hypot(at.x - 2 * seen.x, at.y - 2 * seen.y)).toBeLessThan(2);
    }
  });
});

describe('moving a fixture on the room picture', () => {
  const pin = roomPin;
  const picture = roomPicture;
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
    const onFloor = { x: 3, y: 5, z: 0 };
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
  it('lays a model drawn in iso screen space onto the picture where its box stands', () => {
    const top = ISO_PRESETS.office.surfaces.find((x) => x.id === 'desk:top')!;
    const box = {
      at: { x: top.rect.x + 0.5, y: top.rect.y + 0.4, z: top.z },
      size: { w: 0.8, d: 0.5, h: 1.2 },
    };
    const [a, b, c, d, e, f] = isoToPicture(pin, picture, null, box)!;
    // Each corner of the box, drawn by the iso view, lands near where the picture puts it:
    // an affine map can't follow the camera's perspective exactly, so near is a share of
    // the box's size on the picture.
    const corners = [0, 1].flatMap((i) =>
      [0, 1].flatMap((j) =>
        [0, 1].map((k) => ({
          x: box.at.x + i * box.size.w,
          y: box.at.y + j * box.size.d,
          z: box.at.z + k * box.size.h,
        })),
      ),
    );
    const want = corners.map((v) => scenePointInPicture(pin, picture, null, v)!);
    const xs = want.map((p) => p.x);
    const ys = want.map((p) => p.y);
    const extent = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const errors = corners.map((v, n) => {
      const s = toIso(v);
      return Math.hypot(a * s.sx + c * s.sy + e - want[n]!.x, b * s.sx + d * s.sy + f - want[n]!.y);
    });
    expect(errors.reduce((t, x) => t + x, 0) / errors.length).toBeLessThan(extent * 0.2);
  });
  it('doesn’t map a picture redrawn from frames of another size than the pin’s', () => {
    const other = { ...picture, drawnFrom: { width: 1280, height: 720 } };
    expect(pictureToScene(pin, other, null, { x: 10, y: 10 })).toBeNull();
    expect(scenePointInPicture(pin, other, null, { x: 3, y: 5, z: 0 })).toBeNull();
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

describe('placing what SAM outlined', () => {
  const pin = DEMO_SURFACE;
  const top = isoSurface('desk', 'desk:top', null)!.rect;
  const camera = cameraFromPin(pin.corners, pin.frame, top.w, [top.d, top.d])!;
  /** A box of `size` tiles centred at `centre` on the desk, outlined as SAM would see it. */
  const outlined = (centre: Point, size: { w: number; d: number; h: number }) => {
    const corners: Point[] = [];
    for (const dx of [-size.w / 2, size.w / 2])
      for (const dy of [-size.d / 2, size.d / 2])
        for (const z of [0, size.h])
          corners.push(projectPoint(camera, centre.x - top.x + dx, centre.y - top.y + dy, z)!);
    const bits = newBits(pin.frame.width, pin.frame.height);
    fillRings(bits, [convexHull(corners)]);
    return outlineOf(detectionFromBits('1', bits)!, pin.frame)!;
  };
  const centreOf = (f: { at: Point; size: { w: number; d: number } }) => ({
    x: f.at.x + f.size.w / 2,
    y: f.at.y + f.size.d / 2,
  });
  const scanOf = (sizeCm: ScannedThing['sizeCm']): FixtureScan => ({
    things: [thing({ label: 'thing', archetype: 'box', sizeCm })],
  });

  it('keeps the largest part of a mask, so a neighbour a loose box took in is dropped', () => {
    const bits = newBits(200, 100);
    for (let y = 40; y < 80; y++) for (let x = 20; x < 80; x++) bits.data[y * 200 + x] = 1;
    for (let y = 10; y < 20; y++) for (let x = 150; x < 160; x++) bits.data[y * 200 + x] = 1;
    const outline = outlineOf(detectionFromBits('1', bits)!, { width: 200, height: 100 })!;
    expect(outline.size.w).toBeCloseTo(0.3, 2);
    expect(outline.size.h).toBeCloseTo(0.4, 2);
    // Its hull: the rectangle's corners, none of the stray bit.
    expect(outline.points!.length).toBeGreaterThanOrEqual(4);
    expect(outline.points!.every((p) => p.x <= 0.4 && p.y >= 0.4)).toBe(true);
  });
  it.each([
    ['a flat pad', { w: 20, d: 30, h: 1 }],
    ['a tall speaker', { w: 12, d: 12, h: 30 }],
  ])('stands %s where it really is, from its whole outline', (_, sizeCm) => {
    const size = sizeInTiles(sizeCm);
    const truth = { x: top.x + top.w * 0.6, y: top.y + top.d * 0.4 };
    const outline = outlined(truth, size);
    const [placed] = mapScan({
      scan: scanOf(sizeCm),
      pin,
      custom: null,
      library: [],
      room: 12,
      entities: [],
      outlines: [outline],
    });
    expect(placed!.fixture!.surfaceId).toBe('desk:top');
    const centre = centreOf(placed!.fixture!);
    expect(Math.hypot(centre.x - truth.x, centre.y - truth.y)).toBeLessThan(0.08);
    // A corrected pin places it again from the same outline, to the same spot.
    const again = placeSeen({ ...placed!.fixture!, seen: placed!.seen! }, pin, null)!;
    expect(again.at.x).toBeCloseTo(placed!.fixture!.at.x, 5);
    expect(again.at.y).toBeCloseTo(placed!.fixture!.at.y, 5);
  });
  it('moves fixtures placed by hand only when asked to', () => {
    const size = sizeInTiles({ w: 20, d: 30, h: 1 });
    const byHand = fixture({
      label: 'Thing',
      scene: 'desk',
      surfaceId: 'desk:top',
      at: { x: top.x, y: top.y },
      size,
    });
    const outline = outlined({ x: top.x + top.w * 0.6, y: top.y + top.d * 0.4 }, size);
    const scan = (replace: boolean) =>
      mapScan({
        scan: scanOf({ w: 20, d: 30, h: 1 }),
        pin,
        custom: null,
        library: [byHand],
        room: 12,
        entities: [],
        outlines: [outline],
        replace,
      })[0]!;
    expect(scan(false)).toMatchObject({ match: 'existing', fixtureId: byHand.id });
    expect(scan(false).moveTo).toBeUndefined();
    expect(scan(true).moveTo?.surfaceId).toBe('desk:top');
  });
});

async function setup(
  env: Record<string, string> = {},
  fetcher?: Fetcher,
  /** A data folder to start from, copied: the store as an earlier test left it. */
  from?: string,
) {
  const { app, post, dataDir } = await testApp({
    name: 'scan',
    env,
    ...(fetcher ? { fetcher } : {}),
    ...(from ? { from } : {}),
  });
  return { app, post, dataDir };
}
type Scanned = { run: EvidenceRun; mapped: MappedThing[]; memory: DeskMemory };

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
  it('lifts the room’s fixtures off its picture, as sprites over a base, and puts them back', async () => {
    const s = await setup();
    expect((await s.post('scene/separate')).statusCode).toBe(409);
    const draft = (await s.post('scene/from-photo')).json<EvidenceRun<PhotoDraft>>();
    const { layout } = draft.output;
    await s.post('scene/from-photo/save', {
      runId: draft.id,
      scene: layout.scene,
      pin: layout.pin,
      track: [],
    });
    await s.post('scene/illustrate');
    // Nothing of the room yet: the demo's scans map the preset desk.
    expect((await s.post('scene/separate')).statusCode).toBe(409);
    const top = layout.scene.surfaces.find((x) => x.id === layout.pin!.surfaceId)!;
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      state: _s,
      model,
      ...rest
    } = fixture({
      label: 'Green book',
      scene: 'custom',
      surfaceId: top.id,
      at: { x: top.rect.x + 0.4, y: top.rect.y + 0.3 },
      size: { w: 0.6, d: 0.6, h: 0.8 },
      control: { kind: 'none' },
    });
    const saved = await s.post('fixtures/save', {
      fixture: { ...rest, model: { label: model.label, parts: model.parts } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const jobId = crypto.randomUUID();
    const res = await s.post('scene/separate', { jobId });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json<{ memory: DeskMemory; lifted: number; run: EvidenceRun }>();
    // Followed step by step, with pictures of what was found and cut.
    const job = (await s.app.inject(`/api/jobs/${jobId}`)).json<Job>();
    expect(job).toMatchObject({ title: 'Lifting the fixtures', outcome: 'done' });
    expect(job.steps.every((x) => x.state === 'done')).toBe(true);
    for (const id of ['find', 'outline', 'base'])
      expect(job.steps.find((x) => x.id === id)!.image).toBeTruthy();
    expect(job.runIds).toContain(out.run.id);
    const picture = out.memory.illustration!;
    const fixtures = out.memory.fixtures!.filter((f) => f.scene === 'custom');
    expect(out.lifted).toBeGreaterThan(0);
    expect(picture.layers!.sprites).toHaveLength(out.lifted);
    expect(picture.layers!.base).toBe(`${out.run.id}/base.png`);
    // Each sprite belongs to a fixture of the room, and is served like the picture.
    for (const sprite of picture.layers!.sprites) {
      expect(fixtures.map((f) => f.id)).toContain(sprite.fixtureId);
      const served = await s.app.inject(
        `/api/scene/illustration?asset=${encodeURIComponent(sprite.asset)}`,
      );
      expect(served.statusCode).toBe(200);
      const size = await sharp(served.rawPayload).metadata();
      expect([size.width, size.height, size.channels]).toEqual([
        sprite.box.width,
        sprite.box.height,
        4,
      ]);
    }
    // The base keeps the picture's size and changes only where a fixture was lifted.
    const base = await sharp(
      readFileSync(join(s.dataDir, 'evidence', picture.layers!.base)),
    ).metadata();
    expect([base.width, base.height]).toEqual([picture.frame.width, picture.frame.height]);
    const raw = (asset: string) =>
      sharp(readFileSync(join(s.dataDir, 'evidence', asset)))
        .removeAlpha()
        .raw()
        .toBuffer();
    expect((await raw(picture.layers!.base)).equals(await raw(picture.asset))).toBe(false);
    // Putting them back shows the picture whole again.
    const back = (await s.post('scene/separate/undo')).json<{ memory: DeskMemory }>();
    expect(back.memory.illustration!.layers).toBeUndefined();
    expect(back.memory.illustration!.asset).toBe(picture.asset);
    await s.app.close();
  });
  it('moves a sprite with its fixture, and scales it with the footprint', () => {
    const sprite = {
      fixtureId: 'f',
      asset: 'r/sprite-1.png',
      box: { x: 90, y: 40, width: 20, height: 60 },
      anchor: { x: 100, y: 100 },
      size: { w: 1, d: 1 },
    };
    expect(spriteBox(sprite, { anchor: { x: 130, y: 90 }, w: 1, d: 1 })).toEqual({
      x: 120,
      y: 30,
      width: 20,
      height: 60,
    });
    expect(spriteBox(sprite, { anchor: { x: 100, y: 100 }, w: 2, d: 2 })).toEqual({
      x: 80,
      y: -20,
      width: 40,
      height: 120,
    });
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
      if (body.text.format.name === 'item_check')
        return sparkResponse({ height: 1, radius: 1, handleReach: 1, body: null, note: 'Close.' });
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
    const photo = await sharp(readFileSync('testdata/desk.svg')).png().toBuffer();
    const imageDataUrl = `data:image/png;base64,${photo.toString('base64')}`;
    const scan = () => s.post('fixtures/scan', { mode: 'live', imageDataUrl });
    return { ...s, prompts, scan, fetcher };
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
  it('lifts the room’s fixtures with one Spark, one SAM and one image call, over a furniture-only base', async () => {
    const calls: string[] = [];
    const fill = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#ff00ff' },
    })
      .png()
      .toBuffer();
    const fetcher = mock<Fetcher>().mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === 'sam-3.1') {
        calls.push('sam');
        return samResponse(`<0f>1${sam.wire.replace(/^<0f>7/, '')}`);
      }
      if (body.text?.format?.name === 'sculpt') {
        calls.push(
          `sculpt (${body.reasoning?.effort ?? 'default'}): ${body.input[0].content[0].text}`,
        );
        return sparkResponse({
          note: 'A shade on a thin stand.',
          parts: [
            {
              id: 'shade',
              shape: 'lathe',
              at: { x: 0.1, y: 0.1, z: 0.6 },
              size: { w: 0.8, d: 0.8, h: 0.4 },
              color: '#f0e0c0',
              material: 'fabric',
              profile: [
                { r: 1, z: 0 },
                { r: 0.6, z: 1 },
              ],
              path: null,
              outline: null,
              radius: null,
              rough: null,
              bands: null,
            },
            {
              id: 'stand',
              shape: 'tube',
              at: { x: 0.45, y: 0.45, z: 0 },
              size: { w: 0.1, d: 0.1, h: 0.6 },
              color: '#202020',
              material: 'metal',
              profile: null,
              path: [
                { x: 0.5, y: 0.5, z: 0 },
                { x: 0.5, y: 0.5, z: 1 },
              ],
              outline: null,
              radius: 0.03,
              rough: null,
              bands: null,
            },
          ],
        });
      }
      if (body.text?.format?.name === 'picture_find') {
        calls.push(`find: ${body.input[0].content[0].text}`);
        // Found anywhere in the picture: SAM's outline decides the rest.
        return sparkResponse({
          found: [{ index: 1, seen: true, box: { x1: 0, y1: 0, x2: 1000, y2: 1000 } }],
        });
      }
      if (String(url).endsWith('/images/edits')) {
        calls.push(`image: ${body.prompt}`);
        return new Response(
          JSON.stringify({ created: 1, data: [{ b64_json: fill.toString('base64') }] }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected call ${String(url)}`);
    });
    const s = await setup({ MODEL_API_KEY: 'test-key', META_LIVE_ENABLED: 'true' }, fetcher);
    // A room drawn offline, moved to the live desk with its picture and one fixture on its desk.
    const draft = (await s.post('scene/from-photo')).json<EvidenceRun<PhotoDraft>>();
    const { layout } = draft.output;
    await s.post('scene/from-photo/save', {
      runId: draft.id,
      scene: layout.scene,
      pin: layout.pin,
      track: [],
    });
    const drawn = (await s.post('scene/illustrate')).json<{ memory: DeskMemory }>().memory;
    const top = layout.scene.surfaces.find((x) => x.id === layout.pin!.surfaceId)!;
    // The picture redraws the camera's 960×640 frame, the size the mocked SAM reply is for.
    const old = drawn.illustration!;
    expect(old.frame).toEqual({ width: 960, height: 640 });
    mkdirSync(join(s.dataDir, 'evidence', 'live-picture'), { recursive: true });
    writeFileSync(
      join(s.dataDir, 'evidence', 'live-picture', 'illustration.png'),
      readFileSync(join(s.dataDir, 'evidence', old.asset)),
    );
    const restored = await s.post('desk/restore', {
      mode: 'live',
      memory: {
        mode: 'live',
        object: null,
        scene: drawn.scene,
        surface: drawn.surface,
        illustration: { ...old, asset: 'live-picture/illustration.png' },
      },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      state: _s,
      model,
      ...rest
    } = fixture({
      label: 'Desk lamp',
      scene: 'custom',
      surfaceId: top.id,
      at: { x: top.rect.x + 0.4, y: top.rect.y + 0.3 },
      size: { w: 0.6, d: 0.6, h: 0.8 },
      control: { kind: 'none' },
    });
    const saved = await s.post('fixtures/save', {
      mode: 'live',
      fixture: { ...rest, model: { label: model.label, parts: model.parts } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const res = await s.post('scene/separate', { mode: 'live' });
    expect(res.statusCode, res.body).toBe(200);
    // Spark finds it by name near where the layout expects it, SAM outlines it there, Muse redraws the furniture.
    expect(calls).toEqual([
      expect.stringMatching(/^find: [\s\S]*1\. Desk lamp \(expected near \d+, \d+, \d+, \d+\)/),
      'sam',
      expect.stringContaining('including the desk lamp'),
    ]);
    const status = (await s.app.inject('/api/status')).json<{ meta: { spentToday: number } }>();
    expect(status.meta.spentToday).toBeGreaterThan(0.0125);
    expect(status.meta.spentToday).toBeLessThan(0.02);
    const picture = res.json<{ memory: DeskMemory }>().memory.illustration!;
    expect(picture.layers!.sprites).toHaveLength(1);
    // The base is Muse's furniture-only redraw as a whole, the picture's size.
    const base = await sharp(readFileSync(join(s.dataDir, 'evidence', picture.layers!.base)))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([base.info.width, base.info.height]).toEqual([960, 640]);
    expect([...base.data.subarray(0, 4)]).toEqual([255, 0, 255, 255]);

    // Modelled with AI from its cut-out: three drafts from its model at once, at low effort.
    const lamp = res
      .json<{ memory: DeskMemory }>()
      .memory.fixtures!.find((f) => f.label === 'Desk lamp')!;
    calls.length = 0;
    const jobId = crypto.randomUUID();
    const sculpted = await s.post('fixtures/sculpt', { mode: 'live', fixtureId: lamp.id, jobId });
    expect(sculpted.statusCode, sculpted.body).toBe(200);
    // Its steps can be followed by the page's id: all done, with pictures of what each made.
    const job = (await s.app.inject(`/api/jobs/${jobId}`)).json<Job>();
    expect(job.done).toBe(true);
    expect(job.steps.map((x) => [x.id, x.state])).toEqual([
      ['picture', 'done'],
      ['current', 'done'],
      ['draft', 'done'],
      ['keep', 'done'],
      ['save', 'done'],
    ]);
    expect(job.steps.filter((x) => x.image?.startsWith('data:image/png')).map((x) => x.id)).toEqual(
      ['picture', 'current', 'draft', 'keep'],
    );
    expect(job.steps[2]!.detail).toMatch(
      /^2 parts, \d+% overlap with the picture, the best of 3\. A shade/,
    );
    expect((await s.app.inject(`/api/jobs/${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect(calls).toEqual(
      Array(3).fill(
        expect.stringMatching(/^sculpt \(low\): Model the desk lamp in the first image/),
      ),
    );
    const after = sculpted.json<{ memory: DeskMemory; run: EvidenceRun }>();
    const sculpture = after.memory.fixtures!.find((f) => f.id === lamp.id)!.model;
    expect(sculpture.source).toBe('spark');
    expect(sculpture.parts.map((p) => [p.id, p.shape])).toEqual([
      ['shade', 'lathe'],
      ['stand', 'tube'],
    ]);
    expect(after.run.assets).toContain(`${after.run.id}/render-final.png`);
    // A note is looked up (the catalog knows this one, so no web search) and told to Spark.
    calls.length = 0;
    const noted = crypto.randomUUID();
    const withNote = await s.post('fixtures/sculpt', {
      mode: 'live',
      fixtureId: lamp.id,
      jobId: noted,
      note: 'It’s an IKEA Alex desk',
    });
    expect(withNote.statusCode, withNote.body).toBe(200);
    const lookedUp = (await s.app.inject(`/api/jobs/${noted}`)).json<Job>().steps[1]!;
    expect([lookedUp.id, lookedUp.state, lookedUp.detail]).toEqual([
      'lookup',
      'done',
      'IKEA ALEX desk (catalog ✓)',
    ]);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call).toContain('The person says about it: "It’s an IKEA Alex desk"');
      expect(call).toContain('What is known of the product: It is the IKEA ALEX desk.');
    }
    expect(withNote.json<{ run: EvidenceRun }>().run.output).toMatchObject({
      asked: 'It’s an IKEA Alex desk',
      product: 'IKEA ALEX desk',
    });
    // The product's size (131 × 60 × 76 cm) is the fixture's now, along its own longer side.
    const resized = withNote
      .json<{ memory: DeskMemory }>()
      .memory.fixtures!.find((f) => f.id === lamp.id)!.size;
    const long = lamp.size.w >= lamp.size.d;
    expect(resized).toEqual(
      long ? { w: 131 / 30, d: 2, h: 76 / 30 } : { w: 2, d: 131 / 30, h: 76 / 30 },
    );
    expect((await s.app.inject(`/api/jobs/${noted}`)).json<Job>().steps.at(-1)!.detail).toMatch(
      /sized as the product: (131 × 60|60 × 131) × 76 cm$/,
    );
    // A past run's model goes back on with no call, the one it replaces kept as a draft.
    calls.length = 0;
    const before = withNote
      .json<{ memory: DeskMemory }>()
      .memory.fixtures!.find((f) => f.id === lamp.id)!;
    const reapplied = await s.post('fixtures/sculpt/reapply', { mode: 'live', jobId });
    expect(reapplied.statusCode, reapplied.body).toBe(200);
    expect(calls).toEqual([]);
    const back = reapplied
      .json<{ memory: DeskMemory; fixtureId: string }>()
      .memory.fixtures!.find((f) => f.id === lamp.id)!;
    expect(reapplied.json<{ fixtureId: string }>().fixtureId).toBe(lamp.id);
    expect(back.model.parts).toEqual(sculpture.parts);
    expect(back.drafts?.length).toBe((before.drafts?.length ?? 0) + 1);
    // The first run looked nothing up, so the product's size stays.
    expect(back.size).toEqual(resized);
    expect(
      (await s.post('fixtures/sculpt/reapply', { mode: 'live', jobId: crypto.randomUUID() }))
        .statusCode,
    ).toBe(404);
    // The demo has no Spark to ask.
    expect((await s.post('fixtures/sculpt', { fixtureId: lamp.id })).statusCode).toBe(400);
    await s.app.close();
    // Drawing, lifting and modelling with image work: slow on a busy machine.
  }, 20_000);
  it('asks Spark once, leaving out what the camera follows, and maps what it finds', async () => {
    const s = await live();
    await pin(s);
    const res = await s.scan();
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json<Scanned>();
    // Spark's list and SAM's outlines; each thing is fitted locally, with no check of its own.
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[0]).toMatch(/^fixture_scan: /);
    expect(s.prompts[0]).toContain('followed separately: Mug');
    expect(s.prompts[1]).toBe('sam');
    expect(r.run).toMatchObject({ kind: 'fixture', mode: 'live', status: 'completed' });
    expect(r.run.assets).toEqual(
      expect.arrayContaining([
        `${r.run.id}/source.webp`,
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
    const photo = await sharp(readFileSync('testdata/desk.svg')).png().toBuffer();
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
  it('says the room’s photo is the wrong shape when it scans that and not a frame', async () => {
    const s = await live();
    await pin(s);
    const memory = (await s.app.inject('/api/desk/live')).json<DeskMemory>();
    const runId = crypto.randomUUID();
    const dir = join(s.dataDir, 'evidence', runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'source.png'),
      await sharp(readFileSync('testdata/desk.svg')).resize(640, 480).png().toBuffer(),
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
    const res = await s.post('fixtures/scan', { mode: 'live' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: 'scan_frame',
      message: expect.stringMatching(/^No photo was sent, and the room’s own photo is 640×480/),
    });
    expect(s.prompts).toEqual([]);
  });
  it('serves a drafted room’s photo at its pin’s size, nothing for a preset, and refuses another camera’s shape', async () => {
    const s = await live();
    await pin(s);
    expect((await s.app.inject('/api/scene/photo?mode=live')).statusCode).toBe(404);
    const memory = (await s.app.inject('/api/desk/live')).json<DeskMemory>();
    const runId = crypto.randomUUID();
    const dir = join(s.dataDir, 'evidence', runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'source.png'),
      await sharp(readFileSync('testdata/desk.svg')).resize(480, 320).png().toBuffer(),
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
    // A 4:3 photo from a phone is not the pinned camera's 3:2 view: it isn't stretched to pass for it.
    writeFileSync(
      join(dir, 'source.png'),
      await sharp(readFileSync('testdata/desk.svg')).resize(640, 480).png().toBuffer(),
    );
    const other = await s.app.inject('/api/scene/photo?mode=live');
    expect(other.statusCode).toBe(409);
    expect(other.json<{ error: { code: string } }>().error.code).toBe('photo_shape');
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

describe('a looked-up product’s size for a fixture', () => {
  const alex = { sizeCm: { w: 131, d: 60, h: 76 }, confidence: 0.9 };
  it('lays it along the fixture’s own longer side, in tiles', () => {
    expect(productSize(alex, { w: 4, d: 2 })).toEqual({ w: 131 / 30, d: 2, h: 76 / 30 });
    expect(productSize(alex, { w: 2, d: 4 })).toEqual({ w: 2, d: 131 / 30, h: 76 / 30 });
  });
  it('keeps the fixture’s own when the lookup is unsure or the size is not one a fixture can be', () => {
    expect(productSize({ ...alex, confidence: 0.3 }, { w: 4, d: 2 })).toBeNull();
    expect(productSize({ confidence: 0.9 }, { w: 4, d: 2 })).toBeNull();
    expect(
      productSize({ sizeCm: { w: 900, d: 60, h: 76 }, confidence: 0.9 }, { w: 4, d: 2 }),
    ).toBeNull();
  });
  it('tells Spark a greyscale picture is for shape only', () => {
    expect(sculptPrompt('Fan', { w: 1, d: 1, h: 3 }, { greyscale: true })).toContain(
      'use it for shape only',
    );
    expect(sculptPrompt('Fan', { w: 1, d: 1, h: 3 })).not.toContain('greyscale');
  });
});

describe('finding only what the room has', () => {
  // The office desk as the person's own layout, pinned on its top.
  const custom = { ...ISO_PRESETS.desk, kind: 'custom' as const };
  const pin: SurfacePin = { ...DEMO_SURFACE, scene: 'custom' };
  const book = thing();
  const mouse = thing({
    label: 'purple mouse',
    archetype: 'device',
    box: { x1: 500, y1: 500, x2: 560, y2: 560 },
    sizeCm: { w: 6, d: 12, h: 4 },
  });
  const map = (over: Partial<Parameters<typeof mapScan>[0]> = {}) =>
    mapScan({
      scan: { things: [book, mouse] },
      pin,
      scene: 'custom',
      custom,
      library: [],
      room: 12,
      entities: [],
      replace: true,
      ...over,
    });

  it('lists the layout’s things standing on the desk, not the desk', () => {
    expect(
      layoutThings(custom)
        .map((t) => t.group)
        .sort(),
    ).toEqual(['book', 'bottle', 'lamp']);
  });
  it('moves the layout’s book to where it was seen, and adds nothing without addNew', () => {
    const [found, other] = map({ addNew: false });
    expect(found).toMatchObject({ match: 'existing', layoutGroup: 'book', fixture: null });
    expect(found!.moveBy).toBeDefined();
    expect(other).toMatchObject({ match: 'new', fixture: null });
    // It lands where a new book seen there would have been placed.
    const [placed] = mapScan({
      scan: { things: [book] },
      pin,
      scene: 'custom',
      custom: { ...custom, props: custom.props.filter((p) => p.group !== 'book') },
      library: [],
      room: 12,
      entities: [],
    });
    const moved = withLayoutMoves(custom, [found!]);
    const was = layoutThings(custom).find((t) => t.group === 'book')!;
    const now = layoutThings(moved).find((t) => t.group === 'book')!;
    expect(now.at.z).toBeCloseTo(was.at.z, 5);
    const f = placed!.fixture!;
    expect(Math.abs(now.at.x + now.size.w / 2 - (f.at.x + f.size.w / 2))).toBeLessThan(0.3);
    expect(Math.abs(now.at.y + now.size.d - (f.at.y + f.size.d))).toBeLessThan(0.3);
  });
  it('leaves the layout’s things off the desk where they are', () => {
    // The office's plant stands on the floor, its book on the shelf.
    const office = { ...ISO_PRESETS.office, kind: 'custom' as const };
    const room = {
      ...office,
      props: office.props.map((p) =>
        p.group === 'book' ? { ...p, at: { x: 7.4, y: 0.3, z: 4 } } : p,
      ),
    };
    const plant = thing({ label: 'potted plant', archetype: 'plant' });
    const mapped = mapScan({
      scan: { things: [book, plant] },
      pin,
      scene: 'custom',
      custom: room,
      library: [],
      room: 12,
      entities: [],
      replace: true,
      addNew: false,
    });
    expect(mapped.map((m) => m.match)).toEqual(['new', 'new']);
    expect(mapped.some((m) => m.layoutGroup)).toBe(false);
  });
  it('leaves the layout where it is without replace, and adds new things with addNew', () => {
    const [found, other] = map({ replace: false });
    expect(found!.moveBy).toBeUndefined();
    expect(other!.fixture).not.toBeNull();
  });
});
