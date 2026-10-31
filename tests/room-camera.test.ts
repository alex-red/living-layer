import { describe, expect, it } from 'bun:test';
import {
  cameraEdges,
  cameraFromMarks,
  cameraMoved,
  demoFrame,
  convexHull,
  cornerCamera,
  marksFromFloor,
  marksFromWalls,
  marksOf,
  newBits,
  fillRings,
  projectRoom,
  unprojectRoom,
  type RoomCamera,
} from '@livinglayer/domain';

const room = { w: 10, d: 8 };
const close = (a: RoomCamera, b: RoomCamera) => {
  // Every floor point lands within a few pixels of where the true camera puts it.
  let worst = 0;
  for (let x = 0; x <= room.w; x += 2)
    for (let y = 0; y <= room.d; y += 2) {
      const p = projectRoom(a, { x, y, z: 0 });
      const q = projectRoom(b, { x, y, z: 0 });
      if (p && q) worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y));
    }
  return worst;
};

describe('room camera', () => {
  it('projects and unprojects the floor', () => {
    const c = cornerCamera(room);
    const corner = projectRoom(c, { x: 0, y: 0, z: 0 })!;
    expect(corner.x).toBeGreaterThan(c.frame.width * 0.3);
    expect(corner.x).toBeLessThan(c.frame.width * 0.7);
    expect(corner.y).toBeLessThan(c.frame.height / 2);
    // The back wall runs to the right, the left wall to the left, as in the iso view.
    expect(projectRoom(c, { x: 4, y: 0, z: 0 })!.x).toBeGreaterThan(corner.x);
    expect(projectRoom(c, { x: 0, y: 4, z: 0 })!.x).toBeLessThan(corner.x);
    // Higher is higher in the frame.
    expect(projectRoom(c, { x: 3, y: 3, z: 2 })!.y).toBeLessThan(
      projectRoom(c, { x: 3, y: 3, z: 0 })!.y,
    );
    for (const z of [0, 2.4]) {
      const at = { x: 3.3, y: 2.1, z };
      const back = unprojectRoom(c, projectRoom(c, at)!, z)!;
      expect(back.x).toBeCloseTo(at.x, 6);
      expect(back.y).toBeCloseTo(at.y, 6);
    }
  });

  it('recovers the camera from the corner and the walls', () => {
    for (const [heightCm, hfovDeg, insetCm] of [
      [240, 100, 10],
      [210, 90, 10],
      [270, 115, 10],
    ] as const) {
      const truth = cornerCamera(room, { heightCm, hfovDeg, insetCm });
      const fit = cameraFromMarks(marksOf(truth), truth.frame, room, { heightCm });
      expect(fit.error).toBeLessThan(1);
      expect(close(fit.camera, truth)).toBeLessThan(2);
      // The three floor corners it can see are enough without the height.
      const free = cameraFromMarks(marksOf(truth), truth.frame, room);
      expect(close(free.camera, truth)).toBeLessThan(3);
      expect(Math.abs(free.heightCm - heightCm)).toBeLessThan(5);
    }
  });

  it('fits the whole lens behind a zoomed view, its principal point off centre', () => {
    const truth = cornerCamera(room);
    const { width, height } = truth.frame;
    // A tight crop around the far corner: far narrower than any lens the fit allows on its own.
    const crop = { x: 0.3, y: 0.05, w: 0.4, h: 0.45 };
    const zoomed: RoomCamera = {
      ...truth,
      cx: truth.cx - crop.x * width,
      cy: truth.cy - crop.y * height,
      frame: { width: width * crop.w, height: height * crop.h },
    };
    const marks = marksOf(zoomed);
    expect(marks.back.length + marks.left.length).toBeGreaterThan(4);
    const fit = cameraFromMarks(marks, zoomed.frame, room, { heightCm: 240, crop });
    expect(fit.camera.frame).toEqual(zoomed.frame);
    expect(fit.error).toBeLessThan(1);
    expect(close(fit.camera, zoomed)).toBeLessThan(2);
    expect(fit.hfovDeg).toBeLessThan(45);
  });

  it('reads the marks off a floor mask, furniture and all', () => {
    const truth = cornerCamera(room);
    const { width, height } = truth.frame;
    const bits = newBits(width, height);
    const floor = [
      { x: 0, y: 0, z: 0 },
      { x: room.w, y: 0, z: 0 },
      { x: room.w, y: room.d * 0.7, z: 0 },
      { x: room.w * 0.7, y: room.d, z: 0 },
      { x: 0, y: room.d, z: 0 },
    ].map((p) => projectRoom(truth, p)!);
    fillRings(bits, [floor]);
    // A desk against the back wall hides a stretch of the floor's edge.
    const desk = newBits(width, height);
    fillRings(desk, [
      [
        { x: 1, y: 0, z: 0 },
        { x: 6, y: 0, z: 0 },
        { x: 6, y: 2.6, z: 0 },
        { x: 1, y: 2.6, z: 0 },
      ].map((p) => projectRoom(truth, p)!),
    ]);
    for (let i = 0; i < bits.data.length; i++) if (desk.data[i]) bits.data[i] = 0;
    const marks = marksFromFloor(bits, convexHull)!;
    const corner = projectRoom(truth, { x: 0, y: 0, z: 0 })!;
    expect(Math.hypot(marks.corner.x - corner.x, marks.corner.y - corner.y)).toBeLessThan(4);
    expect(marks.backEnd).toBeTruthy();
    expect(marks.leftEnd).toBeTruthy();
    const fit = cameraFromMarks(marks, truth.frame, room);
    expect(close(fit.camera, truth)).toBeLessThan(8);
  });
});

describe('reading the marks off the walls', () => {
  // The floor and both walls as SAM outlines them, a skirting board's height of each wall left out.
  const scene = (hide?: (truth: RoomCamera) => { x: number; y: number }[]) => {
    const truth = cornerCamera(room);
    const { width, height } = truth.frame;
    const poly = (pts: { x: number; y: number; z: number }[]) => {
      const b = newBits(width, height);
      fillRings(b, [pts.map((p) => projectRoom(truth, p)!)]);
      return b;
    };
    const floor = poly([
      { x: 0, y: 0, z: 0 },
      { x: room.w, y: 0, z: 0 },
      { x: room.w, y: room.d, z: 0 },
      { x: 0, y: room.d, z: 0 },
    ]);
    const skirting = 0.25;
    const back = poly([
      { x: 0, y: 0, z: skirting },
      { x: room.w, y: 0, z: skirting },
      { x: room.w, y: 0, z: 8 },
      { x: 0, y: 0, z: 8 },
    ]);
    const left = poly([
      { x: 0, y: 0, z: skirting },
      { x: 0, y: room.d, z: skirting },
      { x: 0, y: room.d, z: 8 },
      { x: 0, y: 0, z: 8 },
    ]);
    if (hide) {
      const cover = newBits(width, height);
      fillRings(cover, [hide(truth)]);
      for (const m of [floor, back, left])
        for (let i = 0; i < m.data.length; i++) if (cover.data[i]) m.data[i] = 0;
    }
    const walls = newBits(width, height);
    for (let i = 0; i < walls.data.length; i++) walls.data[i] = back.data[i]! | left.data[i]!;
    return { truth, floor, walls, parts: [back, left] };
  };
  const corner = (truth: RoomCamera) => projectRoom(truth, { x: 0, y: 0, z: 0 })!;

  it('finds the corner where both floor lines meet, across a skirting board', () => {
    const { truth, floor, walls, parts } = scene();
    const marks = marksFromWalls(floor, walls, parts)!;
    const c = corner(truth);
    expect(Math.hypot(marks.corner.x - c.x, marks.corner.y - c.y)).toBeLessThan(4);
    expect(marks.back).toHaveLength(6);
    expect(marks.left).toHaveLength(6);
  });

  it('keeps one wall’s line and where that wall ends when furniture hides the other', () => {
    // A long cabinet against the left wall, from just past the corner, hides its floor line.
    const { truth, floor, walls, parts } = scene((t) =>
      [
        { x: 0, y: 0.15, z: 0 },
        { x: 2, y: 0.15, z: 0 },
        { x: 2, y: room.d, z: 0 },
        { x: 2, y: room.d, z: 3 },
        { x: 0, y: room.d, z: 3 },
        { x: 0, y: 0.15, z: 3 },
      ].map((p) => projectRoom(t, p)!),
    );
    const marks = marksFromWalls(floor, walls, parts)!;
    expect(marks.left).toEqual([]);
    expect(marks.back).toHaveLength(6);
    const c = corner(truth);
    expect(Math.hypot(marks.corner.x - c.x, marks.corner.y - c.y)).toBeLessThan(6);
    // Without each wall's own mask there is no telling where the corner is.
    expect(marksFromWalls(floor, walls)).toBeNull();
  });
});

describe('telling whether the camera moved', () => {
  const grey = (shiftX = 0, extra?: (x: number, y: number) => number | null) => {
    const picture = demoFrame('centre');
    const { width, height } = picture;
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sx = Math.min(width - 1, Math.max(0, x + shiftX));
        const i = (y * width + sx) * 4;
        const v = extra?.(x, y);
        data[y * width + x] =
          v ?? picture.rgba[i]! * 0.3 + picture.rgba[i + 1]! * 0.59 + picture.rgba[i + 2]! * 0.11;
      }
    return { width, height, data };
  };
  const reference = cameraEdges(grey());
  it('holds still for the same view, and for someone walking through it', () => {
    expect(cameraMoved(reference, cameraEdges(grey())).moved).toBe(false);
    // A person-sized dark shape in front of the desk.
    const person = grey(0, (x, y) => (x > 300 && x < 380 && y > 250 && y < 600 ? 40 : null));
    expect(cameraMoved(reference, cameraEdges(person)).moved).toBe(false);
  });
  it('notices the camera knocked aside', () => {
    const moved = cameraMoved(reference, cameraEdges(grey(36)));
    expect(moved.moved).toBe(true);
  });
});
