import {
  fixtureOutput,
  fixturesDraftBodySchema,
  fixturesPhotoBodySchema,
  DEMO_REFERENCES,
  META_PRICES,
  promptBox,
  sparkCeiling,
  sizeInTiles,
  defaultFixtureStates,
  fixtureModel,
  fixtureSize,
  monitorItem,
  uniqueParts,
  buildItem,
  fuseFits,
  scoreAgainst,
  type SavedItem,
  type Detection,
  type FixtureClass,
  type FixtureDraft,
  type Usage,
  addUsage,
} from '@livinglayer/domain';
import { LabError, modeImage } from '../errors.js';
import { demoDeskThing, demoMugCloseUp, demoFixtureClass, demoReference } from '../demo.js';
import { maskedCrop, toDataUrl, validateImage } from '../images.js';
import { draftModel, keepLocked, pinElevation } from '../item.js';
import { type RouteDeps } from '../route-deps.js';
import { SPARK_BUDGET } from '../meta.js';
import { BUNDLED_CATALOG, Catalog } from '../research.js';
import { around, withModel, productSize, type Parsed } from './shared.js';

/**
 * The most a live draft can cost: Spark names the thing, SAM outlines it,
 * SAM looks for up to two parts, and Spark checks one render.
 */
const fixtureDraftCeiling = () =>
  sparkCeiling(SPARK_BUDGET.fixtureClass, 1) +
  3 * META_PRICES.samPerImage +
  sparkCeiling(SPARK_BUDGET.itemCheck, 2);

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
export async function draftFixture(
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

/**
 * Another photo of a fixture, usually a close one of a thing the room's
 * camera sees too small to model well: outlined and fitted as a draft is,
 * then fused with the fits it already has, counted for more the larger its
 * crop is than the last one's. Its crop becomes the fixture's picture. The
 * demo uses its own close photos: the mug's, or a bundled picture by name.
 */
export async function refitFixture(
  { store, meta, run }: Pick<RouteDeps, 'store' | 'meta' | 'run'>,
  { mode, fixtureId, imageDataUrl }: Parsed<typeof fixturesPhotoBodySchema>,
) {
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
        throw new LabError('fixture_none', `The ${fixture.label} is too small in the photo.`, 422);
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
}
