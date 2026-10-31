import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import {
  DEMO_POSITIONS,
  DEMO_SURFACE,
  demoFrame,
  detectionFromBits,
  roomMask,
  ISO_PRESETS,
  applyHomography,
  depthOrder,
  fromIso,
  guessedScene,
  homography,
  invertHomography,
  isoSurface,
  pinFits,
  projectBox,
  quadIsConvex,
  sceneGuessSchema,
  surfaceMap,
  surfacePinSchema,
  toIso,
  zoneFromSurface,
  type DeskMemory,
  type EvidenceRun,
  type IsoBox,
  type Quad,
  type SceneGuess,
  type Segmentation,
} from '@livinglayer/domain';

const box = (x: number, y: number, z: number, w = 1, d = 1, h = 1): IsoBox => ({
  at: { x, y, z },
  size: { w, d, h },
});
// A desk seen at an angle: the far edge is narrower than the near one.
const tilted: Quad = [
  { x: 300, y: 200 },
  { x: 700, y: 200 },
  { x: 900, y: 600 },
  { x: 100, y: 600 },
];
const frame = { width: 1000, height: 700 };

describe('isometric projection', () => {
  it('round-trips screen points at any height', () => {
    const p = { x: 2.5, y: 1.25, z: 2.4 };
    const back = fromIso(toIso(p), p.z);
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });
  it('draws boxes back to front', () => {
    const near = box(2, 2, 0);
    const far = box(0, 0, 0);
    const right = box(2, 0, 0);
    const onTop = box(0, 0, 1);
    const order = depthOrder([near, onTop, right, far]);
    const at = (b: IsoBox) => order.indexOf(b);
    expect(at(far)).toBeLessThan(at(onTop));
    expect(at(far)).toBeLessThan(at(near));
    // `onTop` is higher and further back than `near`: neither can cover the other.
    // `right` and `near` only touch on screen, so either order is fine.
    expect(order).toHaveLength(4);
  });
  it('orders a mug on a desk after the desk and before a prop in front of it', () => {
    const desk = box(1, 1, 2.2, 6, 4, 0.2);
    const mug = box(3, 2, 2.4, 0.5, 0.5, 0.6);
    const front = box(2.5, 3, 2.4, 1.5, 0.5, 1);
    const order = depthOrder([front, mug, desk]);
    expect(order.indexOf(desk)).toBeLessThan(order.indexOf(mug));
    expect(order.indexOf(mug)).toBeLessThan(order.indexOf(front));
  });
  it('gives every preset a drawable order and surfaces on real props', () => {
    for (const scene of Object.values(ISO_PRESETS)) {
      expect(depthOrder(scene.props)).toHaveLength(scene.props.length);
      for (const s of scene.surfaces) expect(scene.props.some((p) => p.id === s.propId)).toBe(true);
    }
  });
});

describe('surface homography', () => {
  it('maps the four corners onto the unit square and back', () => {
    const map = surfaceMap({ ...DEMO_SURFACE, corners: tilted, frame }, frame)!;
    const unit = tilted.map((c) => applyHomography(map.toSurface, c));
    expect(
      unit.map((p) => [Math.round(p.x * 1e6) / 1e6 + 0, Math.round(p.y * 1e6) / 1e6 + 0]),
    ).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    const back = applyHomography(map.toFrame, { x: 0.5, y: 0.5 });
    const again = applyHomography(map.toSurface, back);
    expect(again.x).toBeCloseTo(0.5);
    expect(again.y).toBeCloseTo(0.5);
  });
  it('keeps perspective: the photo centre lies past the middle of the surface', () => {
    const h = homography(tilted, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ])!;
    // Halfway up the photo is less than halfway back on a receding desk.
    expect(applyHomography(h, { x: 500, y: 400 }).y).toBeGreaterThan(0.5);
    expect(invertHomography(h)).not.toBeNull();
  });
  it('applies only to frames of the pinned size', () => {
    expect(surfaceMap(DEMO_SURFACE, { width: 960, height: 640 })).not.toBeNull();
    expect(surfaceMap(DEMO_SURFACE, { width: 1280, height: 720 })).toBeNull();
  });
  it('rejects folded, collinear and tiny corner sets', () => {
    expect(quadIsConvex(tilted)).toBe(true);
    expect(quadIsConvex([tilted[0], tilted[2], tilted[1], tilted[3]])).toBe(false);
    expect(
      quadIsConvex([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 1 },
      ]),
    ).toBe(false);
    const pin = { scene: 'desk', surfaceId: 'desk:top', frame };
    expect(surfacePinSchema.safeParse({ ...pin, corners: tilted }).success).toBe(true);
    expect(
      surfacePinSchema.safeParse({
        ...pin,
        corners: tilted.map((c) => ({ x: c.x / 20, y: c.y / 20 })),
      }).success,
    ).toBe(false);
    expect(
      surfacePinSchema.safeParse({
        ...pin,
        corners: [tilted[0], tilted[1], tilted[2], { x: 1200, y: 600 }],
      }).success,
    ).toBe(false);
  });
});

describe('placing the demo mug', () => {
  const surface = isoSurface('office', 'desk:top')!;
  const map = surfaceMap(DEMO_SURFACE, DEMO_SURFACE.frame)!;
  it('stands the mug where its box touches the desk', () => {
    for (const position of ['centre', 'right', 'front'] as const) {
      const mug = detectionFromBits('7', roomMask(demoFrame(position), 'mug'))!;
      const placed = projectBox(mug.box, surface, map.toSurface);
      expect(placed.onSurface).toBe(true);
      expect(placed.box.at.z).toBe(surface.z);
      // The box's bottom edge is the mug's front rim, so it lands a little in front of its centre.
      const at = DEMO_POSITIONS[position];
      expect(placed.box.at.x + placed.box.size.w / 2).toBeCloseTo(at.x, 0);
      expect(Math.abs(placed.box.at.y + placed.box.size.d / 2 - at.y)).toBeLessThan(0.4);
    }
  });
  it('flags a box whose foot falls off the surface', () => {
    const map2 = surfaceMap({ ...DEMO_SURFACE, corners: tilted, frame }, frame)!;
    expect(
      projectBox({ x: 10, y: 10, width: 40, height: 40 }, surface, map2.toSurface).onSurface,
    ).toBe(false);
  });
  it('turns a zone drawn on the surface into the frame rectangle around it', () => {
    const a = { x: 0.25, y: 0.25 };
    const b = { x: 0.75, y: 0.75 };
    const back = zoneFromSurface(a, b, DEMO_SURFACE.frame, map.toFrame)!;
    for (const p of [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]) {
      const q = applyHomography(map.toFrame, p);
      expect(q.x / DEMO_SURFACE.frame.width).toBeGreaterThanOrEqual(back.x - 1e-9);
      expect(q.x / DEMO_SURFACE.frame.width).toBeLessThanOrEqual(back.x + back.width + 1e-9);
      expect(q.y / DEMO_SURFACE.frame.height).toBeGreaterThanOrEqual(back.y - 1e-9);
      expect(q.y / DEMO_SURFACE.frame.height).toBeLessThanOrEqual(back.y + back.height + 1e-9);
    }
    expect(
      zoneFromSurface({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, DEMO_SURFACE.frame, map.toFrame),
    ).toBeNull();
  });
});

describe('the office desk', () => {
  it('is a close view of the office, and shares its desk pin with it', () => {
    expect(ISO_PRESETS.desk.label).toBe('Office desk');
    expect(pinFits(DEMO_SURFACE, 'desk')).toBe(true);
    expect(pinFits(DEMO_SURFACE, 'office')).toBe(true);
    expect(pinFits({ scene: 'office', surfaceId: 'shelf:top' }, 'desk')).toBe(false);
    expect(pinFits(DEMO_SURFACE, 'fridge')).toBe(false);
    expect(pinFits(DEMO_SURFACE, 'custom')).toBe(false);
    const office = ISO_PRESETS.office.props.map((p) => p.group);
    expect(office).toEqual(expect.arrayContaining(['book', 'bottle', 'lamp']));
  });
});

describe('scene guesses', () => {
  it('only accepts known presets and props, and hides the props Spark did not see', () => {
    expect(
      sceneGuessSchema.safeParse({ kind: 'garage', visibleProps: [], summary: '' }).success,
    ).toBe(false);
    expect(
      sceneGuessSchema.safeParse({ kind: 'desk', visibleProps: ['spaceship'], summary: '' })
        .success,
    ).toBe(false);
    const scene = guessedScene({ kind: 'office', visibleProps: ['monitor'] });
    const ids = scene.props.map((p) => p.id);
    expect(ids).toContain('monitor');
    expect(ids).toContain('desk');
    expect(ids).not.toContain('plant');
  });
});

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
async function app() {
  const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-iso-'));
  dirs.push(dataDir);
  const fetcher = mock<Fetcher>();
  const server = await buildApp(parseConfig({ DATA_DIR: dataDir }), { fetcher, serveWeb: false });
  const post = (path: string, body: object) =>
    server.inject({ method: 'POST', url: `/api/${path}`, payload: { mode: 'demo', ...body } });
  return { server, post, fetcher };
}

describe('iso routes', () => {
  it('classifies the demo as a desk without provider traffic', async () => {
    const s = await app();
    const run = (await s.post('scene/classify', {})).json<EvidenceRun<SceneGuess>>();
    expect(run.kind).toBe('scene');
    expect(run.status).toBe('completed');
    expect(run.output.kind).toBe('desk');
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('pins a surface, keeps it across reset, and refuses unknown surfaces', async () => {
    const s = await app();
    const pin = { scene: 'fridge', surfaceId: 'fridge:shelf-2', corners: tilted, frame };
    const saved = (await s.post('desk/surface', { pin })).json<DeskMemory>();
    expect(saved.surface?.surfaceId).toBe('fridge:shelf-2');
    const reset = (await s.post('desk/reset', {})).json<DeskMemory>();
    expect(reset.surface?.scene).toBe('fridge');
    const bad = await s.post('desk/surface', { pin: { ...pin, surfaceId: 'desk:top' } });
    expect(bad.statusCode).toBe(400);
    const cleared = (await s.post('desk/surface', { pin: null })).json<DeskMemory>();
    expect(cleared.surface).toBeNull();
  });
  it('keeps the demo mug segmentation on the desk preset', async () => {
    const s = await app();
    const run = (await s.post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
    const mug = run.output.detections[0]!;
    const map = surfaceMap(DEMO_SURFACE, run.output.frame)!;
    expect(projectBox(mug.box, isoSurface('desk', 'desk:top')!, map.toSurface).onSurface).toBe(
      true,
    );
  });
});
