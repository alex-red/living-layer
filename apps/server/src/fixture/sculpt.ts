import {
  archetypeOf,
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
  sculptPrints,
  SCULPT_PROMPT_VERSION,
  type Sculpt,
  isFragmented,
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
import {
  detectionBits,
  maskedCrop,
  toDataUrl,
  validateImage,
  type ValidatedImage,
} from '../images.js';
import { cropInput, keepLocked, sightingPicture, viewPng } from '../item.js';
import { type RouteDeps } from '../route-deps.js';
import { SEARCH_CEILING, SPARK_BUDGET, type MetaAdapter } from '../meta.js';
import { BUNDLED_CATALOG, Catalog, research, type Researcher } from '../research.js';
import { type EvidenceStore } from '../store.js';
import { inkPrints } from '../print-ink.js';
import { fitItemAsync } from '../workers/compute.js';
import { productSize, type Parsed } from './shared.js';

/** What a sighting's picture says about how it was cut out. */
const SIGHTING_CUT = {
  mask: 'Its last sighting, cut out by its outline',
  sam: 'Its last sighting, cut out by SAM: its outline was only the box drawn round it',
  box: 'Its last sighting, with what is round it: SAM couldn’t cut it out',
  samBroken: 'Its last sighting, cut out by SAM: its outline had fallen apart',
  boxBroken:
    'Its last sighting, with what is round it: its outline had fallen apart and SAM couldn’t cut it out',
} as const;
type SightingCut = keyof typeof SIGHTING_CUT;
/** Over this share of its box, a sighting's mask is the box drawn round it, not its outline. */
const BOX_ONLY = 0.9;
/** A crop's mask: 1 where it keeps the pixel. */
function maskBits(rgba: Buffer) {
  const bits = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < bits.length; i++) bits[i] = rgba[i * 4 + 3]! > 127 ? 1 : 0;
  return bits;
}
/** The crop's whole box, what is round the thing too. */
function wholeBox(crop: { rgba: Buffer; width: number; height: number }) {
  const rgba = Buffer.from(crop.rgba);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return sharp(rgba, { raw: { width: crop.width, height: crop.height, channels: 4 } })
    .png()
    .toBuffer();
}
/**
 * A sighting outlined on this machine can be only the box drawn round it,
 * desk and all. SAM cuts the thing out of that crop (one call), so Spark sees
 * it alone. Null when SAM finds nothing, or only the whole box again.
 */
async function cutOut(
  meta: MetaAdapter,
  crop: { png: Buffer; rgba: Buffer; width: number; height: number },
  concept: string,
): Promise<Buffer | null> {
  const { width, height } = crop;
  const found = await meta.segment(toDataUrl(crop.png), concept, width, height);
  const best = [...found.output.detections].sort(
    (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0),
  )[0];
  const bits = best ? await detectionBits([best], width, height) : null;
  if (!bits) return null;
  const share = bits.reduce((n, b) => n + b, 0) / bits.length;
  // The thing may be a small part of a box drawn round it, but not in pieces.
  if (share > BOX_ONLY || isFragmented(bits, width, height, 0.05)) return null;
  const rgba = Buffer.from(crop.rgba);
  for (let i = 0; i < bits.length; i++) rgba[i * 4 + 3] = bits[i] ? 255 : 0;
  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * A close photo the person sent with the request, cut out by SAM (one call)
 * and looked at from its own camera's angle, which the fitter reads off it
 * as it does a photo's. Refused when SAM finds it nowhere or only in pieces.
 */
async function photoCut(
  meta: MetaAdapter,
  photo: ValidatedImage,
  concept: string,
  archetype: ReturnType<typeof archetypeOf>,
) {
  const found = await meta.segment(photo.dataUrl, concept, photo.width, photo.height);
  const best = [...found.output.detections].sort(
    (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0),
  )[0];
  const crop = best ? await maskedCrop(photo.bytes, best) : null;
  if (!crop || isFragmented(maskBits(crop.rgba), crop.width, crop.height))
    throw new LabError(
      'sculpt_photo',
      `Couldn’t cut the ${concept.toLowerCase()} out of the photo. Fill most of the frame with it, against something plain.`,
      422,
    );
  const fitted = await fitItemAsync({
    rgba: crop.rgba,
    width: crop.width,
    height: crop.height,
    label: concept,
    archetype,
  });
  return {
    png: crop.png,
    elevation: fitted.elevation,
    said: 'The close photo you sent, cut out by SAM',
  };
}

/**
 * The close photo its model was last fitted to, when another photo of it was
 * (POST /api/fixtures/photo): its crop, at that photo's own angle.
 */
function storedCloseUp(store: EvidenceStore, fixture: Fixture) {
  const fit = fixtureModel(fixture).fit ?? fixture.model.fit;
  if (!fit?.crop || !fixtureOutput.fuse(store.getRun(fit.crop.split('/')[0]!))) return null;
  const png = store.readAsset(fit.crop);
  return png
    ? { png, elevation: fit.elevation, said: 'The close photo its model was fitted to' }
    : null;
}

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
 * What Modelling with AI looks at: a close photo sent with the request, else
 * the close photo its model was last fitted to, else the fixture's cut-out
 * from the room's picture, or its own or a linked copy's, else its last
 * sighting, else the crop its model was fitted to, else the room draft's
 * crop, looked at from where the room's camera is. A close photo comes first:
 * across a room a mug is a few dozen pixels, too few to model it from.
 */
function sculptPicture(
  store: EvidenceStore,
  memory: DeskMemory,
  fixture: Fixture,
  sighted: { png: Buffer; elevation: number; cut: SightingCut } | null,
  close: { png: Buffer; elevation: number; said: string } | null,
) {
  const group = new Set([
    fixture.id,
    ...linkedFixtures(memory.fixtures ?? [], fixture).map((f) => f.id),
  ]);
  const activeModel = fixtureModel(fixture);
  const activeRef = fixtureReference(fixture);
  const activeSize = fixtureSize(fixture);
  const sprite = memory.illustration?.layers?.sprites.find((x) => group.has(x.fixtureId));
  const fit = activeModel.fit ?? fixture.model.fit;
  const crop = fit?.crop;
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
      said: 'The crop of it the room’s draft kept',
    };
  };
  const pictured =
    close ??
    (sprite
      ? {
          png: store.readAsset(sprite.asset),
          elevation: ISO_ELEVATION,
          said: 'Its cut-out from the room’s picture',
        }
      : sighted
        ? { ...sighted, said: SIGHTING_CUT[sighted.cut] }
        : crop
          ? {
              png: store.readAsset(crop),
              elevation: fit!.elevation,
              said: 'The photo crop its model was fitted to',
            }
          : drafted());
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
    /** What the picture is, as its step says. */
    said: pictured.said,
    png: pictured.png,
    elevation: pictured.elevation,
  };
}

/**
 * One of Spark's sculpt answers as our model: its prints set in type, then
 * read by `fromSculpt`. The route and `bun run sculpt <run>` both read answers
 * this way, so a replay reads them as the route would now.
 */
export async function readSculpt(baseLabel: string, answer: Sculpt): Promise<IsoItem | null> {
  return fromSculpt(baseLabel, answer, await inkPrints(sculptPrints(answer)));
}
/** What a sculpt run keeps of Spark's answers (`answers.json`), so they can be read again offline. */
export interface SculptAnswers {
  promptVersion: string;
  prompt: string;
  /** The model Spark started from, as it was shown it. */
  from: ReturnType<typeof toSculpt>;
  elevation: number;
  baseLabel: string;
  answers: { answer: Sculpt; iou: number | null }[];
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
  const drafts: { item: IsoItem; iou: number; note: string; answer: number }[] = [];
  const kept: SculptAnswers['answers'] = [];
  for (const answer of answers) {
    if (answer.status !== 'fulfilled') continue;
    usage = addUsage(usage, answer.value.usage);
    model = answer.value.model;
    requestId = answer.value.requestId;
    const output = answer.value.output;
    const item = await readSculpt(baseLabel, output);
    const iou = item ? scoreAgainst(item, input, elevation).iou : null;
    kept.push({ answer: output, iou });
    if (item && iou !== null)
      drafts.push({ item, iou, note: output.note, answer: kept.length - 1 });
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
  return { best, drafts, answers: kept, usage, model, requestId };
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
  // Every answer, as Spark gave it, so `bun run sculpt <run>` can read them again with a later tree.
  const kept: SculptAnswers = {
    promptVersion: SCULPT_PROMPT_VERSION,
    prompt,
    from: toSculpt(from),
    elevation,
    baseLabel: activeModel.label,
    answers: asked.answers,
  };
  r.assets.push(store.asset(id, 'answers.json', Buffer.from(JSON.stringify(kept, null, 1))));
  for (const d of drafts)
    r.assets.push(
      store.asset(id, `draft-${d.answer + 1}.png`, await viewPng(d.item, elevation, input.width)),
    );
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
  await job.done('picture', picture.said, picture.png);
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
    promptVersion: SCULPT_PROMPT_VERSION,
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
 * model and the picture of it: a close photo sent with the request or one its
 * model was fitted to, else its cut-out from the room's picture when it was
 * lifted, else its last sighting, else the crop its model was fitted to, else
 * the crop of it a room draft kept (seen from the room's camera). Spark revises the parts
 * against a render of the model (one call), then once more against a render
 * of its own draft (a second), and the draft whose silhouette matches the
 * picture better is kept, with any parts the person locked. Live only.
 */
export async function sculptFixture(
  { store, meta, run, jobs, productsDir }: SculptDeps,
  { mode, fixtureId, jobId, note, imageDataUrl }: Parsed<typeof fixturesSculptBodySchema>,
) {
  if (mode !== 'live')
    throw new LabError(
      'sculpt_demo',
      'Modelling with AI asks Spark, so it runs in Live mode. The demo’s fixtures keep their fitted models.',
    );
  const memory = store.memory(mode);
  const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
  if (!fixture) throw new LabError('fixture_missing', 'That fixture is gone.', 404);
  const photo = imageDataUrl ? await validateImage(imageDataUrl) : null;
  const stored = photo ? null : storedCloseUp(store, fixture);
  // A thing the camera follows is modelled from its last sighting, cut out by its mask,
  // unless there is a close photo of it.
  const sighting =
    !photo && !stored && fixture.place === 'sightings' ? fixture.track?.observation : undefined;
  const crop = sighting ? await sightingPicture(store, mode, memory, sighting) : null;
  const bits = crop ? maskBits(crop.rgba) : null;
  // A mask that is only the box drawn round it, or that fell apart into pieces, is cut out
  // by SAM first: one call more.
  const boxed = crop && bits && bits.reduce((n, b) => n + b, 0) / bits.length > BOX_ONLY;
  const broken = crop && bits && !boxed && isFragmented(bits, crop.width, crop.height);
  // A note is looked up as a product first: the catalog, then the web.
  const ceiling =
    SCULPT_DRAFTS * sparkCeiling(SPARK_BUDGET.sculpt, 2) +
    (note
      ? sparkCeiling(SPARK_BUDGET.productLookup, 0) + SEARCH_CEILING * META_PRICES.webSearchPerQuery
      : 0) +
    (boxed || broken || photo ? META_PRICES.samPerImage : 0);
  meta.mustAfford(ceiling, 'Modelling it');
  const concept = fixture.track?.concept ?? fixture.label;
  const sent = photo
    ? await photoCut(
        meta,
        photo,
        concept,
        fixtureModel(fixture).fit?.archetype ?? archetypeOf(fixture.label),
      )
    : null;
  const cut = crop && (boxed || broken) ? await cutOut(meta, crop, concept) : null;
  const how: SightingCut = cut
    ? broken
      ? 'samBroken'
      : 'sam'
    : broken
      ? 'boxBroken'
      : boxed
        ? 'box'
        : 'mask';
  const sighted = crop && {
    // A broken mask falls back to the whole box: what is round it, but all of the thing.
    png: cut ?? (broken ? await wholeBox(crop) : crop.png),
    elevation: crop.elevation,
    cut: how,
  };
  const picture = sculptPicture(store, memory, fixture, sighted, sent ?? stored);
  const { group, activeModel, activeSize } = picture;
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
