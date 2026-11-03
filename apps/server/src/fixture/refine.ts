import {
  fixtureOutput,
  fixturesRefine3dBodySchema,
  fixtureModel,
  uniqueParts,
  buildItem,
  latheFromSplat,
  latheProportions,
  readSplat,
  scoreAgainst,
  type SavedItem,
} from '@livinglayer/domain';
import { LabError } from '../errors.js';
import { following } from '../jobs.js';
import { cropInput, keepLocked, viewPng } from '../item.js';
import { type RouteDeps } from '../route-deps.js';
import { withModel, type Parsed } from './shared.js';

/** What refining a fixture with SAM 3D shows while it runs, in order. */
const REFINE_STEPS = [
  { id: 'picture', label: 'The picture of it' },
  { id: 'reconstruct', label: 'SAM 3D reconstructs it' },
  { id: 'shape', label: 'Read its shape' },
  { id: 'check', label: 'Check it against the photo' },
  { id: 'save', label: 'Save it' },
];
/**
 * Under this outline match against its crop, SAM 3D's shape is taken to be
 * of something else. On the mug crops a right shape scores 0.6–0.85 where
 * the fitter's own scores 0.83–0.95 (it bends its shape to the outline).
 */
const REFINE_FLOOR = 0.55;

/**
 * Refine a fixture's shape with SAM 3D (experimental): its photo crop is
 * reconstructed whole, and the splat's profile, height and handle replace
 * the fit's, which measured only the side the photo shows; colours and
 * print stay the photo's. Kept unless its outline falls under REFINE_FLOOR
 * against the crop, which says SAM 3D made something else: outline overlap
 * can't judge more finely, since the fitter bends its shape to match one
 * outline (the fit bench scores shapes against real sizes instead). It
 * takes minutes, longer than a request may stay open, so it answers at
 * once and the page follows the job. Only turned bodies, for now.
 */
export async function refineFixture(
  { store, run, jobs, sam3d = null }: Pick<RouteDeps, 'store' | 'run' | 'jobs' | 'sam3d'>,
  { mode, fixtureId, jobId }: Parsed<typeof fixturesRefine3dBodySchema>,
) {
  if (!sam3d)
    throw new LabError(
      'sam3d_off',
      'SAM 3D is off: set SAM3D_ENABLED=true, with SAM3D_MLX_WEIGHTS (on this machine) or FAL_KEY (fal.ai).',
      409,
    );
  const memory = store.memory(mode);
  const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
  if (!fixture) throw new LabError('fixture_missing', 'That fixture is gone.', 404);
  const active = fixtureModel(fixture);
  const fit = active.fit;
  if (fit?.params.family !== 'lathe' || !fit.crop)
    throw new LabError(
      'refine_shape',
      `Only a turned body fitted to a photo can be refined with SAM 3D: the ${fixture.label.toLowerCase()} is ${fit ? `a ${fit.archetype}` : 'not fitted to one'}.`,
      409,
    );
  const params = fit.params;
  const png = store.readAsset(fit.crop);
  if (!png) throw new LabError('refine_picture', 'The photo its model was fitted to is gone.', 409);
  const reconstruct = sam3d;
  const job = jobs.start(jobId, REFINE_STEPS, {
    title: `Refining the ${fixture.label.toLowerCase()} with SAM 3D`,
    mode,
  });
  const work = following(job, async () => {
    const event = await run('fixture', mode, async (id) => {
      job.link(id);
      await job.done('picture', 'The photo crop its model was fitted to', png);
      job.run('reconstruct', 'SAM 3D: about 10 minutes on this machine');
      const splat = await reconstruct(png, job.signal);
      job.check();
      const assets = [store.asset(id, 'splat.ply', splat)];
      await job.done('reconstruct', `${Math.round(splat.length / 1e6)} MB splat`);
      job.run('shape');
      const shaped = latheFromSplat(readSplat(splat), params);
      const before = latheProportions(params);
      const after = latheProportions(shaped);
      await job.done(
        'shape',
        `Height over rim ${before.rim.toFixed(2)} → ${after.rim.toFixed(2)}` +
          (shaped.handle ? ', with a handle' : ''),
      );
      job.run('check');
      const input = await cropInput(png, fixture.label);
      const item = keepLocked(buildItem(fixture.label, shaped), active);
      const score = scoreAgainst(item, input, fit.elevation);
      const render = await viewPng(item, fit.elevation, input.width);
      assets.push(store.asset(id, 'render.png', render));
      const kept = score.iou >= REFINE_FLOOR;
      await job.done(
        'check',
        `${Math.round(score.iou * 100)}% outline match (was ${Math.round(fit.iou * 100)}%): ${kept ? 'kept' : 'too far from the photo, not kept'}`,
        render,
      );
      return {
        output: { kept, iou: score.iou, deltaE: score.deltaE, before, after, item, shaped },
        assets,
        usage: null,
        model: 'sam-3d-objects',
        requestId: null,
      };
    });
    job.check();
    job.run('save');
    const out = fixtureOutput.refine(event)!;
    if (!out.kept) {
      await job.done('save', 'Nothing saved: the model is as it was');
      job.finish();
      return;
    }
    const saved: SavedItem = {
      ...uniqueParts(out.item),
      source: active.source,
      segmentRunId: null,
      swatches: active.swatches,
      updatedAt: new Date().toISOString(),
      fit: {
        ...fit,
        params: out.shaped,
        iou: out.iou,
        deltaE: out.deltaE,
        assists: [...fit.assists, 'SAM 3D: profile, height and handle from a reconstruction'],
      },
    };
    const fresh = store.memory(mode);
    fresh.fixtures = withModel(fresh.fixtures ?? [], fixture, saved);
    store.saveMemory(fresh);
    await job.done('save', 'Saved its new shape');
    job.finish();
  });
  // The page follows the job; a failure is on its steps, not this request's.
  work.catch(() => {});
  return { jobId };
}
