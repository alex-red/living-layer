/**
 * Every SAM experiment's cached masks for a draft, laid out the way the
 * setup does and scored against the points marked by hand on its frame
 * (the captured room's truth.json, scripts/lib/truth.ts): how far, in pixels, each arm draws each thing from where it
 * touches down. No model call: arms that aren't cached are left out.
 *
 *   bun scripts/experiments/evaluate.ts e8f15e31
 *
 * Arms:
 *   first          the draft's own masks (Spark's boxes alone)
 *   clean:<p>      the frame cleaned by Muse Image first (clean-frame.ts)
 *   render:<v>     a second pass with points from the draft's drawing (render-prompts.ts)
 *   best:<v>       per thing, the second pass's mask only when it agrees better with the
 *                  slid drawing and keeps at least 70% of the first mask's size
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhotoDraft, Segmentation } from '@livinglayer/domain';
import { parseArgs } from '../lib/args.js';
import { dataDir, openEvidence } from '../lib/evidence.js';
import { layOutInput, layoutInput } from '../lib/rooms.js';
import { area, bitsOf, iou } from './lib.js';
import { pointsFor } from './render-points.js';
import { errorLine, placementError, truthOf } from '../lib/truth.js';

/** The second pass's mask must keep this share of the first's size to replace it. */
const KEEPS = 0.7;

const args = parseArgs();
const evidence = openEvidence();
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Segmentation;
for (const ref of args.positional.length ? args.positional : ['latest']) {
  const run = evidence.run<PhotoDraft>(ref, 'photo');
  const draft = run.output;
  const short = run.id.slice(0, 8);
  const truth = truthOf(short);
  if (!truth) {
    console.log(
      `${short}: no captured room with marked points (truth.json in its folder), skipped.`,
    );
    continue;
  }
  const arms: { name: string; seg: Segmentation; note?: string }[] = [
    { name: 'first', seg: draft.segmentation },
  ];
  const cleanDir = join(dataDir(), 'experiments', 'clean-frame', short);
  if (existsSync(cleanDir))
    for (const f of readdirSync(cleanDir).filter(
      (f) => f.endsWith('.sam.json') && f !== 'control.sam.json',
    ))
      arms.push({ name: `clean:${f.replace('.sam.json', '')}`, seg: read(join(cleanDir, f)) });
  const renderDir = join(dataDir(), 'experiments', 'render-prompts');
  if (existsSync(renderDir)) {
    const slid = pointsFor(draft).result;
    for (const f of readdirSync(renderDir).filter(
      (f) => f.startsWith(short) && f.endsWith('.sam.json'),
    )) {
      const variant = f.slice(short.length + 1, -'.sam.json'.length) || 'both';
      const second = read(join(renderDir, f));
      arms.push({ name: `render:${variant}`, seg: second });
      // Per thing, the better of the two masks by the rule above.
      const kept: string[] = [];
      const detections = draft.segmentation.detections.map((d) => {
        const thing = Object.keys(draft.detections).find(
          (id) => draft.detections[id] === d.objectId,
        );
        const drawn = thing ? slid.get(thing)?.drawn : null;
        const next = second.detections.find((x) => x.objectId === d.objectId);
        if (!thing || !drawn || !next) return d;
        const a = bitsOf(draft.segmentation, d.objectId)!;
        const b = bitsOf(second, d.objectId)!;
        if (iou(b, drawn) > iou(a, drawn) && area(b) >= KEEPS * area(a)) {
          kept.push(thing);
          return next;
        }
        return d;
      });
      arms.push({
        name: `best:${variant}`,
        seg: { ...draft.segmentation, detections },
        note: `second pass kept for ${kept.join(', ') || 'nothing'}`,
      });
    }
  }
  console.log(`${short}: ${truth.length} points marked; error in pixels, median first`);
  for (const arm of arms) {
    const laid = layOutInput({ ...layoutInput(draft), segmentation: arm.seg });
    const e = errorLine(placementError(laid.layout, laid.calibration.camera, truth));
    console.log(`  ${arm.name.padEnd(14)} ${String(Math.round(e.median)).padStart(3)} | ${e.text}`);
    if (arm.note) console.log(`  ${''.padEnd(14)}     ${arm.note}`);
  }
}
evidence.close();
