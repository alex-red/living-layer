/**
 * A stored "Model with AI" run read again with this tree, no model call:
 * each of Spark's answers is set in type and read as the route reads it now
 * (`readSculpt`: prints, `fromSculpt`, seating handles), scored against the
 * picture Spark was shown, and drawn beside the model kept then.
 *
 *   bun run sculpt <run|latest>             every answer, then and now → out/sculpt/<run>/
 *   bun run sculpt <run> --answer 2         one answer; also writes answer-2.json for `bun run model`
 *
 * Runs from before answers were kept (no answers.json) can't be replayed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IsoItem } from '@livinglayer/domain';
import { viewPng } from '../apps/server/src/item.js';
import { flag, parseArgs } from './lib/args.js';
import { openEvidence } from './lib/evidence.js';
import { pictureGrid } from './lib/image.js';
import { spritePng } from './lib/models.js';
import { replaySculpt } from './lib/sculpt-replay.js';

const args = parseArgs();
const ev = openEvidence();
const replay = await replaySculpt(ev, args.positional[0] ?? 'latest');
ev.close();
if (!replay) {
  console.log(
    'That run kept no answers (answers.json): only sculpts made since answers are kept replay.',
  );
  process.exit(1);
}
const { runId, kept, picture, input, then } = replay;
const dir = resolve('out/sculpt', runId.slice(0, 8));
mkdirSync(dir, { recursive: true });
const fmt = (v: number | null) => (v === null ? '—' : v.toFixed(2));
console.log(
  `${runId.slice(0, 8)}: ${kept.answers.length} answers, prompt ${kept.promptVersion}, picture ${input.width} × ${input.height}, elevation ${kept.elevation.toFixed(0)}°`,
);
const only = flag(args, 'answer');
// Each column: the picture (or an answer's model) seen by Spark's camera, then as the app draws it.
const column = async (item: IsoItem | null) => [
  item ? await viewPng(item, kept.elevation, input.width) : picture,
  item ? (await spritePng(item, { cell: 240 })).png : picture,
];
const columns: Buffer[][] = [[picture, ...(await column(then.item))]];
const labels = [`picture · kept ${fmt(then.iou)}`];
for (const [i, a] of replay.answers.entries()) {
  if (only && Number(only) !== i + 1) continue;
  console.log(
    `  answer ${i + 1}: IoU then ${fmt(a.iouThen)}, now ${fmt(a.iouNow)}; ${a.item?.parts.length ?? 0} parts. ${a.note}`,
  );
  if (!a.item) continue;
  writeFileSync(resolve(dir, `answer-${i + 1}.json`), JSON.stringify(a.item, null, 1));
  columns.push([picture, ...(await column(a.item))]);
  labels.push(`answer ${i + 1} · now ${fmt(a.iouNow)}`);
}
const rows = [0, 1, 2].map((r) => columns.map((c) => c[r]!));
const file = resolve(dir, 'replay.png');
writeFileSync(file, await pictureGrid(rows, labels));
console.log(`${file}\nEach answer's model is in ${dir}/answer-<n>.json, for bun run model <file>.`);
