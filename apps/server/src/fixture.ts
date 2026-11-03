import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import {
  runOutput,
  fixtureOutput,
  type FixtureSculptOutput,
  fixturesChooseBodySchema,
  fixturesControlBodySchema,
  fixturesDeleteBodySchema,
  fixturesAnchorBodySchema,
  modeIdSchema,
  fixturesDraftBodySchema,
  fixturesFindBodySchema,
  fixturesPhotoBodySchema,
  fixturesReferenceQuerySchema,
  fixturesRefine3dBodySchema,
  fixturesReleaseBodySchema,
  fixturesSaveBodySchema,
  fixturesScanBodySchema,
  fixturesSculptBodySchema,
  fixturesSculptReapplyBodySchema,
  fixturesStateBodySchema,
  fixturesUndismissBodySchema,
  DEMO_REFERENCES,
  DEMO_SURFACE,
  calibrationOf,
  elevationAt,
  fixtureBox,
  demoSourceKey,
  fixtureInFrame,
  layoutThings,
  mapScan,
  withLayoutMoves,
  isDismissed,
  MAX_DISMISSED,
  outlineOf,
  type IsoItem,
  type ItemFitRecord,
  type Outline,
  type Swatch,
  fixtureGroup,
  linkedFixtures,
  pinFits,
  type FixtureScan,
  type MappedThing,
  META_PRICES,
  MAX_FIXTURES,
  promptBox,
  sparkCeiling,
  sizeInTiles,
  defaultFixtureStates,
  fixtureEntity,
  fixtureEntities,
  lightSources,
  fixtureModel,
  fixtureProblem,
  fixtureReference,
  fixtureSize,
  monitorItem,
  uniqueParts,
  fromSculpt,
  MAX_DRAFTS,
  modelOrigin,
  withNewModel,
  buildItem,
  latheFromSplat,
  latheProportions,
  readSplat,
  fuseFits,
  scoreAgainst,
  sculptPrompt,
  toSculpt,
  type SavedItem,
  type DeskMemory,
  type EvidenceRun,
  type Job,
  type Detection,
  type Fixture,
  type FixtureInput,
  type FixtureClass,
  type FixtureDraft,
  type FixtureState,
  type LampResult,
  type Segmentation,
  type MergedFacts,
  type ProductFacts,
  type Usage,
  type FitInput,
  type Mode,
  type IsoSceneKind,
  withoutThings,
  addUsage,
} from '@livinglayer/domain';
import { LabError, liveImage, modeImage, parseInput } from './errors.js';
import { following, type JobTracker } from './jobs.js';
import { listedPreview, outlinedPreview, placedPreview } from './scan-preview.js';
import sharp from 'sharp';
import {
  demoDeskThing,
  demoMugCloseUp,
  demoFixtureClass,
  demoFixtureScan,
  demoPhotoSegmentation,
  demoReference,
} from './demo.js';
import { maskedCrop, samDataUrl, toDataUrl, validateImage, type ValidatedImage } from './images.js';
import {
  cropInput,
  demoPhoto,
  draftModel,
  keepLocked,
  pinElevation,
  rescore,
  viewPng,
} from './item.js';
import type { RouteDeps } from './route-deps.js';
import { SEARCH_CEILING, SPARK_BUDGET, type MetaAdapter } from './meta.js';
import { BUNDLED_CATALOG, Catalog, research, type Researcher } from './research.js';
import type { EvidenceStore } from './store.js';

/** The room picture is drawn in 2:1 isometric, so a level square shows half as deep as it is wide. */
const ISO_ELEVATION = 30;
/** What a picture with a transparent background is laid on for Spark: a neutral grey. */
const SCULPT_BACKDROP = '#8a8f9f';
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
/** A scan's steps, as the page follows them. */
const SCAN_STEPS = [
  { id: 'photo', label: 'Send the photo' },
  { id: 'list', label: 'Spark lists what stays put' },
  { id: 'outline', label: 'SAM outlines each one' },
  { id: 'model', label: 'Fit a model to each outline' },
  { id: 'map', label: 'Place them through the pin' },
  { id: 'save', label: 'Save the fixtures' },
];
/** How wide a scan step's picture is kept, so it reads in the dialog. */
const SCAN_PREVIEW = 640;
/** What a scan did, in a line: moved, added and skipped. */
function mappedSummary(mapped: MappedThing[]): string {
  const moved = mapped.filter((m) => m.moveTo || m.moveBy).length;
  const added = mapped.filter((m) => m.fixture).length;
  const kept = mapped.filter((m) => m.match === 'existing' && !m.moveTo && !m.moveBy).length;
  const skipped = mapped.length - moved - added - kept;
  const parts = [
    added && `${added} added`,
    moved && `${moved} moved`,
    kept && `${kept} left where you put ${kept === 1 ? 'it' : 'them'}`,
    skipped && `${skipped} skipped`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Nothing to place';
}
/**
 * The fixtures with a new model for this one and its linked copies in other
 * scenes: their current state's model when it has states, else their own,
 * the one it replaces kept as an earlier draft.
 */
function withModel(fixtures: Fixture[], fixture: Fixture, model: SavedItem): Fixture[] {
  const group = new Set([fixture.id, ...linkedFixtures(fixtures, fixture).map((f) => f.id)]);
  const now = new Date().toISOString();
  return fixtures.map((f) => {
    if (!group.has(f.id)) return f;
    if (!fixture.state) return { ...withNewModel(f, model, now), updatedAt: now };
    const state = fixture.state;
    return {
      ...f,
      states: { ...f.states, [state]: { ...f.states?.[state], model } },
      updatedAt: now,
    };
  });
}
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
 * The most a live draft can cost: Spark names the thing, SAM outlines it,
 * SAM looks for up to two parts, and Spark checks one render.
 */
const fixtureDraftCeiling = () =>
  sparkCeiling(SPARK_BUDGET.fixtureClass, 1) +
  3 * META_PRICES.samPerImage +
  sparkCeiling(SPARK_BUDGET.itemCheck, 2);

/** The part of a photo around a box, with a margin, for Spark and for review. */
export async function around(
  png: Buffer,
  box: { left: number; top: number; right: number; bottom: number },
): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(png).metadata();
  const mx = Math.round((box.right - box.left) * 0.15);
  const my = Math.round((box.bottom - box.top) * 0.15);
  const left = Math.max(0, box.left - mx);
  const top = Math.max(0, box.top - my);
  return sharp(png)
    .extract({
      left,
      top,
      width: Math.min(width, box.right + mx) - left,
      height: Math.min(height, box.bottom + my) - top,
    })
    .png()
    .toBuffer();
}

/**
 * The photo a drafted room's pin was set on: the one it was drafted from, or
 * for rooms saved before that photo was kept, the one its picture was drawn
 * from. Null for preset rooms, whose photos aren't kept.
 */
export function roomPhotoBytes(memory: DeskMemory, store: EvidenceStore): Buffer | null {
  if (memory.surface?.scene !== 'custom') return null;
  const drawn = memory.illustration?.asset.split('/')[0];
  for (const asset of [
    memory.scenePhoto,
    drawn && `${drawn}/source.webp`,
    drawn && `${drawn}/source.png`,
  ]) {
    const bytes = asset ? store.readAsset(asset) : null;
    if (bytes) return bytes;
  }
  return null;
}
/** The room's photo as a data URL, for scanning the room when no newer photo is sent. */
async function roomPhoto(memory: DeskMemory, store: EvidenceStore): Promise<string | undefined> {
  const bytes = roomPhotoBytes(memory, store);
  // A saved PNG can be large; Spark needs no more than a good JPEG.
  return bytes ? toDataUrl(await sharp(bytes).jpeg({ quality: 90 }).toBuffer()) : undefined;
}

/**
 * Each scanned thing's outline, by its place in the scan: SAM from Spark's
 * boxes live (one call), or the demo render's own outlines,
 * matched by how much they overlap the box. Null where nothing was outlined.
 */
async function outlinedThings(
  { meta, store }: { meta: MetaAdapter; store: EvidenceStore },
  scan: FixtureScan,
  frame: { width: number; height: number },
  dataUrl: string | null,
  runId: string,
  assets: string[],
  signal?: AbortSignal,
): Promise<(Detection | null)[]> {
  const boxes = scan.things.map((t) => promptBox(t, frame));
  let detections: Detection[];
  if (dataUrl) {
    const prompts = boxes.flatMap((box, i) => (box ? [{ id: i + 1, box }] : []));
    if (!prompts.length) return scan.things.map(() => null);
    const outlined = await meta.segmentBoxes(dataUrl, prompts, frame.width, frame.height, signal);
    assets.push(store.asset(runId, 'sam-output.txt', outlined.raw));
    detections = outlined.output.detections;
    return boxes.map((_, i) => pickLargest(detections.filter((d) => d.objectId === String(i + 1))));
  }
  detections = (await demoPhotoSegmentation()).detections;
  return boxes.map((box) => {
    if (!box) return null;
    const overlap = (d: Detection) => {
      const w = Math.min(box.right, d.box.x + d.box.width) - Math.max(box.left, d.box.x);
      const h = Math.min(box.bottom, d.box.y + d.box.height) - Math.max(box.top, d.box.y);
      const inter = Math.max(0, w) * Math.max(0, h);
      const union =
        (box.right - box.left) * (box.bottom - box.top) + d.box.width * d.box.height - inter;
      return union > 0 ? inter / union : 0;
    };
    const best = [...detections].sort((a, b) => overlap(b) - overlap(a))[0];
    return best && overlap(best) >= 0.2 ? best : null;
  });
}
const pickLargest = (ds: Detection[]) =>
  [...ds].sort((a, b) => b.mask.foregroundPixels - a.mask.foregroundPixels)[0] ?? null;

/** Whether a save leaves a fixture where it stood. */
const samePlace = (a: Fixture, b: FixtureInput) =>
  a.scene === b.scene &&
  a.surfaceId === b.surfaceId &&
  a.turns === b.turns &&
  Math.abs(a.at.x - b.at.x) < 1e-6 &&
  Math.abs(a.at.y - b.at.y) < 1e-6;

/** Switch one light or switch, through Home Assistant or the demo's virtual adapter. */
/** What a confirmed action says about every fixture on that entity; unconfirmed says nothing. */
export function noteControl(memory: DeskMemory, result: LampResult): void {
  for (const f of memory.fixtures ?? []) {
    if (fixtureEntity(f) === result.entityId)
      f.state = result.stateConfirmed ? (result.action ?? 'on') : null;
    for (const l of f.lights ?? []) {
      if (l.entityId !== result.entityId) continue;
      const { [l.part]: _was, ...lit } = f.lit ?? {};
      f.lit = result.stateConfirmed ? { ...lit, [l.part]: result.action !== 'off' } : lit;
    }
  }
}

/** What each of a fixture's sources last reported, kept for those still on the same entity. */
function lastLit(
  previous: Fixture | undefined,
  lights: FixtureInput['lights'],
): Pick<Fixture, 'lit'> {
  const kept = Object.entries(previous?.lit ?? {}).filter(([part]) => {
    const was = previous?.lights?.find((l) => l.part === part)?.entityId;
    return was && lights?.some((l) => l.part === part && l.entityId === was);
  });
  return kept.length ? { lit: Object.fromEntries(kept) } : {};
}

type Parsed<S extends { parse: (data: unknown) => unknown }> = ReturnType<S['parse']>;

/** What a fixture draft starts from: the photo, what it shows, and the outline SAM cut. */
interface FixtureSource {
  png: Buffer;
  cls: FixtureClass;
  detection: Detection;
  /** What the review shows: the photo of the thing, or the part of the desk photo boxed. */
  shown: Buffer | null;
  usage: Usage | null;
  model: string | undefined;
  requestId: string | null;
  assets: string[];
}

/**
 * Steps 1 and 2 of a draft: the photo and what is in it (Spark live, the
 * hand-written class in the demo), then SAM's outline of that thing.
 */
async function fixtureSource(
  { store, meta }: Pick<RouteDeps, 'store' | 'meta'>,
  input: Parsed<typeof fixturesDraftBodySchema>,
  id: string,
): Promise<FixtureSource> {
  const live = input.mode === 'live';
  let usage: Usage | null = null;
  let model: string | undefined;
  let requestId: string | null = null;
  const assets: string[] = [];
  // 1. The photo, and what is in it: Spark live, the hand-written class in the demo.
  let png: Buffer;
  let cls: FixtureClass;
  let detection: Detection;
  // What the review shows: the photo of the thing, or the part of the desk photo boxed.
  let shown: Buffer | null = null;
  if (input.box && !live) {
    const box = promptBox({ box: input.box }, { width: 960, height: 640 })!;
    const thing = await demoDeskThing(box);
    if (!thing)
      throw new LabError(
        'fixture_none',
        'Nothing is outlined there. Box the mug, the book or the bottle.',
        422,
      );
    ({ png, detection, cls } = thing);
    shown = await around(png, box);
  } else if (input.box) {
    // A box on the desk photo: Spark sees only what is around the box, and
    // SAM outlines the thing from the person's own box on the whole photo.
    const image = await validateImage(input.imageDataUrl);
    png = image.bytes;
    const frame = { width: image.width, height: image.height };
    const box = promptBox({ box: input.box }, frame);
    if (!box) throw new LabError('fixture_none', 'The box is too small to outline.', 422);
    shown = await around(png, box);
    const named = await meta.fixtureClass(toDataUrl(shown), input.label);
    cls = named.output;
    usage = named.usage;
    model = named.model;
    requestId = named.requestId;
    const outlined = await meta.segmentBoxes(
      image.dataUrl,
      [{ id: 1, box }],
      frame.width,
      frame.height,
    );
    assets.push(store.asset(id, 'sam-output.txt', outlined.raw));
    const found = [...outlined.output.detections].sort(
      (a, b) => b.mask.foregroundPixels - a.mask.foregroundPixels,
    )[0];
    if (!found)
      throw new LabError(
        'fixture_none',
        `Couldn’t outline the ${cls.label.toLowerCase()} in that box. Draw it a little larger.`,
        422,
      );
    detection = found;
  } else if (live) {
    const image = await validateImage(input.imageDataUrl);
    png = image.bytes;
    const named = await meta.fixtureClass(image.dataUrl, input.label);
    cls = named.output;
    usage = named.usage;
    model = named.model;
    requestId = named.requestId;
    // 2. SAM outlines whatever is inside Spark's box.
    const frame = { width: image.width, height: image.height };
    const box = promptBox(cls, frame);
    if (!box)
      throw new LabError('fixture_none', `The ${cls.label} is too small in the photo.`, 422);
    const outlined = await meta.segmentBoxes(
      image.dataUrl,
      [{ id: 1, box }],
      frame.width,
      frame.height,
    );
    assets.push(store.asset(id, 'sam-output.txt', outlined.raw));
    const found = [...outlined.output.detections].sort(
      (a, b) => b.mask.foregroundPixels - a.mask.foregroundPixels,
    )[0];
    if (!found)
      throw new LabError(
        'fixture_none',
        `Couldn’t find the ${cls.label.toLowerCase()} in the photo. Try one thing, filling most of the frame.`,
        422,
      );
    detection = found;
  } else {
    cls = demoFixtureClass[input.reference!];
    ({ png, detection } = await demoReference(input.reference!));
  }
  return { png, cls, detection, shown, usage, model, requestId, assets };
}

/**
 * Draft a fixture from a reference photo: one thing, filling most of the
 * frame. Its mask is cut out and modelled by the same fitter as objects,
 * and sized for the scene it is meant for. Nothing is saved; the draft
 * comes back for the person to name, choose a control for, and place.
 * Demo mode drafts from the bundled illustrations only.
 */
async function draftFixture(
  { store, meta, run, productsDir }: Pick<RouteDeps, 'store' | 'meta' | 'run' | 'productsDir'>,
  input: Parsed<typeof fixturesDraftBodySchema>,
) {
  const { mode, scene } = input;
  const live = mode === 'live';
  if (live ? input.reference : input.imageDataUrl || !input.reference === !input.box)
    throw new LabError(
      'demo_image',
      live
        ? 'Live mode drafts from your own photo, not the bundled pictures.'
        : 'Demo mode drafts from a bundled picture or a box in the demo office.',
    );
  const custom = store.memory(mode).scene;
  if (scene === 'custom' && !custom)
    throw new LabError(
      'fixture_place',
      'Save your own scene before drafting fixtures for it.',
      409,
    );
  // Refuse up front rather than stop halfway, with Spark's answer already paid for.
  if (live) meta.mustAfford(fixtureDraftCeiling(), 'A fixture draft');
  const event = await run('fixture', mode, async (id) => {
    const source = await fixtureSource({ store, meta }, input, id);
    const { png, cls, detection, shown, model, requestId, assets } = source;
    let usage = source.usage;
    const label = input.label ?? cls.label;
    const crop = await maskedCrop(png, detection);
    const referenceAsset = store.asset(id, 'reference.png', shown ?? png);
    const cropAsset = store.asset(id, 'item-crop.png', crop.png);
    // 3. The same modelling as objects: part masks and Spark's check when live.
    const drafted = await draftModel(meta, store, id, {
      crop,
      cropUrl: toDataUrl(crop.png),
      label,
      archetype: cls.archetype,
      material: cls.material,
      // A desk photo is taken from the pinned camera; a photo of one thing, from above.
      elevation: input.box ? pinElevation(store.memory(mode), mode) : null,
      live,
      knownHeight: cls.sizeCm.h / Math.max(cls.sizeCm.w, cls.sizeCm.d),
    });
    usage = addUsage(usage, drafted.usage);
    const isMonitor = /\b(monitor|display|screen)\b/i.test(label);
    const draftedItem = isMonitor ? monitorItem(label, false) : uniqueParts(drafted.item);
    const savedModel: SavedItem = {
      ...draftedItem,
      source: live ? 'spark' : 'demo',
      segmentRunId: null,
      swatches: drafted.fitted.swatches,
      updatedAt: new Date().toISOString(),
      fit: {
        archetype: drafted.fitted.archetype,
        params: drafted.params,
        iou: drafted.score.iou,
        deltaE: drafted.score.deltaE,
        elevation: drafted.fitted.elevation,
        views: 1,
        crop: cropAsset,
        cropPx: { width: crop.width, height: crop.height },
        assists: [
          `${live ? 'Spark' : 'Demo'}: ${cls.archetype}, ${cls.material}. ${cls.description}`,
          ...drafted.assists,
        ],
      },
    };
    // A saved product it names (what the person typed, or what Spark read on it) has
    // its real size; the catalog only, so this costs nothing.
    const usual = sizeInTiles(cls.sizeCm);
    const known = new Catalog([productsDir, BUNDLED_CATALOG]).find(
      [input.label, cls.label, cls.description].filter(Boolean).join(' '),
    );
    const real = known && productSize(known.facts, usual);
    const product = real ? (known.facts.name ?? known.facts.query) : null;
    if (product) savedModel.fit!.assists.push(`Sized as the ${product}, from saved products`);
    const seeded = defaultFixtureStates({
      label,
      archetype: drafted.fitted.archetype,
      control: cls.control,
      model: savedModel,
    });
    const draft: FixtureDraft = {
      label,
      archetype: drafted.fitted.archetype,
      suggested: cls.control,
      description: cls.description,
      model: savedModel,
      size: real ?? usual,
      ...(product ? { product } : {}),
      reference: { runId: id, asset: referenceAsset },
      ...(seeded.state ? { state: seeded.state } : {}),
      ...(seeded.states ? { states: seeded.states } : {}),
    };
    return {
      output: draft,
      assets: [referenceAsset, cropAsset, ...assets, ...drafted.assets],
      usage,
      ...(model ? { model } : {}),
      requestId,
    };
  });
  return { run: event, draft: fixtureOutput.draft(event)! };
}

/** What each fitted model was fitted to, by its place in the scan. */
type ScanFits = ({ fit: ItemFitRecord; swatches: Swatch[] } | undefined)[];

/** Step 3 of a scan: each outline is modelled by the fitter, with no further calls. */
async function fitOutlines(
  { store, meta }: Pick<RouteDeps, 'store' | 'meta'>,
  job: JobTracker,
  {
    mode,
    id,
    png,
    scan,
    outlined,
    frame,
    assets,
    usage: spent,
  }: {
    mode: Mode;
    id: string;
    png: Buffer;
    scan: FixtureScan;
    outlined: (Detection | null)[];
    frame: { width: number; height: number };
    assets: string[];
    usage: Usage | null;
  },
) {
  let usage = spent;
  const fits: ScanFits = [];
  const memory = store.memory(mode);
  const outlines: (Outline | null)[] = [];
  const models: (IsoItem | null)[] = [];
  for (const [i, thing] of scan.things.entries()) {
    const detection = outlined[i];
    outlines.push(detection ? outlineOf(detection, frame) : null);
    if (!detection) {
      models.push(null);
      continue;
    }
    const crop = await maskedCrop(png, detection);
    const cropAsset = store.asset(id, `item-crop-${i + 1}.png`, crop.png);
    assets.push(cropAsset);
    const label = thing.label.charAt(0).toUpperCase() + thing.label.slice(1);
    job.run('model', `${label} (${i + 1} of ${scan.things.length})`);
    await job.show('model', crop.png);
    job.check();
    // Fitted locally, in about a second: Spark's check of each crop took the scan
    // 30 s a thing and timed out on all six of one room's. "Model with AI" refines one.
    const request = {
      crop,
      cropUrl: toDataUrl(crop.png),
      label,
      archetype: thing.archetype,
      material: thing.material,
      elevation: pinElevation(memory, mode),
      knownHeight: thing.sizeCm.h / Math.max(thing.sizeCm.w, thing.sizeCm.d),
    };
    const drafted = await draftModel(meta, store, id, { ...request, live: false });
    models.push(drafted.item);
    usage = addUsage(usage, drafted.usage);
    assets.push(...drafted.assets);
    fits[i] = {
      fit: {
        archetype: drafted.fitted.archetype,
        params: drafted.params,
        iou: drafted.score.iou,
        deltaE: drafted.score.deltaE,
        elevation: drafted.fitted.elevation,
        views: 1,
        cropPx: { width: crop.width, height: crop.height },
        crop: cropAsset,
        assists: [
          `Scan: ${thing.archetype}, ${thing.material}, outlined by SAM`,
          ...drafted.assists,
        ],
      },
      swatches: drafted.fitted.swatches,
    };
  }
  return { memory, outlines, models, fits, usage };
}

/** The mapped things join the room's fixtures; the room's own things move as the scan placed them. */
function saveScanned(
  store: EvidenceStore,
  mode: Mode,
  target: IsoSceneKind | 'custom',
  mapped: MappedThing[],
  fits: ScanFits,
) {
  // Read again: the scan took a while, and the memory may have changed meanwhile.
  const memory = store.memory(mode);
  const library = memory.fixtures ?? [];
  const now = new Date().toISOString();
  // A link joins the other scene's group, named after its first fixture.
  const linkWith = (m: MappedThing) => {
    const other = m.linkTo ? library.find((f) => f.id === m.linkTo) : undefined;
    if (!other) return undefined;
    other.link = fixtureGroup(other);
    return other.link;
  };
  for (const m of mapped) {
    const here = m.match === 'existing' ? library.find((f) => f.id === m.fixtureId) : undefined;
    // The scan placed it again, so it stays the scan's to place.
    if (here && m.moveTo)
      Object.assign(here, m.moveTo, {
        scanned: true,
        ...(m.seen ? { seen: m.seen } : {}),
        updatedAt: now,
      });
    const fit = fits[mapped.indexOf(m)];
    if (here && m.remodel && fit)
      here.model = {
        ...uniqueParts(m.remodel),
        source: 'sampled',
        segmentRunId: null,
        swatches: fit.swatches,
        updatedAt: now,
        fit: fit.fit,
      };
    const link = here && linkWith(m);
    if (here && link) {
      for (const f of linkedFixtures(library, here)) f.link = link;
      here.link = link;
    }
  }
  const added: Fixture[] = mapped.flatMap((m, i) => {
    if (!m.fixture) return [];
    const link = linkWith(m);
    const fit = m.match === 'fitted' ? fits[i] : undefined;
    const known = m.match === 'library' ? library.find((f) => f.id === m.fixtureId) : undefined;
    const { model, states: _states, ...rest } = m.fixture;
    return [
      {
        ...rest,
        id: randomUUID(),
        model: known
          ? { ...known.model, ...uniqueParts(model), updatedAt: now }
          : {
              ...uniqueParts(model),
              source: fit ? 'sampled' : 'placeholder',
              segmentRunId: null,
              swatches: fit?.swatches ?? [],
              updatedAt: now,
              fit: fit?.fit ?? null,
            },
        ...(known?.states ? { states: known.states } : {}),
        state: known?.state ?? null,
        ...(link ? { link } : {}),
        scanned: true,
        ...(m.seen ? { seen: m.seen } : {}),
        createdAt: now,
        updatedAt: now,
      },
    ];
  });
  // A fixture saved meanwhile may have taken a place the scan counted on.
  memory.fixtures = [...library, ...added].slice(0, MAX_FIXTURES);
  if (target === 'custom' && memory.scene) memory.scene = withLayoutMoves(memory.scene, mapped);
  store.saveMemory(memory);
  return { memory, count: memory.fixtures.length };
}

/**
 * Scan and map a view: Spark lists what stays put in the photo the pinned
 * camera took (one call), and each thing is mapped onto a scene the pin
 * fits: its own, or the room it is a close view of. A thing found in the
 * other scene is linked with it, so both are one fixture. A
 * thing the scene already has is left alone; one a fixture elsewhere matches
 * is placed with that fixture's model; anything else is added with a model
 * fitted to what SAM outlined of it (one call for all of Spark's boxes), or
 * a placeholder when SAM found nothing. The masks also say where each thing
 * touches down, which a loose box doesn't. Demo mode scans the
 * demo office through its camera, with no model call.
 */
type ScanDeps = Pick<RouteDeps, 'store' | 'meta' | 'run' | 'jobs' | 'entities'>;
type ScanFrame = { width: number; height: number };
type ScanPhoto = { image: ValidatedImage | null; png: Buffer; frame: ScanFrame };
type ScanPin = NonNullable<DeskMemory['surface']>;
type ScanScene = NonNullable<Parsed<typeof fixturesScanBodySchema>['scene']>;
type ScanAsk = { tracked: string[]; known: string[]; only: boolean };

/** The pin a scan maps through and the scene it fills; refuses a scan that has neither. */
function scanTarget(
  before: DeskMemory,
  live: boolean,
  scene: Parsed<typeof fixturesScanBodySchema>['scene'],
) {
  const pin = live ? before.surface : DEMO_SURFACE;
  if (!pin || (pin.scene === 'custom' && !before.scene))
    throw new LabError(
      'scan_pin',
      'Pin a surface first: the scan maps what it finds through the pin.',
      409,
    );
  const target = scene ?? pin.scene;
  if (!pinFits(pin, target))
    throw new LabError(
      'scan_scene',
      'The pin is on another scene: scan its own scene, or the room it is a close view of.',
      409,
    );
  return { pin, target };
}

/** The photo to scan (null in the demo), which must be the shape of the one the pin was set on. */
async function scanPhotoImage(
  store: EvidenceStore,
  before: DeskMemory,
  pin: ScanPin,
  imageDataUrl: string | undefined,
  live: boolean,
) {
  const image = live ? await validateImage(imageDataUrl ?? (await roomPhoto(before, store))) : null;
  // Things are mapped through the pin by where they are in the frame.
  if (
    image &&
    Math.abs(image.width / image.height - pin.frame.width / pin.frame.height) >
      0.02 * (pin.frame.width / pin.frame.height)
  )
    throw new LabError(
      'scan_frame',
      imageDataUrl
        ? `The pin was set on a ${pin.frame.width}×${pin.frame.height} frame, and this photo is ${image.width}×${image.height}. Scan a frame from the pinned camera, or pin the surface again on this photo.`
        : `No photo was sent, and the room’s own photo is ${image.width}×${image.height}, while the pin was set on a ${pin.frame.width}×${pin.frame.height} frame. Start the pinned camera and scan what it shows, or pin the surface again on the room’s photo.`,
      409,
    );
  return image;
}

/** What the room already has, so Spark names things as it does; without addNew, all it looks for. */
function scanKnown(before: DeskMemory, target: ScanScene, addNew: boolean | undefined): ScanAsk {
  const tracked = [before.object?.label, ...(before.others ?? []).map((o) => o.label)].filter(
    (l): l is string => Boolean(l),
  );
  const known = [
    ...new Set([
      ...(before.fixtures ?? []).filter((f) => f.scene === target).map((f) => f.label),
      ...(target === 'custom' && before.scene
        ? layoutThings(before.scene).map((t) => t.label)
        : []),
    ]),
  ];
  const only = addNew === false;
  if (only && !known.length)
    throw new LabError(
      'scan_nothing_known',
      'The room has no fixtures or desk things to look for yet. Tick “Add new fixtures it finds” to add what the scan sees.',
      409,
    );
  return { tracked, known, only };
}

/** Step 1: Spark lists what stays put, each with a loose box. */
async function scanList(
  { meta }: Pick<ScanDeps, 'meta'>,
  job: JobTracker,
  { image, png, frame }: ScanPhoto,
  asked: ScanAsk,
) {
  job.run('list');
  const result = image
    ? await meta.fixtureScan(image.dataUrl, asked.tracked, job.signal, {
        known: asked.known,
        only: asked.only,
      })
    : { output: demoFixtureScan, model: 'demo', requestId: null, usage: null };
  job.check();
  const scan: FixtureScan = result.output;
  await job.done(
    'list',
    scan.things.length
      ? `${scan.things.length} thing${scan.things.length === 1 ? '' : 's'}: ${scan.things.map((t) => t.label).join(', ')}`
      : 'Nothing that stays put',
    await listedPreview(png, frame, scan.things),
    SCAN_PREVIEW,
  );
  return result;
}

/** Step 2: SAM outlines every thing from Spark's box, in one call. */
async function scanOutline(
  deps: Pick<ScanDeps, 'meta' | 'store'>,
  job: JobTracker,
  { image, png, frame }: ScanPhoto,
  scan: FixtureScan,
  id: string,
  assets: string[],
) {
  job.run('outline');
  const outlined = await outlinedThings(
    deps,
    scan,
    frame,
    image ? await samDataUrl(image) : null,
    id,
    assets,
    job.signal,
  );
  job.check();
  await job.done(
    'outline',
    `${outlined.filter(Boolean).length} of ${scan.things.length} outlined`,
    await outlinedPreview(
      png,
      frame,
      scan.things.map((t) => t.label),
      outlined,
    ),
    SCAN_PREVIEW,
  );
  return outlined;
}

type ScanWhere = {
  mode: Mode;
  pin: ScanPin;
  target: ScanScene;
  replace: boolean | undefined;
  addNew: boolean | undefined;
};

/** Step 4: each fitted thing is mapped through the pin onto the scene. */
async function scanMap(
  entities: ScanDeps['entities'],
  job: JobTracker,
  { png, frame }: ScanPhoto,
  where: ScanWhere,
  scan: FixtureScan,
  modelled: Awaited<ReturnType<typeof fitOutlines>>,
) {
  const { mode, pin, target, replace, addNew } = where;
  const { memory, outlines, models } = modelled;
  job.run('map');
  const library = memory.fixtures ?? [];
  const mapped = mapScan({
    scan,
    pin,
    scene: target,
    custom: memory.scene ?? null,
    library,
    room: MAX_FIXTURES - library.length,
    entities: entities(mode),
    outlines,
    models,
    dismissed: memory.dismissed ?? [],
    replace: Boolean(replace),
    addNew: addNew !== false,
  });
  await job.done(
    'map',
    mappedSummary(mapped),
    await placedPreview(png, frame, mapped),
    SCAN_PREVIEW,
  );
  return mapped;
}

/** The scan as one recorded run: list, outline, model, map. */
async function scanRun(
  deps: ScanDeps,
  job: JobTracker,
  photo: ScanPhoto,
  asked: ScanAsk,
  where: ScanWhere,
) {
  const { store, meta, run, entities } = deps;
  const { image, png, frame } = photo;
  // What each fitted model was fitted to, by its place in the scan.
  let fits: ScanFits = [];
  const event = await run('fixture', where.mode, async (id) => {
    job.link(id);
    const result = await scanList(deps, job, photo, asked);
    const scan: FixtureScan = result.output;
    const assets = image ? [store.asset(id, `source.${image.ext}`, image.bytes)] : [];
    const outlined = await scanOutline({ meta, store }, job, photo, scan, id, assets);
    // Step 3: each outline is modelled by the fitter, with no further calls.
    job.run('model');
    const modelled = await fitOutlines({ store, meta }, job, {
      mode: where.mode,
      id,
      png,
      scan,
      outlined,
      frame,
      assets,
      usage: result.usage,
    });
    fits = modelled.fits;
    const fitted = modelled.models.filter(Boolean).length;
    await job.done(
      'model',
      fitted
        ? `${fitted} model${fitted === 1 ? '' : 's'} fitted to their outlines`
        : 'No outlines to fit',
    );
    const mapped = await scanMap(entities, job, photo, where, scan, modelled);
    return { ...result, usage: modelled.usage, output: { scan, mapped }, assets };
  });
  return { event, fits };
}

async function scanFixtures(
  deps: ScanDeps,
  { mode, imageDataUrl, scene, replace, addNew, jobId }: Parsed<typeof fixturesScanBodySchema>,
) {
  const { store, meta, jobs } = deps;
  const live = mode === 'live';
  liveImage(mode, imageDataUrl, 'Demo mode scans only the demo room’s camera.');
  const before = store.memory(mode);
  const { pin, target } = scanTarget(before, live, scene);
  const ceiling = sparkCeiling(SPARK_BUDGET.fixtureScan, 1) + META_PRICES.samPerImage;
  if (live) meta.mustAfford(ceiling, 'A scan');
  const job = jobs.start(jobId, SCAN_STEPS, { title: 'Scanning and mapping', mode });
  return following(job, async () => {
    job.run('photo');
    const image = await scanPhotoImage(store, before, pin, imageDataUrl, live);
    const asked = scanKnown(before, target, addNew);
    const png = image ? image.bytes : await demoPhoto();
    const frame = image
      ? { width: image.width, height: image.height }
      : { width: 960, height: 640 };
    await job.done(
      'photo',
      image
        ? `${image.width} × ${image.height}`
        : 'Demo: the office from its corner camera, no model calls',
      png,
      SCAN_PREVIEW,
    );
    job.check();
    const where = { mode, pin, target, replace, addNew };
    const { event, fits } = await scanRun(deps, job, { image, png, frame }, asked, where);
    // Stopped while the last step ran: nothing is saved.
    job.check();
    job.run('save');
    const { mapped } = fixtureOutput.scan(event)!;
    const { memory, count } = saveScanned(store, mode, target, mapped, fits);
    await job.done('save', `${count} fixture${count === 1 ? '' : 's'} in the workspace`);
    job.finish();
    return { run: event, mapped, memory };
  });
}

/**
 * What Modelling with AI looks at: the fixture's cut-out from the room's
 * picture, or its own or a linked copy's, else the crop its model was fitted
 * to, else the room draft's crop, looked at from where the room's camera is.
 */
function sculptPicture(store: EvidenceStore, memory: DeskMemory, fixture: Fixture) {
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
    : crop
      ? {
          png: store.readAsset(crop),
          elevation: (activeModel.fit ?? fixture.model.fit)!.elevation,
        }
      : drafted();
  if (!pictured?.png)
    throw new LabError(
      'sculpt_picture',
      `There is no picture of the ${fixture.label.toLowerCase()} to model it from. Lift the fixtures off the room’s picture, or draft it from a photo.`,
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

/**
 * Model a fixture in our own parts with Spark, starting from its current
 * model and the picture of it: its cut-out from the room's picture when it
 * was lifted, else the crop its model was fitted to, else the crop of it a
 * room draft kept (seen from the room's camera). Spark revises the parts
 * against a render of the model (one call), then once more against a render
 * of its own draft (a second), and the draft whose silhouette matches the
 * picture better is kept, with any parts the person locked. Live only.
 */
async function sculptFixture(
  {
    store,
    meta,
    run,
    jobs,
    productsDir,
  }: Pick<RouteDeps, 'store' | 'meta' | 'run' | 'jobs' | 'productsDir'>,
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
  const { group, activeModel, activeSize, sprite, png, elevation } = sculptPicture(
    store,
    memory,
    fixture,
  );
  // A note is looked up as a product first: the catalog, then the web.
  const ceiling =
    SCULPT_DRAFTS * sparkCeiling(SPARK_BUDGET.sculpt, 2) +
    (note
      ? sparkCeiling(SPARK_BUDGET.productLookup, 0) + SEARCH_CEILING * META_PRICES.webSearchPerQuery
      : 0);
  meta.mustAfford(ceiling, 'Modelling it');
  const input = await cropInput(png, fixture.label);
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
  // Its proportions: the fixture's, until a lookup gives the product's own.
  const proportions = (s: { w: number; d: number; h: number }) => {
    const longest = Math.max(s.w, s.d);
    return { w: s.w / longest, d: s.d / longest, h: s.h / longest };
  };
  let size = proportions(activeSize);
  const steps = note
    ? [SCULPT_STEPS[0]!, { id: 'lookup', label: 'Look it up' }, ...SCULPT_STEPS.slice(1)]
    : SCULPT_STEPS;
  const job = jobs.start(jobId, steps, {
    title: `Modelling the ${fixture.label.toLowerCase()}`,
    mode,
  });
  const overlap = (iou: number) => `${Math.round(iou * 100)}% overlap with the picture`;
  const parts = (n: number) => `${n} part${n === 1 ? '' : 's'}`;
  const sculptSteps = async (id: string) => {
    job.link(id);
    const assets = [store.asset(id, 'picture.png', png)];
    await job.done(
      'picture',
      sprite ? 'Its cut-out from the room’s picture' : 'The photo crop its model was fitted to',
      png,
    );
    let usage: Usage | null = null;
    let model: string | undefined;
    let requestId: string | null = null;
    let facts: MergedFacts | null = null;
    let productTiles: { w: number; d: number; h: number } | null = null;
    // A note is looked up alongside the drafts, not before them (the web took 48 s): what
    // the catalog knows goes into Spark's prompt at once; what the web finds sizes the
    // saved model and is kept, so the same thing next time comes from the catalog.
    const catalog = new Catalog([productsDir, BUNDLED_CATALOG]);
    const web: Researcher = {
      kind: 'web',
      lookup: async (q, need) => {
        const r = await meta.lookupProduct(q, need, job.signal);
        usage = addUsage(usage, r.usage);
        return r.output.facts;
      },
    };
    const need = ['parts', 'colors'] as const;
    if (note) {
      job.run('lookup');
      const known = await research(note, need, [catalog], { signal: job.signal }).catch(() => null);
      facts = known?.facts.sources.length ? known.facts : null;
      const real = facts && productSize(facts, activeSize);
      if (real) {
        productTiles = real;
        size = proportions(real);
      }
    }
    // The lookup only helps: when it fails, Spark models from the note and the picture.
    const looked = note
      ? research(note, need, [catalog, web], { signal: job.signal }).then(
          (found) => ({ found, failed: null }),
          (e: unknown) => ({
            found: null,
            failed: e instanceof Error ? e.message : 'It failed.',
          }),
        )
      : null;
    const context = { note: note ?? null, facts, greyscale, small };
    const from: IsoItem = { label: activeModel.label, parts: activeModel.parts };
    job.run('current');
    const render = await viewPng(from, elevation, input.width);
    assets.push(store.asset(id, 'render-1.png', render));
    await job.done(
      'current',
      `${parts(from.parts.length)}, ${overlap(scoreAgainst(from, input, elevation).iou)}`,
      render,
    );
    job.run('draft');
    const [picture, current] = await Promise.all([shown(png, true), shown(render)]);
    const prompt = sculptPrompt(fixture.label, size, context);
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
    usage = addUsage(usage, asked.usage);
    model = asked.model;
    requestId = asked.requestId;
    const drafted = await viewPng(best.item, elevation, input.width);
    assets.push(store.asset(id, 'render-2.png', drafted));
    await job.done(
      'draft',
      `${parts(best.item.parts.length)}, ${overlap(best.iou)}, the best of ${drafts.length}. ${best.note}`,
      drafted,
    );
    if (best.iou < SCULPT_FLOOR)
      throw new LabError(
        'sculpt_miss',
        `Spark’s best model of the ${fixture.label.toLowerCase()} overlaps the picture by ${Math.round(best.iou * 100)}%, so it is something else; its model is kept as it was. Say what it is and try again.`,
        502,
      );
    if (looked && note) {
      const { found, failed } = await looked;
      job.check();
      const product = found?.facts.sources.length ? found.facts : null;
      if (product?.origin.name === 'web' || product?.origin.size === 'web')
        try {
          catalog.save({ ...product, query: note });
        } catch {
          /* keeping it is a convenience; the model doesn't depend on it */
        }
      facts = product ?? facts;
      const real = facts && productSize(facts, activeSize);
      if (real) productTiles = real;
      await job.done(
        'lookup',
        product && found
          ? `${product.name ?? 'Found it'} (${found.asked.map((a) => `${a.kind}${a.found ? ' ✓' : ' –'}`).join(' · ')})`
          : failed
            ? `Couldn’t look it up (${failed}); modelled from your note and the picture`
            : 'Nothing found; modelled from your note and the picture',
      );
    }
    job.run('keep');
    const item = keepLocked(best.item, activeModel);
    const final = await viewPng(item, elevation, input.width);
    assets.push(store.asset(id, 'render-final.png', final));
    const kept = item.parts.length - best.item.parts.length;
    await job.done(
      'keep',
      `The best of ${drafts.length} drafts, ${overlap(best.iou)}` +
        (kept > 0 ? `, with ${parts(kept)} you locked` : ''),
      final,
    );
    return {
      output: {
        sculpted: fixture.id,
        label: fixture.label,
        parts: item.parts.length,
        iou: best.iou,
        note: best.note,
        item,
        ...(note ? { asked: note, product: facts?.name ?? null } : {}),
        // The product's size in tiles, laid as this fixture stands; the save gives it the fixture.
        ...(productTiles ? { size: productTiles } : {}),
        greyscale,
      },
      model,
      requestId,
      usage,
      assets,
    };
  };
  // A failure shows on the step that was running; the run records it too.
  return following(job, async () => {
    const event = await run('fixture', mode, (id) => sculptSteps(id));
    // Stopped while the last step ran: nothing is saved.
    job.check();
    const out = fixtureOutput.sculpt(event)!;
    const fresh = store.memory(mode);
    fresh.fixtures = withSculpt(fresh.fixtures ?? [], fixture, out, activeModel.swatches);
    store.saveMemory(fresh);
    await job.done(
      'save',
      `Saved${group.size > 1 ? ` here and in ${group.size - 1} linked view${group.size > 2 ? 's' : ''}` : ''}` +
        (out.size
          ? `, sized as the product: ${[out.size.w, out.size.d, out.size.h].map((t) => Math.round(t * 30)).join(' × ')} cm`
          : ''),
    );
    job.finish();
    return { memory: fresh, run: event };
  });
}

/**
 * Fixtures: things placed in a room by hand, never tracked. Saving checks
 * where one stands and what it switches; controlling one is an explicit
 * action recorded like the lamp test.
 */
export async function fixtureRoutes(
  app: FastifyInstance,
  deps: Pick<
    RouteDeps,
    'store' | 'meta' | 'run' | 'jobs' | 'control' | 'entities' | 'productsDir' | 'sam3d' | 'desk'
  >,
) {
  const { store, meta, run, control, entities, sam3d = null, jobs, desk } = deps;
  app.post('/anchor', async (request) => {
    const { mode, id, segmentRunId, detectionId } = parseInput(
      fixturesAnchorBodySchema,
      request.body,
    );
    return desk.anchorFixture(mode, id, segmentRunId, detectionId);
  });
  /** Stop following a fixture; it stays where it was last seen. */
  app.post('/untrack', async (request) => {
    const { mode, id } = parseInput(modeIdSchema, request.body);
    desk.available(mode);
    const memory = store.memory(mode);
    const fixture = memory.fixtures?.find((f) => f.id === id);
    if (!fixture)
      throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
    delete fixture.track;
    // Rules that counted only it can't be checked any more.
    memory.rules = withoutThings(memory.rules, [id]);
    store.saveMemory(memory);
    return memory;
  });
  app.post('/draft', async (request) =>
    draftFixture(deps, parseInput(fixturesDraftBodySchema, request.body)),
  );
  app.post('/scan', async (request) =>
    scanFixtures(deps, parseInput(fixturesScanBodySchema, request.body)),
  );
  app.post('/sculpt', async (request) =>
    sculptFixture(deps, parseInput(fixturesSculptBodySchema, request.body)),
  );
  /**
   * Put a past modelling job's model back on its fixture, as it saved it then,
   * with no model call: the model it replaces is kept as an earlier draft.
   */
  app.post('/sculpt/reapply', async (request) => {
    const { mode, jobId } = parseInput(fixturesSculptReapplyBodySchema, request.body);
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
  });
  /**
   * Another photo of a fixture, usually a close one of a thing the room's
   * camera sees too small to model well: outlined and fitted as a draft is,
   * then fused with the fits it already has, counted for more the larger its
   * crop is than the last one's. Its crop becomes the fixture's picture. The
   * demo uses its own close photos: the mug's, or a bundled picture by name.
   */
  app.post('/photo', async (request) => {
    const { mode, fixtureId, imageDataUrl } = parseInput(fixturesPhotoBodySchema, request.body);
    const live = mode === 'live';
    modeImage(mode, imageDataUrl, {
      live: 'Send a photo of the fixture.',
      demo: 'Demo mode uses its own close photos, not uploads.',
    });
    const memory = store.memory(mode);
    const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
    if (!fixture) throw new LabError('fixture_missing', 'That fixture is gone.', 404);
    if (live) meta.mustAfford(fixtureDraftCeiling(), 'Fitting another photo');
    const active = fixtureModel(fixture);
    const previous = active.fit ?? null;
    const event = await run('fixture', mode, async (id) => {
      let usage: Usage | null = null;
      let model: string | undefined;
      let requestId: string | null = null;
      const assets: string[] = [];
      let png: Buffer;
      let detection: Detection;
      let cls: Pick<FixtureClass, 'archetype' | 'material'> | null = null;
      if (live) {
        const image = await validateImage(imageDataUrl);
        png = image.bytes;
        const named = await meta.fixtureClass(image.dataUrl, fixture.label);
        cls = named.output;
        usage = named.usage;
        model = named.model;
        requestId = named.requestId;
        const frame = { width: image.width, height: image.height };
        const box = promptBox(named.output, frame);
        if (!box)
          throw new LabError(
            'fixture_none',
            `The ${fixture.label} is too small in the photo.`,
            422,
          );
        const outlined = await meta.segmentBoxes(
          image.dataUrl,
          [{ id: 1, box }],
          frame.width,
          frame.height,
        );
        assets.push(store.asset(id, 'sam-output.txt', outlined.raw));
        const found = [...outlined.output.detections].sort(
          (a, b) => b.mask.foregroundPixels - a.mask.foregroundPixels,
        )[0];
        if (!found)
          throw new LabError(
            'fixture_none',
            `Couldn’t find the ${fixture.label.toLowerCase()} in the photo. Fill most of the frame with it.`,
            422,
          );
        detection = found;
      } else {
        const reference = DEMO_REFERENCES.find((r) => fixture.label.toLowerCase().includes(r));
        if (/\bmug\b/i.test(fixture.label)) ({ png, detection } = await demoMugCloseUp('centre'));
        else if (reference) ({ png, detection } = await demoReference(reference));
        else
          throw new LabError(
            'demo_photo',
            `The demo has no close photo of the ${fixture.label.toLowerCase()}: only the mug, mouse, lamp, monitor and cat.`,
            409,
          );
      }
      const crop = await maskedCrop(png, detection);
      const cropAsset = store.asset(id, 'item-crop.png', crop.png);
      const archetype = previous?.archetype ?? cls?.archetype ?? 'generic';
      const size = fixtureSize(fixture);
      const drafted = await draftModel(meta, store, id, {
        crop,
        cropUrl: toDataUrl(crop.png),
        label: fixture.label,
        archetype,
        material: cls?.material ?? null,
        elevation: null,
        live,
        knownHeight: size.h / Math.max(size.w, size.d),
      });
      usage = addUsage(usage, drafted.usage);
      assets.push(...drafted.assets);
      let { params, item, score } = drafted;
      let views = 1;
      const assists = [...drafted.assists];
      if (previous && previous.archetype === drafted.fitted.archetype) {
        // A close photo carries more than a far one: weighed by how much wider its crop is.
        const weight = previous.cropPx
          ? Math.min(4, Math.max(1, crop.width / Math.max(1, previous.cropPx.width)))
          : 1;
        params = fuseFits(previous.params, previous.views, params, weight);
        item = buildItem(fixture.label, params);
        score = scoreAgainst(item, drafted.input, drafted.fitted.elevation);
        views = previous.views + 1;
        assists.push(
          `Fused with ${previous.views} earlier view${previous.views === 1 ? '' : 's'}` +
            (weight > 1 ? `, this one counted ${weight.toFixed(1)} times` : ''),
        );
      }
      const saved: SavedItem = {
        ...uniqueParts(keepLocked(item, active)),
        source: live ? 'spark' : 'demo',
        segmentRunId: null,
        swatches: drafted.fitted.swatches,
        updatedAt: new Date().toISOString(),
        fit: {
          archetype: drafted.fitted.archetype,
          params,
          iou: score.iou,
          deltaE: score.deltaE,
          elevation: drafted.fitted.elevation,
          views,
          crop: cropAsset,
          cropPx: { width: crop.width, height: crop.height },
          assists,
        },
      };
      return {
        output: { fixtureId, views, iou: score.iou, model: saved },
        assets: [cropAsset, ...assets],
        usage,
        ...(model ? { model } : {}),
        requestId,
      };
    });
    const saved = fixtureOutput.fuse(event)!.model;
    const fresh = store.memory(mode);
    fresh.fixtures = withModel(fresh.fixtures ?? [], fixture, saved);
    store.saveMemory(fresh);
    return { run: event, memory: fresh };
  });
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
  app.post('/refine3d', async (request) => {
    const { mode, fixtureId, jobId } = parseInput(fixturesRefine3dBodySchema, request.body);
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
    if (!png)
      throw new LabError('refine_picture', 'The photo its model was fitted to is gone.', 409);
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
  });
  /**
   * Put one of a fixture's earlier drafts back as its model, the current one
   * kept in its place, here and in its linked copies. Each pick is logged
   * with what it was chosen over (`fixture-picks.jsonl` in the data folder),
   * as examples of which modeller people prefer for which things.
   */
  app.post('/choose', async (request) => {
    const { mode, fixtureId, draft } = parseInput(fixturesChooseBodySchema, request.body);
    const memory = store.memory(mode);
    const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
    if (!fixture) throw new LabError('fixture_missing', 'That fixture is gone.', 404);
    const chosen = fixture.drafts?.[draft];
    if (!chosen) throw new LabError('draft_missing', 'That draft is gone.', 404);
    const now = new Date().toISOString();
    const swap = <F extends Pick<Fixture, 'model' | 'drafts'>>(f: F): F => {
      const rest = (f.drafts ?? []).filter((d) => d !== chosen && d.model !== chosen.model);
      const kept = { model: f.model, origin: modelOrigin(f.model), replacedAt: now };
      return { ...f, model: chosen.model, drafts: [kept, ...rest].slice(0, MAX_DRAFTS) };
    };
    const group = new Set([
      fixture.id,
      ...linkedFixtures(memory.fixtures ?? [], fixture).map((f) => f.id),
    ]);
    memory.fixtures = (memory.fixtures ?? []).map((f) =>
      group.has(f.id) ? { ...swap(f), updatedAt: now } : f,
    );
    store.saveMemory(memory);
    store.appendPick({
      at: now,
      mode,
      label: fixture.label,
      archetype: chosen.model.fit?.archetype ?? fixture.model.fit?.archetype ?? null,
      chosen: chosen.origin,
      over: [
        modelOrigin(fixture.model),
        ...(fixture.drafts ?? []).filter((d) => d !== chosen).map((d) => d.origin),
      ],
      crop: chosen.model.fit?.crop ?? fixture.model.fit?.crop ?? null,
    });
    return memory;
  });
  app.post('/save', async (request) => {
    const { mode, fixture: input } = parseInput(fixturesSaveBodySchema, request.body);
    const memory = store.memory(mode);
    const fixtures = memory.fixtures ?? [];
    const previous = input.id ? fixtures.find((f) => f.id === input.id) : undefined;
    if (input.id && !previous)
      throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
    if (!previous && fixtures.length >= MAX_FIXTURES)
      throw new LabError('fixture_limit', `Up to ${MAX_FIXTURES} fixtures are allowed.`, 409);
    const problem = fixtureProblem(input, memory.scene);
    if (problem) throw new LabError('fixture_place', problem, 400);
    const entity = fixtureEntity(input);
    if (fixtureEntities(input).some((e) => !entities(mode).includes(e)))
      throw new LabError('fixture_entity', 'Choose one of the configured lights or switches.', 400);
    const sources = new Set(lightSources(input.model).map((s) => s.part));
    const stray = input.lights?.find((l) => !sources.has(l.part));
    if (stray)
      throw new LabError(
        'fixture_light',
        `The model has no light source called “${stray.part}”.`,
        400,
      );
    const referenceRun = input.reference ? store.getRun(input.reference.runId) : undefined;
    if (
      input.reference &&
      (!referenceRun || !input.reference.asset.startsWith(`${input.reference.runId}/`))
    )
      throw new LabError(
        'fixture_reference',
        'The reference photo is not one of the saved runs.',
        400,
      );
    const now = new Date().toISOString();
    const retyped = Boolean(previous && input.type && previous.type !== input.type);
    const { id: _id, model, room: roomInput, states: statesInput, ...rest } = input;
    // Its own place in the room's view: kept unless the save says otherwise, null clears it.
    const room = roomInput === undefined ? previous?.room : roomInput;
    // What the model was drafted as: the fixture before, or the draft it came from.
    const drafted =
      referenceRun?.status === 'completed' ? fixtureOutput.draft(referenceRun) : undefined;
    const base = previous?.model ?? drafted?.model;
    const savedModel: SavedItem = {
      ...uniqueParts(model),
      source: base?.source ?? (mode === 'demo' ? 'demo' : 'sampled'),
      segmentRunId: base?.segmentRunId ?? null,
      swatches: base?.swatches ?? [],
      updatedAt: now,
      // An edit keeps its fit record, scored again against the same crop.
      fit: await rescore(store, model, base?.fit),
    };
    const seeded = defaultFixtureStates({
      label: rest.label,
      archetype: drafted?.archetype ?? savedModel.fit?.archetype,
      control: rest.control.kind,
      model: savedModel,
    });
    const states: Record<string, FixtureState> | undefined = statesInput
      ? Object.fromEntries(
          Object.entries(statesInput).map(([stateName, entry]) => {
            const prevState = previous?.states?.[stateName]?.model;
            return [
              stateName,
              {
                model: {
                  ...uniqueParts(entry.model),
                  source: prevState?.source ?? savedModel.source,
                  segmentRunId: prevState?.segmentRunId ?? null,
                  swatches: prevState?.swatches ?? savedModel.swatches,
                  updatedAt: now,
                  fit: prevState?.fit ?? null,
                },
                ...(entry.size ? { size: entry.size } : {}),
                ...(entry.reference !== undefined ? { reference: entry.reference } : {}),
              },
            ];
          }),
        )
      : (previous?.states ?? drafted?.states ?? seeded.states);
    if (states) {
      for (const entry of Object.values(states)) {
        if (entry.size) {
          const sizeProblem = fixtureProblem({ ...input, size: entry.size }, memory.scene);
          if (sizeProblem) throw new LabError('fixture_place', sizeProblem, 400);
        }
      }
    }
    const fixture: Fixture = {
      ...rest,
      ...(room ? { room } : {}),
      id: previous?.id ?? randomUUID(),
      model: savedModel,
      ...(states ? { states } : {}),
      // A source keeps what its entity last reported while it stays on that entity.
      ...lastLit(previous, input.lights),
      // A new entity starts with no known state; a pet starts in its default pose.
      // Another kind of thing starts in that kind's own state.
      state: retyped
        ? entity
          ? null
          : (seeded.state ?? null)
        : previous
          ? entity
            ? fixtureEntity(previous) === entity
              ? (previous.state ?? null)
              : null
            : (previous.state ?? null)
          : entity
            ? null
            : (drafted?.state ?? seeded.state ?? null),
      ...(previous?.link ? { link: previous.link } : {}),
      // The camera keeps following it unless it was moved by hand.
      ...(previous?.track && samePlace(previous, input) ? { track: previous.track } : {}),
      ...(previous?.seen && samePlace(previous, input) ? { seen: previous.seen } : {}),
      // A change of what it is keeps the model it had, to pick back from Earlier drafts.
      ...(previous && retyped
        ? { drafts: withNewModel(previous, savedModel, now).drafts }
        : previous?.drafts?.length
          ? { drafts: previous.drafts }
          : {}),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    // The same thing in its other scenes is renamed, remodelled and rewired with it.
    const linked = new Set(linkedFixtures(fixtures, fixture).map((f) => f.id));
    memory.fixtures = previous
      ? fixtures.map((f) =>
          f.id === previous.id
            ? fixture
            : linked.has(f.id)
              ? {
                  ...f,
                  label: fixture.label,
                  model: fixture.model,
                  ...(fixture.states ? { states: fixture.states } : {}),
                  control: fixture.control,
                  ...(fixture.type ? { type: fixture.type } : {}),
                  lights: fixture.lights,
                  lit: fixture.lit,
                  state: fixture.state ?? null,
                  updatedAt: now,
                }
              : f,
        )
      : [...fixtures, fixture];
    store.saveMemory(memory);
    return memory;
  });
  /** The reference photo a fixture was drafted from, for review and the inspector. */
  app.get('/reference', async (request, reply) => {
    const { runId } = parseInput(fixturesReferenceQuerySchema, request.query);
    const drafted = store.getRun(runId);
    const png = drafted?.kind === 'fixture' ? store.readAsset(`${runId}/reference.png`) : null;
    if (!png) throw new LabError('fixture_reference', 'That draft has no reference photo.', 404);
    return reply.type('image/png').header('cache-control', 'private, max-age=3600').send(png);
  });
  /** Rules that switched the fixture keep its entity and lose the link to it. */
  /**
   * Delete a fixture. `dismiss` also remembers its name as not a fixture, so
   * scans skip it: something Spark keeps finding that shouldn't be one.
   */
  /**
   * Look for a fixture in a camera frame, for a person to confirm which
   * outline it is: SAM is pointed at where it should stand, from where the
   * camera last saw it or its place in the room drawn through the pin (one
   * call). The demo picks the render's outlines under that box.
   * Saved as an ordinary segmentation of the fixture's name.
   */
  app.post('/find', async (request) => {
    const { mode, id, imageDataUrl } = parseInput(fixturesFindBodySchema, request.body);
    const memory = store.memory(mode);
    const fixture = memory.fixtures?.find((f) => f.id === id);
    if (!fixture)
      throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
    const pin = memory.surface ?? (mode === 'demo' ? DEMO_SURFACE : null);
    if (!pin)
      throw new LabError('fixture_view', 'Pin the desk first, so the camera’s view is known.', 409);
    const expected = fixtureInFrame(fixture, pin, memory.scene ?? null);
    if (!expected)
      throw new LabError(
        'fixture_view',
        `The ${fixture.label.toLowerCase()} stands outside what the pinned camera sees.`,
        409,
      );
    const concept = fixture.label.trim().toLowerCase();
    if (mode === 'live' && !imageDataUrl)
      throw new LabError('fixture_frame', 'Send a camera frame to look in.', 400);
    liveImage(mode, imageDataUrl);
    return run('segment', mode, async (runId) => {
      // Grown by half its size each way: the place is a guess, SAM finds the edge.
      const grow = (b: typeof expected, sx: number, sy: number, w: number, h: number) => {
        const left = Math.max(0, (b.x - b.width / 2) * sx);
        const top = Math.max(0, (b.y - b.height / 2) * sy);
        return {
          left,
          top,
          right: Math.min(w, (b.x + 1.5 * b.width) * sx),
          bottom: Math.min(h, (b.y + 1.5 * b.height) * sy),
        };
      };
      if (mode === 'demo') {
        const photo = await demoPhotoSegmentation();
        const box = grow(expected, 1, 1, photo.frame.width, photo.frame.height);
        const inside = (d: Detection) => {
          const w = Math.min(box.right, d.box.x + d.box.width) - Math.max(box.left, d.box.x);
          const h = Math.min(box.bottom, d.box.y + d.box.height) - Math.max(box.top, d.box.y);
          return (Math.max(0, w) * Math.max(0, h)) / (d.box.width * d.box.height);
        };
        // The desk itself is a surface, never a fixture.
        const detections = photo.detections.filter((d) => d.objectId !== '1' && inside(d) >= 0.5);
        const output: Segmentation = {
          concept,
          frame: photo.frame,
          detections,
          sourceKey: demoSourceKey(),
        };
        return { output };
      }
      const image = await validateImage(imageDataUrl!);
      const box = grow(
        expected,
        image.width / pin.frame.width,
        image.height / pin.frame.height,
        image.width,
        image.height,
      );
      const outlined = await meta.segmentBoxes(
        await samDataUrl(image),
        [{ id: 1, box }],
        image.width,
        image.height,
      );
      return {
        ...outlined,
        output: {
          ...outlined.output,
          concept,
          sourceKey: createHash('sha256').update(image.bytes).digest('hex'),
        },
        assets: [
          store.asset(runId, `source.${image.ext}`, image.bytes),
          store.asset(runId, 'sam-output.txt', outlined.raw),
        ],
      };
    });
  });
  /** Delete one fixture, or several at once (`fixtureIds`), in one save. */
  app.post('/delete', async (request) => {
    const { mode, fixtureId, fixtureIds, dismiss } = parseInput(
      fixturesDeleteBodySchema,
      request.body,
    );
    const ids = new Set(fixtureIds ?? [fixtureId!]);
    const memory = store.memory(mode);
    for (const gone of (memory.fixtures ?? []).filter((f) => ids.has(f.id)))
      if (dismiss && !isDismissed(gone.label, memory.dismissed ?? []))
        memory.dismissed = [...(memory.dismissed ?? []), gone.label].slice(-MAX_DISMISSED);
    memory.fixtures = (memory.fixtures ?? []).filter((f) => !ids.has(f.id));
    // Rules they decided go with them; rules that switched one keep their entity.
    memory.rules = withoutThings(memory.rules, [...ids]).map((r) => {
      if (!r.fixtureId || !ids.has(r.fixtureId)) return r;
      const { fixtureId: _gone, ...rest } = r;
      return rest;
    });
    store.saveMemory(memory);
    return memory;
  });
  /** Hand every fixture of a scene back to scans, to place and refit on the next one. */
  app.post('/release', async (request) => {
    const { mode, scene } = parseInput(fixturesReleaseBodySchema, request.body);
    const memory = store.memory(mode);
    for (const f of memory.fixtures ?? []) if (f.scene === scene) f.scanned = true;
    store.saveMemory(memory);
    return memory;
  });
  /** Let scans find a dismissed name again. */
  app.post('/undismiss', async (request) => {
    const { mode, label } = parseInput(fixturesUndismissBodySchema, request.body);
    const memory = store.memory(mode);
    memory.dismissed = (memory.dismissed ?? []).filter((d) => d !== label);
    store.saveMemory(memory);
    return memory;
  });
  /**
   * Switch a fixture's active state, or add/edit/remove a custom state with its
   * own unique fixture model, size or reference.
   */
  app.post('/state', async (request) => {
    const {
      mode,
      fixtureId,
      state,
      fixture: stateInput,
      remove,
    } = parseInput(fixturesStateBodySchema, request.body);
    const memory = store.memory(mode);
    const target = memory.fixtures?.find((f) => f.id === fixtureId);
    if (!target)
      throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
    const now = new Date().toISOString();
    const states: Record<string, FixtureState> = { ...(target.states ?? {}) };
    if (remove) delete states[remove];
    if (state) {
      if (stateInput) {
        if (stateInput.size) {
          const problem = fixtureProblem({ ...target, size: stateInput.size }, memory.scene);
          if (problem) throw new LabError('fixture_place', problem, 400);
        }
        const prev = states[state]?.model ?? fixtureModel(target, state);
        states[state] = {
          model: {
            ...uniqueParts(stateInput.model),
            source: prev.source,
            segmentRunId: prev.segmentRunId,
            swatches: prev.swatches,
            updatedAt: now,
            fit: prev.fit,
          },
          ...(stateInput.size
            ? { size: stateInput.size }
            : states[state]?.size
              ? { size: states[state]!.size }
              : {}),
          ...(stateInput.reference !== undefined
            ? { reference: stateInput.reference }
            : states[state]?.reference !== undefined
              ? { reference: states[state]!.reference }
              : {}),
        };
      } else if (!states[state] && state !== 'on' && state !== 'off') {
        const currentModel = fixtureModel(target);
        states[state] = {
          model: { ...currentModel, updatedAt: now },
          size: fixtureSize(target),
        };
      }
    }
    const nextState =
      state !== undefined
        ? state
        : remove && target.state === remove
          ? null
          : (target.state ?? null);
    const nextStates = Object.keys(states).length ? states : undefined;
    const group = new Set([
      target.id,
      ...linkedFixtures(memory.fixtures ?? [], target).map((f) => f.id),
    ]);
    memory.fixtures = (memory.fixtures ?? []).map((f) => {
      if (!group.has(f.id)) return f;
      const copy: Fixture = { ...f, state: nextState, updatedAt: now };
      if (nextStates) copy.states = nextStates;
      else delete copy.states;
      return copy;
    });
    store.saveMemory(memory);
    return memory;
  });
  /**
   * Switch a fixture's light or switch, a fixture's state/pose, or a configured
   * entity directly: a lamp that is part of the room's layout has no fixture of its own.
   */
  app.post('/control', async (request) => {
    const { mode, fixtureId, entityId, part, action } = parseInput(
      fixturesControlBodySchema,
      request.body,
    );
    let entity = entityId ?? null;
    if (fixtureId) {
      const memory = store.memory(mode);
      const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
      if (!fixture)
        throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
      if (part) {
        const light = fixture.lights?.find((l) => l.part === part);
        if (!light)
          throw new LabError(
            'fixture_control',
            `That light source of the ${fixture.label} switches nothing.`,
            400,
          );
        entity = light.entityId;
      } else entity = fixtureEntity(fixture);
      if (part && action !== 'on' && action !== 'off')
        throw new LabError(
          'fixture_control',
          'A light source can only be switched on or off.',
          400,
        );
      if (!entity || (action !== 'on' && action !== 'off')) {
        if (!fixture.states || !(action in fixture.states))
          throw new LabError('fixture_control', `The ${fixture.label} has nothing to switch.`, 400);
        const now = new Date().toISOString();
        const group = new Set([
          fixture.id,
          ...linkedFixtures(memory.fixtures ?? [], fixture).map((f) => f.id),
        ]);
        for (const f of memory.fixtures ?? [])
          if (group.has(f.id)) {
            f.state = action;
            f.updatedAt = now;
          }
        store.saveMemory(memory);
        return { memory, event: null };
      }
    } else if (!entities(mode).includes(entity!))
      throw new LabError('lamp_unknown', 'That entity is not one of the configured ones.', 409);
    if (action !== 'on' && action !== 'off')
      throw new LabError('fixture_control', 'An entity can only be switched on or off.', 400);
    const event = await run('lamp', mode, async () => ({
      output: await control(mode, entity!, action),
    }));
    // Read again: the action took a while, and the memory may have changed meanwhile.
    const memory = store.memory(mode);
    noteControl(memory, runOutput(event, 'lamp')!);
    store.saveMemory(memory);
    return { memory, event };
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
 * A looked-up product's size in tiles, laid the way the fixture stands (its
 * longer side along its own longer side), when the lookup is sure enough of
 * it and it is a size a fixture can be. Null otherwise.
 */
export function productSize(
  facts: Pick<ProductFacts, 'sizeCm' | 'confidence'>,
  current: { w: number; d: number },
): { w: number; d: number; h: number } | null {
  const cm = facts.sizeCm;
  if (!cm || facts.confidence < 0.5) return null;
  const same = current.w >= current.d === cm.w >= cm.d;
  const t = { w: (same ? cm.w : cm.d) / 30, d: (same ? cm.d : cm.w) / 30, h: cm.h / 30 };
  return [t.w, t.d, t.h].every((v) => v >= 0.1 && v <= 8) ? t : null;
}
