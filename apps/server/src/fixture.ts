import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DEMO_REFERENCES,
  DEMO_SURFACE,
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
  fixtureEntity,
  fixtureInputSchema,
  fixtureProblem,
  modeSchema,
  uniqueParts,
  fromSculpt,
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
  type LampResult,
  type Mode,
  type Segmentation,
  type Usage,
} from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import { Jobs } from './jobs.js';
import sharp from 'sharp';
import {
  demoDeskThing,
  demoFixtureClass,
  demoFixtureScan,
  demoPhotoSegmentation,
  demoReference,
} from './demo.js';
import { maskedCrop, validateImage } from './images.js';
import {
  cropInput,
  demoPhoto,
  draftModel,
  keepLocked,
  pinElevation,
  rescore,
  viewPng,
  type Runner,
} from './item.js';
import { SPARK_BUDGET, type MetaAdapter } from './meta.js';
import type { EvidenceStore } from './store.js';

/** The room picture is drawn in 2:1 isometric, so a level square shows half as deep as it is wide. */
const ISO_ELEVATION = 30;
/** What a picture with a transparent background is laid on for Spark: a neutral grey. */
const SCULPT_BACKDROP = '#8a8f9f';
/** What modelling a fixture with AI shows while it runs, in order. */
const SCULPT_STEPS = [
  { id: 'picture', label: 'The picture of it' },
  { id: 'current', label: 'Its model as it is' },
  { id: 'draft', label: 'Spark drafts it in parts' },
  { id: 'check', label: 'Spark checks its draft' },
  { id: 'keep', label: 'Keep the better draft' },
  { id: 'save', label: 'Save it' },
];
/** Long jobs the page is following. */
const jobs = new Jobs();
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
const fixtureDraftCeiling = () =>
  sparkCeiling(SPARK_BUDGET.fixtureClass, 1) +
  3 * META_PRICES.samPerImage +
  sparkCeiling(SPARK_BUDGET.itemCheck, 2);

/** The part of a photo around a box, with a margin, for Spark and for review. */
async function around(
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
 * boxes live (one call), or the illustrated desk's own outlines in the demo,
 * matched by how much they overlap the box. Null where nothing was outlined.
 */
async function outlinedThings(
  { meta, store }: { meta: MetaAdapter; store: EvidenceStore },
  scan: FixtureScan,
  frame: { width: number; height: number },
  dataUrl: string | null,
  runId: string,
  assets: string[],
): Promise<(Detection | null)[]> {
  const boxes = scan.things.map((t) => promptBox(t, frame));
  let detections: Detection[];
  if (dataUrl) {
    const prompts = boxes.flatMap((box, i) => (box ? [{ id: i + 1, box }] : []));
    if (!prompts.length) return scan.things.map(() => null);
    const outlined = await meta.segmentBoxes(dataUrl, prompts, frame.width, frame.height);
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
  }: {
    store: EvidenceStore;
    meta: MetaAdapter;
    run: Runner;
    control: Control;
    entities: (mode: Mode) => string[];
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
           * live photo sent with it, or the illustrated desk in the demo.
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
          : 'Demo mode drafts from a bundled picture or a box on the illustrated desk.',
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
      const draft: FixtureDraft = {
        label,
        archetype: drafted.fitted.archetype,
        suggested: cls.control,
        description: cls.description,
        model: {
          ...uniqueParts(drafted.item),
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
            assists: [
              `${live ? 'Spark' : 'Demo'}: ${cls.archetype}, ${cls.material}. ${cls.description}`,
              ...drafted.assists,
            ],
          },
        },
        size: sizeInTiles(cls.sizeCm, scene, custom),
        reference: { runId: id, asset: referenceAsset },
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
   * illustrated desk, which fills the frame, with no model call.
   */
  app.post('/api/fixtures/scan', async (request) => {
    const { mode, imageDataUrl, scene, replace } = parseInput(
      z
        .object({
          mode: modeSchema,
          imageDataUrl: z.string().max(7_000_000).optional(),
          /** The scene to map into; the pin's own when left out. */
          scene: z.union([isoSceneKindSchema, z.literal('custom')]).optional(),
          /** Move fixtures placed by hand too, to where the scan finds them. */
          replace: z.boolean().optional(),
        })
        .strict(),
      request.body,
    );
    const live = mode === 'live';
    if (!live && imageDataUrl)
      throw new LabError('demo_image', 'Demo mode scans only the illustrated desk.');
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
        `The pin was set on a ${pin.frame.width}×${pin.frame.height} frame, and this photo is ${image.width}×${image.height}. Scan a frame from the pinned camera, or pin the surface again on this photo.`,
        409,
      );
    const tracked = [before.object?.label, ...(before.others ?? []).map((o) => o.label)].filter(
      (l): l is string => Boolean(l),
    );
    // What each fitted model was fitted to, by its place in the scan.
    const fits: ({ fit: ItemFitRecord; swatches: Swatch[] } | undefined)[] = [];
    const event = await run('fixture', mode, async (id) => {
      const result = image
        ? await meta.fixtureScan(image.dataUrl, tracked)
        : { output: demoFixtureScan, model: 'demo', requestId: null, usage: null };
      const scan: FixtureScan = result.output;
      const assets = image ? [store.asset(id, 'source.png', image.bytes)] : [];
      // 2. SAM outlines every thing from Spark's box, in one call.
      const png = image ? image.bytes : await demoPhoto();
      const frame = image
        ? { width: image.width, height: image.height }
        : { width: 960, height: 640 };
      const outlined = await outlinedThings(
        { meta, store },
        scan,
        frame,
        image?.dataUrl ?? null,
        id,
        assets,
      );
      // 3. Each outline is modelled by the fitter, with no further calls.
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
        const drafted = await draftModel(meta, store, id, {
          crop,
          cropUrl: `data:image/png;base64,${crop.png.toString('base64')}`,
          label,
          archetype: thing.archetype,
          material: thing.material,
          elevation: pinElevation(memory, mode),
          live: false,
          knownHeight: thing.sizeCm.h / Math.max(thing.sizeCm.w, thing.sizeCm.d),
        });
        models.push(drafted.item);
        fits[i] = {
          fit: {
            archetype: drafted.fitted.archetype,
            params: drafted.params,
            iou: drafted.score.iou,
            deltaE: drafted.score.deltaE,
            elevation: drafted.fitted.elevation,
            views: 1,
            crop: cropAsset,
            assists: [
              `Scan: ${thing.archetype}, ${thing.material}, outlined by SAM`,
              ...drafted.assists,
            ],
          },
          swatches: drafted.fitted.swatches,
        };
      }
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
      return { ...result, output: { scan, mapped }, assets };
    });
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
      const { model, ...rest } = m.fixture;
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
          state: null,
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
    return { run: event, mapped, memory };
  });
  /**
   * Model a fixture in our own parts with Spark, starting from its current
   * model and the picture of it: its cut-out from the room's picture when it
   * was lifted, else the crop its model was fitted to. Spark revises the parts
   * against a render of the model (one call), then once more against a render
   * of its own draft (a second), and the draft whose silhouette matches the
   * picture better is kept, with any parts the person locked. Live only.
   */
  app.post('/api/fixtures/sculpt', async (request) => {
    const { mode, fixtureId, jobId } = parseInput(
      z
        .object({
          mode: modeSchema,
          fixtureId: z.string().uuid(),
          /** The page's id for following the steps as they go. */
          jobId: z.string().uuid().optional(),
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
    // The picture of it: its cut-out, or its own or a linked copy's, else its fitted crop.
    const group = new Set([
      fixture.id,
      ...linkedFixtures(memory.fixtures ?? [], fixture).map((f) => f.id),
    ]);
    const sprite = memory.illustration?.layers?.sprites.find((x) => group.has(x.fixtureId));
    const crop = fixture.model.fit?.crop;
    const pictured = sprite
      ? { png: store.readAsset(sprite.asset), elevation: ISO_ELEVATION }
      : crop
        ? { png: store.readAsset(crop), elevation: fixture.model.fit!.elevation }
        : null;
    if (!pictured?.png)
      throw new LabError(
        'sculpt_picture',
        `There is no picture of the ${fixture.label.toLowerCase()} to model it from. Lift the fixtures off the room’s picture, or draft it from a photo.`,
        409,
      );
    const ceiling = 2 * sparkCeiling(SPARK_BUDGET.sculpt, 2);
    if (!meta.canAfford(ceiling))
      throw new LabError(
        'spend_limit',
        `Modelling it could cost up to $${ceiling.toFixed(3)}, which would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.`,
        429,
      );
    const png = pictured.png;
    const { elevation } = pictured;
    const input = await cropInput(png, fixture.label);
    const shown = async (b: Buffer) =>
      `data:image/png;base64,${(await sharp(b).flatten({ background: SCULPT_BACKDROP }).png().toBuffer()).toString('base64')}`;
    const longest = Math.max(fixture.size.w, fixture.size.d);
    const size = {
      w: fixture.size.w / longest,
      d: fixture.size.d / longest,
      h: fixture.size.h / longest,
    };
    const job = jobs.start(jobId, SCULPT_STEPS);
    const overlap = (iou: number) => `${Math.round(iou * 100)}% overlap with the picture`;
    const parts = (n: number) => `${n} part${n === 1 ? '' : 's'}`;
    const sculptSteps = async (id: string) => {
      const assets = [store.asset(id, 'picture.png', png)];
      await job.done(
        'picture',
        sprite ? 'Its cut-out from the room’s picture' : 'The photo crop its model was fitted to',
        png,
      );
      let usage: Usage | null = null;
      let model: string | undefined;
      let requestId: string | null = null;
      const drafts: { item: IsoItem; iou: number; note: string; round: number }[] = [];
      let from: IsoItem = { label: fixture.model.label, parts: fixture.model.parts };
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
          round === 1 ? sculptPrompt(fixture.label, size) : sculptCheckPrompt(fixture.label),
          JSON.stringify(toSculpt(from)),
        );
        usage = sumUsage(usage, answer.usage);
        model = answer.model;
        requestId = answer.requestId;
        const item = fromSculpt(fixture.model.label, answer.output);
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
      const item = keepLocked(best.item, fixture.model);
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
        },
        model,
        requestId,
        usage,
        assets,
      };
    };
    const event = await run('fixture', mode, async (id) => {
      try {
        return await sculptSteps(id);
      } catch (error) {
        // The step that was running shows what went wrong; the run records it too.
        job.fail(error instanceof Error ? error.message : 'Modelling failed.');
        throw error;
      }
    });
    const out = event.output as { item: IsoItem };
    const now = new Date().toISOString();
    const saved: SavedItem = {
      ...out.item,
      source: 'spark',
      segmentRunId: null,
      swatches: fixture.model.swatches,
      updatedAt: now,
      fit: null,
    };
    // The same thing in its other scenes takes the same model.
    const fresh = store.memory(mode);
    fresh.fixtures = (fresh.fixtures ?? []).map((f) =>
      group.has(f.id) ? { ...f, model: saved, updatedAt: now } : f,
    );
    store.saveMemory(fresh);
    await job.done(
      'save',
      `Saved${group.size > 1 ? ` here and in ${group.size - 1} linked view${group.size > 2 ? 's' : ''}` : ''}`,
    );
    job.finish();
    return { memory: fresh, run: event };
  });
  /** Where a long job the page follows has got to. */
  app.get('/api/jobs/:id', async (request) => {
    const { id } = parseInput(z.object({ id: z.string().uuid() }).strict(), request.params);
    const job = jobs.get(id);
    if (!job) throw new LabError('job_missing', 'That job isn’t running here.', 404);
    return job;
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
        'The reference photo is not one of the lab’s runs.',
        400,
      );
    const now = new Date().toISOString();
    const { id: _id, model, ...rest } = input;
    // What the model was drafted as: the fixture before, or the draft it came from.
    const base =
      previous?.model ??
      (referenceRun?.kind === 'fixture' && referenceRun.status === 'completed'
        ? (referenceRun.output as FixtureDraft).model
        : undefined);
    const fixture: Fixture = {
      ...rest,
      id: previous?.id ?? randomUUID(),
      model: {
        ...uniqueParts(model),
        source: base?.source ?? (mode === 'demo' ? 'demo' : 'sampled'),
        segmentRunId: base?.segmentRunId ?? null,
        swatches: base?.swatches ?? [],
        updatedAt: now,
        // An edit keeps its fit record, scored again against the same crop.
        fit: await rescore(store, model, base?.fit),
      },
      // A new entity starts with no known state.
      state: previous && fixtureEntity(previous) === entity ? (previous.state ?? null) : null,
      ...(previous?.link ? { link: previous.link } : {}),
      // The camera keeps following it unless it was moved by hand.
      ...(previous?.track && samePlace(previous, input) ? { track: previous.track } : {}),
      ...(previous?.seen && samePlace(previous, input) ? { seen: previous.seen } : {}),
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
   * call). The demo picks the illustrated desk's outlines under that box.
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
      throw new LabError('demo_image', 'Demo mode uses only the bundled illustrated desk.');
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
  app.post('/api/fixtures/delete', async (request) => {
    const { mode, fixtureId, dismiss } = parseInput(
      z
        .object({ mode: modeSchema, fixtureId: z.string().uuid(), dismiss: z.boolean().optional() })
        .strict(),
      request.body,
    );
    const memory = store.memory(mode);
    const gone = memory.fixtures?.find((f) => f.id === fixtureId);
    if (dismiss && gone && !isDismissed(gone.label, memory.dismissed ?? []))
      memory.dismissed = [...(memory.dismissed ?? []), gone.label].slice(-MAX_DISMISSED);
    memory.fixtures = (memory.fixtures ?? []).filter((f) => f.id !== fixtureId);
    // Rules it decided go with it; rules that switched it keep their entity.
    memory.rules = (memory.rules ?? [])
      .filter((r) => r.objectId !== fixtureId)
      .map((r) => {
        if (r.fixtureId !== fixtureId) return r;
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
   * Switch a fixture's light or switch, or a configured entity directly: a
   * lamp that is part of the room's layout has no fixture of its own.
   */
  app.post('/api/fixtures/control', async (request) => {
    const { mode, fixtureId, entityId, action } = parseInput(
      z
        .object({
          mode: modeSchema,
          fixtureId: z.string().uuid().optional(),
          entityId: entityIdSchema.optional(),
          action: z.enum(['on', 'off']),
        })
        .strict()
        .refine((x) => Boolean(x.fixtureId) !== Boolean(x.entityId), {
          message: 'Name a fixture or an entity, not both.',
        }),
      request.body,
    );
    let entity = entityId ?? null;
    if (fixtureId) {
      const fixture = store.memory(mode).fixtures?.find((f) => f.id === fixtureId);
      if (!fixture)
        throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
      entity = fixtureEntity(fixture);
      if (!entity)
        throw new LabError('fixture_control', `The ${fixture.label} has nothing to switch.`, 400);
    } else if (!entities(mode).includes(entity!))
      throw new LabError('lamp_unknown', 'That entity is not one of the configured ones.', 409);
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
