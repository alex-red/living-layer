import { randomUUID } from 'node:crypto';
import {
  fixtureOutput,
  fixturesScanBodySchema,
  DEMO_SURFACE,
  layoutThings,
  mapScan,
  withLayoutMoves,
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
  uniqueParts,
  type DeskMemory,
  type Detection,
  type Fixture,
  type Usage,
  type Mode,
  type IsoSceneKind,
  addUsage,
} from '@livinglayer/domain';
import sharp from 'sharp';
import { LabError, liveImage } from '../errors.js';
import { following, type JobTracker } from '../jobs.js';
import { listedPreview, outlinedPreview, placedPreview } from '../scan-preview.js';
import { demoFixtureScan, demoPhotoSegmentation } from '../demo.js';
import {
  maskedCrop,
  samDataUrl,
  toDataUrl,
  validateImage,
  type ValidatedImage,
} from '../images.js';
import { demoPhoto, draftModel, pinElevation } from '../item.js';
import { type RouteDeps } from '../route-deps.js';
import { SPARK_BUDGET, type MetaAdapter } from '../meta.js';
import { type EvidenceStore } from '../store.js';
import { roomPhotoBytes, type Parsed } from './shared.js';

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

export async function scanFixtures(
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
    const { mapped, scan } = fixtureOutput.scan(event)!;
    const { memory, count } = saveScanned(store, mode, target, mapped, fits);
    await job.done('save', `${count} fixture${count === 1 ? '' : 's'} in the workspace`);
    job.finish();
    // Things that move aren't saved: the page follows each as an object, if asked.
    return { run: event, mapped, memory, moving: scan.moving ?? [] };
  });
}
