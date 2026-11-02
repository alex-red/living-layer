import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DEMO_REFERENCES,
  DEMO_SURFACE,
  calibrationOf,
  elevationAt,
  fixtureBox,
  demoSourceKey,
  fixtureInFrame,
  mapScan,
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
  entityIdSchema,
  META_PRICES,
  MAX_FIXTURES,
  isoSceneKindSchema,
  promptBox,
  sparkCeiling,
  sizeInTiles,
  defaultFixtureStates,
  fixtureEntity,
  fixtureInputSchema,
  fixtureModel,
  fixtureProblem,
  fixtureReference,
  fixtureSize,
  fixtureStateInputSchema,
  fixtureStateNameSchema,
  monitorItem,
  modeSchema,
  uniqueParts,
  fromSculpt,
  MAX_DRAFTS,
  modelOrigin,
  withNewModel,
  buildItem,
  latheFromSplat,
  latheProportions,
  readSplat,
  type LatheFit,
  fuseFits,
  scoreAgainst,
  sculptCheckPrompt,
  sculptPrompt,
  toSculpt,
  type SavedItem,
  type DeskMemory,
  type Detection,
  type Fixture,
  type FixtureInput,
  type FixtureClass,
  type FixtureDraft,
  type FixtureState,
  type LampResult,
  type Mode,
  type Segmentation,
  type MergedFacts,
  type ProductFacts,
  type Usage,
  withoutThings,
} from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import { following, jobs } from './jobs.js';
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
import { maskedCrop, validateImage } from './images.js';
import {
  cropInput,
  demoPhoto,
  PART_CONCEPTS,
  draftModel,
  keepLocked,
  pinElevation,
  rescore,
  viewPng,
  type Runner,
} from './item.js';
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
/** What modelling a fixture with AI shows while it runs, in order. */
const SCULPT_STEPS = [
  { id: 'picture', label: 'The picture of it' },
  { id: 'current', label: 'Its model as it is' },
  { id: 'draft', label: 'Spark drafts it in parts' },
  { id: 'check', label: 'Spark checks its draft' },
  { id: 'keep', label: 'Keep the better draft' },
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
  const moved = mapped.filter((m) => m.moveTo).length;
  const added = mapped.filter((m) => m.fixture).length;
  const kept = mapped.filter((m) => m.match === 'existing' && !m.moveTo).length;
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
/** A crop at least this wide is worth Spark's check in a scan; smaller wants a close photo. */
const CHECKED_CROP_PX = 40;
const sumUsage = (a: Usage | null, b: Usage | null | undefined): Usage | null =>
  !b
    ? a
    : !a
      ? b
      : {
          inputTokens: a.inputTokens + b.inputTokens,
          outputTokens: a.outputTokens + b.outputTokens,
          totalTokens: a.totalTokens + b.totalTokens,
        };

/**
 * The most a live draft can cost: Spark names the thing, SAM outlines it,
 * SAM looks for up to two parts, and Spark checks one render.
 */
/** The most modelling one crop live can cost: SAM per part it looks for, and Spark's check. */
const modelCeiling = (archetype: FixtureClass['archetype']) =>
  Object.keys(PART_CONCEPTS[archetype] ?? {}).length * META_PRICES.samPerImage +
  sparkCeiling(SPARK_BUDGET.itemCheck, 2);
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
  for (const asset of [memory.scenePhoto, drawn && `${drawn}/source.png`]) {
    const bytes = asset ? store.readAsset(asset) : null;
    if (bytes) return bytes;
  }
  return null;
}
/** The room's photo as a data URL, for scanning the room when no newer photo is sent. */
async function roomPhoto(memory: DeskMemory, store: EvidenceStore): Promise<string | undefined> {
  const bytes = roomPhotoBytes(memory, store);
  // A saved PNG can be large; Spark needs no more than a good JPEG.
  return bytes
    ? `data:image/jpeg;base64,${(await sharp(bytes).jpeg({ quality: 90 }).toBuffer()).toString('base64')}`
    : undefined;
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
export type Control = (mode: Mode, entityId: string, action: 'on' | 'off') => Promise<LampResult>;

/** What a confirmed action says about every fixture on that entity; unconfirmed says nothing. */
export function noteControl(memory: DeskMemory, result: LampResult): void {
  for (const f of memory.fixtures ?? [])
    if (fixtureEntity(f) === result.entityId)
      f.state = result.stateConfirmed ? (result.action ?? 'on') : null;
}

/**
 * Fixtures: things placed in a room by hand, never tracked. Saving checks
 * where one stands and what it switches; controlling one is an explicit
 * action recorded like the lamp test.
 */
export function fixtureRoutes(
  app: FastifyInstance,
  {
    store,
    meta,
    run,
    control,
    entities,
    productsDir,
    sam3d = null,
  }: {
    store: EvidenceStore;
    meta: MetaAdapter;
    run: Runner;
    control: Control;
    entities: (mode: Mode) => string[];
    /** Where looked-up products are kept, as the AI brush keeps them. */
    productsDir: string;
    /** SAM 3D on a masked crop, giving a splat's PLY bytes; null when it isn't set up. */
    sam3d?: ((crop: Buffer, signal?: AbortSignal) => Promise<Buffer>) | null;
  },
) {
  /**
   * Draft a fixture from a reference photo: one thing, filling most of the
   * frame. Its mask is cut out and modelled by the same fitter as objects,
   * and sized for the scene it is meant for. Nothing is saved; the draft
   * comes back for the person to name, choose a control for, and place.
   * Demo mode drafts from the bundled illustrations only.
   */
  app.post('/api/fixtures/draft', async (request) => {
    const input = parseInput(
      z
        .object({
          mode: modeSchema,
          scene: z.union([isoSceneKindSchema, z.literal('custom')]),
          /** Demo: one of the bundled pictures. */
          reference: z.enum(DEMO_REFERENCES).optional(),
          /** Live: the person's photo of the thing, or the desk photo a box is drawn on. */
          imageDataUrl: z.string().max(7_000_000).optional(),
          /**
           * A box drawn around the thing on a desk photo, in thousandths: the
           * live photo sent with it, or the demo camera's frame in the demo.
           */
          box: z
            .object({
              x1: z.number().int().min(0).max(1000),
              y1: z.number().int().min(0).max(1000),
              x2: z.number().int().min(0).max(1000),
              y2: z.number().int().min(0).max(1000),
            })
            .strict()
            .refine((b) => b.x2 > b.x1 && b.y2 > b.y1, { message: 'The box must have an area.' })
            .optional(),
          /** What the person says it is; Spark is told, and it names the draft. */
          label: z.string().trim().min(1).max(40).optional(),
        })
        .strict(),
      request.body,
    );
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
    if (live && !meta.canAfford(fixtureDraftCeiling()))
      throw new LabError(
        'spend_limit',
        `A fixture draft could cost up to $${fixtureDraftCeiling().toFixed(3)}, which would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.`,
        429,
      );
    const event = await run('fixture', mode, async (id) => {
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
        const named = await meta.fixtureClass(
          `data:image/png;base64,${shown.toString('base64')}`,
          input.label,
        );
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
      const label = input.label ?? cls.label;
      const crop = await maskedCrop(png, detection);
      const referenceAsset = store.asset(id, 'reference.png', shown ?? png);
      const cropAsset = store.asset(id, 'item-crop.png', crop.png);
      // 3. The same modelling as objects: part masks and Spark's check when live.
      const drafted = await draftModel(meta, store, id, {
        crop,
        cropUrl: `data:image/png;base64,${crop.png.toString('base64')}`,
        label,
        archetype: cls.archetype,
        material: cls.material,
        // A desk photo is taken from the pinned camera; a photo of one thing, from above.
        elevation: input.box ? pinElevation(store.memory(mode), mode) : null,
        live,
        knownHeight: cls.sizeCm.h / Math.max(cls.sizeCm.w, cls.sizeCm.d),
      });
      if (drafted.usage)
        usage = usage
          ? {
              inputTokens: usage.inputTokens + drafted.usage.inputTokens,
              outputTokens: usage.outputTokens + drafted.usage.outputTokens,
              totalTokens: usage.totalTokens + drafted.usage.totalTokens,
            }
          : drafted.usage;
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
    return { run: event, draft: event.output as FixtureDraft };
  });
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
  app.post('/api/fixtures/scan', async (request) => {
    const { mode, imageDataUrl, scene, replace, jobId } = parseInput(
      z
        .object({
          mode: modeSchema,
          imageDataUrl: z.string().max(7_000_000).optional(),
          /** The scene to map into; the pin's own when left out. */
          scene: z.union([isoSceneKindSchema, z.literal('custom')]).optional(),
          /** Move fixtures placed by hand too, to where the scan finds them. */
          replace: z.boolean().optional(),
          /** The page's id for following the steps as they go. */
          jobId: z.string().uuid().optional(),
        })
        .strict(),
      request.body,
    );
    const live = mode === 'live';
    if (!live && imageDataUrl)
      throw new LabError('demo_image', 'Demo mode scans only the demo room’s camera.');
    const before = store.memory(mode);
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
    const ceiling = sparkCeiling(SPARK_BUDGET.fixtureScan, 1) + META_PRICES.samPerImage;
    if (live && !meta.canAfford(ceiling))
      throw new LabError(
        'spend_limit',
        `A scan could cost up to $${ceiling.toFixed(3)}, which would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.`,
        429,
      );
    const job = jobs.start(jobId, SCAN_STEPS, { title: 'Scanning and mapping', mode });
    return following(job, async () => {
      job.run('photo');
      const image = live
        ? await validateImage(imageDataUrl ?? (await roomPhoto(before, store)))
        : null;
      // Things are mapped through the pin by where they are in the frame, so the
      // photo must be the shape of the one the pin was set on.
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
      const tracked = [before.object?.label, ...(before.others ?? []).map((o) => o.label)].filter(
        (l): l is string => Boolean(l),
      );
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
      // What each fitted model was fitted to, by its place in the scan.
      const fits: ({ fit: ItemFitRecord; swatches: Swatch[] } | undefined)[] = [];
      const event = await run('fixture', mode, async (id) => {
        job.link(id);
        // 1. Spark lists what stays put, each with a loose box.
        job.run('list');
        const result = image
          ? await meta.fixtureScan(image.dataUrl, tracked, job.signal)
          : { output: demoFixtureScan, model: 'demo', requestId: null, usage: null };
        job.check();
        const scan: FixtureScan = result.output;
        let usage: Usage | null = result.usage;
        await job.done(
          'list',
          scan.things.length
            ? `${scan.things.length} thing${scan.things.length === 1 ? '' : 's'}: ${scan.things.map((t) => t.label).join(', ')}`
            : 'Nothing that stays put',
          await listedPreview(png, frame, scan.things),
          SCAN_PREVIEW,
        );
        const assets = image ? [store.asset(id, 'source.png', image.bytes)] : [];
        // 2. SAM outlines every thing from Spark's box, in one call.
        job.run('outline');
        const outlined = await outlinedThings(
          { meta, store },
          scan,
          frame,
          image?.dataUrl ?? null,
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
        // 3. Each outline is modelled by the fitter, with no further calls.
        job.run('model');
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
          // Live help (part masks, Spark's check) for what is big enough to judge, while
          // today's limit covers it; a thing a few pixels across wants a close photo instead.
          const helped =
            Boolean(image) &&
            Math.max(crop.width, crop.height) >= CHECKED_CROP_PX &&
            meta.canAfford(modelCeiling(thing.archetype));
          const request = {
            crop,
            cropUrl: `data:image/png;base64,${crop.png.toString('base64')}`,
            label,
            archetype: thing.archetype,
            material: thing.material,
            elevation: pinElevation(memory, mode),
            knownHeight: thing.sizeCm.h / Math.max(thing.sizeCm.w, thing.sizeCm.d),
          };
          // The help only helps: when it fails, this thing is fitted locally and the scan goes on.
          const drafted = helped
            ? await draftModel(meta, store, id, { ...request, live: true }).catch(
                async (e: unknown) => {
                  job.check();
                  const local = await draftModel(meta, store, id, { ...request, live: false });
                  local.assists.push(
                    `Spark's check failed (${e instanceof Error ? e.message : 'it failed'}): fitted locally`,
                  );
                  return local;
                },
              )
            : await draftModel(meta, store, id, { ...request, live: false });
          models.push(drafted.item);
          usage = sumUsage(usage, drafted.usage);
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
        const fitted = models.filter(Boolean).length;
        await job.done(
          'model',
          fitted
            ? `${fitted} model${fitted === 1 ? '' : 's'} fitted to their outlines`
            : 'No outlines to fit',
        );
        // 4. Each is mapped through the pin onto the scene.
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
        });
        await job.done(
          'map',
          mappedSummary(mapped),
          await placedPreview(png, frame, mapped),
          SCAN_PREVIEW,
        );
        return { ...result, usage, output: { scan, mapped }, assets };
      });
      // Stopped while the last step ran: nothing is saved.
      job.check();
      job.run('save');
      const { mapped } = event.output as { scan: FixtureScan; mapped: MappedThing[] };
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
      store.saveMemory(memory);
      await job.done(
        'save',
        `${memory.fixtures.length} fixture${memory.fixtures.length === 1 ? '' : 's'} in the workspace`,
      );
      job.finish();
      return { run: event, mapped, memory };
    });
  });
  /**
   * Model a fixture in our own parts with Spark, starting from its current
   * model and the picture of it: its cut-out from the room's picture when it
   * was lifted, else the crop its model was fitted to, else the crop of it a
   * room draft kept (seen from the room's camera). Spark revises the parts
   * against a render of the model (one call), then once more against a render
   * of its own draft (a second), and the draft whose silhouette matches the
   * picture better is kept, with any parts the person locked. Live only.
   */
  app.post('/api/fixtures/sculpt', async (request) => {
    const { mode, fixtureId, jobId, note } = parseInput(
      z
        .object({
          mode: modeSchema,
          fixtureId: z.string().uuid(),
          /** The page's id for following the steps as they go. */
          jobId: z.string().uuid().optional(),
          /** What the person says it is or wants of it: "it's a Dyson bladeless fan". */
          note: z.string().trim().min(1).max(300).optional(),
        })
        .strict(),
      request.body,
    );
    if (mode !== 'live')
      throw new LabError(
        'sculpt_demo',
        'Modelling with AI asks Spark, so it runs in Live mode. The demo’s fixtures keep their fitted models.',
      );
    const memory = store.memory(mode);
    const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
    if (!fixture) throw new LabError('fixture_missing', 'That fixture is gone.', 404);
    // The picture of it: its cut-out, or its own or a linked copy's, else its fitted crop,
    // else the room draft's crop, looked at from where the room's camera is.
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
    // A note is looked up as a product first: the catalog, then the web.
    const ceiling =
      2 * sparkCeiling(SPARK_BUDGET.sculpt, 2) +
      (note
        ? sparkCeiling(SPARK_BUDGET.productLookup, 0) +
          SEARCH_CEILING * META_PRICES.webSearchPerQuery
        : 0);
    if (!meta.canAfford(ceiling))
      throw new LabError(
        'spend_limit',
        `Modelling it could cost up to $${ceiling.toFixed(3)}, which would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.`,
        429,
      );
    const png = pictured.png;
    const { elevation } = pictured;
    const input = await cropInput(png, fixture.label);
    const greyscale = await isGreyscale(png);
    const shown = async (b: Buffer) =>
      `data:image/png;base64,${(await sharp(b).flatten({ background: SCULPT_BACKDROP }).png().toBuffer()).toString('base64')}`;
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
      if (note) {
        job.run('lookup');
        const web: Researcher = {
          kind: 'web',
          lookup: async (q, need) => {
            const r = await meta.lookupProduct(q, need, job.signal);
            usage = sumUsage(usage, r.usage);
            return r.output.facts;
          },
        };
        // The lookup only helps: when it fails, Spark models from the note and the picture.
        let failed: string | null = null;
        const found = await research(
          note,
          ['parts', 'colors'],
          [new Catalog([productsDir, BUNDLED_CATALOG]), web],
          { signal: job.signal },
        ).catch((e: unknown) => {
          job.check();
          failed = e instanceof Error ? e.message : 'It failed.';
          return null;
        });
        job.check();
        facts = found?.facts.sources.length ? found.facts : null;
        // What the web found is kept, so the same thing next time comes from the catalog.
        if (facts?.origin.name === 'web' || facts?.origin.size === 'web')
          try {
            new Catalog([productsDir, BUNDLED_CATALOG]).save({ ...facts, query: note });
          } catch {
            /* keeping it is a convenience; the model doesn't depend on it */
          }
        const real = facts && productSize(facts, activeSize);
        if (real) {
          productTiles = real;
          size = proportions(real);
        }
        await job.done(
          'lookup',
          facts && found
            ? `${facts.name ?? 'Found it'} (${found.asked.map((a) => `${a.kind}${a.found ? ' ✓' : ' –'}`).join(' · ')})`
            : failed
              ? `Couldn’t look it up (${failed}); modelling from your note and the picture`
              : 'Nothing found; modelling from your note and the picture',
        );
      }
      const context = { note: note ?? null, facts, greyscale };
      const drafts: { item: IsoItem; iou: number; note: string; round: number }[] = [];
      let from: IsoItem = { label: activeModel.label, parts: activeModel.parts };
      job.run('current');
      let render = await viewPng(from, elevation, input.width);
      assets.push(store.asset(id, 'render-1.png', render));
      await job.done(
        'current',
        `${parts(from.parts.length)}, ${overlap(scoreAgainst(from, input, elevation).iou)}`,
        render,
      );
      for (const round of [1, 2]) {
        const step = round === 1 ? 'draft' : 'check';
        job.run(step);
        const answer = await meta.sculpt(
          await shown(png),
          await shown(render),
          round === 1
            ? sculptPrompt(fixture.label, size, context)
            : sculptCheckPrompt(fixture.label, context),
          JSON.stringify(toSculpt(from)),
          job.signal,
        );
        job.check();
        usage = sumUsage(usage, answer.usage);
        model = answer.model;
        requestId = answer.requestId;
        const item = fromSculpt(activeModel.label, answer.output);
        if (!item) {
          await job.done(step, 'No usable parts came back');
          break;
        }
        const iou = scoreAgainst(item, input, elevation).iou;
        drafts.push({ item, iou, note: answer.output.note, round });
        from = item;
        render = await viewPng(item, elevation, input.width);
        assets.push(store.asset(id, `render-${round + 1}.png`, render));
        await job.done(
          step,
          `${parts(item.parts.length)}, ${overlap(iou)}. ${answer.output.note}`,
          render,
        );
      }
      job.run('keep');
      const best = [...drafts].sort((a, b) => b.iou - a.iou)[0];
      if (!best)
        throw new LabError(
          'sculpt_empty',
          `Spark’s model of the ${fixture.label.toLowerCase()} had no usable parts. Try again.`,
          502,
        );
      const item = keepLocked(best.item, activeModel);
      const final = await viewPng(item, elevation, input.width);
      assets.push(store.asset(id, 'render-final.png', final));
      const kept = item.parts.length - best.item.parts.length;
      await job.done(
        'keep',
        `${best.round === 1 ? 'The first draft' : 'The checked draft'}, ${overlap(best.iou)}` +
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
      const out = event.output as { item: IsoItem; size?: FixtureInput['size'] };
      // The looked-up product's size, where each view keeps its size now, laid along its own longer side.
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
        swatches: activeModel.swatches,
        updatedAt: now,
        fit: null,
      };
      // The same thing in its other scenes takes the same model.
      const fresh = store.memory(mode);
      fresh.fixtures = (fresh.fixtures ?? []).map((f) =>
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
  });
  /**
   * Another photo of a fixture, usually a close one of a thing the room's
   * camera sees too small to model well: outlined and fitted as a draft is,
   * then fused with the fits it already has, counted for more the larger its
   * crop is than the last one's. Its crop becomes the fixture's picture. The
   * demo uses its own close photos: the mug's, or a bundled picture by name.
   */
  app.post('/api/fixtures/photo', async (request) => {
    const { mode, fixtureId, imageDataUrl } = parseInput(
      z
        .object({
          mode: modeSchema,
          fixtureId: z.string().uuid(),
          imageDataUrl: z.string().max(7_000_000).optional(),
        })
        .strict(),
      request.body,
    );
    const live = mode === 'live';
    if (live !== Boolean(imageDataUrl))
      throw new LabError(
        'demo_image',
        live ? 'Send a photo of the fixture.' : 'Demo mode uses its own close photos, not uploads.',
      );
    const memory = store.memory(mode);
    const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
    if (!fixture) throw new LabError('fixture_missing', 'That fixture is gone.', 404);
    if (live && !meta.canAfford(fixtureDraftCeiling()))
      throw new LabError(
        'spend_limit',
        `Fitting another photo could cost up to $${fixtureDraftCeiling().toFixed(3)}, which would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.`,
        429,
      );
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
        cropUrl: `data:image/png;base64,${crop.png.toString('base64')}`,
        label: fixture.label,
        archetype,
        material: cls?.material ?? null,
        elevation: null,
        live,
        knownHeight: size.h / Math.max(size.w, size.d),
      });
      usage = sumUsage(usage, drafted.usage);
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
    const saved = (event.output as { model: SavedItem }).model;
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
  app.post('/api/fixtures/refine3d', async (request) => {
    const { mode, fixtureId, jobId } = parseInput(
      z
        .object({ mode: modeSchema, fixtureId: z.string().uuid(), jobId: z.string().uuid() })
        .strict(),
      request.body,
    );
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
      const out = event.output as {
        kept: boolean;
        iou: number;
        deltaE: number;
        item: IsoItem;
        shaped: LatheFit;
      };
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
  app.post('/api/fixtures/choose', async (request) => {
    const { mode, fixtureId, draft } = parseInput(
      z
        .object({
          mode: modeSchema,
          fixtureId: z.string().uuid(),
          draft: z
            .number()
            .int()
            .min(0)
            .max(MAX_DRAFTS - 1),
        })
        .strict(),
      request.body,
    );
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
  /** Where a long job the page follows has got to. */
  app.get('/api/jobs/:id', async (request) => {
    const { id } = parseInput(z.object({ id: z.string().uuid() }).strict(), request.params);
    const job = jobs.get(id);
    if (!job) throw new LabError('job_missing', 'That job isn’t running here.', 404);
    return job;
  });
  /** Stop a job the page is following: its running call is aborted and nothing more is saved. */
  app.post('/api/jobs/:id/stop', async (request) => {
    const { id } = parseInput(z.object({ id: z.string().uuid() }).strict(), request.params);
    if (!jobs.stop(id)) throw new LabError('job_missing', 'That job isn’t running here.', 404);
    return jobs.get(id);
  });
  app.post('/api/fixtures/save', async (request) => {
    const { mode, fixture: input } = parseInput(
      z.object({ mode: modeSchema, fixture: fixtureInputSchema }).strict(),
      request.body,
    );
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
    if (entity && !entities(mode).includes(entity))
      throw new LabError('fixture_entity', 'Choose one of the configured lights or switches.', 400);
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
    const { id: _id, model, room: roomInput, states: statesInput, ...rest } = input;
    // Its own place in the room's view: kept unless the save says otherwise, null clears it.
    const room = roomInput === undefined ? previous?.room : roomInput;
    // What the model was drafted as: the fixture before, or the draft it came from.
    const drafted =
      referenceRun?.kind === 'fixture' && referenceRun.status === 'completed'
        ? (referenceRun.output as FixtureDraft)
        : undefined;
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
      // A new entity starts with no known state; a pet starts in its default pose.
      state: previous
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
      ...(previous?.drafts?.length ? { drafts: previous.drafts } : {}),
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
                  state: fixture.state ?? null,
                  updatedAt: now,
                }
              : f,
        )
      : [...fixtures, fixture];
    store.saveMemory(memory);
    return memory;
  });
  /**
   * The photo a drafted room's pin was set on, at the pin's frame size, for
   * checking the pin's corners on it after the page has lost its photo.
   */
  app.get('/api/scene/photo', async (request, reply) => {
    const { mode } = parseInput(z.object({ mode: modeSchema }).strict(), request.query);
    const memory = store.memory(mode);
    const bytes = mode === 'live' ? roomPhotoBytes(memory, store) : null;
    if (!bytes || !memory.surface)
      throw new LabError('photo_missing', 'This room has no photo of its own kept.', 404);
    const { width, height } = memory.surface.frame;
    // A photo of another shape is from another camera: stretched, its desk would
    // pass for the pinned camera's, and the pin would be dragged onto the wrong view.
    const size = await sharp(bytes).metadata();
    if (Math.abs(size.width! / size.height! - width / height) > 0.02 * (width / height))
      throw new LabError(
        'photo_shape',
        `The room’s photo is ${size.width}×${size.height}, and the pin was set on ${width}×${height} frames from another camera. Start that camera to check the pin on what it shows.`,
        409,
      );
    const png = await sharp(bytes).resize(width, height, { fit: 'fill' }).png().toBuffer();
    return reply.type('image/png').header('cache-control', 'no-cache').send(png);
  });
  /** The reference photo a fixture was drafted from, for review and the inspector. */
  app.get('/api/fixtures/reference', async (request, reply) => {
    const { runId } = parseInput(z.object({ runId: z.string().uuid() }).strict(), request.query);
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
  app.post('/api/fixtures/find', async (request) => {
    const { mode, id, imageDataUrl } = parseInput(
      z
        .object({
          mode: modeSchema,
          id: z.string().uuid(),
          imageDataUrl: z.string().max(7_000_000).optional(),
        })
        .strict(),
      request.body,
    );
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
    if (mode === 'demo' && imageDataUrl)
      throw new LabError('demo_image', 'Demo mode uses only the demo room’s camera.');
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
        image.dataUrl,
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
          store.asset(runId, 'source.png', image.bytes),
          store.asset(runId, 'sam-output.txt', outlined.raw),
        ],
      };
    });
  });
  /** Delete one fixture, or several at once (`fixtureIds`), in one save. */
  app.post('/api/fixtures/delete', async (request) => {
    const { mode, fixtureId, fixtureIds, dismiss } = parseInput(
      z
        .object({
          mode: modeSchema,
          fixtureId: z.string().uuid().optional(),
          fixtureIds: z.array(z.string().uuid()).min(1).max(MAX_FIXTURES).optional(),
          dismiss: z.boolean().optional(),
        })
        .strict()
        .refine((b) => Boolean(b.fixtureId) !== Boolean(b.fixtureIds), {
          message: 'Give fixtureId or fixtureIds.',
        }),
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
  app.post('/api/fixtures/release', async (request) => {
    const { mode, scene } = parseInput(
      z
        .object({ mode: modeSchema, scene: z.union([isoSceneKindSchema, z.literal('custom')]) })
        .strict(),
      request.body,
    );
    const memory = store.memory(mode);
    for (const f of memory.fixtures ?? []) if (f.scene === scene) f.scanned = true;
    store.saveMemory(memory);
    return memory;
  });
  /** Let scans find a dismissed name again. */
  app.post('/api/fixtures/undismiss', async (request) => {
    const { mode, label } = parseInput(
      z.object({ mode: modeSchema, label: z.string().min(1).max(40) }).strict(),
      request.body,
    );
    const memory = store.memory(mode);
    memory.dismissed = (memory.dismissed ?? []).filter((d) => d !== label);
    store.saveMemory(memory);
    return memory;
  });
  /**
   * Switch a fixture's active state, or add/edit/remove a custom state with its
   * own unique fixture model, size or reference.
   */
  app.post('/api/fixtures/state', async (request) => {
    const {
      mode,
      fixtureId,
      state,
      fixture: stateInput,
      remove,
    } = parseInput(
      z
        .object({
          mode: modeSchema,
          fixtureId: z.string().uuid(),
          state: fixtureStateNameSchema.nullable().optional(),
          fixture: fixtureStateInputSchema.optional(),
          remove: fixtureStateNameSchema.optional(),
        })
        .strict(),
      request.body,
    );
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
  app.post('/api/fixtures/control', async (request) => {
    const { mode, fixtureId, entityId, action } = parseInput(
      z
        .object({
          mode: modeSchema,
          fixtureId: z.string().uuid().optional(),
          entityId: entityIdSchema.optional(),
          action: fixtureStateNameSchema,
        })
        .strict()
        .refine((x) => Boolean(x.fixtureId) !== Boolean(x.entityId), {
          message: 'Name a fixture or an entity, not both.',
        }),
      request.body,
    );
    let entity = entityId ?? null;
    if (fixtureId) {
      const memory = store.memory(mode);
      const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
      if (!fixture)
        throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
      entity = fixtureEntity(fixture);
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
    noteControl(memory, event.output as LampResult);
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
