import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import type { FloorMarks } from '../apps/server/src/room.js';
import {
  DEMO_CALIBRATION,
  DEMO_POSITIONS,
  ROOM_CASES,
  ROOM_TARGETS,
  DEMO_CAMERA,
  cameraFromMarks,
  projectRoom,
  upgradeMemory,
  type DeskMemory,
  judgeRoom,
  layoutRoom,
  marksOf,
  roomCase,
  type RoomCalibration,
} from '@livinglayer/domain';
import { demoPhotoInventory, demoPhotoSegmentation } from '../apps/server/src/demo.js';

describe('laying out a room from its calibrated camera', () => {
  for (const c of ROOM_CASES)
    it(`places everything in ${c.name} where it stands`, () => {
      const scene = c.scene();
      const truth = c.camera(scene);
      const s = roomCase(scene, truth);
      const marks = marksOf(truth);
      const fit = cameraFromMarks(marks, truth.frame, truth.room);
      const calibration: RoomCalibration = {
        camera: fit.camera,
        marks,
        scene: 'custom',
        error: fit.error,
        calibratedAt: new Date(0).toISOString(),
      };
      const j = judgeRoom(layoutRoom({ ...s, calibration }), s.truth);
      expect(j.worst).toBeLessThanOrEqual(ROOM_TARGETS.position);
      expect(j.size).toBeLessThanOrEqual(ROOM_TARGETS.size);
      expect(j.wrongTurns).toBe(0);
      expect(j.iou).toBeGreaterThanOrEqual(ROOM_TARGETS.iou);
    });

  it('lays out the demo room, the mug where it stands on the desk', async () => {
    const segmentation = await demoPhotoSegmentation();
    const detections = Object.fromEntries(
      demoPhotoInventory.things.map((t, i) => [t.id, String(i + 1)]),
    );
    const layout = layoutRoom({
      inventory: demoPhotoInventory,
      segmentation,
      detections,
      calibration: DEMO_CALIBRATION,
    });
    const desk = layout.things.find((t) => t.id === 'desk')!;
    expect(desk.status).toBe('placed');
    expect(desk.iou!).toBeGreaterThan(0.8);
    const mug = layout.things.find((t) => t.id === 'mug')!;
    expect(mug.status).toBe('object');
    const at = DEMO_POSITIONS.centre;
    expect(
      Math.hypot(
        mug.foot!.at.x + mug.foot!.size.w / 2 - at.x,
        mug.foot!.at.y + mug.foot!.size.d / 2 - at.y,
      ),
    ).toBeLessThan(0.15);
    expect(mug.foot!.at.z).toBeCloseTo(2.4, 1);
    // The desk's top as the camera sees it is the pin.
    expect(layout.pin?.surfaceId).toBe(
      layout.scene.surfaces.find((x) => x.propId === desk.group)?.id,
    );
    // A thing a person removed stays out.
    const edited = layoutRoom({
      inventory: demoPhotoInventory,
      segmentation,
      detections,
      calibration: DEMO_CALIBRATION,
      edits: { book: { removed: true } },
    });
    expect(edited.things.find((t) => t.id === 'book')!.status).toBe('removed');
  });
});

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-room-'));
  dirs.push(dataDir);
  const fetcher = mock<Fetcher>();
  const app = await buildApp(parseConfig({ DATA_DIR: dataDir }), { fetcher, serveWeb: false });
  const post = async (path: string, body: object = {}) =>
    app.inject({ method: 'POST', url: `/api/${path}`, payload: { mode: 'demo', ...body } });
  return { app, post, fetcher };
}

describe('calibrating the room camera', () => {
  it('reads marks off the floor, fits the camera to them and pins the desk through it', async () => {
    const s = await setup();
    const floor = await s.post('room/floor');
    expect(floor.statusCode, floor.body).toBe(200);
    const { marks, run } = floor.json<FloorMarks>();
    expect(run.kind).toBe('segment');
    // The floor's corner is inside the walls, which are 6 cm thick.
    const corner = projectRoom(DEMO_CAMERA, { x: 0.2, y: 0.2, z: 0 })!;
    expect(Math.hypot(marks!.corner.x - corner.x, marks!.corner.y - corner.y)).toBeLessThan(2);
    const saved = await s.post('room/calibrate', {
      marks,
      room: { w: 294, d: 234 },
      scene: 'office',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const { memory, fit } = saved.json<{ memory: DeskMemory; fit: { error: number } }>();
    expect(fit.error).toBeLessThan(3);
    expect(memory.camera?.reference).toBeTruthy();
    expect(memory.fixedCamera).toBe(true);
    expect(memory.surface).toMatchObject({ scene: 'office', surfaceId: 'desk:top' });
    // The fitted camera draws the room where the demo camera does.
    for (const p of [
      { x: 3, y: 2, z: 2.4 },
      { x: 8, y: 1, z: 0 },
    ]) {
      const a = projectRoom(memory.camera!.camera, p)!;
      const b = projectRoom(DEMO_CAMERA, p)!;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(8);
    }
    // Marks that fit no corner camera are refused.
    const wrong = await s.post('room/calibrate', {
      marks: { ...marks!, corner: { x: 40, y: 600 } },
      room: { w: 294, d: 234 },
      scene: 'office',
    });
    expect(wrong.statusCode).toBe(422);
    const forgotten = (await s.post('room/forget')).json<DeskMemory>();
    expect(forgotten.camera).toBeNull();
    expect(s.fetcher).not.toHaveBeenCalled();
    await s.app.close();
  });
});

describe('demo memory from the illustrated desk', () => {
  it('drops what was drawn on the old picture, and keeps the rest', () => {
    const memory = {
      mode: 'demo',
      object: { id: 'o', label: 'Mug', createdAt: '2026-10-01T00:00:00.000Z' },
      observation: { sourceKey: 'illustrated-desk-v1@right' },
      zone: {
        id: 'z',
        sourceKey: 'illustrated-desk-v1',
        rect: { x: 0, y: 0, width: 1, height: 1 },
      },
      lastDecision: null,
      fixtures: [
        { id: 'a', scene: 'office' },
        { id: 'b', scene: 'custom' },
      ],
      exposed: [{ id: 'e' }],
    } as unknown as DeskMemory;
    const next = upgradeMemory(memory);
    expect(next.observation).toBeNull();
    expect(next.zone).toBeNull();
    expect(next.object).toBeNull();
    expect(next.fixtures!.map((f) => f.id)).toEqual(['a']);
    expect(next.exposed).toHaveLength(1);
    // Live memory and new demo memory are left alone.
    expect(upgradeMemory({ ...memory, mode: 'live' }).zone).not.toBeNull();
    const fresh = {
      ...memory,
      observation: null,
      zone: { ...memory.zone!, sourceKey: 'corner-office-v1' },
    };
    expect(upgradeMemory(fresh).zone).not.toBeNull();
  });
});
