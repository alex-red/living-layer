/**
 * A stored AI brush request run again with this tree, offline: the same
 * frame, outline and reading of the request, and the facts it found, through
 * today's build and camera check. Prints what moved and keeps the new model
 * for the sheet. No model call: Spark's refinements aren't replayed, so a run
 * that was refined is compared with its first round's start.
 *
 *   bun run assist <run>              a run by id, id prefix or `latest`
 *   bun run assist latest --catalog   look the product up in the catalog again
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DeskMemory, FixtureRecipe, ProductFacts } from '@livinglayer/domain';
import { finishDraft, pngMask, rgbaOf, type AssistDraft } from '../apps/server/src/assist.js';
import { BUNDLED_CATALOG, Catalog, type Researcher } from '../apps/server/src/research.js';
import { selectionRoom } from '../apps/server/src/select.js';
import { has, parseArgs } from './lib/args.js';
import { dataDir, openEvidence } from './lib/evidence.js';

const args = parseArgs();
const ref = args.positional[0] ?? 'latest';
const ev = openEvidence();
const run = ev.run<AssistDraft>(ref, 'assist');
const was = run.output;
const read = (name: string) => {
  const png = ev.asset(`${run.id}/${name}`);
  if (!png) throw new Error(`Run ${run.id} has no ${name}.`);
  return png;
};
const frame = read('frame.png');
const outline = await pngMask(read('outline.png'));
const memory = ev.memory(run.mode) ?? ({ mode: run.mode } as DeskMemory);
const room = selectionRoom(memory);
// What the request started from: the run it followed, else the selected group's own model.
const before = was.previous ? ev.run<AssistDraft>(was.previous, 'assist').output : null;
const own = room.scene.props.find((p) => p.group === was.target?.id && p.recipe)?.recipe ?? null;
const start: FixtureRecipe | null = before?.recipe ?? own;

const stored: Researcher = {
  kind: was.facts?.origin.size ?? 'catalog',
  lookup: async () => (was.facts ? (was.facts as ProductFacts) : null),
};
const researchers = has(args, 'catalog')
  ? [new Catalog([join(dataDir(), 'products'), BUNDLED_CATALOG])]
  : [stored];
const draft: AssistDraft = {
  ...was,
  facts: before?.facts ?? null,
  disagreement: [],
  recipe: start,
  place: before?.place ?? null,
  check: before?.check ?? null,
  rounds: [],
};
const log: string[] = [];
await finishDraft(draft, {
  room,
  outline,
  rgba: (await rgbaOf(frame)).data,
  researchers,
  refiner: null,
  steps: {
    run: () => {},
    done: async (id, detail) => void log.push(`  ${id.padEnd(7)} ${detail ?? ''}`),
    check: () => {},
  },
});

console.log(`run ${run.id} (${run.mode}): “${was.prompt}”`);
console.log(`  target  ${was.target ? `${was.target.kind} ${was.target.label}` : 'nothing yet'}`);
console.log(log.join('\n'));
const names = (r: FixtureRecipe | null) => new Set(r?.parts.map((p) => p.name) ?? []);
const [a, b] = [names(was.recipe), names(draft.recipe)];
const size = (r: FixtureRecipe | null) =>
  r ? `${r.sizeCm.w} × ${r.sizeCm.d} × ${r.sizeCm.h} cm` : '–';
console.log('\n          then                       now');
console.log(`  size    ${size(was.recipe).padEnd(26)} ${size(draft.recipe)}`);
console.log(`  parts   ${String(a.size).padEnd(26)} ${b.size}`);
console.log(
  `  IoU     ${(was.check?.iou.toFixed(3) ?? '–').padEnd(26)} ${draft.check?.iou.toFixed(3) ?? '–'}`,
);
if (was.rounds.length) console.log(`  (then refined ${was.rounds.length}× by Spark; not replayed)`);
const added = [...b].filter((n) => !a.has(n));
const gone = [...a].filter((n) => !b.has(n));
if (added.length) console.log(`  added   ${added.join(', ')}`);
if (gone.length) console.log(`  gone    ${gone.join(', ')}`);
if (draft.recipe) {
  const out = resolve(import.meta.dir, '..', 'out');
  mkdirSync(out, { recursive: true });
  const file = join(out, `assist-${run.id.slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify(draft.recipe, null, 2));
  console.log(`\n→ ${file}  (bun run sheet --recipe ${file})`);
}
ev.close();
