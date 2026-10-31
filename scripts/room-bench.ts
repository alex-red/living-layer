/**
 * How closely a room scanned by its calibrated corner camera matches where
 * things really are. Each case (ROOM_CASES, which the tests scan too) renders
 * a known room through a corner camera, outlines every thing the way SAM
 * would, fits the camera to the room's floor marks as calibration would, lays
 * the room out, and prints how much room is left before each target
 * (ROOM_TARGETS): the worst position error of any thing in tiles, furniture
 * turned wrong, and the worst furniture width or depth error. Flags are in
 * scripts/lib/bench.ts.
 *
 *   bun run bench:room
 *   bun run bench:room --set desk.legCm=4,6,8      sweep a measurement
 */
import {
  ROOM_CASES,
  ROOM_TARGETS,
  cameraFromMarks,
  judgeRoom,
  layoutRoom,
  marksOf,
  roomCase,
  withFurniture,
  type RoomCalibration,
} from '@livinglayer/domain';
import { parseArgs, variants } from './lib/args.js';
import { report, type Row } from './lib/bench.js';

const args = parseArgs();
const rows: Row[] = [];
const swept = variants(args.flags.get('set'));
for (const v of swept)
  for (const c of ROOM_CASES)
    withFurniture(v.overrides, () => {
      const scene = c.scene();
      const truthCamera = c.camera(scene);
      const s = roomCase(scene, truthCamera, c.guess);
      // Calibrated from the room's marks, as a person would, not handed the true camera.
      const fit = cameraFromMarks(marksOf(truthCamera), truthCamera.frame, truthCamera.room);
      const calibration: RoomCalibration = {
        camera: fit.camera,
        marks: marksOf(truthCamera),
        scene: 'custom',
        error: fit.error,
        calibratedAt: new Date(0).toISOString(),
      };
      const start = performance.now();
      const layout = layoutRoom({ ...s, calibration });
      const ms = Math.round(performance.now() - start);
      const j = judgeRoom(layout, s.truth);
      rows.push({
        case: c.name,
        variant: v.label,
        metrics: {
          position: {
            value: j.worst,
            target: ROOM_TARGETS.position,
            better: 'lower',
            unit: 'tiles',
          },
          'wrong turns': { value: j.wrongTurns, target: 0, better: 'lower', digits: 0 },
          size: { value: j.size, target: ROOM_TARGETS.size, better: 'lower', unit: 'tiles' },
        },
        notes: { worst: j.who, ms: String(ms), things: String(s.inventory.things.length) },
      });
    });
process.exit(report(rows, args, 'room bench', swept));
