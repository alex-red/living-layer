/**
 * Captured rooms: real frames of a room's camera, kept with what Spark and
 * SAM made of them, so a change to the layout can be tried on them again
 * with no model call. Local only, under the ignored data folder (see
 * testdata/README: real captures aren't published). Each room is a folder:
 *
 *   room.json      the run it came from, and the layout's inputs
 *   frame.png      the frame
 *   expected.json  the placements last accepted, which the rooms bench compares with
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  layoutRoom,
  refineWalls,
  type LayoutTrace,
  type PhotoDraft,
  type RoomCalibration,
  type RoomLayoutInput,
} from '@livinglayer/domain';
import { roomsDir } from './evidence.js';
import { placements, type Placement } from './placements.js';

export interface CapturedRoom {
  name: string;
  runId: string;
  capturedAt: string;
  input: Omit<RoomLayoutInput, 'edits'>;
  dir: string;
}
/** What a layout needs from a drafted run. */
export const layoutInput = (draft: PhotoDraft): CapturedRoom['input'] => ({
  inventory: draft.inventory,
  segmentation: draft.segmentation,
  detections: draft.detections,
  calibration: draft.calibration,
});

export function captureRoom(
  name: string,
  runId: string,
  draft: PhotoDraft,
  frame: Buffer | null,
): CapturedRoom {
  if (!/^[a-z0-9-]+$/.test(name))
    throw new Error('A room name is lowercase letters, digits and dashes');
  const dir = join(roomsDir(), name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const room: CapturedRoom = {
    name,
    runId,
    capturedAt: new Date().toISOString(),
    input: layoutInput(draft),
    dir,
  };
  const { dir: _dir, ...saved } = room;
  writeFileSync(join(dir, 'room.json'), JSON.stringify(saved));
  if (frame) writeFileSync(join(dir, 'frame.png'), frame);
  acceptRoom(room);
  return room;
}

export function capturedRooms(): CapturedRoom[] {
  const base = roomsDir();
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(base, e.name, 'room.json')))
    .map((e) => ({
      ...(JSON.parse(readFileSync(join(base, e.name, 'room.json'), 'utf8')) as Omit<
        CapturedRoom,
        'dir'
      >),
      dir: join(base, e.name),
    }));
}

export const roomFrame = (room: CapturedRoom) => {
  const file = join(room.dir, 'frame.png');
  return existsSync(file) ? readFileSync(file) : null;
};
/**
 * Laid out with this tree's code, as the room's setup does: a wall whose
 * marks the things against it disagree with is turned first, and the layout
 * goes through that camera. `calibration` lays it out through another
 * camera instead (a captured room's, the saved one), to tell a calibration's
 * error from the layout's; `trace` collects what the layout weighed.
 */
export function layOutInput(
  input: RoomLayoutInput,
  { calibration: through, trace }: { calibration?: RoomCalibration; trace?: LayoutTrace } = {},
) {
  const start = through ? { ...input, calibration: through } : input;
  const refined = refineWalls(start);
  const calibration = refined?.calibration ?? start.calibration;
  return { layout: layoutRoom({ ...start, calibration }, { trace }), calibration, refined };
}
/** The room laid out with this tree's code. */
export const layOut = (room: CapturedRoom) => layOutInput(room.input);
export function expectedOf(room: CapturedRoom): Record<string, Placement> | null {
  const file = join(room.dir, 'expected.json');
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Placement>)
    : null;
}
/** Keep how this tree lays the room out as what the bench expects from now on. */
export function acceptRoom(room: CapturedRoom) {
  writeFileSync(
    join(room.dir, 'expected.json'),
    JSON.stringify(placements(layOut(room).layout), null, 1),
  );
}
