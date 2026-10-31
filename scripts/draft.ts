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
 *   bun run draft capture latest --name office
 *                                           keep it for `bun run bench:rooms`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { draftModel, layoutRoom, type PhotoDraft } from '@livinglayer/domain';
import { flag, has, parseArgs } from './lib/args.js';
import { openEvidence } from './lib/evidence.js';
import { isoPicture, layoutOverlay } from './lib/overlay.js';
import { placementTable, placements } from './lib/placements.js';
import { captureRoom, layoutInput } from './lib/rooms.js';

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
const shown = async (layout: PhotoDraft['layout'], file: string) => {
  writeFileSync(file, await layoutOverlay(layout, camera, frame));
  writeFileSync(file.replace(/\.png$/, '-iso.png'), await isoPicture(layout));
  return file;
};

if (has(args, 'relayout')) {
  const layout = layoutRoom(layoutInput(draft));
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
  console.log(`\n${await shown(draft.layout, resolve(out, `draft-${short}.png`))}  as drafted`);
  console.log(
    `${await shown(layout, resolve(out, `draft-${short}-relayout.png`))}  laid out again`,
  );
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
