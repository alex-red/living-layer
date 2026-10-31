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
  DEMO_CAMERA,
  DEMO_SURFACE,
  marksOf,
  cameraFromPin,
  cleanInventory,
  framePointInPicture,
  isoSceneSchema,
  placeTemplate,
  maskBits,
  pathRings,
  projectPoint,
  promptBox,
  sceneForSave,
  unprojectPoint,
  type DeskMemory,
  type EvidenceRun,
  type Job,
  type PhotoInventory,
  type PhotoLayout,
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

describe('the camera behind a pin', () => {
  it('recovers the camera exactly when the perspective shows the focal length', () => {
    const cam = camera(35, 0.45, 900);
    const corners: Quad = [cam(0, 0, 0), cam(4, 0, 0), cam(4, 2.5, 0), cam(0, 2.5, 0)];
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
    const corners: Quad = [cam(0, 0, 0), cam(4, 0, 0), cam(4, 2.5, 0), cam(0, 2.5, 0)];
    const c = cameraFromPin(corners, { width: 1280, height: 720 }, 4)!;
    expect(c.focalGuessed).toBe(true);
    expect(Math.abs(c.surface.d - 2.5) / 2.5).toBeLessThan(0.15);
    expect(Math.abs(c.elevation - cam.elevation)).toBeLessThan(4);
  });
});

describe('the saved scene', () => {
  it('stands untracked objects with a template in the saved scene, and leaves tracked ones out', () => {
    const desk = placeTemplate('desk', 'desk', 1, 1, 0);
    const top = desk.surfaces[0]!.z;
    const object = (id: 'mug' | 'bottle', x: number) => ({
      id,
      label: id,
      as: id,
      role: 'object' as const,
      on: 'desk',
      box: { x1: 0, y1: 0, x2: 10, y2: 10 },
      detectionId: id,
      status: 'object' as const,
      foot: { at: { x, y: 1.6, z: top }, size: { w: 0.3, d: 0.3, h: 0.4 } },
    });
    const layout: PhotoLayout = {
      scene: { kind: 'custom', label: 'Room', grid: { w: 8, d: 8 }, ...desk },
      pin: null,
      surfaceThing: null,
      things: [object('mug', 1.5), object('bottle', 3)],
      score: null,
    };
    const scene = sceneForSave(layout, ['mug']);
    expect(scene.props.filter((p) => p.template === 'bottle')).toHaveLength(1);
    expect(scene.props.find((p) => p.template === 'bottle')!.at.z).toBeCloseTo(top, 3);
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
  it('auto-pins the demo room’s desk through its calibrated camera, with no call', async () => {
    const s = await setup();
    const res = await s.post('desk/auto-pin');
    expect(res.statusCode, res.body).toBe(200);
    const { run, pin } = res.json<AutoPin>();
    expect(run).toBeNull();
    // The desk's top as the demo camera sees it.
    expect(pin!.frame).toEqual({ width: 960, height: 640 });
    pin!.corners.forEach((c, i) =>
      expect(
        Math.hypot(c.x - DEMO_SURFACE.corners[i]!.x, c.y - DEMO_SURFACE.corners[i]!.y),
      ).toBeLessThan(25),
    );
    // Nothing is pinned until the person saves the corners.
    expect((await s.app.inject('/api/desk/demo')).json<DeskMemory>().surface ?? null).toBeNull();
    expect(
      (await s.post('desk/auto-pin', { imageDataUrl: 'data:image/png;base64,AA' })).statusCode,
    ).toBe(400);
  });
  it('drafts the demo room, then saves the scene, the pin and the ticked objects with their models', async () => {
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
    // Laid out through the calibrated demo camera: the desk's top is where that camera sees it.
    expect(run.output.calibration).toBeTruthy();
    layout.pin!.corners.forEach((c, i) =>
      expect(
        Math.hypot(c.x - DEMO_SURFACE.corners[i]!.x, c.y - DEMO_SURFACE.corners[i]!.y),
      ).toBeLessThan(10),
    );
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
    expect(memory.scene?.label).toBe('From the room camera');
    expect(memory.surface?.scene).toBe('custom');
    expect(memory.object?.label).toBe('Cream mug');
    expect(memory.observation?.detectionId).toBe('2');
    expect(memory.item?.fit?.archetype).toBe('mug');
    expect(memory.others?.map((o) => [o.label, o.concept, Boolean(o.item)])).toEqual([
      ['Sage bottle', 'sage bottle', true],
    ]);
    // The room is drawn from its templates: nothing from the photo is pasted on.
    expect(isoSceneSchema.safeParse(memory.scene).success).toBe(true);
    expect(memory.scene!.props.some((p) => p.texture)).toBe(false);
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
  it('sets the demo room up from its camera: sizes it, calibrates it, then drafts through it', async () => {
    const s = await setup();
    const jobId = crypto.randomUUID();
    const res = await s.post('scene/setup', { scene: 'office', jobId });
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json<EvidenceRun<PhotoDraft>>();
    const job = (await s.app.inject(`/api/jobs/${jobId}`)).json<Job>();
    expect(job).toMatchObject({ title: 'Setting up the room', outcome: 'done' });
    expect(job.steps.map((x) => [x.id, x.state])).toEqual([
      ['photo', 'done'],
      ['list', 'done'],
      ['walls', 'done'],
      ['calibrate', 'done'],
      ['outline', 'done'],
      ['layout', 'done'],
      ['models', 'done'],
    ]);
    // The office's own size, the right way round: its back wall is the longer one.
    const { setup: done } = run.output;
    expect(done!.floorCm.w).toBe(done!.room.rightWallCm);
    expect(done!.fit.error).toBeLessThan(2);
    // The camera is saved, and sees the desk where the demo camera does.
    const memory = (await s.app.inject('/api/desk/demo')).json<DeskMemory>();
    expect(memory.camera?.scene).toBe('office');
    run.output.layout.pin!.corners.forEach((c, i) =>
      expect(
        Math.hypot(c.x - DEMO_SURFACE.corners[i]!.x, c.y - DEMO_SURFACE.corners[i]!.y),
      ).toBeLessThan(10),
    );
    expect(run.output.layout.things.find((t) => t.id === 'desk')?.status).toBe('placed');
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
  it('draws the demo room through its camera as its picture, and only once its desk is pinned', async () => {
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
    // It redraws the camera's frame, so a frame point maps by scale and the desk sits where the pin is.
    expect(picture.drawnFrom).toEqual({ width: 960, height: 640 });
    expect(picture.desk).toBeNull();
    const pin = layout.pin!;
    expect(framePointInPicture(pin, picture, pin.frame, pin.corners[0])).toEqual(pin.corners[0]);
    expect(
      framePointInPicture(pin, picture, { width: 1280, height: 720 }, { x: 480, y: 320 }),
    ).toBeNull();
    const served = await s.app.inject(
      `/api/scene/illustration?asset=${encodeURIComponent(picture.asset)}`,
    );
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    // The demo has only its corner camera, so there is no close frame of the desk to draw.
    expect((await s.post('scene/illustrate', { view: 'desk' })).statusCode).toBe(400);
    // Starting over forgets the mug, not the room: the picture stays.
    const reset = (await s.post('desk/reset')).json<DeskMemory>();
    expect(reset.illustration?.asset).toBe(picture.asset);
    // A new scan makes a new room, so its old picture goes.
    const again = (await s.post('scene/from-photo')).json<EvidenceRun<PhotoDraft>>();
    const resaved = await s.post('scene/from-photo/save', {
      runId: again.id,
      scene: again.output.layout.scene,
      pin: again.output.layout.pin,
      track: [],
    });
    expect(resaved.json<DeskMemory>().illustration ?? null).toBeNull();
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

  async function setup(env: Record<string, string> = {}, { calibrated = true } = {}) {
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
    const photo = await sharp(readFileSync('testdata/desk.svg')).png().toBuffer();
    // The room's corner camera, calibrated on a frame of the photo's size from the demo camera's marks.
    if (calibrated) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/room/calibrate',
        payload: {
          mode: 'live',
          imageDataUrl: `data:image/png;base64,${photo.toString('base64')}`,
          marks: marksOf(DEMO_CAMERA),
          room: { w: 294, d: 234 },
          scene: 'office',
        },
      });
      if (res.statusCode !== 200) throw new Error(res.body);
    }
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
  it('refuses before any call until the room’s camera is calibrated', async () => {
    const s = await setup({}, { calibrated: false });
    const res = await s.post({ check: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_calibrated');
    expect(s.fetcher).not.toHaveBeenCalled();
    await s.app.close();
  });
  it('asks Spark once and SAM once with every box, then Spark checks the room drawn through the camera', async () => {
    const s = await setup();
    const res = await s.post({ check: true });
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json<EvidenceRun<PhotoDraft>>();
    expect(s.asked).toEqual([
      'spark:photo_inventory',
      'sam:<0f>1<|box;x1=0;y1=0;x2=959;y2=639;w=960;h=640|>,2<|box;x1=345;y1=172;x2=614;y2=467;w=960;h=640|>',
      'spark:photo_check',
    ]);
    // SAM outlined only the mug; the desk is reported, not invented, so nothing is pinned.
    expect(run.output.layout.things.map((t) => [t.id, t.status])).toEqual([
      ['desk', 'not-found'],
      ['mug', 'object'],
    ]);
    expect(run.output.layout.pin).toBeNull();
    expect(run.output.check?.note).toBe('Close.');
    expect(run.assets.some((a) => a.endsWith('/scene-render.png'))).toBe(true);
    expect(run.output.items.mug?.fit?.archetype).toBe('mug');
    expect(run.usage?.totalTokens).toBe(240);
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
  it('draws the room as a picture from its camera’s frame: one image call, tied to the camera', async () => {
    const s = await setup();
    // Muse Image may answer at another size; the picture is kept at the frame's.
    const picture = await sharp({
      create: { width: 1024, height: 683, channels: 3, background: '#e8e0d0' },
    })
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
      throw new Error(`unexpected call ${String(url)}: ${body.model}`);
    });
    // A room drafted offline, restored as the live desk with its pin and the calibrated camera.
    const { camera } = (await s.app.inject('/api/desk/live')).json<DeskMemory>();
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
        memory: { mode: 'live', object: null, scene: draft.scene, surface: draft.pin, camera },
      },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const photo = await sharp(readFileSync('testdata/desk.svg')).png().toBuffer();
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/scene/illustrate',
      payload: { mode: 'live', imageDataUrl: `data:image/png;base64,${photo.toString('base64')}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json<{
      run: EvidenceRun;
      segment: EvidenceRun<Segmentation> | null;
      memory: DeskMemory;
    }>();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(edit!.size).toBe('960x640');
    expect(String(edit!.prompt)).toContain('framing exactly');
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
    expect(out.segment).toBeNull();
    const illustration = out.memory.illustration!;
    expect(illustration.surfaceId).toBe(draft.pin!.surfaceId);
    expect(illustration.frame).toEqual({ width: 960, height: 640 });
    expect(illustration.drawnFrom).toEqual({ width: 960, height: 640 });
    expect(illustration.desk).toBeNull();
    // A cent for the picture, counted against the limit.
    const status = (await s.app.inject('/api/status')).json<{ meta: { spentToday: number } }>();
    expect(status.meta.spentToday).toBeCloseTo(0.01, 6);

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
    expect(after.meta.spentToday).toBeCloseTo(0.02, 6);
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
