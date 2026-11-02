/**
 * A room draft, from the lab's stored runs, with no server and no model
 * call: where each thing went and its model, and the layout drawn over the
 * frame. With --relayout, the same inputs (Spark's list, SAM's masks, the
 * calibration) are laid out again with this tree's code, to try a change on
 * a real frame without paying for another draft. `capture` keeps the run as
 * a captured room for the rooms bench.
 *
 *   bun run draft                           the latest draft → out/draft-<id>.png
 *   bun run draft f35cc7f4 --relayout       laid out again: what moved → out/draft-<id>-relayout.png
 *   bun run draft f35cc7f4 --compare        as drafted beside laid out again → out/draft-<id>-compare.png
 *   bun run draft f35cc7f4 --why desk       how the desk's place was found, and every overlap it
 *                                           was in → out/draft-<id>-why-desk.png (its near points)
 *   bun run draft f35cc7f4 --trace          every overlap the layout pulled apart, and how
 *   bun run draft f35cc7f4 --relayout --calibration office-d
 *                                           through another camera: a captured room's, a run's, or `saved`
 *   bun run draft f35cc7f4 --relayout --set layout.pastTop=8
 *                                           with one of the layout's numbers changed (LAYOUT_TUNING)
 *   bun run draft capture latest --name office
 *                                           keep it for `bun run bench:rooms`
 *
 * --why, --trace, --compare, --calibration and --set all lay it out again.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  draftModel,
  layoutTrace,
  type PhotoDraft,
  type RoomCalibration,
  type RoomCamera,
} from '@livinglayer/domain';
import { flag, has, parseArgs, variants, withVariant } from './lib/args.js';
import { openEvidence } from './lib/evidence.js';
import { pictureGrid } from './lib/image.js';
import { isoPicture, layoutOverlay, overlay } from './lib/overlay.js';
import { placementTable, placements } from './lib/placements.js';
import { capturedRooms, captureRoom, layOutInput, layoutInput } from './lib/rooms.js';

const args = parseArgs();
const capture = args.positional[0] === 'capture';
const ref = args.positional[capture ? 1 : 0] ?? 'latest';
const store = openEvidence();
const run = store.run<PhotoDraft>(ref, 'photo');
const draft = run.output;
const short = run.id.slice(0, 8);
const frame = store.asset(`${run.id}/source.png`);
const out = resolve(import.meta.dir, '..', 'out');
mkdirSync(out, { recursive: true });

if (capture) {
  const name = flag(args, 'name');
  if (!name) throw new Error('Name the room: bun run draft capture <run> --name office');
  const room = captureRoom(name, run.id, draft, frame);
  console.log(
    `Captured ${short} as "${name}" in ${room.dir}${frame ? '' : ' (no frame: a demo run)'}.`,
  );
  console.log('`bun run bench:rooms` now lays it out on every run; `--accept` keeps a change.');
  process.exit(0);
}

const { camera } = draft.calibration;
console.log(
  `${run.mode} draft ${short}, ${run.createdAt}, ${draft.layout.things.length} things through a ${camera.frame.width} × ${camera.frame.height} camera`,
);
if (!frame) console.log('No frame stored (a demo run): drawn over a blank canvas.');
const stored = placements(draft.layout);
const from = (id: string) => draft.modelFrom?.[id];
const shown = async (layout: PhotoDraft['layout'], file: string, through: RoomCamera = camera) => {
  writeFileSync(file, await layoutOverlay(layout, through, frame));
  writeFileSync(file.replace(/\.png$/, '-iso.png'), await isoPicture(layout));
  return file;
};

const why = flag(args, 'why');
const again = ['relayout', 'why', 'trace', 'compare', 'calibration', 'set'].some((f) =>
  has(args, f),
);
if (again) {
  const swept = variants(args.flags.get('set'));
  if (swept.length > 1)
    throw new Error('--set takes one value per key here; sweep with `bun run bench:rooms --set …`');
  const through = calibrationOf(flag(args, 'calibration'));
  const trace = layoutTrace();
  const { layout, calibration, refined } = withVariant(swept[0]!, () =>
    layOutInput(layoutInput(draft), { calibration: through, trace }),
  );
  if (swept[0]!.label !== 'as built') console.log(`\nWith ${swept[0]!.label}.`);
  if (through) console.log(`\nThrough ${flag(args, 'calibration')}'s calibration.`);
  if (refined) {
    const { room, position } = calibration.camera;
    console.log(
      `\nTurned the ${refined.wall} wall's marks ${refined.degrees}° to ${refined.witnesses.join(', ')}: the room ${Math.round((room.w - 0.2) * 30)} × ${Math.round((room.d - 0.2) * 30)} cm, the camera ${Math.round(position[2] * 30)} cm up, off by ${calibration.error.toFixed(1)} px`,
    );
  }
  console.log('\nLaid out again with this tree:\n');
  console.log(placementTable(placements(layout), stored));
  // The model each thing would get now, from the fixtures saved in that mode.
  const library = store.memory(run.mode)?.fixtures ?? [];
  const models = layout.things
    .filter((t) => t.status === 'object' || (t.status === 'placed' && t.role === 'object'))
    .map((t) => {
      const now = draftModel(t, t.as, library).source;
      const before = from(t.id) ?? 'fitted';
      return `${t.id}: ${before === now ? now : `${before} → ${now}`}`;
    });
  if (models.length) console.log(`\nModels: ${models.join(', ')}`);
  if (has(args, 'trace')) {
    console.log(
      '\nOverlaps pulled apart, each with its fixes, cheapest first (the first was taken):',
    );
    for (const step of trace.apart) console.log(stepLines(step));
  }
  if (why) {
    const t = trace.things[why];
    if (!t)
      throw new Error(
        `No "${why}" was planned; the things are ${Object.keys(trace.things).join(', ')}`,
      );
    const xy = (p: { x: number; y: number }) => `${p.x.toFixed(2)}, ${p.y.toFixed(2)}`;
    const box = (f?: { x: number; y: number; w: number; d: number }) =>
      f
        ? `${xy(f)} to ${xy({ x: f.x + f.w, y: f.y + f.d })} (${f.w.toFixed(2)} × ${f.d.toFixed(2)})`
        : '–';
    const open = t.points.filter((p) => p.open).length;
    console.log(`\nWhy ${why} is where it is (tiles; x along the back wall, y along the left):`);
    console.log(`  stands at z ${t.top.toFixed(2)}, turned ${t.turns}`);
    console.log(
      `  near points  ${t.points.length}, ${open} only a bound (cut off by the frame or behind a wall)`,
    );
    console.log(`  reach        ${xy(t.reach)}   inset ${xy(t.inset)}`);
    console.log(
      `  near sides   x ${t.open.x ? 'only a bound' : 'seen'}, y ${t.open.y ? 'only a bound' : 'seen'}${t.cut ? '; the frame cuts it off below' : ''}`,
    );
    console.log(`  top seen to  ${t.topFar ? xy(t.topFar) : '–'}`);
    console.log(`  flush        ${t.flush ?? '–'}   slack ${xy(t.slack)}   give ${xy(t.give)}`);
    console.log(`  planned      ${box(t.planned)}`);
    console.log(`  placed       ${box(t.placed)}`);
    const steps = trace.apart.filter((s) => s.a === why || s.b === why);
    if (steps.length)
      console.log(`\n  Overlaps it was in:\n${steps.map((s) => stepLines(s, '  ')).join('\n')}`);
    const file = resolve(out, `draft-${short}-why-${why}.png`);
    writeFileSync(
      file,
      await overlay({
        camera: calibration.camera,
        frame,
        boxes: [
          {
            label: `${why} planned`,
            box: {
              at: { x: t.planned.x, y: t.planned.y, z: t.top },
              size: { w: t.planned.w, d: t.planned.d, h: 0 },
            },
          },
          ...(t.placed
            ? [
                {
                  label: `${why} placed`,
                  box: {
                    at: { x: t.placed.x, y: t.placed.y, z: t.top },
                    size: { w: t.placed.w, d: t.placed.d, h: 0 },
                  },
                },
              ]
            : []),
        ],
        dots: t.points.map((p) => ({
          at: { x: p.x, y: p.y, z: t.top },
          color: p.open ? '#f44' : '#3f6',
        })),
      }),
    );
    console.log(
      `\n${file}  its near points (green seen, red only a bound) and its footprint, planned and placed`,
    );
  }
  const before = await shown(draft.layout, resolve(out, `draft-${short}.png`));
  const after = await shown(
    layout,
    resolve(out, `draft-${short}-relayout.png`),
    calibration.camera,
  );
  console.log(`\n${before}  as drafted\n${after}  laid out again`);
  if (has(args, 'compare')) {
    const file = resolve(out, `draft-${short}-compare.png`);
    writeFileSync(
      file,
      await pictureGrid(
        [
          [
            await layoutOverlay(draft.layout, camera, frame),
            await layoutOverlay(layout, calibration.camera, frame),
          ],
          [await isoPicture(draft.layout), await isoPicture(layout)],
        ],
        ['As drafted', 'Laid out again with this tree'],
      ),
    );
    console.log(`${file}  side by side`);
  }
} else {
  console.log(`\n${placementTable(stored)}`);
  const models = Object.keys(draft.items ?? {})
    .map((id) => `${id}: ${from(id) ?? 'fitted'}`)
    .join(', ');
  if (models) console.log(`\nModels: ${models}`);
  if (draft.assists.length) console.log(`\n${draft.assists.map((a) => `· ${a}`).join('\n')}`);
  console.log(`\n${await shown(draft.layout, resolve(out, `draft-${short}.png`))}`);
}
store.close();

/** A calibration by name: a captured room's, a photo run's, or `saved` (the room's own); none for none. */
function calibrationOf(name?: string): RoomCalibration | undefined {
  if (!name) return undefined;
  if (name === 'saved') {
    const saved = store.memory(run.mode)?.camera;
    if (!saved) throw new Error(`The ${run.mode} room has no saved calibration.`);
    return saved;
  }
  const room = capturedRooms().find((r) => r.name === name);
  if (room) return room.input.calibration;
  return store.run<PhotoDraft>(name, 'photo').output.calibration;
}
/** An overlap `apart` met, its fixes cheapest first. */
function stepLines(step: ReturnType<typeof layoutTrace>['apart'][number], indent = '') {
  const [took, ...rest] = step.fixes;
  return [
    `${indent}  ${step.phase} pass ${step.pass + 1}: ${step.a} × ${step.b}, overlapping ${step.overlap.x.toFixed(2)} × ${step.overlap.y.toFixed(2)}`,
    took
      ? `${indent}    → ${took.what}  (${took.cost.toFixed(2)})`
      : `${indent}    → nothing could clear it`,
    ...rest.slice(0, 3).map((f) => `${indent}      ${f.what}  (${f.cost.toFixed(2)})`),
  ].join('\n');
}
