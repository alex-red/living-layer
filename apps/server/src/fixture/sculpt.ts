import {
  fixtureOutput,
  type FixtureSculptOutput,
  fixturesSculptBodySchema,
  fixturesSculptReapplyBodySchema,
  calibrationOf,
  elevationAt,
  fixtureBox,
  type IsoItem,
  type Swatch,
  linkedFixtures,
  META_PRICES,
  sparkCeiling,
  fixtureModel,
  fixtureReference,
  fixtureSize,
  fromSculpt,
  withNewModel,
  scoreAgainst,
  sculptPrompt,
  toSculpt,
  type SavedItem,
  type DeskMemory,
  type EvidenceRun,
  type Job,
  type Fixture,
  type FixtureInput,
  type MergedFacts,
  type Usage,
  type FitInput,
  type Mode,
  addUsage,
} from '@livinglayer/domain';
import sharp from 'sharp';
import { LabError } from '../errors.js';
import { following, type JobTracker } from '../jobs.js';
import { toDataUrl } from '../images.js';
import { cropInput, keepLocked, sightingPicture, viewPng } from '../item.js';
import { type RouteDeps } from '../route-deps.js';
import { SEARCH_CEILING, SPARK_BUDGET, type MetaAdapter } from '../meta.js';
import { BUNDLED_CATALOG, Catalog, research, type Researcher } from '../research.js';
import { type EvidenceStore } from '../store.js';
import { productSize, type Parsed } from './shared.js';

/** The room picture is drawn in 2:1 isometric, so a level square shows half as deep as it is wide. */
const ISO_ELEVATION = 30;
/** What a picture with a transparent background is laid on for Spark: a neutral grey. */
const SCULPT_BACKDROP = '#8a8f9f';
/**
 * Spark's drafts of a fixture's model, asked at once and at low effort: each
 * answers in 25–55 s instead of 90–120, and the best of three matched the
 * picture about as well as one at full effort (the mouse 0.73 against 0.75, a
 * cat tower 0.39 against 0.40; a fan 0.36 against 0.57). A second look at its
 * own draft added a few points for another 45–90 s, so there is none.
 */
const SCULPT_DRAFTS = 3;
/** Under this overlap with the picture, Spark's draft is of something else, and isn't saved. */
const SCULPT_FLOOR = 0.15;
/** A picture narrower than this is a room camera's crop; Spark is shown it larger. */
const SCULPT_SMALL_PX = 128;
/** What modelling a fixture with AI shows while it runs, in order. */
const SCULPT_STEPS = [
  { id: 'picture', label: 'The picture of it' },
  { id: 'current', label: 'Its model as it is' },
  { id: 'draft', label: `Spark drafts it ${SCULPT_DRAFTS} ways` },
  { id: 'keep', label: 'Keep the best draft' },
  { id: 'save', label: 'Save it' },
];
/**
 * The fixtures with a sculpt's model saved on this one and its linked copies,
 * sized as the product it looked up: where each view keeps its size now,
 * laid along its own longer side.
 */
function withSculpt(
  fixtures: Fixture[],
  fixture: Fixture,
  out: FixtureSculptOutput,
  swatches: SavedItem['swatches'],
): Fixture[] {
  const group = new Set([fixture.id, ...linkedFixtures(fixtures, fixture).map((f) => f.id)]);
  const sized = <F extends { size?: FixtureInput['size'] }>(f: F): F => {
    const s = out.size;
    if (!s || !f.size) return f;
    const same = f.size.w >= f.size.d === s.w >= s.d;
    return { ...f, size: same ? s : { w: s.d, d: s.w, h: s.h } };
  };
  const now = new Date().toISOString();
  const saved: SavedItem = {
    ...out.item,
    source: 'spark',
    segmentRunId: null,
    swatches,
    updatedAt: now,
    fit: null,
  };
  // The same thing in its other scenes takes the same model.
  return fixtures.map((f) =>
    group.has(f.id)
      ? fixture.state
        ? {
            ...f,
            ...(f.states?.[fixture.state]?.size ? {} : sized({ size: f.size })),
            states: {
              ...f.states,
              [fixture.state]: {
                ...(f.states?.[fixture.state]?.size
                  ? sized(f.states[fixture.state]!)
                  : (f.states?.[fixture.state] ?? {})),
                model: saved,
              },
            },
            updatedAt: now,
          }
        : { ...withNewModel(sized(f), saved, now), updatedAt: now }
      : f,
  );
}
/** A past job's sculpt run, when it modelled a fixture and its model was kept. */
function sculptRunOf(job: Job | null, getRun: (id: string) => EvidenceRun | undefined) {
  for (const id of job?.runIds ?? []) {
    const run = getRun(id);
    const out = fixtureOutput.sculpt(run);
    if (run?.status === 'completed' && out?.item?.parts?.length) return { run, out };
  }
  return null;
}

/**
 * What Modelling with AI looks at: the fixture's cut-out from the room's
 * picture, or its own or a linked copy's, else the crop its model was fitted
 * to, else the room draft's crop, looked at from where the room's camera is.
 */
function sculptPicture(
  store: EvidenceStore,
  memory: DeskMemory,
  fixture: Fixture,
  sighted: { png: Buffer; elevation: number } | null,
) {
  const group = new Set([
    fixture.id,
    ...linkedFixtures(memory.fixtures ?? [], fixture).map((f) => f.id),
  ]);
  const activeModel = fixtureModel(fixture);
  const activeRef = fixtureReference(fixture);
  const activeSize = fixtureSize(fixture);
  const sprite = memory.illustration?.layers?.sprites.find((x) => group.has(x.fixtureId));
  const crop = activeModel.fit?.crop ?? fixture.model.fit?.crop;
  const camera = calibrationOf(memory)?.camera;
  const drafted = () => {
    if (!activeRef || fixture.scene !== 'custom' || !memory.scene || !camera) return null;
    const box = fixtureBox(fixture, memory.scene);
    const centre = {
      x: box.at.x + box.size.w / 2,
      y: box.at.y + box.size.d / 2,
      z: box.at.z,
    };
    return {
      png: store.readAsset(activeRef.asset),
      elevation: elevationAt(camera, centre),
    };
  };
  const pictured = sprite
    ? { png: store.readAsset(sprite.asset), elevation: ISO_ELEVATION }
    : sighted
      ? sighted
      : crop
        ? {
            png: store.readAsset(crop),
            elevation: (activeModel.fit ?? fixture.model.fit)!.elevation,
          }
        : drafted();
  if (!pictured?.png)
    throw new LabError(
      'sculpt_picture',
      fixture.place === 'sightings'
        ? `There is no picture of the ${fixture.label.toLowerCase()} to model it from: the frame it was last seen in is gone. Track it again in a new frame.`
        : `There is no picture of the ${fixture.label.toLowerCase()} to model it from. Lift the fixtures off the room’s picture, or draft it from a photo.`,
      409,
    );
  return {
    group,
    activeModel,
    activeSize,
    sprite: Boolean(sprite),
    png: pictured.png,
    elevation: pictured.elevation,
  };
}

/** Step 3 of modelling with AI: Spark drafts the parts several times, and the draft whose silhouette matches best is kept. */
async function bestSculpt(
  meta: MetaAdapter,
  job: JobTracker,
  {
    label,
    baseLabel,
    picture,
    current,
    prompt,
    from,
    input,
    elevation,
  }: {
    label: string;
    baseLabel: string;
    picture: string;
    current: string;
    prompt: string;
    from: IsoItem;
    input: FitInput;
    elevation: number;
  },
) {
  let usage: Usage | null = null;
  let model: string | undefined;
  let requestId: string | null = null;
  const answers = await Promise.allSettled(
    Array.from({ length: SCULPT_DRAFTS }, () =>
      meta.sculpt(picture, current, prompt, JSON.stringify(toSculpt(from)), job.signal, 12, 'low'),
    ),
  );
  job.check();
  const drafts: { item: IsoItem; iou: number; note: string }[] = [];
  for (const answer of answers) {
    if (answer.status !== 'fulfilled') continue;
    usage = addUsage(usage, answer.value.usage);
    model = answer.value.model;
    requestId = answer.value.requestId;
    const item = fromSculpt(baseLabel, answer.value.output);
    if (item)
      drafts.push({
        item,
        iou: scoreAgainst(item, input, elevation).iou,
        note: answer.value.output.note,
      });
  }
  const best = drafts.sort((a, b) => b.iou - a.iou)[0];
  if (!best) {
    const failed = answers.find((a) => a.status === 'rejected');
    if (failed) throw failed.reason;
    throw new LabError(
      'sculpt_empty',
      `Spark’s model of the ${label.toLowerCase()} had no usable parts. Try again.`,
      502,
    );
  }
  return { best, drafts, usage, model, requestId };
}

type SculptDeps = Pick<RouteDeps, 'store' | 'meta' | 'run' | 'jobs' | 'productsDir'>;
type Tiles = { w: number; d: number; h: number };
type SculptPicture = ReturnType<typeof sculptPicture>;
type SculptBest = Awaited<ReturnType<typeof bestSculpt>>;
type SculptLooked = Promise<
  { found: Awaited<ReturnType<typeof research>>; failed: null } | { found: null; failed: string }
>;

/** What one Modelling run knows and has gathered so far; the steps read and add to it. */
interface SculptRun {
  store: EvidenceStore;
  meta: MetaAdapter;
  job: JobTracker;
  id: string;
  fixture: Fixture;
  note: string | undefined;
  picture: SculptPicture;
  input: Awaited<ReturnType<typeof cropInput>>;
  greyscale: boolean;
  small: boolean;
  /** The picture, or a render, as Spark sees it. */
  shown: (b: Buffer, enlarge?: boolean) => Promise<string>;
  assets: string[];
  catalog: Catalog;
  web: Researcher;
  need: readonly ['parts', 'colors'];
  usage: Usage | null;
  facts: MergedFacts | null;
  /** The product's size in tiles, once a lookup gives it. */
  productTiles: Tiles | null;
  /** The proportions Spark is asked for. */
  size: Tiles;
}

const overlap = (iou: number) => `${Math.round(iou * 100)}% overlap with the picture`;
const partsOf = (n: number) => `${n} part${n === 1 ? '' : 's'}`;

/** A size as proportions of its longest side. */
function proportions(s: Tiles): Tiles {
  const longest = Math.max(s.w, s.d);
  return { w: s.w / longest, d: s.d / longest, h: s.h / longest };
}

/** How the picture is looked at: its crop, its colours, and how it is shown to Spark. */
async function sculptLook(png: Buffer, label: string) {
  const input = await cropInput(png, label);
  const greyscale = await isGreyscale(png);
  const { width = 0, height = 0 } = await sharp(png).metadata();
  const small = Math.max(width, height) < SCULPT_SMALL_PX;
  // A room camera's crop is shown at least 3× larger, so Spark doesn't read it as a speck.
  const shown = async (b: Buffer, enlarge = false) => {
    let image = sharp(b).flatten({ background: SCULPT_BACKDROP });
    if (enlarge && small)
      image = image.resize({
        width: Math.max(1, width) * Math.ceil((SCULPT_SMALL_PX * 3) / Math.max(width, height)),
        kernel: 'lanczos3',
      });
    return toDataUrl(await image.png().toBuffer());
  };
  return { input, greyscale, small, shown };
}

/** The steps a sculpt shows: with a note, a lookup comes after the picture. */
function sculptStepList(note: string | undefined) {
  return note
    ? [SCULPT_STEPS[0]!, { id: 'lookup', label: 'Look it up' }, ...SCULPT_STEPS.slice(1)]
    : SCULPT_STEPS;
}

/**
 * Step "lookup": what the catalog knows about the note goes into Spark's prompt at once.
 * The web is asked alongside the drafts, not before them (it took 48 s); what it finds sizes
 * the saved model and is kept, so the same thing next time comes from the catalog.
 */
async function sculptLookup(
  r: SculptRun,
  activeSize: Tiles,
): Promise<{ looked: SculptLooked } | null> {
  const { note, job, catalog, web, need } = r;
  if (!note) return null;
  job.run('lookup');
  const known = await research(note, need, [catalog], { signal: job.signal }).catch(() => null);
  r.facts = known?.facts.sources.length ? known.facts : null;
  const real = r.facts && productSize(r.facts, activeSize);
  if (real) {
    r.productTiles = real;
    r.size = proportions(real);
  }
  // The lookup only helps: when it fails, Spark models from the note and the picture.
  // Wrapped, so the async function doesn't wait for it: the drafts are asked meanwhile.
  const looked = research(note, need, [catalog, web], { signal: job.signal }).then(
    (found) => ({ found, failed: null }),
    (e: unknown) => ({ found: null, failed: e instanceof Error ? e.message : 'It failed.' }),
  );
  return { looked };
}

/** Step "current": the fixture's own model, rendered the way the picture is looked at. */
async function sculptCurrent(r: SculptRun, activeModel: ReturnType<typeof fixtureModel>) {
  const { job, store, id, input } = r;
  const { elevation } = r.picture;
  const from: IsoItem = { label: activeModel.label, parts: activeModel.parts };
  job.run('current');
  const render = await viewPng(from, elevation, input.width);
  r.assets.push(store.asset(id, 'render-1.png', render));
  await job.done(
    'current',
    `${partsOf(from.parts.length)}, ${overlap(scoreAgainst(from, input, elevation).iou)}`,
    render,
  );
  return { from, render };
}

/** Step "draft": Spark's drafts against the picture; the best must still look like it. */
async function sculptDraft(
  r: SculptRun,
  activeModel: ReturnType<typeof fixtureModel>,
  { from, render }: { from: IsoItem; render: Buffer },
) {
  const { job, store, meta, id, input, fixture } = r;
  const { elevation, png } = r.picture;
  job.run('draft');
  const [picture, current] = await Promise.all([r.shown(png, true), r.shown(render)]);
  const prompt = sculptPrompt(fixture.label, r.size, {
    note: r.note ?? null,
    facts: r.facts,
    greyscale: r.greyscale,
    small: r.small,
  });
  const asked = await bestSculpt(meta, job, {
    label: fixture.label,
    baseLabel: activeModel.label,
    picture,
    current,
    prompt,
    from,
    input,
    elevation,
  });
  const { best, drafts } = asked;
  r.usage = addUsage(r.usage, asked.usage);
  const drafted = await viewPng(best.item, elevation, input.width);
  r.assets.push(store.asset(id, 'render-2.png', drafted));
  await job.done(
    'draft',
    `${partsOf(best.item.parts.length)}, ${overlap(best.iou)}, the best of ${drafts.length}. ${best.note}`,
    drafted,
  );
  if (best.iou < SCULPT_FLOOR)
    throw new LabError(
      'sculpt_miss',
      `Spark’s best model of the ${fixture.label.toLowerCase()} overlaps the picture by ${Math.round(best.iou * 100)}%, so it is something else; its model is kept as it was. Say what it is and try again.`,
      502,
    );
  return asked;
}

/** The web lookup, once the drafts are in: what it found is kept and may size the model. */
async function sculptFinishLookup(r: SculptRun, looked: SculptLooked, activeSize: Tiles) {
  const { job, note, catalog } = r;
  const { found, failed } = await looked;
  job.check();
  const product = found?.facts.sources.length ? found.facts : null;
  if (note && (product?.origin.name === 'web' || product?.origin.size === 'web'))
    try {
      catalog.save({ ...product, query: note });
    } catch {
      /* keeping it is a convenience; the model doesn't depend on it */
    }
  r.facts = product ?? r.facts;
  const real = r.facts && productSize(r.facts, activeSize);
  if (real) r.productTiles = real;
  await job.done(
    'lookup',
    product && found
      ? `${product.name ?? 'Found it'} (${found.asked.map((a) => `${a.kind}${a.found ? ' ✓' : ' –'}`).join(' · ')})`
      : failed
        ? `Couldn’t look it up (${failed}); modelled from your note and the picture`
        : 'Nothing found; modelled from your note and the picture',
  );
}

/** Step "keep": the best draft with any parts the person locked. */
async function sculptKeep(
  r: SculptRun,
  activeModel: ReturnType<typeof fixtureModel>,
  { best, drafts }: SculptBest,
) {
  const { job, store, id, input } = r;
  job.run('keep');
  const item = keepLocked(best.item, activeModel);
  const final = await viewPng(item, r.picture.elevation, input.width);
  r.assets.push(store.asset(id, 'render-final.png', final));
  const kept = item.parts.length - best.item.parts.length;
  await job.done(
    'keep',
    `The best of ${drafts.length} drafts, ${overlap(best.iou)}` +
      (kept > 0 ? `, with ${partsOf(kept)} you locked` : ''),
    final,
  );
  return item;
}

type SculptStart = Pick<
  SculptRun,
  | 'store'
  | 'meta'
  | 'job'
  | 'id'
  | 'fixture'
  | 'note'
  | 'picture'
  | 'input'
  | 'greyscale'
  | 'small'
  | 'shown'
> & { productsDir: string };

/** The run's starting state: nothing gathered, the fixture's own proportions, the catalog and the web to ask. */
function newSculptRun({ productsDir, ...start }: SculptStart): SculptRun {
  const { meta, job } = start;
  const r: SculptRun = {
    ...start,
    assets: [],
    catalog: new Catalog([productsDir, BUNDLED_CATALOG]),
    web: {
      kind: 'web',
      lookup: async (q, need) => {
        const found = await meta.lookupProduct(q, need, job.signal);
        r.usage = addUsage(r.usage, found.usage);
        return found.output.facts;
      },
    },
    need: ['parts', 'colors'],
    usage: null,
    facts: null,
    productTiles: null,
    // Its proportions: the fixture's, until a lookup gives the product's own.
    size: proportions(start.picture.activeSize),
  };
  return r;
}

/** The sculpt as one recorded run. */
async function sculptSteps(
  r: SculptRun,
  activeModel: ReturnType<typeof fixtureModel>,
  activeSize: Tiles,
) {
  const { job, store, id, fixture, note, picture } = r;
  job.link(id);
  r.assets.push(store.asset(id, 'picture.png', picture.png));
  await job.done(
    'picture',
    picture.sprite
      ? 'Its cut-out from the room’s picture'
      : 'The photo crop its model was fitted to',
    picture.png,
  );
  const looked = await sculptLookup(r, activeSize);
  const current = await sculptCurrent(r, activeModel);
  const asked = await sculptDraft(r, activeModel, current);
  if (looked) await sculptFinishLookup(r, looked.looked, activeSize);
  const item = await sculptKeep(r, activeModel, asked);
  const { best } = asked;
  return {
    output: {
      sculpted: fixture.id,
      label: fixture.label,
      parts: item.parts.length,
      iou: best.iou,
      note: best.note,
      item,
      ...(note ? { asked: note, product: r.facts?.name ?? null } : {}),
      // The product's size in tiles, laid as this fixture stands; the save gives it the fixture.
      ...(r.productTiles ? { size: r.productTiles } : {}),
      greyscale: r.greyscale,
    },
    model: asked.model,
    requestId: asked.requestId,
    usage: r.usage,
    assets: r.assets,
  };
}

/** The sculpted model replaces the fixture's (and its linked copies'). */
async function sculptSave(
  store: EvidenceStore,
  mode: Mode,
  job: JobTracker,
  fixture: Fixture,
  out: NonNullable<ReturnType<typeof fixtureOutput.sculpt>>,
  group: Set<string>,
  swatches: Swatch[],
) {
  const fresh = store.memory(mode);
  fresh.fixtures = withSculpt(fresh.fixtures ?? [], fixture, out, swatches);
  store.saveMemory(fresh);
  await job.done(
    'save',
    `Saved${group.size > 1 ? ` here and in ${group.size - 1} linked view${group.size > 2 ? 's' : ''}` : ''}` +
      (out.size
        ? `, sized as the product: ${[out.size.w, out.size.d, out.size.h].map((t) => Math.round(t * 30)).join(' × ')} cm`
        : ''),
  );
  return fresh;
}

/**
 * Model a fixture in our own parts with Spark, starting from its current
 * model and the picture of it: its cut-out from the room's picture when it
 * was lifted, else the crop its model was fitted to, else the crop of it a
 * room draft kept (seen from the room's camera). Spark revises the parts
 * against a render of the model (one call), then once more against a render
 * of its own draft (a second), and the draft whose silhouette matches the
 * picture better is kept, with any parts the person locked. Live only.
 */
export async function sculptFixture(
  { store, meta, run, jobs, productsDir }: SculptDeps,
  { mode, fixtureId, jobId, note }: Parsed<typeof fixturesSculptBodySchema>,
) {
  if (mode !== 'live')
    throw new LabError(
      'sculpt_demo',
      'Modelling with AI asks Spark, so it runs in Live mode. The demo’s fixtures keep their fitted models.',
    );
  const memory = store.memory(mode);
  const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
  if (!fixture) throw new LabError('fixture_missing', 'That fixture is gone.', 404);
  // A thing the camera follows is modelled from its last sighting, cut out by its mask.
  const sighting = fixture.place === 'sightings' ? fixture.track?.observation : undefined;
  const sighted = sighting ? await sightingPicture(store, mode, memory, sighting) : null;
  const picture = sculptPicture(store, memory, fixture, sighted);
  const { group, activeModel, activeSize } = picture;
  // A note is looked up as a product first: the catalog, then the web.
  const ceiling =
    SCULPT_DRAFTS * sparkCeiling(SPARK_BUDGET.sculpt, 2) +
    (note
      ? sparkCeiling(SPARK_BUDGET.productLookup, 0) + SEARCH_CEILING * META_PRICES.webSearchPerQuery
      : 0);
  meta.mustAfford(ceiling, 'Modelling it');
  const look = await sculptLook(picture.png, fixture.label);
  const job = jobs.start(jobId, sculptStepList(note), {
    title: `Modelling the ${fixture.label.toLowerCase()}`,
    mode,
  });
  // A failure shows on the step that was running; the run records it too.
  return following(job, async () => {
    const event = await run('fixture', mode, (id) =>
      sculptSteps(
        newSculptRun({ ...look, store, meta, job, id, fixture, note, picture, productsDir }),
        activeModel,
        activeSize,
      ),
    );
    // Stopped while the last step ran: nothing is saved.
    job.check();
    const out = fixtureOutput.sculpt(event)!;
    const fresh = await sculptSave(store, mode, job, fixture, out, group, activeModel.swatches);
    job.finish();
    return { memory: fresh, run: event };
  });
}

/** Whether a picture has no colour to speak of: a night or infrared camera's. */
async function isGreyscale(png: Buffer): Promise<boolean> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let spread = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3]! < 128) continue;
    spread +=
      Math.max(data[i]!, data[i + 1]!, data[i + 2]!) -
      Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
    n++;
  }
  return n > 0 && spread / n < 8;
}

/**
 * Put a past modelling job's model back on its fixture, as it saved it then,
 * with no model call: the model it replaces is kept as an earlier draft.
 */
export async function reapplySculpt(
  { store, jobs }: Pick<RouteDeps, 'store' | 'jobs'>,
  { mode, jobId }: Parsed<typeof fixturesSculptReapplyBodySchema>,
) {
  const found = sculptRunOf(jobs.get(jobId), (id) => store.getRun(id));
  if (!found || found.run.mode !== mode)
    throw new LabError('reapply_missing', 'That AI run has no model to apply again.', 404);
  const memory = store.memory(mode);
  const fixture = memory.fixtures?.find((f) => f.id === found.out.sculpted);
  if (!fixture) throw new LabError('fixture_missing', 'That fixture is gone.', 404);
  memory.fixtures = withSculpt(
    memory.fixtures ?? [],
    fixture,
    found.out,
    fixtureModel(fixture).swatches,
  );
  store.saveMemory(memory);
  return { memory, fixtureId: fixture.id, label: fixture.label };
}
