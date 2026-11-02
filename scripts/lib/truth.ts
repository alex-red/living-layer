/**
 * Where things really touch down in a captured room's frame, marked by hand,
 * and how far a layout puts them from there: a measure of placement that
 * doesn't come from the layout's own masks or drawings. A room's points are
 * its `truth.json`, beside its frame (local only, like the frame).
 *
 * A point is a thing's base (the middle of where it stands, at the height it
 * stands on) or one corner of its box, named by which sides: `x1y0` is its
 * far end's room side for a desk along the left wall. `top` takes the corner
 * at the top of the box, not its foot. Mark only what the frame shows: a foot
 * behind a chair is a guess. Draw the marked and drawn points over the frame
 * before trusting a number (`bun run bench:rooms` does): a point can mark
 * another thing than the one Spark's id names.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  groupBounds,
  projectRoom,
  type IsoBox,
  type PhotoLayout,
  type RoomCamera,
} from '@livinglayer/domain';
import { capturedRooms } from './rooms.js';

export interface TruthPoint {
  thing: string;
  at: { x: number; y: number };
  corner?: 'x0y0' | 'x1y0' | 'x0y1' | 'x1y1';
  top?: boolean;
  note?: string;
}
/** A captured room's marked points, by its folder; null when none are marked. */
export function truthIn(dir: string): TruthPoint[] | null {
  const file = join(dir, 'truth.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as TruthPoint[]) : null;
}
/** The marked points of the captured room made from a draft, by the draft's id or its start. */
export function truthOf(runId: string): TruthPoint[] | null {
  const room = capturedRooms().find((r) => r.runId.startsWith(runId));
  return room ? truthIn(room.dir) : null;
}
/** A mark's name in tables: its thing, and which corner when it marks one. */
export const markName = (p: TruthPoint) =>
  `${p.thing}${p.corner ? ` ${p.corner}${p.top ? ' top' : ''}` : ''}`;
/** Where the layout draws a marked point, in the frame. */
export function drawnAt(layout: PhotoLayout, camera: RoomCamera, p: TruthPoint) {
  const t = layout.things.find((x) => x.id === p.thing);
  const box: IsoBox | null | undefined =
    t?.foot ?? (t?.group ? groupBounds(layout.scene, t.group) : null);
  if (!box) return null;
  const x = p.corner
    ? p.corner[1] === '1'
      ? box.at.x + box.size.w
      : box.at.x
    : box.at.x + box.size.w / 2;
  const y = p.corner
    ? p.corner[3] === '1'
      ? box.at.y + box.size.d
      : box.at.y
    : box.at.y + box.size.d / 2;
  return projectRoom(camera, { x, y, z: p.top ? box.at.z + box.size.h : box.at.z });
}

/** Each marked point's distance in pixels from where the layout draws it; NaN when the thing isn't there. */
export function placementError(layout: PhotoLayout, camera: RoomCamera, truth: TruthPoint[]) {
  return truth.map((p) => {
    const seen = drawnAt(layout, camera, p);
    return { ...p, seen, error: seen ? Math.hypot(seen.x - p.at.x, seen.y - p.at.y) : NaN };
  });
}
/** The marked points (green) joined to where the layout draws them (red), to lay over the frame. */
export function truthSvg(errors: ReturnType<typeof placementError>, frame: RoomCamera['frame']) {
  const marks = errors.map((e) => {
    const label = `<text x="${e.at.x + 7}" y="${e.at.y - 7}" fill="#3f6" font-size="13" font-family="sans-serif">${e.thing} ${Number.isFinite(e.error) ? Math.round(e.error) : '–'}</text>`;
    const drawn = e.seen
      ? `<line x1="${e.at.x}" y1="${e.at.y}" x2="${e.seen.x}" y2="${e.seen.y}" stroke="#fe3" stroke-width="2"/><circle cx="${e.seen.x}" cy="${e.seen.y}" r="5" fill="#f33"/>`
      : '';
    return `${drawn}<circle cx="${e.at.x}" cy="${e.at.y}" r="5" fill="#3f6"/>${label}`;
  });
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}">${marks.join('')}</svg>`,
  );
}
/** The errors as one line, and their median. */
export function errorLine(errors: ReturnType<typeof placementError>) {
  const finite = errors
    .map((e) => e.error)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const median = finite.length ? finite[Math.floor((finite.length - 1) / 2)]! : NaN;
  return {
    median,
    text: errors
      .map(
        (e) =>
          `${e.thing}${e.corner ? `·${e.corner}${e.top ? '↑' : ''}` : ''} ${Number.isFinite(e.error) ? Math.round(e.error) : '–'}`,
      )
      .join('  '),
  };
}
