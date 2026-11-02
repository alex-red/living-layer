/**
 * A stored AI brush request run again with this tree, offline: the same
 * frame, outline and reading of the request, and the facts it found, through
 * today's build and camera check. Prints what moved and keeps the new model
 * for the sheet. No model call: Spark's refinements aren't replayed, so a run
 * that was refined is compared with its first round's start.
 *
 *   bun run assist <run>              a run by id, id prefix or `latest`
 *   bun run assist latest --catalog   look the product up in the catalog again
 *   bun run assist latest --replaces ikea-alex-desk
 *                                     the group it replaces now, when the room has
 *                                     changed since (the request's own was saved over)
 *   bun run assist latest --match     read the request as “match the photo”
 *   bun run assist latest --live      shape it from the photo with Spark (billed, two calls)
 *   bun run assist latest --looks     the same, from the answers a --live replay kept (free)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AssistDraft, DeskMemory, FixtureRecipe, ProductFacts } from '@livinglayer/domain';
import { finishDraft, pngMask, rgbaOf, samWhole } from '../apps/server/src/assist.js';
import { shapeFromPhoto } from '../apps/server/src/brush-sculpt.js';
import { parseConfig } from '../apps/server/src/config.js';
import { MetaAdapter } from '../apps/server/src/meta.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { decodeStoredSam } from '../apps/server/src/sam.js';
import { BUNDLED_CATALOG, Catalog, type Researcher } from '../apps/server/src/research.js';
import { selectionRoom } from '../apps/server/src/select.js';
import { flag, has, parseArgs } from './lib/args.js';
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
// SAM's whole outline: kept since the place fit, else read from SAM's stored answer.
const keptWhole = ev.asset(`${run.id}/whole.png`);
const samText = ev.asset(`${run.id}/sam-output.txt`);
const whole = keptWhole
  ? await pngMask(keptWhole)
  : samText
    ? samWhole(
        (
          await decodeStoredSam(
            samText.toString('utf8'),
            'thing',
            was.frame.width,
            was.frame.height,
          )
        ).output,
        was.frame,
      )
    : null;
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
  ...(has(args, 'match')
    ? { intent: { ...was.intent, ops: [{ op: 'match_photo' as const }] } }
    : {}),
  facts: before?.facts ?? null,
  disagreement: [],
  recipe: start,
  place:
    before?.place ??
    (flag(args, 'replaces') && was.place
      ? { ...was.place, replaces: flag(args, 'replaces')! }
      : null),
  check: before?.check ?? null,
  rounds: [],
};
const log: string[] = [];
const spent: number[] = [];
const shots = resolve(import.meta.dir, '..', 'out', 'assist', run.id.slice(0, 8));
let meta: MetaAdapter | null = null;
if (has(args, 'live')) {
  // The running server's keys; spend kept in a throwaway store, so the server's ledger isn't touched.
  const env = join(dirname(dataDir()), '.env');
  if (!process.env.MODEL_API_KEY && existsSync(env)) process.loadEnvFile(env);
  meta = new MetaAdapter(
    parseConfig(process.env),
    new EvidenceStore(mkdtempSync(join(tmpdir(), 'assist-replay-'))),
  );
}
if (has(args, 'looks')) {
  // Spark's answers from the last --live replay, read back in order.
  let n = 0;
  meta = {
    sculpt: async () => {
      const file = join(shots, `look-${++n}.json`);
      if (!existsSync(file)) throw new Error(`No ${file}: run with --live first.`);
      return {
        output: JSON.parse(readFileSync(file, 'utf8')),
        usage: null,
        model: 'stored',
        requestId: null,
      };
    },
  } as unknown as MetaAdapter;
}
// Each of Spark's answers kept beside the pictures, to read when a look comes back unusable.
else if (meta) {
  const sculpt = meta.sculpt.bind(meta);
  let n = 0;
  meta.sculpt = async (...a: Parameters<typeof sculpt>) => {
    const r = await sculpt(...a);
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, `look-${++n}.json`), JSON.stringify(r.output, null, 2));
    writeFileSync(join(shots, `look-${n}-prompt.txt`), a[2]);
    return r;
  };
}
await finishDraft(draft, {
  room,
  outline,
  whole,
  rgba: (await rgbaOf(frame)).data,
  researchers,
  refiner: null,
  shaper: meta
    ? async (recipe, place, against, check) => {
        const shaped = await shapeFromPhoto({
          meta: meta!,
          camera: room.camera,
          scene: room.scene,
          place,
          recipe,
          frame,
          against,
          request: was.prompt,
          check,
          onCall: (r) => void spent.push(r.usage?.totalTokens ?? 0),
        });
        if (shaped) {
          mkdirSync(shots, { recursive: true });
          writeFileSync(join(shots, 'shaped.png'), shaped.render);
          for (const [i, c] of shaped.looks.entries())
            log.push(`  look ${i + 1}  IoU ${c.iou.toFixed(3)}, ΔE ${c.deltaE?.toFixed(1) ?? '–'}`);
        }
        return shaped;
      }
    : null,
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
console.log(`  ΔE      ${'–'.padEnd(26)} ${draft.check?.deltaE?.toFixed(1) ?? '–'}`);
if (spent.length)
  console.log(`  Spark   ${spent.length} calls, ${spent.reduce((a, b) => a + b, 0)} tokens`);
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
