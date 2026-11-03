import type { RoomCalibration } from './memory.js';
import type { Point } from './iso.js';
import { cameraFromMarks, fitLimit, roomSizeFor, type RoomMarks } from './room-camera.js';
import { layoutTuning } from './layout-tuning.js';
import { layoutRoom, type RoomLayoutInput, type WallGap } from './room-scan.js';

const STEP_DEG = 0.5;
const MOST_DEG = 15;

export interface WallRefinement {
  calibration: RoomCalibration;
  wall: keyof WallGap;
  /** The turn of that wall's marks about the corner, in the frame, clockwise. */
  degrees: number;
  /** The things that stood behind it. */
  witnesses: string[];
}

/**
 * The calibration with one wall turned to where the room's things say it is.
 * A wall's floor line is often hidden behind furniture, so its marks are a
 * guess; but nothing stands behind a wall, and what stands against it touches
 * it. When several things stand behind one wall, its marks are turned about
 * the corner until those things, taken together, just touch it, the other
 * wall's length kept and this one's found again. Together, as the middle one
 * of them: an outline that doesn't reach down to where its thing stands (a
 * screen above its stand) would turn the wall too far on its own. Null when no
 * wall needs it, or no turn within the fit's limit brings them to it.
 */
export function refineWalls(input: RoomLayoutInput): WallRefinement | null {
  const gapsOf = (calibration: RoomCalibration) => {
    const gaps = new Map<string, WallGap>();
    layoutRoom({ ...input, calibration }, { behind: gaps });
    return gaps;
  };
  const T = layoutTuning();
  const base = gapsOf(input.calibration);
  for (const wall of ['left', 'back'] as const) {
    const witnesses = [...base]
      // Too far behind it, a thing hangs on the wall (a calendar) rather than standing there.
      .filter(([, g]) => g[wall] > T.wallSlack && g[wall] < T.hanging)
      .map(([id]) => id);
    if (witnesses.length < T.witnesses) continue;
    const middle = (gaps: Map<string, WallGap>) => {
      const vs = witnesses.map((id) => gaps.get(id)?.[wall] ?? 0).sort((a, b) => a - b);
      return (vs[Math.floor((vs.length - 1) / 2)]! + vs[Math.floor(vs.length / 2)]!) / 2;
    };
    const at = (degrees: number) => {
      const calibration = turnWall(input.calibration, wall, degrees);
      return calibration ? { calibration, degrees, gap: middle(gapsOf(calibration)) } : null;
    };
    // Which way: the turn that brings them nearer.
    let best = [at(STEP_DEG), at(-STEP_DEG)].filter((w) => !!w).sort((a, b) => a.gap - b.gap)[0];
    if (!best || best.gap >= middle(base)) continue;
    const sign = Math.sign(best.degrees);
    for (let k = 2; best.gap > 0 && k * STEP_DEG <= MOST_DEG; k++) {
      const next = at(sign * k * STEP_DEG);
      if (!next || next.gap >= best.gap) break;
      best = next;
    }
    if (best.gap > 0) continue;
    return { calibration: best.calibration, wall, degrees: best.degrees, witnesses };
  }
  return null;
}

/**
 * The calibration with one wall's marks turned about the corner by `degrees`
 * (clockwise in the frame), refitted with the other wall's length kept.
 * Null when the turned marks fit no corner camera.
 */
export function turnWall(
  calibration: RoomCalibration,
  wall: keyof WallGap,
  degrees: number,
): RoomCalibration | null {
  const { marks, camera } = calibration;
  const a = (degrees * Math.PI) / 180;
  const c = marks.corner;
  const turn = (p: Point) => ({
    x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a),
    y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a),
  });
  const end = wall === 'left' ? 'leftEnd' : 'backEnd';
  const turned: RoomMarks = {
    ...marks,
    [wall]: marks[wall].map(turn),
    [end]: marks[end] ? turn(marks[end]) : marks[end],
  };
  // The scene's walls are 0.2 thick, as `layoutRoom` builds them: the fit is the floor inside.
  const origin = { x: 0.2, y: 0.2 };
  const options = { origin, crop: calibration.crop ?? null };
  const inner = { w: camera.room.w - origin.x, d: camera.room.d - origin.y };
  const found = roomSizeFor(turned, camera.frame, inner, wall === 'left' ? 'd' : 'w', options);
  const fit = cameraFromMarks(turned, camera.frame, found.room, options);
  if (fit.error > fitLimit(camera.frame)) return null;
  return { ...calibration, marks: turned, camera: fit.camera, error: fit.error };
}
