/**
 * The room's saved calibration, with no server and no model call: how well
 * the camera fits the marks, the camera it implies, and which room sizes the
 * marks fit better (the marks pin the room's shape, not its size, so one
 * wall is kept and the other found). Drawn over a frame of that camera: the
 * marks, and the floor's tiles through the saved camera.
 *
 *   bun run calib                  live → out/calib-live.png
 *   bun run calib demo
 *   bun run calib --grid           also the fit over both walls' lengths, every 30 cm
 *   bun run calib --frame f35cc7f4 over that draft's frame (default: the latest of this size)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEMO_CALIBRATION,
  ISO_PRESETS,
  ISO_TILE_CM,
  cameraFromMarks,
  roomSizeFor,
  type Mode,
  type PhotoDraft,
} from '@livinglayer/domain';
import { flag, has, parseArgs } from './lib/args.js';
import { openEvidence } from './lib/evidence.js';
import { overlay } from './lib/overlay.js';

const args = parseArgs();
const mode = (args.positional[0] ?? 'live') as Mode;
const store = openEvidence();
const memory = store.memory(mode);
const calibration = memory?.camera ?? (mode === 'demo' ? DEMO_CALIBRATION : null);
if (!calibration) throw new Error(`The ${mode} room isn't calibrated.`);
const { camera, marks } = calibration;
const crop = calibration.crop ?? null;

// The fit's room is the floor inside the walls, offset by their thickness, as saving fits it.
const scene =
  calibration.scene === 'custom'
    ? (memory?.scene ?? ISO_PRESETS.office)
    : ISO_PRESETS[calibration.scene];
const wall = (g: string) => scene.props.find((p) => p.group === g);
const origin = { x: wall('wall-left')?.size.w ?? 0, y: wall('wall-back')?.size.d ?? 0 };
const inner = { w: camera.room.w - origin.x, d: camera.room.d - origin.y };
const cmOf = (tiles: number) => Math.round(tiles * ISO_TILE_CM);
const options = { origin, crop };
const refit = cameraFromMarks(marks, camera.frame, inner, options);
const hfov = (2 * Math.atan(camera.frame.width / 2 / camera.f) * 180) / Math.PI;
const limit = Math.hypot(camera.frame.width, camera.frame.height) / 60;

console.log(`${mode} calibration, ${calibration.calibratedAt}`);
console.log(
  `  room inside its walls ${cmOf(inner.w)} × ${cmOf(inner.d)} cm (back × left), frame ${camera.frame.width} × ${camera.frame.height}${crop ? `, zoomed to ${(crop.w * 100).toFixed(0)}% × ${(crop.h * 100).toFixed(0)}%` : ''}`,
);
console.log(
  `  camera ${cmOf(camera.position[2])} cm up, ${hfov.toFixed(0)}° wide; marks off by ${calibration.error.toFixed(1)} px (saving refuses over ${limit.toFixed(0)} px)`,
);
console.log(
  `  fitted again with the height free: off by ${refit.error.toFixed(1)} px, ${refit.heightCm} cm up`,
);
console.log('\nOne wall kept, the other found:');
for (const solve of ['d', 'w'] as const) {
  const found = roomSizeFor(marks, camera.frame, inner, solve, options);
  const kept = solve === 'd' ? 'back' : 'left';
  console.log(
    `  ${kept} wall kept at ${cmOf(solve === 'd' ? inner.w : inner.d)} cm: ${solve === 'd' ? 'left' : 'back'} wall ${cmOf(found.room[solve])} cm fits to ${found.error.toFixed(1)} px`,
  );
}
if (has(args, 'grid')) {
  const lengths = Array.from({ length: 14 }, (_, i) => 4 + i);
  console.log(`\nOff by (px), back wall down, left wall across, in cm:`);
  console.log(`      ${lengths.map((v) => String(v * 30).padStart(5)).join('')}`);
  for (const w of lengths)
    console.log(
      `${String(w * 30).padStart(5)} ${lengths
        .map((d) =>
          cameraFromMarks(marks, camera.frame, { w, d }, options).error.toFixed(1).padStart(5),
        )
        .join('')}`,
    );
}

// A frame of this camera: the one asked for, else the latest draft of this size.
const ref = flag(args, 'frame');
const draft = ref
  ? store.run<PhotoDraft>(ref, 'photo')
  : store
      .runs({ kind: 'photo', mode, limit: 30 })
      .find(
        (r) =>
          r.status === 'completed' &&
          (r.output as PhotoDraft).calibration?.camera.frame.width === camera.frame.width &&
          (r.output as PhotoDraft).calibration?.camera.frame.height === camera.frame.height,
      );
const frame = draft ? store.asset(`${draft.id}/source.png`) : null;
const out = resolve(import.meta.dir, '..', 'out');
mkdirSync(out, { recursive: true });
const file = resolve(out, `calib-${mode}.png`);
writeFileSync(file, await overlay({ camera, frame, marks, grid: true }));
console.log(
  `\n${file}${frame ? ` over draft ${draft!.id.slice(0, 8)}'s frame` : ' (no frame of this size)'}`,
);
store.close();
