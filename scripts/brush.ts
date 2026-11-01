/**
 * One AI brush request from the shell, as the panel sends it: the target
 * the panel shows beside the one the request worked on (flagged when they
 * differ), each step, the model, its camera check and the cost, and the
 * pictures in `out/brush/<run>/` (overlay.png: the selection in yellow, the
 * outline in blue, the model drawn in place through the room's camera).
 *
 *   bun run brush --around desk "It's an IKEA Alex desk: make it its own furniture"
 *   bun run brush --around desk "make it its own furniture" --then "make the drawers green" --save
 *   bun run brush --box 105,385,655,995 "…"           a box in thousandths of the frame
 *   bun run brush --polygon 100,400,600,400,600,990 "…"   x,y pairs in thousandths
 *   bun run brush --live --around shelf-2 "…"         the running server and its camera (billed)
 *
 * The demo runs in process with a throwaway data folder: no server, and the
 * dev server's demo memory is never touched. `--pad 0.1` sets the padding
 * around `--around`'s drawing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { META_PRICES, runCost } from '@livinglayer/domain';
import { flag, has, parseArgs } from './lib/args.js';
import { brushOverlay, runBrush, sameTarget, targetName, type BrushSelect } from './lib/brush.js';

const args = parseArgs();
const numbers = (name: string, text: string) => {
  const v = text.split(',').map(Number);
  if (v.some((n) => !Number.isFinite(n) || n < 0 || n > 1000))
    throw new Error(`--${name} ${text}: expected numbers from 0 to 1000, comma separated`);
  return v;
};
function selectFrom(): BrushSelect {
  const around = flag(args, 'around');
  const box = flag(args, 'box');
  const polygon = flag(args, 'polygon');
  if (around) return { around, ...(flag(args, 'pad') ? { pad: Number(flag(args, 'pad')) } : {}) };
  if (box) {
    const [x1, y1, x2, y2] = numbers('box', box);
    if (x2 === undefined || y2 === undefined) throw new Error('--box x1,y1,x2,y2');
    return { box: { x1: x1!, y1: y1!, x2, y2 } };
  }
  if (polygon) {
    const v = numbers('polygon', polygon);
    if (v.length < 6 || v.length % 2) throw new Error('--polygon x,y,x,y,x,y… (3 points or more)');
    return { polygon: v.flatMap((x, i) => (i % 2 ? [] : [{ x, y: v[i + 1]! }])) };
  }
  throw new Error('Select something: --around <group>, --box x1,y1,x2,y2 or --polygon x,y,…');
}
const prompt = args.positional.join(' ').trim();
if (!prompt) throw new Error('Say what you want: bun run brush --around desk "make it green"');
const mode = has(args, 'live') ? 'live' : 'demo';

const result = await runBrush({
  mode,
  select: selectFrom(),
  prompt,
  follow: args.flags.get('then') ?? [],
  save: has(args, 'save'),
  ...(flag(args, 'server') ? { server: flag(args, 'server')! } : {}),
});

const { resolve: panel } = result;
const box = result.shape.kind === 'rect' ? Object.values(result.shape.box).join(',') : 'polygon';
console.log(`${mode} · selection ${box}`);
console.log(
  `panel     ${targetName(panel.target)}${panel.ambiguous ? ' (ambiguous)' : ''}  ` +
    panel.candidates
      .slice(0, 3)
      .map((c) => `${c.target.id} covered ${c.covered.toFixed(2)} fills ${c.fills.toFixed(2)}`)
      .join(' · '),
);
let total = 0;
for (const [i, turn] of result.turns.entries()) {
  const d = turn.run.output;
  const same = sameTarget(d.target, panel.target);
  console.log(`\n${i ? 'then' : 'request'}  “${turn.prompt}”  (run ${turn.run.id.slice(0, 8)})`);
  console.log(
    `  target  ${targetName(d.target)}${same ? '' : `  ✗ MISMATCH: the panel showed ${targetName(panel.target)}`}`,
  );
  for (const s of turn.steps)
    console.log(
      `  ${s.state === 'done' ? '✓' : s.state === 'failed' ? '✗' : '·'} ${s.label.padEnd(28)} ${s.detail ?? ''}`,
    );
  if (d.question) console.log(`  asks    ${d.question}`);
  if (d.intent.dropped.length) console.log(`  left out ${d.intent.dropped.join(' ')}`);
  if (d.recipe) {
    const { w, d: depth, h } = d.recipe.sizeCm;
    console.log(
      `  model   ${d.recipe.label}, ${w} × ${depth} × ${h} cm, ${d.recipe.parts.length} parts: ${d.recipe.parts.map((p) => p.name + (p.color ? ` ${p.color}` : '')).join(', ')}`,
    );
  }
  if (d.photo.sizeCm)
    console.log(
      `  camera  ${Math.round(d.photo.sizeCm.w)} × ${Math.round(d.photo.sizeCm.d)} × ${Math.round(d.photo.sizeCm.h)} cm${d.disagreement.length ? `, disagrees on ${d.disagreement.map((x) => x.axis).join(', ')}` : ''}`,
    );
  if (d.check)
    console.log(
      `  check   IoU ${d.check.iou.toFixed(2)}${d.rounds.length ? `, after ${d.rounds.length} refinement(s)` : ''}`,
    );
  // SAM bills per image, outside the run's tokens: once per new selection, live.
  const cost =
    (runCost(turn.run) ?? 0) + (mode === 'live' && i === 0 ? META_PRICES.samPerImage : 0);
  total += cost;
  if (mode === 'live')
    console.log(
      `  cost    $${cost.toFixed(4)} (Spark tokens${i === 0 ? ' and SAM' : ''}; web searches, if any, are in the ledger)`,
    );
}
const { failed } = result;
let failedRun: string | null = null;
if (failed) {
  const error = (() => {
    try {
      return (JSON.parse(failed.message) as { error: { message: string; runId?: string } }).error;
    } catch {
      return { message: failed.message, runId: undefined };
    }
  })();
  failedRun = error.runId ?? null;
  console.log(
    `\n${result.turns.length ? 'then' : 'request'}  “${failed.prompt}”  ✗ ${failed.status}`,
  );
  for (const s of failed.steps)
    console.log(
      `  ${s.state === 'done' ? '✓' : s.state === 'failed' ? '✗' : '·'} ${s.label.padEnd(28)} ${s.detail ?? ''}`,
    );
  console.log(
    `  error   ${error.message}${failedRun ? `  (bun run runs ${failedRun.slice(0, 8)})` : ''}`,
  );
}
if (result.saved) console.log(`\nsaved as ${result.saved}`);
if (mode === 'live') console.log(`\ncost $${total.toFixed(4)}`);

const name = (result.turns[0]?.run.id ?? failedRun ?? crypto.randomUUID()).slice(0, 8);
const dir = resolve(import.meta.dir, '..', 'out', 'brush', name);
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'overlay.png'), await brushOverlay(result));
writeFileSync(resolve(dir, 'frame.png'), result.frame);
const outline = result.turns.at(-1)?.outline;
if (outline)
  await sharp(Buffer.from(outline.data.map((v) => (v ? 255 : 0))), {
    raw: { width: outline.width, height: outline.height, channels: 1 },
  })
    .png()
    .toFile(resolve(dir, 'outline.png'));
const { room: _room, frame: _frame, ...kept } = result;
writeFileSync(
  resolve(dir, 'result.json'),
  JSON.stringify({ ...kept, turns: kept.turns.map(({ outline: _o, ...t }) => t) }, null, 1),
);
console.log(`\n→ out/brush/${name}/overlay.png`);
if (!result.agrees) console.log('✗ The panel and the request name different targets.');
if (!result.agrees || failed) process.exit(1);
