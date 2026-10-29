import { afterEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { syntheticStream } from '../apps/server/src/sam.js';
import type { PhotoDraft } from '../apps/server/src/photo.js';
import { MetaAdapter } from '../apps/server/src/meta.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import {
  cameraFromPin,
  cleanInventory,
  fillRings,
  fitSurfaceQuad,
  groupBounds,
  isoSceneSchema,
  layoutPhoto,
  maskBits,
  newBits,
  orderCorners,
  pathRings,
  projectPoint,
  promptBox,
  sceneForSave,
  syntheticPhoto,
  unprojectPoint,
  type DeskMemory,
  type EvidenceRun,
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
  it('drafts the illustrated desk, then saves the scene, the pin and the ticked objects with their models', async () => {
    const s = await setup();
    const drafted = await s.post('scene/from-photo', { check: true });
    expect(drafted.statusCode, drafted.body).toBe(200);
    const run = drafted.json<EvidenceRun<PhotoDraft>>();
    expect(run.kind).toBe('photo');
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
});
