import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig } from '../apps/server/src/config.js';
import { demoSegmentation } from '../apps/server/src/demo.js';
import {
  clipMask,
  DEMO_CAMERA,
  DEMO_FRAME,
  DEMO_ROOM,
  groupLabels,
  maskBits,
  resolveSelection,
  roomLabels,
  selectionBox,
  selectionMask,
  selectionShapeSchema,
  surfaceUnder,
  cm,
  type Detection,
  type SelectionShape,
  type SelectResolve,
} from '@livinglayer/domain';

/**
 * Selections drawn around what the demo camera shows: every box comes from
 * the demo's own SAM masks (`demoSegmentation`), never from hand-picked
 * pixels, so they hold when the room or its camera changes.
 */
const frame = { ...DEMO_FRAME };
const picture = roomLabels(DEMO_CAMERA, DEMO_ROOM);
const labels = groupLabels(DEMO_ROOM);
const seen = async (concept: string) => (await demoSegmentation(concept)).output.detections[0]!;
/** A rectangle around a detection's box, grown by `grow` of its size on each side. */
function around(d: Detection, grow = 0.1): SelectionShape {
  const t = (v: number, of: number) => Math.round(Math.min(1000, Math.max(0, (v / of) * 1000)));
  const gx = d.box.width * grow;
  const gy = d.box.height * grow;
  return {
    kind: 'rect',
    box: {
      x1: t(d.box.x - gx, frame.width),
      y1: t(d.box.y - gy, frame.height),
      x2: t(d.box.x + d.box.width + gx, frame.width),
      y2: t(d.box.y + d.box.height + gy, frame.height),
    },
  };
}
const resolve = (shape: SelectionShape, objects: Parameters<typeof resolveSelection>[3] = []) =>
  resolveSelection(selectionMask(shape, frame), picture, labels, objects);

describe('selection shapes', () => {
  it('checks shapes and masks a rectangle and a polygon by their area', () => {
    expect(
      selectionShapeSchema.safeParse({ kind: 'polygon', points: [{ x: 1, y: 1 }] }).success,
    ).toBe(false);
    const rect: SelectionShape = { kind: 'rect', box: { x1: 0, y1: 0, x2: 500, y2: 500 } };
    const count = (shape: SelectionShape) =>
      selectionMask(shape, frame).data.reduce((a, b) => a + b, 0);
    expect(count(rect)).toBe(480 * 320);
    // The triangle that is half of it.
    const half: SelectionShape = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 500, y: 0 },
        { x: 0, y: 500 },
      ],
    };
    expect(count(half) / count(rect)).toBeCloseTo(0.5, 2);
    expect(selectionBox(half, frame)).toEqual({ left: 0, top: 0, right: 480, bottom: 320 });
  });

  it("cuts SAM's outline to a polygon that leaves part of the box out", async () => {
    const desk = await seen('desk');
    const whole = maskBits(desk, frame, 1).data.reduce((a, b) => a + b, 0);
    const { x, width } = desk.box;
    const mid = ((x + width / 2) / frame.width) * 1000;
    // The desk's left half, as a polygon.
    const left: SelectionShape = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: mid, y: 0 },
        { x: mid, y: 1000 },
        { x: 0, y: 1000 },
      ],
    };
    const cut = clipMask(desk, left, frame)!;
    const kept = cut.data.reduce((a, b) => a + b, 0);
    expect(kept).toBeGreaterThan(whole * 0.2);
    expect(kept).toBeLessThan(whole * 0.8);
    const right: SelectionShape = { kind: 'rect', box: { x1: 990, y1: 990, x2: 1000, y2: 1000 } };
    expect(clipMask(desk, right, frame)).toBeNull();
  });
});

describe('what a selection points at', () => {
  it('picks the desk from a box around it, though its monitor and lamp are inside too', async () => {
    const r = resolve(around(await seen('desk')));
    expect(r.target).toEqual({ kind: 'prop', id: 'desk', label: 'Desk' });
    expect(r.ambiguous).toBe(false);
    const ids = r.candidates.map((c) => c.target.id);
    expect(ids).toContain('monitor');
    expect(ids.indexOf('desk')).toBe(0);
  });

  it('picks the thing on the desk when only it is boxed', async () => {
    for (const concept of ['monitor', 'chair', 'bookshelf', 'lamp']) {
      const d = await seen(concept);
      const target = resolve(around(d)).target;
      expect(target?.id).toBe(concept === 'bookshelf' ? 'shelf' : concept);
    }
  });

  it('picks a tracked object by its box, over the desk it stands on', async () => {
    const mug = await seen('mug');
    const r = resolve(around(mug, 0.3), [{ id: 'mug', label: 'My mug', box: mug.box }]);
    expect(r.target).toEqual({ kind: 'object', id: 'mug', label: 'My mug' });
  });

  it("says nothing is selected when the box is of something the room doesn't have", async () => {
    // A small box on the desktop, where a thing the room hasn't modelled would stand.
    const desk = await seen('desk');
    const t = (v: number, of: number) => Math.round((v / of) * 1000);
    const cx = desk.box.x + desk.box.width * 0.35;
    const cy = desk.box.y + desk.box.height * 0.45;
    const r = resolve({
      kind: 'rect',
      box: {
        x1: t(cx - 12, frame.width),
        y1: t(cy - 12, frame.height),
        x2: t(cx + 12, frame.width),
        y2: t(cy + 12, frame.height),
      },
    });
    expect(r.target).toBeNull();
    // The desk is touched, only not selected.
    expect(r.candidates[0]?.target.id).toBe('desk');
    expect(r.candidates[0]!.covered).toBeLessThan(0.1);
  });

  it('finds a fixture by its box in the room', () => {
    const desk = DEMO_ROOM.surfaces.find((s) => s.propId === 'desk')!;
    const box = {
      at: { x: desk.rect.x + desk.rect.w - cm(30), y: desk.rect.y + cm(5), z: desk.z },
      size: { w: cm(20), d: cm(20), h: cm(40) },
    };
    expect(surfaceUnder(DEMO_ROOM, box)).toBeCloseTo(desk.z);
    const withFixture = roomLabels(DEMO_CAMERA, DEMO_ROOM, [{ id: 'f1', box }]);
    const k = withFixture.names.indexOf('fixture:f1');
    // Draw the selection around the fixture's own pixels.
    let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
    for (let i = 0; i < withFixture.ids.length; i++)
      if (withFixture.ids[i] === k) {
        const x = i % frame.width;
        const y = Math.floor(i / frame.width);
        [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      }
    const shape = around({
      box: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 },
    } as Detection);
    const r = resolveSelection(
      selectionMask(shape, frame),
      withFixture,
      new Map([...labels, ['fixture:f1', 'Desk fan']]),
    );
    expect(r.target).toEqual({ kind: 'fixture', id: 'f1', label: 'Desk fan' });
  });
});

describe('POST /api/select/resolve', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  async function app() {
    const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-select-'));
    dirs.push(dataDir);
    return buildApp(parseConfig({ DATA_DIR: dataDir }), { serveWeb: false });
  }

  it('reads a selection through the demo camera, with no model call', async () => {
    const a = await app();
    const shape = around(await seen('desk'));
    const res = await a.inject({
      method: 'POST',
      url: '/api/select/resolve',
      payload: { mode: 'demo', shape },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SelectResolve>();
    expect(body.target).toEqual({ kind: 'prop', id: 'desk', label: 'Desk' });
    expect(body.frame).toEqual(frame);
    expect(body.candidates.length).toBeLessThanOrEqual(5);
  });

  it('refuses a live selection until the room is calibrated', async () => {
    const a = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/api/select/resolve',
      payload: { mode: 'live', shape: { kind: 'rect', box: { x1: 0, y1: 0, x2: 10, y2: 10 } } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_calibrated');
  });
});
