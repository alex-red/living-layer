import {
  demoEdit,
  EDIT_PROMPT_VERSION,
  editNote,
  editorVoxels,
  editPrompt,
  fixtureSize,
  type FixtureEditOutput,
  fixturesEditBodySchema,
  type IsoItem,
  sparkCeiling,
  toSculpt,
} from '@livinglayer/domain';
import sharp from 'sharp';
import { LabError } from '../errors.js';
import { toDataUrl } from '../images.js';
import { keepLocked, viewPng } from '../item.js';
import { following } from '../jobs.js';
import { SPARK_BUDGET } from '../meta.js';
import { type RouteDeps } from '../route-deps.js';
import { type Parsed } from './shared.js';
import {
  ISO_ELEVATION,
  proportions,
  readSculpt,
  SCULPT_BACKDROP,
  storedCloseUp,
} from './sculpt.js';

/** How wide a model is drawn for Spark, in pixels per unit of its footprint. */
const EDIT_RENDER_PX = 160;
/** What editing a model with AI shows while it runs, in order. */
const EDIT_STEPS = [
  { id: 'current', label: 'Its model as it is' },
  { id: 'edit', label: 'Spark changes it' },
];
const partsOf = (n: number) => `${n} part${n === 1 ? '' : 's'}`;
const shown = async (png: Buffer) =>
  toDataUrl(await sharp(png).flatten({ background: SCULPT_BACKDROP }).png().toBuffer());

/**
 * Change a thing's model as the person asks, starting from the model the
 * editor has now: Spark sees it rendered (and the close photo it was fitted
 * to, when there is one) and gives its parts back changed only where asked
 * (one call), keeping the parts the person locked. Nothing is saved: the
 * editor shows the answer as a draft. The demo recolours by name, offline.
 */
export async function editFixture(
  { store, meta, run, jobs }: Pick<RouteDeps, 'store' | 'meta' | 'run' | 'jobs'>,
  { mode, fixtureId, prompt, item, focus = [], jobId }: Parsed<typeof fixturesEditBodySchema>,
) {
  const fixture = store.memory(mode).fixtures?.find((f) => f.id === fixtureId);
  if (!fixture) throw new LabError('fixture_missing', 'That fixture is gone.', 404);
  const from: IsoItem = { label: item.label, parts: item.parts };
  // Only parts the model has: a brushed part an earlier edit removed means nothing now.
  const brushed = [...new Set(focus)].filter((id) => from.parts.some((p) => p.id === id));
  const output = (edited: IsoItem, note: string): FixtureEditOutput => ({
    edited: fixture.id,
    label: fixture.label,
    prompt,
    ...(brushed.length ? { focus: brushed } : {}),
    note,
    parts: edited.parts.length,
    item: edited,
  });
  if (mode !== 'live') {
    const answer = demoEdit(from, prompt, brushed);
    if (!answer)
      throw new LabError(
        'edit_demo',
        'The demo’s AI edits only recolour: try “make the handle red”. Switch to Live for anything else.',
      );
    const note = editNote(from, answer.item, answer.note);
    const event = await run('fixture', mode, async () => ({
      output: output(answer.item, note),
      promptVersion: 'edit-demo',
    }));
    return { run: event, item: answer.item, note };
  }
  const photo = storedCloseUp(store, fixture);
  meta.mustAfford(sparkCeiling(SPARK_BUDGET.sculptEdit, photo ? 2 : 1), 'This edit');
  const job = jobs.start(jobId, EDIT_STEPS, {
    title: `Editing the ${fixture.label.toLowerCase()}`,
    mode,
  });
  return following(job, async () => {
    const event = await run('fixture', mode, async (id) => {
      job.link(id);
      const assets: string[] = [];
      job.run('current');
      const render = await viewPng(from, ISO_ELEVATION, EDIT_RENDER_PX);
      assets.push(store.asset(id, 'render-1.png', render));
      await job.done('current', partsOf(from.parts.length), render);
      job.run('edit');
      const asked = editPrompt(
        fixture.label,
        proportions(fixtureSize(fixture)),
        prompt,
        Boolean(photo),
        editorVoxels(from.parts),
        brushed,
      );
      const images = await Promise.all([...(photo ? [photo.png] : []), render].map(shown));
      const answer = await meta.sculptEdit(
        images,
        asked,
        JSON.stringify(toSculpt(from)),
        job.signal,
      );
      job.check();
      const read = await readSculpt(from.label, answer.output);
      if (!read)
        throw new LabError(
          'sculpt_empty',
          `Spark’s edit of the ${fixture.label.toLowerCase()} had no usable parts. Try again.`,
          502,
        );
      const edited = keepLocked(read, from);
      const note = editNote(from, edited, answer.output.note);
      const after = await viewPng(edited, ISO_ELEVATION, EDIT_RENDER_PX);
      assets.push(store.asset(id, 'render-2.png', after));
      await job.done('edit', note, after);
      return {
        output: output(edited, note),
        model: answer.model,
        requestId: answer.requestId,
        usage: answer.usage,
        assets,
        promptVersion: EDIT_PROMPT_VERSION,
      };
    });
    job.check();
    job.finish();
    const out = event.output as FixtureEditOutput;
    return { run: event, item: out.item, note: out.note };
  });
}
