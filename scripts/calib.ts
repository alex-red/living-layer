/**
 * A room's calibration, with no server and no model call: how well the
 * camera fits the marks, the camera it implies (height, lens, pitch, roll,
 * principal point), how each upright mark leans against how the camera says
 * it should, and which room sizes the marks fit better (the marks pin the
 * room's shape, not its size, so one wall is kept and the other found).
 * Drawn over a frame of that camera: the marks, the uprights drawn and
 * predicted, and the floor's tiles.
 *
 *   bun run calib                  the saved live one → out/calib-live.png
 *   bun run calib demo
 *   bun run calib --run latest     the one a photo run laid out through (id, prefix or latest)
 *   bun run calib --room office-e  a captured room's
 *   bun run calib --diff saved office-e   two side by side (run id, room name, saved or demo)
 *   bun run calib --grid           also the fit over both walls' lengths, every 30 cm
 *   bun run calib --frame f35cc7f4 over that draft's frame (default: the source's own, else the latest of this size)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEMO_CALIBRATION,
  ISO_PRESETS,
  ISO_TILE_CM,
  cameraFromMarks,
  projectRoom,
  roomSizeFor,
  uprightAt,
  type IsoScene,
  type Mode,
  type PhotoDraft,
  type Point,
  type RoomCalibration,
  type RoomCamera,
} from '@livinglayer/domain';
import { flag, has, parseArgs } from './lib/args.js';
import { openEvidence } from './lib/evidence.js';
import { overlay } from './lib/overlay.js';
import { capturedRooms, layOut, roomFrame } from './lib/rooms.js';

const args = parseArgs();
const store = openEvidence();

/** A calibration to look at, wherever it was kept. */
interface Source {
  /** For the report and the overlay's file name. */
  name: string;
  calibration: RoomCalibration;
  /** The scene it was calibrated in, for its walls' thickness. */
  scene: IsoScene;
  frame: Buffer | null;
  /** Where the frame came from, when there is one. */
  frameFrom?: string;
  mode: Mode;
}

const sceneOf = (c: RoomCalibration, custom?: IsoScene | null) =>
  c.scene === 'custom' ? (custom ?? ISO_PRESETS.office) : ISO_PRESETS[c.scene];

/** `saved`/`live`/`demo`, a captured room's name, or a photo run's id. */
function sourceOf(ref: string): Source {
  if (ref === 'saved' || ref === 'live' || ref === 'demo') {
    const mode: Mode = ref === 'demo' ? 'demo' : 'live';
    const memory = store.memory(mode);
    const calibration = memory?.camera ?? (mode === 'demo' ? DEMO_CALIBRATION : null);
    if (!calibration) throw new Error(`The ${mode} room isn't calibrated.`);
    return {
      name: mode,
      calibration,
      scene: sceneOf(calibration, memory?.scene),
      frame: null,
      mode,
    };
  }
  const room = capturedRooms().find((r) => r.name === ref);
  if (room) {
    const calibration = room.input.calibration;
    return {
      name: `room-${room.name}`,
      calibration,
      scene: sceneOf(calibration, layOut(room).layout.scene),
      frame: roomFrame(room),
      frameFrom: `room ${room.name}`,
      mode: 'live',
    };
  }
  const run = store.run<PhotoDraft>(ref, 'photo');
  const calibration = run.output.calibration;
  if (!calibration) throw new Error(`Run ${run.id} has no calibration.`);
  return {
    name: `run-${run.id.slice(0, 8)}`,
    calibration,
    scene: sceneOf(calibration, run.output.layout?.scene),
    frame: store.asset(`${run.id}/source.png`),
    frameFrom: `run ${run.id.slice(0, 8)}`,
    mode: run.mode,
  };
}

type Vec3 = [number, number, number];
const deg = (r: number) => (r * 180) / Math.PI;
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** The camera turned about its view by `roll` radians from level; 0 is level. */
function rolled(c: RoomCamera, roll: number): RoomCamera {
  const right0 = unit(cross([0, 0, 1], c.forward));
  const down0 = unit(cross(right0, c.forward));
  const [k, s] = [Math.cos(roll), Math.sin(roll)];
  const mix = (a: Vec3, b: Vec3, x: number, y: number) =>
    unit([0, 1, 2].map((i) => a[i]! * x + b[i]! * y) as Vec3);
  return { ...c, right: mix(right0, down0, k, s), down: mix(down0, right0, k, -s) };
}
/** Degrees a line up the picture leans from straight up, positive to the right. */
const leanOf = (up: Point) => deg(Math.atan2(up.x, -up.y));
/** A mark's own lean, up being whichever end is higher in the frame. */
const drawnLean = ({ a, b }: { a: Point; b: Point }) =>
  leanOf(a.y < b.y ? { x: a.x - b.x, y: a.y - b.y } : { x: b.x - a.x, y: b.y - a.y });
const middle = ({ a, b }: { a: Point; b: Point }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** What the report says about a calibration, in order, for one column or two. */
function numbers(src: Source) {
  const { camera, error } = src.calibration;
  const { origin, inner } = floorOf(src);
  const cmOf = (tiles: number) => Math.round(tiles * ISO_TILE_CM);
  const crop = src.calibration.crop;
  const rows: [string, string][] = [
    ['calibrated', src.calibration.calibratedAt.slice(0, 16).replace('T', ' ')],
    ['frame', `${camera.frame.width} × ${camera.frame.height}`],
    [
      'zoom',
      crop
        ? `${(crop.w * 100).toFixed(0)}% × ${(crop.h * 100).toFixed(0)}% at ${(crop.x * 100).toFixed(0)}%, ${(crop.y * 100).toFixed(0)}%`
        : 'whole frame',
    ],
    ['room inside walls', `${cmOf(inner.w)} × ${cmOf(inner.d)} cm`],
    ['walls', `${cmOf(origin.x)} / ${cmOf(origin.y)} cm`],
    ['height', `${cmOf(camera.position[2])} cm`],
    ['hfov', `${deg(2 * Math.atan(camera.frame.width / 2 / camera.f)).toFixed(1)}°`],
    ['pitch (down)', `${deg(Math.asin(-camera.forward[2])).toFixed(1)}°`],
    ['roll', `${deg(Math.asin(camera.right[2])).toFixed(2)}°`],
    [
      'principal point',
      `${(camera.cx - camera.frame.width / 2).toFixed(0)}, ${(camera.cy - camera.frame.height / 2).toFixed(0)} px from the middle`,
    ],
    ['fit error', `${error.toFixed(1)} px`],
    ['uprights', String(src.calibration.marks.verticals?.length ?? 0)],
  ];
  return rows;
}

function floorOf(src: Source) {
  const wall = (g: string) => src.scene.props.find((p) => p.group === g);
  const origin = { x: wall('wall-left')?.size.w ?? 0, y: wall('wall-back')?.size.d ?? 0 };
  const { room } = src.calibration.camera;
  return { origin, inner: { w: room.w - origin.x, d: room.d - origin.y } };
}

/**
 * Each upright mark's lean against the fitted camera's and a level one's, and
 * the roll the uprights alone call for: when that roll is far from the fitted
 * one, or the uprights lean less than the fit says, the roll came from them.
 */
function uprights(src: Source) {
  const { camera, marks } = src.calibration;
  const level = rolled(camera, 0);
  const rows = (marks.verticals ?? []).map((m) => {
    const mid = middle(m);
    return {
      drawn: drawnLean(m),
      fitted: leanOf(uprightAt(camera, mid)),
      level: leanOf(uprightAt(level, mid)),
    };
  });
  let wanted = 0;
  if (rows.length) {
    let best = Infinity;
    for (let r = -15; r <= 15; r += 0.02) {
      const c = rolled(camera, (r * Math.PI) / 180);
      const miss = (marks.verticals ?? []).reduce(
        (s, m) => s + (leanOf(uprightAt(c, middle(m))) - drawnLean(m)) ** 2,
        0,
      );
      if (miss < best) [best, wanted] = [miss, r];
    }
  }
  // In the report's terms: the tilt of image right, from its z.
  const tilt = deg(Math.asin(rolled(camera, (wanted * Math.PI) / 180).right[2]));
  return { rows, wanted: rows.length ? tilt : 0 };
}

function printUprights(src: Source) {
  const { rows, wanted } = uprights(src);
  if (!rows.length) return console.log('  no uprights marked');
  const roll = deg(Math.asin(src.calibration.camera.right[2]));
  console.log('  upright   drawn   fitted   level   (degrees from straight up, + leans right)');
  rows.forEach((r, i) =>
    console.log(
      `  ${String(i + 1).padStart(7)} ${r.drawn.toFixed(2).padStart(7)} ${r.fitted.toFixed(2).padStart(8)} ${r.level.toFixed(2).padStart(7)}${Math.abs(r.drawn - r.fitted) > Math.abs(r.drawn - r.level) ? '   level fits it better' : ''}`,
    ),
  );
  console.log(
    `  the uprights alone call for ${wanted.toFixed(2)}° of roll; the fit has ${roll.toFixed(2)}°`,
  );
}

/** A frame of this camera: the one asked for, the source's own, else the latest draft of this size. */
function frameFor(src: Source) {
  const { camera } = src.calibration;
  const ref = flag(args, 'frame');
  if (!ref && src.frame) return { frame: src.frame, from: src.frameFrom! };
  const draft = ref
    ? store.run<PhotoDraft>(ref, 'photo')
    : store
        .runs({ kind: 'photo', mode: src.mode, limit: 30 })
        .find(
          (r) =>
            r.status === 'completed' &&
            (r.output as PhotoDraft).calibration?.camera.frame.width === camera.frame.width &&
            (r.output as PhotoDraft).calibration?.camera.frame.height === camera.frame.height,
        );
  const frame = draft ? store.asset(`${draft.id}/source.png`) : null;
  return { frame, from: frame ? `draft ${draft!.id.slice(0, 8)}` : null };
}

async function drawn(src: Source) {
  const { camera, marks } = src.calibration;
  const { frame, from } = frameFor(src);
  const out = resolve(import.meta.dir, '..', 'out');
  mkdirSync(out, { recursive: true });
  const file = resolve(out, `calib-${src.name}.png`);
  writeFileSync(file, await overlay({ camera, frame, marks, grid: true, uprights: true }));
  return `${file}${from ? ` over ${from}'s frame` : ' (no frame of this size)'}`;
}

function report(src: Source) {
  const { calibration } = src;
  const { camera, marks } = calibration;
  const { origin, inner } = floorOf(src);
  const cmOf = (tiles: number) => Math.round(tiles * ISO_TILE_CM);
  const options = { origin, crop: calibration.crop ?? null };
  console.log(`${src.name} calibration`);
  for (const [k, v] of numbers(src)) console.log(`  ${k.padEnd(18)} ${v}`);
  console.log(
    `  saving refuses over ${(Math.hypot(camera.frame.width, camera.frame.height) / 60).toFixed(0)} px`,
  );
  const refit = cameraFromMarks(marks, camera.frame, inner, options);
  console.log(
    `  fitted again with the height free: off by ${refit.error.toFixed(1)} px, ${refit.heightCm} cm up`,
  );
  console.log('\nUprights:');
  printUprights(src);
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
}

/** Two calibrations side by side, and how far apart they draw a few points of the room. */
function diff(a: Source, b: Source) {
  const [na, nb] = [numbers(a), numbers(b)];
  const width = Math.max(24, ...na.map(([, v]) => v.length + 2));
  console.log(`${''.padEnd(18)} ${a.name.padEnd(width)} ${b.name}`);
  na.forEach(([k, v], i) => console.log(`${k.padEnd(18)} ${v.padEnd(width)} ${nb[i]![1]}`));
  for (const src of [a, b]) {
    console.log(`\nUprights, ${src.name}:`);
    printUprights(src);
  }
  const ca = a.calibration.camera;
  const cb = b.calibration.camera;
  if (ca.frame.width !== cb.frame.width || ca.frame.height !== cb.frame.height)
    console.log('\nThe frames differ in size, so the pixels below compare unlike pictures.');
  // The room's points in a's tiles: the back-left floor corner is the origin in both.
  const { origin } = floorOf(a);
  const { w, d } = ca.room;
  const points: [string, { x: number; y: number; z: number }][] = [
    ['back-left corner', { x: origin.x, y: origin.y, z: 0 }],
    ['back-right corner', { x: w, y: origin.y, z: 0 }],
    ['front-left corner', { x: origin.x, y: d, z: 0 }],
    ['front-right, below camera', { x: w, y: d, z: 0 }],
    ['middle, 75 cm up', { x: (origin.x + w) / 2, y: (origin.y + d) / 2, z: 75 / ISO_TILE_CM }],
  ];
  const at = (p: Point | null) => (p ? `${p.x.toFixed(0)}, ${p.y.toFixed(0)}` : 'behind');
  console.log(`\nWhere each draws the room (pixels; ${a.name}'s room):`);
  console.log(`${''.padEnd(26)} ${a.name.padEnd(14)} ${b.name.padEnd(14)} apart`);
  for (const [label, p] of points) {
    const [pa, pb] = [projectRoom(ca, p), projectRoom(cb, p)];
    const apart = pa && pb ? Math.hypot(pa.x - pb.x, pa.y - pb.y).toFixed(1) : '—';
    console.log(`${label.padEnd(26)} ${at(pa).padEnd(14)} ${at(pb).padEnd(14)} ${apart}`);
  }
}

const pair = args.positional;
if (has(args, 'diff')) {
  // `--diff a b`: the flag may take the first, the rest come positional.
  const given = [flag(args, 'diff'), ...pair].filter(
    (v): v is string => typeof v === 'string' && v !== 'true',
  );
  if (given.length !== 2) throw new Error('--diff takes two: a run id, a room name or saved');
  const [a, b] = given.map(sourceOf) as [Source, Source];
  diff(a, b);
  console.log(`\n${await drawn(a)}\n${await drawn(b)}`);
} else {
  const run = flag(args, 'run');
  const room = flag(args, 'room');
  const src = sourceOf(run ?? room ?? pair[0] ?? 'saved');
  report(src);
  console.log(`\n${await drawn(src)}`);
}
store.close();
