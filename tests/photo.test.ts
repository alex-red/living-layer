import { afterEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { syntheticStream } from '../apps/server/src/sam.js';
import type { PhotoDraft } from '../apps/server/src/photo.js';
import type { AutoPin } from '../apps/server/src/pin.js';
import { MetaAdapter } from '../apps/server/src/meta.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import {
  cameraFromPin,
  cleanInventory,
  framePointInPicture,
  fillRings,
  fitSurfaceQuad,
  groupBounds,
  isoSceneSchema,
  layoutPhoto,
  maskBits,
  newBits,
  orderCorners,
  pathRings,
  photoTextures,
  pinFromMask,
  projectPoint,
  promptBox,
  sceneForSave,
  surfaceTop,
  syntheticPhoto,
  unprojectPoint,
  type DeskMemory,
  type EvidenceRun,
  type Job,
  type PhotoInventory,
  type Point,
  type Quad,
  type Segmentation,
} from '@livinglayer/domain';

// The route tests fit object models, which a busy machine stretches past bun's 5 s default.
setDefaultTimeout(30_000);

/**
 * A pinhole camera looking at a desk from `elevation` degrees up, turned by
 * `yaw` radians, `dist` tiles from the desk's centre. World X runs along the
 * desk's back edge, Y toward the front, Z up from the desktop.
 */
function camera(elevation: number, yaw: number, f: number, frame = { width: 1280, height: 720 }) {
  const el = (elevation * Math.PI) / 180;
  const dist = 9;
  const target = [2, 1.25, -0.6];
  const C = [
    target[0]! + dist * Math.cos(el) * Math.sin(yaw),
    target[1]! + dist * Math.cos(el) * Math.cos(yaw),
    target[2]! + dist * Math.sin(el),
  ];
  const fwd = target.map((v, i) => v - C[i]!);
  const n = Math.hypot(...fwd);
  const z = fwd.map((v) => v / n);
  const right = [Math.cos(yaw), -Math.sin(yaw), 0];
  const down = [
    right[1]! * z[2]! - right[2]! * z[1]!,
    right[2]! * z[0]! - right[0]! * z[2]!,
    right[0]! * z[1]! - right[1]! * z[0]!,
  ];
  const project = (X: number, Y: number, Z: number): Point => {
    const p = [X - C[0]!, Y - C[1]!, Z - C[2]!];
    const d = (a: number[]) => p[0]! * a[0]! + p[1]! * a[1]! + p[2]! * a[2]!;
    return {
      x: (f * d(right)) / d(z) + frame.width / 2,
      y: (f * d(down)) / d(z) + frame.height / 2,
    };
  };
  // The camera aims a little below the desktop; this is its angle above the desk's centre.
  const centre = Math.hypot(C[0]! - 2, C[1]! - 1.25, C[2]!);
  return Object.assign(project, { elevation: (Math.asin(C[2]! / centre) * 180) / Math.PI });
}
/** A desk with a chair in front of it and a mug on it, as SAM would outline them. */
const deskPhoto = (elevation: number, yaw: number) =>
  syntheticPhoto({
    elevation,
    yaw,
    f: 1000,
    furniture: [{ id: 'chair', as: 'chair', x: 1.3, y: 3.2 }],
    objects: [{ id: 'mug', as: 'mug', x: 2.5, y: 1.2, r: 0.3, h: 0.7 }],
  });

describe('photo masks', () => {
  it('reads SAM paths, absolute and relative, and fills them by the even-odd rule', () => {
    expect(pathRings('M0 0L4 0L4 4L0 4Z')).toEqual([
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
        { x: 0, y: 4 },
      ],
    ]);
    expect(pathRings('m1 1 h2 v2 h-2 z')[0]).toEqual([
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 3 },
      { x: 1, y: 3 },
    ]);
    // A 2 × 1 mask stretched over a 20 × 10 box: its left half, with a hole cut out.
    const bits = maskBits(
      {
        objectId: '1',
        confidence: 1,
        box: { x: 10, y: 5, width: 20, height: 10 },
        mask: {
          width: 2,
          height: 1,
          foregroundPixels: 1,
          svgPath: 'M0 0L1 0L1 1L0 1ZM0.25 0.25L0.75 0.25L0.75 0.75L0.25 0.75Z',
        },
      },
      { width: 40, height: 20 },
      1,
    );
    expect(bits.data[6 * 40 + 11]).toBe(1);
    expect(bits.data[10 * 40 + 15]).toBe(0);
    expect(bits.data[10 * 40 + 25]).toBe(0);
  });
  it('turns Spark’s thousandths into a prompt box inside the frame, the right way up', () => {
    const [t] = cleanInventory({
      kind: 'desk',
      summary: '',
      things: [
        {
          id: 'Mug 1',
          label: 'mug',
          as: 'mug',
          role: 'object',
          on: 'nothing',
          box: { x1: 600, y1: 900, x2: 400, y2: 1000 },
        },
      ],
    }).things;
    expect(t!.id).toBe('mug-1');
    expect(t!.on).toBe('floor');
    expect(promptBox(t!, { width: 1000, height: 500 })).toEqual({
      left: 400,
      top: 450,
      right: 600,
      bottom: 500,
    });
  });
});

describe('the pinned surface', () => {
  it('orders corners clockwise from the back left', () => {
    const q = orderCorners([
      { x: 90, y: 80 },
      { x: 10, y: 10 },
      { x: 5, y: 85 },
      { x: 100, y: 12 },
    ]);
    expect(q).toEqual([
      { x: 10, y: 10 },
      { x: 100, y: 12 },
      { x: 90, y: 80 },
      { x: 5, y: 85 },
    ]);
  });
  it('finds a thin top seen nearly edge-on, without the drawer unit under one end', () => {
    // A long desk running away from the camera: its top a thin strip, a drawer unit below its near end.
    const top: Quad = [
      { x: 0, y: 60 },
      { x: 190, y: 40 },
      { x: 190, y: 52 },
      { x: 0, y: 96 },
    ];
    const drawers: Quad = [
      { x: 10, y: 90 },
      { x: 70, y: 80 },
      { x: 70, y: 130 },
      { x: 10, y: 130 },
    ];
    const bits = newBits(200, 130);
    fillRings(bits, [top]);
    fillRings(bits, [drawers]);
    const found = surfaceTop(bits, []);
    const at = (x: number, y: number) => found.data[y * 200 + x];
    // The far, thin end of the top stays; the drawer fronts go.
    expect(at(170, 47)).toBe(1);
    expect(at(40, 120)).toBe(0);
    expect(at(40, 110)).toBe(0);
    const fit = fitSurfaceQuad(found, { width: 200, height: 130 })!;
    expect(Math.max(...fit.corners.map((c) => c.y))).toBeLessThan(100);
  });
  it('keeps all of a desk seen at an angle, its near side rising above the front edge', () => {
    const top: Quad = [
      { x: 40, y: 30 },
      { x: 170, y: 40 },
      { x: 150, y: 80 },
      { x: 20, y: 110 },
    ];
    const bits = newBits(200, 130);
    fillRings(bits, [top]);
    const found = surfaceTop(bits, []);
    expect(found.data[105 * 200 + 25]).toBe(1);
    expect(found.data[60 * 200 + 150]).toBe(1);
  });
  it('fits four corners to a perspective quad’s mask', () => {
    const truth: Quad = [
      { x: 52, y: 40 },
      { x: 160, y: 30 },
      { x: 190, y: 110 },
      { x: 20, y: 118 },
    ];
    const bits = newBits(200, 130);
    fillRings(bits, [truth]);
    const fit = fitSurfaceQuad(bits, { width: 200, height: 130 })!;
    expect(fit.iou).toBeGreaterThan(0.97);
    fit.corners.forEach((c, i) => {
      expect(Math.hypot(c.x - truth[i]!.x, c.y - truth[i]!.y)).toBeLessThan(3);
    });
  });
  it('recovers the camera exactly when the perspective shows the focal length', () => {
    const cam = camera(35, 0.45, 900);
    const corners = orderCorners([cam(0, 0, 0), cam(4, 0, 0), cam(4, 2.5, 0), cam(0, 2.5, 0)]);
    const c = cameraFromPin(corners, { width: 1280, height: 720 }, 4)!;
    expect(c.focalGuessed).toBe(false);
    expect(c.f).toBeCloseTo(900, 0);
    expect(c.surface.d).toBeCloseTo(2.5, 3);
    const floor = unprojectPoint(c, cam(1, 4, -2.4), -2.4)!;
    expect(floor.X).toBeCloseTo(1, 3);
    expect(floor.Y).toBeCloseTo(4, 3);
    const p = projectPoint(c, 3, 2, 1)!;
    expect(p.x).toBeCloseTo(cam(3, 2, 1).x, 2);
    expect(p.y).toBeCloseTo(cam(3, 2, 1).y, 2);
  });
  it('falls back to a typical lens when the desk is seen square on, and stays close', () => {
    const cam = camera(35, 0, 900);
    const corners = orderCorners([cam(0, 0, 0), cam(4, 0, 0), cam(4, 2.5, 0), cam(0, 2.5, 0)]);
    const c = cameraFromPin(corners, { width: 1280, height: 720 }, 4)!;
    expect(c.focalGuessed).toBe(true);
    expect(Math.abs(c.surface.d - 2.5) / 2.5).toBeLessThan(0.15);
    expect(Math.abs(c.elevation - cam.elevation)).toBeLessThan(4);
  });
});

describe('pin from one mask', () => {
  for (const [elevation, yaw] of [
    [35, 0.4],
    [50, -0.3],
    [28, 0],
  ] as const)
    it(`pins a close photo's desk from its outline alone (${elevation}°, turned ${yaw})`, () => {
      const s = deskPhoto(elevation, yaw);
      const desk = s.segmentation.detections.find((d) => d.objectId === s.detections.surface)!;
      const pin = pinFromMask(desk, s.segmentation.frame)!;
      // The mug's hole and the legs are ignored, without the other masks.
      expect(pin.iou).toBeGreaterThan(0.9);
      const diag = Math.hypot(1280, 720);
      pin.corners.forEach((c, i) =>
        expect(
          Math.hypot(c.x - s.truth.corners[i]!.x, c.y - s.truth.corners[i]!.y) / diag,
        ).toBeLessThan(0.03),
      );
    });
});

describe('photo layout', () => {
  for (const [elevation, yaw] of [
    [35, 0.4],
    [50, -0.3],
    [28, 0],
  ] as const)
    it(`measures a desk, a chair and a mug from their masks (${elevation}°, turned ${yaw})`, () => {
      const s = deskPhoto(elevation, yaw);
      const layout = layoutPhoto({ ...s, refine: true });
      expect(isoSceneSchema.safeParse(layout.scene).success).toBe(true);
      // The desk's top is found above its legs, and pinned within a few pixels.
      expect(layout.quadIou).toBeGreaterThan(0.9);
      const diag = Math.hypot(1280, 720);
      layout.pin!.corners.forEach((c, i) => {
        expect(
          Math.hypot(c.x - s.truth.corners[i]!.x, c.y - s.truth.corners[i]!.y) / diag,
        ).toBeLessThan(0.025);
      });
      expect(Math.abs(layout.camera!.surface.d - 2.5)).toBeLessThan(0.25);
      const origin = layout.origin!;
      const chair = layout.things.find((t) => t.id === 'chair')!;
      expect(chair.status).toBe('placed');
      const b = groupBounds(layout.scene, chair.group!)!;
      expect(Math.abs(b.at.x - origin.x - 1.3)).toBeLessThan(0.5);
      expect(Math.abs(b.at.y - origin.y - 3.2)).toBeLessThan(0.5);
      const mug = layout.things.find((t) => t.id === 'mug')!;
      expect(mug.status).toBe('object');
      expect(mug.foot!.at.z).toBeCloseTo(origin.z, 3);
      expect(Math.abs(mug.foot!.at.x + mug.foot!.size.w / 2 - origin.x - 2.5)).toBeLessThan(0.3);
      expect(Math.abs(mug.foot!.at.y + mug.foot!.size.d / 2 - origin.y - 1.2)).toBeLessThan(0.4);
      expect(layout.score!).toBeGreaterThan(0.7);
      expect(chair.iou!).toBeGreaterThan(0.6);
    });
  it('reads the same desk when a review edit lays the draft out again from its own corners', () => {
    const s = deskPhoto(35, 0.4);
    const draft = layoutPhoto({ ...s, refine: true });
    const again = layoutPhoto({ ...s, corners: draft.pin!.corners, refine: true });
    expect(again.camera!.surface.w).toBe(draft.camera!.surface.w);
    expect(again.camera!.surface.d).toBeCloseTo(draft.camera!.surface.d, 6);
  });
  it('paints the desk top from the photo where the camera saw it', () => {
    const s = deskPhoto(35, 0.4);
    const layout = layoutPhoto({ ...s, refine: true });
    // A photo that is red on its upper half and blue below, at the frame's size.
    const { width, height } = s.segmentation.frame;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        data.set(y < height / 2 ? [200, 0, 0, 255] : [0, 0, 200, 255], (y * width + x) * 4);
    const textures = photoTextures(layout.scene, layout.pin!, { width, height, data });
    const surface = layout.scene.surfaces.find((x) => x.id === layout.pin!.surfaceId)!;
    const top = textures.get(surface.propId)?.top;
    expect(top).toBeDefined();
    // Each texel holds the photo's colour where its point on the top projects.
    const cam = layout.camera!;
    const origin = layout.origin!;
    const prop = layout.scene.props.find((p) => p.id === surface.propId)!;
    for (const [a, b] of [
      [0.5, 0.05],
      [0.5, 0.95],
      [0.1, 0.5],
    ] as const) {
      const X = prop.at.x + prop.size.w * a - origin.x;
      const Y = prop.at.y + prop.size.d * b - origin.y;
      const px = projectPoint(cam, X, Y, prop.at.z + prop.size.h - origin.z)!;
      const i = Math.floor(a * top!.width);
      const j = Math.floor(b * top!.height);
      const texel = top!.data[(j * top!.width + i) * 4]!;
      expect(texel > 100).toBe(px.y < height / 2);
    }
    // Every texel is opaque: unseen ones take the face's mean colour.
    for (let n = 3; n < top!.data.length; n += 4) expect(top!.data[n]).toBe(255);
  });
  it('spreads things over the room without a surface, and leaves the pin to a person', () => {
    const layout = layoutPhoto({ ...deskPhoto(35, 0.4), edits: { surface: { as: 'rug' } } });
    expect(layout.pin).toBeNull();
    expect(layout.camera).toBeNull();
    expect(layout.things.find((t) => t.id === 'chair')!.status).toBe('placed');
    expect(isoSceneSchema.safeParse(layout.scene).success).toBe(true);
  });
  it('leaves out what a person removed and what SAM did not find', () => {
    const s = deskPhoto(35, 0.4);
    const { chair: _, ...found } = s.detections;
    const layout = layoutPhoto({ ...s, detections: found, edits: { mug: { removed: true } } });
    expect(layout.things.map((t) => t.status)).toEqual(['placed', 'not-found', 'removed']);
    expect(layout.scene.props.every((p) => p.group === 'desk')).toBe(true);
  });
  it('stands untracked objects with a template in the saved scene, and leaves tracked ones out', () => {
    const s = syntheticPhoto({
      elevation: 40,
      yaw: 0.3,
      f: 1000,
      objects: [
        { id: 'mug', as: 'mug', x: 1, y: 1.2, r: 0.3, h: 0.7 },
        { id: 'bottle', as: 'bottle', x: 3, y: 1, r: 0.25, h: 1.4 },
      ],
    });
    const layout = layoutPhoto(s);
    const scene = sceneForSave(layout, ['mug']);
    expect(scene.props.filter((p) => p.template === 'bottle')).toHaveLength(1);
    expect(scene.props.filter((p) => p.template === 'bottle')[0]!.at.z).toBeCloseTo(2.4, 3);
    expect(isoSceneSchema.safeParse(scene).success).toBe(true);
  });
});

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('photo routes, offline', () => {
  async function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-photo-'));
    dirs.push(dataDir);
    const fetcher = mock<Fetcher>();
    const app = await buildApp(parseConfig({ DATA_DIR: dataDir }), { fetcher, serveWeb: false });
    const post = (path: string, body: object = {}) =>
      app.inject({ method: 'POST', url: `/api/${path}`, payload: { mode: 'demo', ...body } });
    return { app, post, fetcher };
  }
  it('auto-pins the illustrated desk from its outline, saving only the segmentation', async () => {
    const s = await setup();
    const res = await s.post('desk/auto-pin');
    expect(res.statusCode, res.body).toBe(200);
    const { run, pin } = res.json<AutoPin>();
    expect(run.kind).toBe('segment');
    expect(run.output.concept).toBe('desk');
    // The illustration is all desktop, so the corners are the frame's.
    expect(pin!.frame).toEqual({ width: 960, height: 640 });
    const frame = [
      { x: 0, y: 0 },
      { x: 960, y: 0 },
      { x: 960, y: 640 },
      { x: 0, y: 640 },
    ];
    pin!.corners.forEach((c, i) =>
      expect(Math.hypot(c.x - frame[i]!.x, c.y - frame[i]!.y)).toBeLessThan(25),
    );
    // Nothing is pinned until the person saves the corners.
    expect((await s.app.inject('/api/desk/demo')).json<DeskMemory>().surface ?? null).toBeNull();
    expect(
      (await s.post('desk/auto-pin', { imageDataUrl: 'data:image/png;base64,AA' })).statusCode,
    ).toBe(400);
  });
  it('drafts the illustrated desk, then saves the scene, the pin and the ticked objects with their models', async () => {
    const s = await setup();
    const jobId = crypto.randomUUID();
    const drafted = await s.post('scene/from-photo', { check: true, jobId });
    expect(drafted.statusCode, drafted.body).toBe(200);
    const run = drafted.json<EvidenceRun<PhotoDraft>>();
    expect(run.kind).toBe('photo');
    // Followed step by step, Spark's check among them since it was asked for.
    const job = (await s.app.inject(`/api/jobs/${jobId}`)).json<Job>();
    expect(job).toMatchObject({ title: 'Drafting the room', outcome: 'done', runIds: [run.id] });
    expect(job.steps.map((x) => [x.id, x.state])).toEqual([
      ['photo', 'done'],
      ['list', 'done'],
      ['outline', 'done'],
      ['layout', 'done'],
      ['check', 'done'],
      ['models', 'done'],
    ]);
    for (const id of ['photo', 'list', 'outline', 'layout'])
      expect(job.steps.find((x) => x.id === id)!.image).toBeTruthy();
    const { layout, items } = run.output;
    // The illustration is all desktop, so the pin is the frame itself.
    expect(layout.pin!.corners).toEqual([
      { x: 0, y: 0 },
      { x: 960, y: 0 },
      { x: 960, y: 640 },
      { x: 0, y: 640 },
    ]);
    expect(layout.things.map((t) => [t.id, t.status])).toEqual([
      ['desk', 'placed'],
      ['mug', 'object'],
      ['book', 'object'],
      ['bottle', 'object'],
    ]);
    expect(Object.keys(items).sort()).toEqual(['book', 'bottle', 'mug']);
    expect(items.mug!.fit!.archetype).toBe('mug');
    expect(items.mug!.fit!.iou).toBeGreaterThan(0.8);
    expect(run.output.check?.note).toMatch(/^Demo/);
    expect(isoSceneSchema.safeParse(layout.scene).success).toBe(true);
    // The box-prompted masks are saved as a segmentation of their own.
    const segment = await s.app.inject(`/api/runs`);
    expect(
      segment
        .json<EvidenceRun[]>()
        .some((r) => r.id === run.output.segmentRunId && r.kind === 'segment'),
    ).toBe(true);

    const saved = await s.post('scene/from-photo/save', {
      runId: run.id,
      scene: layout.scene,
      pin: layout.pin,
      track: ['mug', 'bottle'],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const memory = saved.json<DeskMemory>();
    expect(memory.scene?.label).toBe('From photo');
    expect(memory.surface?.scene).toBe('custom');
    expect(memory.object?.label).toBe('Cream mug');
    expect(memory.observation?.detectionId).toBe('2');
    expect(memory.item?.fit?.archetype).toBe('mug');
    expect(memory.others?.map((o) => [o.label, o.concept, Boolean(o.item)])).toEqual([
      ['Sage bottle', 'sage bottle', true],
    ]);
    // The desk's top is painted from the photo, and its texture is served as a PNG.
    expect(isoSceneSchema.safeParse(memory.scene).success).toBe(true);
    const top = memory.scene!.props.find((p) => p.texture?.top)?.texture?.top;
    expect(top).toMatch(new RegExp(`^${run.id}/tex-\\d+\\.png$`));
    const texture = await s.app.inject(`/api/scene/texture?asset=${encodeURIComponent(top!)}`);
    expect(texture.statusCode).toBe(200);
    expect(texture.headers['content-type']).toBe('image/png');
    expect((await sharp(texture.rawPayload).metadata()).width).toBeGreaterThan(8);
    // Only textures are served, nothing else of the evidence.
    const other = await s.app.inject(
      `/api/scene/texture?asset=${encodeURIComponent(`${run.id}/source.png`)}`,
    );
    expect(other.statusCode).toBe(400);
    // The mug is followed from that sighting like any confirmed mug.
    const moved = (await s.post('segment', { concept: 'mug', demoPosition: 'right' })).json<
      EvidenceRun<Segmentation>
    >();
    const tracked = await s.post('desk/track', { segmentRunId: moved.id });
    expect(tracked.statusCode, tracked.body).toBe(200);
    expect(s.fetcher).not.toHaveBeenCalled();
    await s.app.close();
  });
  it('refuses a stale draft, an outside pin and objects SAM did not outline', async () => {
    const s = await setup();
    const run = (await s.post('scene/from-photo')).json<EvidenceRun<PhotoDraft>>();
    const { scene, pin } = run.output.layout;
    const save = (body: object) =>
      s.post('scene/from-photo/save', { runId: run.id, scene, pin, track: [], ...body });
    expect((await save({ track: ['nothing'] })).statusCode).toBe(400);
    expect((await save({ pin: { ...pin!, surfaceId: 'shelf:top' } })).statusCode).toBe(400);
    expect(
      (await s.post('scene/from-photo', { imageDataUrl: 'data:image/png;base64,AAAA' })).statusCode,
    ).toBe(400);
    await s.post('segment', { concept: 'mug' });
    expect((await save({})).statusCode).toBe(409);
    await s.app.close();
  });
  it('shows a photographed room as its ready-made demo picture, and only once its desk is pinned', async () => {
    const s = await setup();
    // No room yet: nothing to tie a picture to.
    const early = await s.post('scene/illustrate');
    expect(early.statusCode).toBe(409);
    const run = (await s.post('scene/from-photo')).json<EvidenceRun<PhotoDraft>>();
    const { layout } = run.output;
    await s.post('scene/from-photo/save', {
      runId: run.id,
      scene: layout.scene,
      pin: layout.pin,
      track: [],
    });
    const res = await s.post('scene/illustrate');
    expect(res.statusCode, res.body).toBe(200);
    const { memory } = res.json<{ memory: DeskMemory }>();
    const picture = memory.illustration!;
    expect(picture.asset).toMatch(/\/illustration\.png$/);
    expect(picture.desk).toHaveLength(4);
    // The mug's spot in the frame lands inside the picture's desk top.
    const middle = framePointInPicture(layout.pin!, picture, layout.pin!.frame, {
      x: 480,
      y: 320,
    })!;
    const xs = picture.desk!.map((p) => p.x);
    const ys = picture.desk!.map((p) => p.y);
    expect(middle.x).toBeGreaterThan(Math.min(...xs));
    expect(middle.x).toBeLessThan(Math.max(...xs));
    expect(middle.y).toBeGreaterThan(Math.min(...ys));
    expect(middle.y).toBeLessThan(Math.max(...ys));
    const served = await s.app.inject(
      `/api/scene/illustration?asset=${encodeURIComponent(picture.asset)}`,
    );
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    // The desk close up is drawn from the frame and keeps its framing, so frames that size map by scale.
    const desk = (await s.post('scene/illustrate', { view: 'desk' })).json<{ memory: DeskMemory }>()
      .memory.deskIllustration!;
    expect(desk.drawnFrom).toEqual({ width: 960, height: 640 });
    expect(desk.desk).toBeNull();
    const pin = layout.pin!;
    expect(framePointInPicture(pin, desk, { width: 960, height: 640 }, { x: 480, y: 320 })).toEqual(
      {
        x: desk.frame.width / 2,
        y: desk.frame.height / 2,
      },
    );
    expect(
      framePointInPicture(pin, desk, { width: 1280, height: 720 }, { x: 480, y: 320 }),
    ).toBeNull();
    // Starting over forgets the mug, not the room: both pictures stay.
    const reset = (await s.post('desk/reset')).json<DeskMemory>();
    expect(reset.illustration?.asset).toBe(picture.asset);
    expect(reset.deskIllustration?.asset).toBe(desk.asset);
    // A new photo makes a new room, so its old picture goes.
    const again = (await s.post('scene/from-photo')).json<EvidenceRun<PhotoDraft>>();
    const resaved = await s.post('scene/from-photo/save', {
      runId: again.id,
      scene: again.output.layout.scene,
      pin: again.output.layout.pin,
      track: [],
    });
    expect(resaved.json<DeskMemory>().illustration ?? null).toBeNull();
    expect(resaved.json<DeskMemory>().deskIllustration ?? null).toBeNull();
    expect(s.fetcher).not.toHaveBeenCalled();
    await s.app.close();
  });
});

describe('photo routes, live with a mocked Meta API', () => {
  const demo = JSON.parse(readFileSync('testdata/sam-mug.json', 'utf8')) as { wire: string };
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
  const inventory: PhotoInventory = {
    kind: 'desk',
    summary: 'A desk with a mug.',
    things: [
      {
        id: 'desk',
        label: 'desk',
        as: 'desk',
        role: 'surface',
        on: 'floor',
        box: { x1: 0, y1: 0, x2: 1000, y2: 1000 },
      },
      {
        id: 'mug',
        label: 'cream mug',
        as: 'mug',
        role: 'object',
        on: 'desk',
        box: { x1: 360, y1: 270, x2: 640, y2: 730 },
      },
    ],
  };
  // SAM's box-prompted answer outlines only the mug, under the id its box was sent with.
  const mugBody = demo.wire.replace(/^<0f>7/, '');

  async function setup(env: Record<string, string> = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-photo-live-'));
    dirs.push(dataDir);
    const asked: string[] = [];
    const fetcher = mock<Fetcher>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === 'sam-3.1') {
        const prompt = body.input[0].content[0].text as string;
        asked.push(`sam:${prompt}`);
        return samResponse(`<0f>2${mugBody}`);
      }
      const name = body.text.format.name as string;
      asked.push(`spark:${name}`);
      return sparkResponse(
        name === 'photo_inventory' ? inventory : { missing: [], extra: ['desk'], note: 'Close.' },
      );
    });
    const app = await buildApp(
      parseConfig({
        DATA_DIR: dataDir,
        MODEL_API_KEY: 'test-key',
        META_LIVE_ENABLED: 'true',
        ...env,
      }),
      { fetcher, serveWeb: false },
    );
    const photo = await sharp(readFileSync('apps/web/public/desk.svg')).png().toBuffer();
    const post = (body: object) =>
      app.inject({
        method: 'POST',
        url: '/api/scene/from-photo',
        payload: {
          mode: 'live',
          imageDataUrl: `data:image/png;base64,${photo.toString('base64')}`,
          ...body,
        },
      });
    return { app, post, asked, fetcher };
  }
  it('asks Spark once and SAM once with every box, and skips the check with no camera to draw from', async () => {
    const s = await setup();
    const res = await s.post({ check: true });
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json<EvidenceRun<PhotoDraft>>();
    expect(s.asked).toEqual([
      'spark:photo_inventory',
      'sam:<0f>1<|box;x1=0;y1=0;x2=959;y2=639;w=960;h=640|>,2<|box;x1=345;y1=172;x2=614;y2=467;w=960;h=640|>',
    ]);
    // SAM outlined only the mug; the desk is reported, not invented, so nothing is pinned.
    expect(run.output.layout.things.map((t) => [t.id, t.status])).toEqual([
      ['desk', 'not-found'],
      ['mug', 'object'],
    ]);
    expect(run.output.layout.pin).toBeNull();
    expect(run.output.check).toBeNull();
    expect(run.output.items.mug?.fit?.archetype).toBe('mug');
    expect(run.usage?.totalTokens).toBe(120);
    expect(run.assets.some((a) => a.endsWith('/source.png'))).toBe(true);
    await s.app.close();
  });
  it('sends Spark the photo and the drawing, and reads back what is missing', async () => {
    const s = await setup();
    const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-photo-meta-'));
    dirs.push(dataDir);
    const config = parseConfig({
      DATA_DIR: dataDir,
      MODEL_API_KEY: 'test-key',
      META_LIVE_ENABLED: 'true',
    });
    const meta = new MetaAdapter(config, new EvidenceStore(dataDir), s.fetcher);
    const result = await meta.photoCheck(
      'data:image/png;base64,AA==',
      'data:image/png;base64,AA==',
      'desk (desk, desk)',
    );
    expect(s.asked).toEqual(['spark:photo_check']);
    const body = JSON.parse(String(s.fetcher.mock.calls[0]![1]?.body));
    expect(body.input[0].content.map((c: { type: string }) => c.type)).toEqual([
      'input_text',
      'input_image',
      'input_image',
    ]);
    expect(result.output).toEqual({ missing: [], extra: ['desk'], note: 'Close.' });
    await s.app.close();
  });
  it('says exactly why Spark stopped, and keeps the failed run’s model and tokens', async () => {
    const s = await setup();
    s.fetcher.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp_spark',
            object: 'response',
            model: 'muse-spark-1.3',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [],
            usage: { input_tokens: 1500, output_tokens: 16384, total_tokens: 17884 },
          }),
          { headers: { 'content-type': 'application/json', 'x-request-id': 'req-cut' } },
        ),
    );
    const res = await s.post({});
    expect(res.statusCode).toBe(502);
    const { error } = res.json<{
      error: { code: string; message: string; runId: string; detail: Record<string, unknown> };
    }>();
    expect(error.message).toContain('16,384-token output limit');
    expect(error.message).toContain('photo inventory');
    expect(error.detail).toMatchObject({
      provider: 'Spark',
      step: 'photo inventory',
      reason: 'max_output_tokens',
      requestId: 'req-cut',
      maxOutputTokens: 16384,
      usage: { outputTokens: 16384 },
    });
    const runs = (await s.app.inject({ url: '/api/runs' })).json<EvidenceRun[]>();
    const failed = runs.find((r) => r.id === error.runId)!;
    expect(failed.status).toBe('failed');
    expect(failed.model).toBe('muse-spark-1.3');
    expect(failed.usage?.outputTokens).toBe(16384);
    await s.app.close();
  });
  it('names the fields when Spark answers outside the contract', async () => {
    const s = await setup();
    s.fetcher.mockImplementation(async () =>
      sparkResponse({ kind: 'garage', things: [], summary: '' }),
    );
    const res = await s.post({});
    const { error } = res.json<{ error: { code: string; message: string } }>();
    expect(error.code).toBe('invalid_response');
    expect(error.message).toMatch(/broke the expected shape: kind: /);
    await s.app.close();
  });
  it('refuses before calling anything when the spending limit cannot cover the draft', async () => {
    const s = await setup({ META_DAILY_SPEND_LIMIT_USD: '0.1' });
    const res = await s.post({ check: true });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('spend_limit');
    expect(s.fetcher).not.toHaveBeenCalled();
    await s.app.close();
  });
  it('draws a photographed room as a picture: one image call, one SAM call, its desk tied to the pin', async () => {
    const s = await setup();
    // At the frame size the recorded SAM answer was made for.
    const picture = await sharp(readFileSync('apps/server/assets/demo-illustration.webp'))
      .resize(960, 640)
      .png()
      .toBuffer();
    let edit: Record<string, unknown> | null = null;
    s.fetcher.mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/images/edits')) {
        edit = body;
        return new Response(
          JSON.stringify({
            created: 1,
            data: [{ b64_json: picture.toString('base64') }],
            output_format: 'png',
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (body.model === 'sam-3.1') return samResponse(demo.wire);
      throw new Error(`unexpected call ${String(url)}`);
    });
    // A room drafted offline, restored as the live desk with its pin.
    const offline = await buildApp(parseConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'll-')) }), {
      serveWeb: false,
    });
    const draft = (
      await offline.inject({
        method: 'POST',
        url: '/api/scene/from-photo',
        payload: { mode: 'demo' },
      })
    ).json<EvidenceRun<PhotoDraft>>().output.layout;
    await offline.close();
    const restored = await s.app.inject({
      method: 'POST',
      url: '/api/desk/restore',
      payload: {
        mode: 'live',
        memory: { mode: 'live', object: null, scene: draft.scene, surface: draft.pin },
      },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const photo = await sharp(readFileSync('apps/web/public/desk.svg')).png().toBuffer();
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/scene/illustrate',
      payload: { mode: 'live', imageDataUrl: `data:image/png;base64,${photo.toString('base64')}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json<{
      run: EvidenceRun;
      segment: EvidenceRun<Segmentation>;
      memory: DeskMemory;
    }>();
    // The edit asks Muse Image for a PNG, with its search and tools off.
    expect(edit!.model).toBe('muse-image-1.0');
    expect(edit!.output_format).toBe('png');
    expect(edit!.tool_enablement).toEqual({
      enable_image_search: false,
      enable_web_search: false,
      enable_shell: false,
    });
    expect((edit!.images as { image_url: string }[])[0]!.image_url).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(out.run.kind).toBe('illustration');
    expect(out.segment.kind).toBe('segment');
    expect(out.segment.output.concept).toBe('desk');
    const illustration = out.memory.illustration!;
    expect(illustration.surfaceId).toBe(draft.pin!.surfaceId);
    expect(illustration.frame).toEqual({ width: 960, height: 640 });
    expect(illustration.desk).not.toBeNull();
    // A cent for the picture and SAM's price for the outline, both counted against the limit.
    const status = (await s.app.inject('/api/status')).json<{ meta: { spentToday: number } }>();
    expect(status.meta.spentToday).toBeCloseTo(0.0125, 6);

    // The desk: a close frame and the room picture as style, shaped like the frame, and no SAM call.
    const calls = s.fetcher.mock.calls.length;
    const frame = await sharp({
      create: { width: 1280, height: 720, channels: 3, background: '#d8c9a8' },
    })
      .png()
      .toBuffer();
    const deskRes = await s.app.inject({
      method: 'POST',
      url: '/api/scene/illustrate',
      payload: {
        mode: 'live',
        view: 'desk',
        imageDataUrl: `data:image/png;base64,${frame.toString('base64')}`,
      },
    });
    expect(deskRes.statusCode, deskRes.body).toBe(200);
    expect(s.fetcher.mock.calls.length).toBe(calls + 1);
    expect(edit!.size).toBe('1280x720');
    const sent = edit!.images as { image_url: string }[];
    expect(sent).toHaveLength(2);
    expect(sent[1]!.image_url).toMatch(/^data:image\/jpeg;base64,/);
    expect(String(edit!.prompt)).toContain('art style of the second image');
    const desk = deskRes.json<{ memory: DeskMemory }>().memory.deskIllustration!;
    expect(desk.drawnFrom).toEqual({ width: 1280, height: 720 });
    // The room picture is kept beside it.
    expect(deskRes.json<{ memory: DeskMemory }>().memory.illustration?.asset).toBe(
      illustration.asset,
    );
    const after = (await s.app.inject('/api/status')).json<{ meta: { spentToday: number } }>();
    expect(after.meta.spentToday).toBeCloseTo(0.0225, 6);
    // A redraw with a note asks for that change too; the same frame alone draws the same.
    const redraw = await s.app.inject({
      method: 'POST',
      url: '/api/scene/illustrate',
      payload: {
        mode: 'live',
        view: 'desk',
        imageDataUrl: `data:image/png;base64,${frame.toString('base64')}`,
        note: '  leave out the cables ',
      },
    });
    expect(redraw.statusCode, redraw.body).toBe(200);
    expect(String(edit!.prompt)).toMatch(/This time, also: leave out the cables$/);
    const tooLong = await s.app.inject({
      method: 'POST',
      url: '/api/scene/illustrate',
      payload: { mode: 'live', view: 'desk', note: 'x'.repeat(201) },
    });
    expect(tooLong.statusCode).toBe(400);
    await s.app.close();
  });
});
