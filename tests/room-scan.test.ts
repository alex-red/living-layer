import { describe, expect, it } from 'bun:test';
import { testApp } from './lib/app.js';
import type { FloorMarks } from '../apps/server/src/room.js';
import {
  DEMO_CALIBRATION,
  cameraEdges,
  cameraMoved,
  DEMO_POSITIONS,
  ROOM_CASES,
  ROOM_TARGETS,
  ISO_PRESETS,
  groupBounds,
  DEMO_CAMERA,
  cameraFromMarks,
  projectRoom,
  upgradeMemory,
  type DeskMemory,
  layoutRoom,
  layoutTrace,
  layoutTuning,
  LAYOUT_TUNING,
  withLayout,
  marksOf,
  roomCase,
  placeTemplate,
  cornerCamera,
  renderRoom,
  sceneSolids,
  thingSolids,
  refineWalls,
  turnWall,
  resizeRoom,
  type RoomCalibration,
  sceneOf,
  type IsoScene,
  scanCase,
} from '@livinglayer/domain';
import { demoPhotoInventory, demoPhotoSegmentation, demoPng } from '../apps/server/src/demo.js';
import { lumaHeight, lumaOf } from '../apps/server/src/frames.js';

describe('laying out a room from its calibrated camera', () => {
  for (const c of ROOM_CASES)
    it(`places everything in ${c.name} where it stands`, () => {
      const scene = c.scene();
      const j = scanCase(scene, c.camera(scene), c).judged;
      expect(j.worst).toBeLessThanOrEqual(ROOM_TARGETS.position);
      expect(j.size).toBeLessThanOrEqual(ROOM_TARGETS.size);
      expect(j.wrongTurns).toBe(0);
    });

  it('stops a desk Spark guessed long at the bookcase beside it, and leaves the bookcase', () => {
    // A bookcase in the back corner, a 120 cm desk to its right along the back wall.
    const scene = sceneOf(
      [
        { template: 'wall', id: 'wall-back', x: 0, y: 0 },
        { template: 'shelf', x: 0.4, y: 0.2 },
        { template: 'desk', x: 3.6, y: 0.2 },
      ],
      { grid: { w: 12, d: 9 } },
    );
    // Guessed at 230 cm, it would reach back into the bookcase.
    const { boxes } = scanCase(scene, cornerCamera(scene.grid), { guess: { desk: { w: 230 } } });
    const [desk, shelf] = [boxes.desk!, boxes.shelf!];
    expect(desk.at.x).toBeGreaterThanOrEqual(shelf.at.x + shelf.size.w - 0.02);
    expect(Math.abs(shelf.at.x - 0.4)).toBeLessThan(0.15);
    // Its near end, which the camera sees, stays where it is.
    expect(Math.abs(desk.at.x + desk.size.w - (3.6 + 4))).toBeLessThan(0.15);
  });
  // The near end the camera doesn't see isn't where it is cut: 140 cm, to a couple of centimetres.
  for (const [name, why] of [
    ['desk cut off by the frame', 'the frame cuts off'],
    ["desk's near end hidden", 'a cabinet hides'],
  ])
    it(`keeps the length of a desk whose near end ${why}, clear of the bookcase`, () => {
      const c = ROOM_CASES.find((c) => c.name === name)!;
      const scene = c.scene();
      const { boxes } = scanCase(scene, c.camera(scene), c);
      const [desk, shelf] = [boxes.desk!, boxes.shelf!];
      expect(Math.abs(desk.size.d * 30 - 140)).toBeLessThan(2);
      expect(desk.at.y).toBeGreaterThanOrEqual(shelf.at.y + shelf.size.d - 0.02);
    });
  it('turns a wall marked askew back to the things standing against it', () => {
    // A desk along the back wall, four things on it against that wall.
    const scene = sceneOf([
      { template: 'wall', id: 'wall-back', x: 0, y: 0 },
      { template: 'wall', id: 'wall-left', x: 0, y: 0.2 },
      { template: 'desk', x: 2, y: 0.2 },
      ...(['bottle', 'jar', 'carton', 'book'] as const).map((template, i) => ({
        template,
        x: 2.4 + i,
        y: 0.2,
        on: 'desk',
      })),
    ]);
    const truth = cornerCamera(scene.grid);
    const s = roomCase(scene, truth);
    // Marked where the floor meets the walls' inner faces, as a person would.
    const along = (to: (t: number) => { x: number; y: number }) =>
      [1, 2, 3, 4, 5, 6].map((i) => projectRoom(truth, { ...to(i / 6), z: 0 })!);
    const marks = {
      corner: projectRoom(truth, { x: 0.2, y: 0.2, z: 0 })!,
      back: along((t) => ({ x: 0.2 + t * 11.8, y: 0.2 })),
      left: along((t) => ({ x: 0.2, y: 0.2 + t * 9.8 })),
    };
    const fit = cameraFromMarks(
      marks,
      truth.frame,
      { w: 11.8, d: 9.8 },
      { origin: { x: 0.2, y: 0.2 } },
    );
    const calibration: RoomCalibration = {
      camera: fit.camera,
      marks,
      scene: 'custom',
      error: fit.error,
      calibratedAt: '',
    };
    // Marked true, nothing to turn.
    expect(refineWalls({ ...s, calibration })).toBeNull();
    // Marked 6° off, so the things seem to stand behind the wall: turned back, the room's width found again.
    const askew = turnWall(calibration, 'back', 6)!;
    expect(askew.camera.room.w).toBeGreaterThan(12.5);
    const refined = refineWalls({ ...s, calibration: askew })!;
    expect(refined).toMatchObject({ wall: 'back', degrees: -6 });
    expect(refined.witnesses.sort()).toEqual(['book', 'bottle', 'carton', 'jar']);
    // To the third of a tile `roomSizeFor` finds a wall's length to.
    expect(Math.abs(refined.calibration.camera.room.w - 12)).toBeLessThan(0.2);
    // Off the other way they only seem to stand out from it, which nothing says is wrong.
    expect(refineWalls({ ...s, calibration: turnWall(calibration, 'back', -6)! })).toBeNull();
  });
  it('builds a bookcase as tall as Spark says, with its top up there', () => {
    const c = ROOM_CASES[0]!;
    const scene = c.scene();
    const { layout } = scanCase(scene, c.camera(scene), { guess: { shelf: { h: 180 } } });
    const shelf = layout.things.find((t) => t.id === 'shelf')!;
    const box = groupBounds(layout.scene, shelf.group!)!;
    expect(box.size.h * 30).toBeCloseTo(180, 0);
    const top = layout.scene.surfaces.find((x) => x.propId === shelf.group)!;
    expect(top.z * 30).toBeCloseTo(180, 0);
  });
  it('traces why each thing went where it did, without changing where', () => {
    // The study above: a desk Spark guessed at 230 cm runs into the bookcase beside it.
    let scene: IsoScene = {
      kind: 'custom',
      label: 'Study',
      grid: { w: 12, d: 9 },
      props: [],
      surfaces: [],
    };
    for (const [id, g, x, y] of [
      ['wall', 'wall-back', 0, 0],
      ['shelf', 'shelf', 0.4, 0.2],
      ['desk', 'desk', 3.6, 0.2],
    ] as const) {
      const built = placeTemplate(id, g, x, y, 0);
      scene = {
        ...scene,
        props: [...scene.props, ...built.props],
        surfaces: [...scene.surfaces, ...built.surfaces],
      };
    }
    const truth = cornerCamera(scene.grid);
    const s = roomCase(scene, truth, { desk: { w: 230 } });
    const marks = marksOf(truth);
    const fit = cameraFromMarks(marks, truth.frame, truth.room);
    const input = {
      ...s,
      calibration: {
        camera: fit.camera,
        marks,
        scene: 'custom' as const,
        error: fit.error,
        calibratedAt: '',
      },
    };
    const trace = layoutTrace();
    const traced = layoutRoom(input, { trace });
    expect(traced).toEqual(layoutRoom(input));
    const desk = trace.things.desk!;
    expect(desk.points.length).toBeGreaterThan(0);
    expect(desk.topFar).not.toBeNull();
    // How that overlap was settled: every fix it weighed, cheapest (the one taken) first.
    const step = trace.apart.find((x) => x.a === 'desk' || x.b === 'desk')!;
    expect(step.fixes[0]!.cost).toBeLessThanOrEqual(step.fixes.at(-1)!.cost);
    const box = groupBounds(traced.scene, traced.things.find((t) => t.id === 'desk')!.group!)!;
    expect(desk.placed).toMatchObject({ x: box.at.x, w: box.size.w });
  });
  it('tries the layout’s numbers without an edit, and puts them back', () => {
    expect(layoutTuning().pastTop).toBe(LAYOUT_TUNING.pastTop);
    withLayout({ pastTop: 9 }, () => {
      expect(layoutTuning().pastTop).toBe(9);
      withLayout({ flush: 0 }, () =>
        expect(layoutTuning()).toMatchObject({ pastTop: 9, flush: 0 }),
      );
    });
    expect(layoutTuning()).toEqual(LAYOUT_TUNING);
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
    // Where the office has it, at Spark's size, its back to the back wall.
    const drawn = groupBounds(layout.scene, desk.group!)!;
    const truth = groupBounds(ISO_PRESETS.office, 'desk')!;
    expect(Math.abs(drawn.at.x - truth.at.x)).toBeLessThan(0.3);
    expect(Math.abs(drawn.at.y - truth.at.y)).toBeLessThan(0.3);
    expect(drawn.size.w).toBeCloseTo(truth.size.w, 1);
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
    // The room's picture, which Spark compares with the photo, shows it too, where it stands.
    const picture = renderRoom(DEMO_CALIBRATION.camera, [
      ...sceneSolids(layout.scene),
      ...thingSolids(layout.things.filter((t) => t.status === 'object')),
    ]);
    const k = picture.names.indexOf('mug');
    expect(k).toBeGreaterThanOrEqual(0);
    const seen = picture.ids.filter((id) => id === k).length;
    expect(seen).toBeGreaterThan(50);
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

const setup = () => testApp({ name: 'room' });

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
    // Frames read the way the watcher reads them (its own height) line up with the reference.
    const watched = await lumaOf(await demoPng(), lumaHeight(960, 640));
    expect(cameraMoved(memory.camera!.reference!, cameraEdges(watched)).moved).toBe(false);
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
    // Kept after a move, the calibration stays and the frame now is the reference.
    const kept = await s.post('room/keep');
    expect(kept.statusCode, kept.body).toBe(200);
    const camera = kept.json<DeskMemory>().camera!;
    expect(camera.calibratedAt).toBe(memory.camera!.calibratedAt);
    expect(camera.reference).toBe(memory.camera!.reference);
    expect(camera.moved).toBeUndefined();
    const forgotten = (await s.post('room/forget')).json<DeskMemory>();
    expect(forgotten.camera).toBeNull();
    // With nothing calibrated there is nothing to keep.
    expect((await s.post('room/keep')).statusCode).toBe(409);
    expect(s.fetcher).not.toHaveBeenCalled();
    await s.app.close();
  });
  it('fits the camera again, from the same marks, when the room is saved another size', async () => {
    const s = await setup();
    const office: IsoScene = { ...ISO_PRESETS.office, kind: 'custom' };
    expect((await s.post('scene/save', { scene: office })).statusCode).toBe(200);
    const { marks } = (await s.post('room/floor')).json<FloorMarks>();
    const saved = await s.post('room/calibrate', {
      marks,
      room: { w: 294, d: 234 },
      scene: 'custom',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const before = saved.json<{ memory: DeskMemory }>().memory.camera!;
    const bigger = resizeRoom(office, { w: 12, d: 9 });
    const res = await s.post('scene/save', { scene: bigger });
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json<DeskMemory>().camera!;
    expect(after.marks).toEqual(before.marks);
    expect(after.calibratedAt).not.toBe(before.calibratedAt);
    expect(after.camera.room).toMatchObject({ w: 12, d: 9 });
    // The marks no longer fit a room of that shape as well.
    expect(after.error).toBeGreaterThan(before.error);
    // Saved the same size again, the camera stays.
    const again = (await s.post('scene/save', { scene: bigger })).json<DeskMemory>().camera!;
    expect(again.calibratedAt).toBe(after.calibratedAt);
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
