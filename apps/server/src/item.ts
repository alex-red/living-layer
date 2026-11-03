import type { FastifyInstance } from 'fastify';
import { fitItemAsync } from './workers/compute.js';
import sharp from 'sharp';
import {
  runOutput,
  itemCropQuerySchema,
  itemDraftBodySchema,
  itemSaveBodySchema,
  itemRefitBodySchema,
  DEMO_POSITIONS,
  type DemoPosition,
  applyCheck,
  archetypeOf,
  buildItem,
  describeFit,
  fuseFits,
  isMugConcept,
  elevationAt,
  isoSurface,
  labRgb,
  modelTarget,
  renderView,
  scoreAgainst,
  setModel,
  uniqueParts,
  voxelize,
  type Archetype,
  type DeskMemory,
  type DeskObservation,
  type Detection,
  type EvidenceRun,
  type FitInput,
  type IsoItem,
  type ItemClass,
  type ItemFitRecord,
  type Mode,
  type SavedItem,
  type Usage,
  addUsage,
} from '@livinglayer/domain';
import { demoMugCloseUp, demoPng } from './demo.js';
import { LabError, parseInput } from './errors.js';
import { detectionBits, findSource, maskedCrop, toDataUrl } from './images.js';
import type { MetaAdapter } from './meta.js';
import { requestSignal } from './request-signal.js';
import type { RouteDeps } from './route-deps.js';
import type { EvidenceStore } from './store.js';

/** What a Spark class looks like offline: the demo mug is a glossy mug. */
const demoItemClass: ItemClass = {
  archetype: 'mug',
  material: 'gloss',
  description: 'A cream mug with coffee in it and a handle on the right.',
  backside: null,
};
/** SAM concepts worth asking for inside a crop, per archetype: parts the fitter can use. */
const PART_CONCEPTS: Partial<Record<Archetype, { handle?: string; inside?: string }>> = {
  mug: { handle: 'mug handle', inside: 'inside of the mug' },
  cup: { inside: 'inside of the cup' },
  plant: { inside: 'soil' },
};

/** The demo camera's frame: the office rendered from its corner, the mug at `position`. */
export const demoPhoto = (position: DemoPosition = 'centre') => demoPng(position);
/** The detection's masked crop, from the frame it was seen in. */
async function itemCrop(
  store: EvidenceStore,
  mode: Mode,
  segment: EvidenceRun,
  detection: Detection,
) {
  if (mode === 'demo') {
    const sourceKey = runOutput(segment, 'segment')?.sourceKey;
    const position = (sourceKey?.split('@')[1] ?? 'centre') as DemoPosition;
    // The demo mug is modelled from a close photo of it, as a person would take one.
    const close = await demoMugCloseUp(DEMO_POSITIONS[position] ? position : 'centre');
    return maskedCrop(close.png, close.detection);
  }
  const photo = findSource(segment.assets);
  const bytes = photo ? store.readAsset(photo) : null;
  if (!bytes) throw new LabError('item_source', 'The photo behind this sighting is missing.', 409);
  return maskedCrop(bytes, detection);
}

/**
 * A sighted thing's picture: the masked crop of its last sighting, seen from
 * the pinned camera's angle (or a desk camera's usual 30° without one).
 * Null when the segmentation behind the sighting is gone.
 */
export async function sightingPicture(
  store: EvidenceStore,
  mode: Mode,
  memory: DeskMemory,
  sighting: DeskObservation,
) {
  const segment = store.getRun(sighting.segmentRunId);
  const detection = runOutput(segment, 'segment')?.detections.find(
    (d) => d.objectId === sighting.detectionId,
  );
  if (!segment || !detection) return null;
  const crop = await itemCrop(store, mode, segment, detection);
  return { ...crop, elevation: pinElevation(memory, mode) ?? 30 };
}

/**
 * The camera's angle above the pinned surface. The calibrated room camera
 * knows it, at the surface's middle. Without one it is guessed from the pin:
 * a rectangle seen at elevation e looks sin(e) times as deep as it is, which
 * holds only for one seen square on (a desk seen corner on reads as seen from
 * above). Null without a pin of this frame, or for the demo, whose
 * illustration has no real camera.
 */
export function pinElevation(memory: DeskMemory, mode: Mode): number | null {
  const pin = memory.surface;
  if (mode === 'demo' || !pin) return null;
  const surface = isoSurface(pin.scene, pin.surfaceId, memory.scene);
  if (!surface) return null;
  const camera = pin.scene === 'custom' ? memory.camera?.camera : undefined;
  if (camera)
    return elevationAt(camera, {
      x: surface.rect.x + surface.rect.w / 2,
      y: surface.rect.y + surface.rect.d / 2,
      z: surface.z,
    });
  const [a, b, c, d] = pin.corners;
  const dist = (p: typeof a, q: typeof a) => Math.hypot(q.x - p.x, q.y - p.y);
  const width = (dist(a, b) + dist(d, c)) / 2;
  const depth = (dist(a, d) + dist(b, c)) / 2;
  const sin = depth / width / (surface.rect.d / surface.rect.w);
  return (Math.asin(Math.max(0.1, Math.min(1, sin))) * 180) / Math.PI;
}

/** The model drawn from the photo's camera in flat colours, as a PNG for Spark to compare. */
export async function viewPng(item: IsoItem, elevation: number, width: number): Promise<Buffer> {
  const view = renderView(voxelize(item.parts, { resolution: 48 }), { elevation, ppu: width });
  const rgba = Buffer.alloc(view.width * view.height * 4);
  for (let p = 0; p < view.width * view.height; p++) {
    if (!view.mask[p]) continue;
    const [r, g, b] = labRgb([view.lab[p * 3]!, view.lab[p * 3 + 1]!, view.lab[p * 3 + 2]!]);
    rgba.set(
      [r, g, b, 255].map((v) => Math.max(0, Math.min(255, Math.round(v)))),
      p * 4,
    );
  }
  return sharp(rgba, { raw: { width: view.width, height: view.height, channels: 4 } })
    .png()
    .toBuffer();
}
/** A saved crop back as fitter input. */
export async function cropInput(png: Buffer, label: string): Promise<FitInput> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8Array(data), width: info.width, height: info.height, label };
}
/** Keep the parts a person locked: they replace the fitted part of the same id, or join it. */
export function keepLocked(fitted: IsoItem, previous: IsoItem | null | undefined): IsoItem {
  const locked = previous?.parts.filter((p) => p.locked) ?? [];
  if (!locked.length) return fitted;
  const parts = fitted.parts.map((p) => locked.find((l) => l.id === p.id) ?? p);
  for (const l of locked) if (!parts.some((p) => p.id === l.id)) parts.push(l);
  return { ...fitted, parts: parts.slice(0, 12) };
}
/** Score an edited model against the crop its fit came from, if there is one. */
export async function rescore(
  store: EvidenceStore,
  item: IsoItem,
  fit: ItemFitRecord | null | undefined,
) {
  const png = fit?.crop ? store.readAsset(fit.crop) : null;
  if (!fit || !png) return fit ?? null;
  const score = scoreAgainst(item, await cropInput(png, item.label), fit.elevation);
  return { ...fit, ...score };
}

/** A masked crop and what is known about it, ready to model. */
interface ModelRequest {
  crop: Awaited<ReturnType<typeof maskedCrop>>;
  cropUrl: string;
  label: string;
  archetype: Archetype;
  material: ItemClass['material'] | null;
  elevation: number | null;
  /** Ask Meta's models for part masks and a check; off for the demo and `sampled`. */
  live: boolean;
  /** How tall it is as a share of its longer side, when its real size is known. */
  knownHeight?: number | null;
  /** Stops the SAM asks when the caller goes away. */
  signal?: AbortSignal;
}
/**
 * Model one masked crop. Live, SAM segments parts the fitter can use (a
 * handle, the liquid) inside the crop first. The local fitter measures the
 * model; live, Spark then compares a render with the photo and suggests
 * bounded corrections, kept only when the silhouette still matches.
 */
export async function draftModel(
  meta: MetaAdapter,
  store: EvidenceStore,
  runId: string,
  { crop, cropUrl, label, archetype, material, elevation, live, knownHeight, signal }: ModelRequest,
) {
  const assets: string[] = [];
  const assists: string[] = [];
  let usage: Usage | null = null;
  // 1. Part masks from SAM, inside the crop.
  const parts: FitInput['parts'] = {};
  if (live) {
    // The parts are asked together: each is its own SAM call on the same crop.
    const found = await Promise.all(
      Object.entries(PART_CONCEPTS[archetype] ?? {}).map(async ([key, concept]) => {
        const result = await meta.segment(cropUrl, concept, crop.width, crop.height, {
          ...(signal ? { signal } : {}),
        });
        return {
          key,
          concept,
          bits: await detectionBits(result.output.detections, crop.width, crop.height),
        };
      }),
    );
    for (const { key, concept, bits } of found) {
      parts[key as 'handle' | 'inside'] = bits;
      assists.push(`SAM: ${concept} ${bits ? 'found' : 'not found'}`);
    }
  }
  // 2. Measure and refine against the mask.
  const input: FitInput = {
    rgba: crop.rgba,
    width: crop.width,
    height: crop.height,
    label,
    archetype,
    material,
    elevation,
    parts,
    knownHeight,
  };
  const fitted = await fitItemAsync(input);
  let params = fitted.params;
  let item = fitted.item;
  let score = fitted.score;
  // 3. Spark checks the render against the photo; keep its nudge only if it holds up.
  if (live) {
    const render = await viewPng(item, fitted.elevation, crop.width);
    assets.push(store.asset(runId, 'item-render.png', render));
    const check = await meta.itemCheck(cropUrl, toDataUrl(render), describeFit(params));
    usage = addUsage(usage, check.usage);
    const nudged = applyCheck(params, check.output);
    const nudgedItem = buildItem(label, nudged);
    const nudgedScore = scoreAgainst(nudgedItem, input, fitted.elevation);
    const kept = nudgedScore.iou >= score.iou - 0.01;
    if (kept) {
      params = nudged;
      item = nudgedItem;
      score = nudgedScore;
    }
    assists.push(`Spark check (${kept ? 'kept' : 'not kept'}): ${check.output.note}`);
  }
  return { input, fitted, params, item, score, assets, assists, usage };
}

export async function itemRoutes(
  app: FastifyInstance,
  { store, meta, run }: Pick<RouteDeps, 'store' | 'meta' | 'run'>,
) {
  /** Save an edited model of the remembered object, or remove it. */
  app.post('/save', async (request) => {
    const { mode, item, objectId } = parseInput(itemSaveBodySchema, request.body);
    const memory = store.memory(mode);
    const target = modelTarget(memory, objectId);
    if (!target)
      throw new LabError('item_identity', 'Confirm the object by hand first, then model it.', 409);
    setModel(
      memory,
      target.id,
      item && {
        ...uniqueParts(item),
        source: target.item?.source ?? 'sampled',
        segmentRunId: target.item?.segmentRunId ?? null,
        swatches: target.item?.swatches ?? [],
        updatedAt: new Date().toISOString(),
        // An edit keeps its fit record, scored again against the same crop.
        fit: await rescore(store, item, target.item?.fit),
      },
    );
    store.saveMemory(memory);
    return memory;
  });
  /**
   * Draft a model of a remembered object from its current sighting's mask.
   * Both sources measure the model from the mask with the local fitter.
   * `spark` also asks Meta's models for help: Spark names the archetype and
   * material, SAM segments parts (a handle, the liquid) inside the crop, and
   * Spark compares a render with the photo and suggests bounded corrections,
   * kept only when the silhouette still matches.
   */
  app.post('/draft', async (request) => {
    const { mode, source, objectId } = parseInput(itemDraftBodySchema, request.body);
    const object = modelTarget(store.memory(mode), objectId);
    const sighting = object?.observation;
    if (object?.fixture)
      throw new LabError(
        'item_fixture',
        'A fixture’s model comes from its photo. Refit it, or add the fixture again from a new photo.',
        409,
      );
    if (!object || !sighting)
      throw new LabError(
        'item_identity',
        'Confirm the object by hand first, then draft its model.',
        409,
      );
    const elevation = pinElevation(store.memory(mode), mode);
    const event = await run(
      'item',
      mode,
      async (id, signal) => {
        const segment = store.getRun(sighting.segmentRunId);
        const segmentation = runOutput(segment, 'segment');
        const detection = segmentation?.detections.find((d) => d.objectId === sighting.detectionId);
        if (!segment || !segmentation || !detection)
          throw new LabError(
            'item_source',
            'The segmentation behind this sighting is missing. Segment a new frame.',
            409,
          );
        const crop = await itemCrop(store, mode, segment, detection);
        const cropAsset = store.asset(id, 'item-crop.png', crop.png);
        const assets = [cropAsset];
        const cropUrl = toDataUrl(crop.png);
        const assists: string[] = [];
        let usage: Usage | null = null;
        let model: string | undefined;
        let requestId: string | null = null;
        const live = mode === 'live' && source === 'spark';
        // 1. A name for the shape: Spark when asked, else the concept or label.
        let archetype: Archetype = isMugConcept(segmentation.concept)
          ? 'mug'
          : archetypeOf(`${segmentation.concept} ${object.label}`);
        let material: ItemClass['material'] | null = null;
        if (source === 'spark') {
          const result = live
            ? await meta.itemClass(cropUrl, object.label)
            : { output: demoItemClass, usage: null, model: undefined, requestId: null };
          ({ archetype, material } = result.output);
          usage = addUsage(usage, result.usage);
          model = result.model ?? model;
          requestId = result.requestId ?? requestId;
          assists.push(`Spark: ${archetype}, ${material}. ${result.output.description}`);
        }
        // 2. Model the crop: part masks, the fitter and the check.
        const drafted = await draftModel(meta, store, id, {
          crop,
          cropUrl,
          label: object.label,
          archetype,
          material,
          elevation,
          live,
          ...(signal ? { signal } : {}),
        });
        const { input, fitted } = drafted;
        let { params, item, score } = drafted;
        assets.push(...drafted.assets);
        assists.push(...drafted.assists);
        usage = addUsage(usage, drafted.usage);
        // 3. Another sighting of the same object: average the shape with what came before.
        const previous = object.item?.fit;
        let views = 1;
        if (
          previous &&
          previous.archetype === fitted.archetype &&
          object.item?.segmentRunId !== segment.id
        ) {
          params = fuseFits(previous.params, previous.views, params);
          item = buildItem(object.label, params);
          score = scoreAgainst(item, input, fitted.elevation);
          views = previous.views + 1;
          assists.push(
            `Fused with ${previous.views} earlier view${previous.views === 1 ? '' : 's'}`,
          );
        }
        item = keepLocked(item, object.item);
        const saved: SavedItem = {
          ...uniqueParts(item),
          source: mode === 'demo' ? 'demo' : source,
          segmentRunId: segment.id,
          swatches: fitted.swatches,
          updatedAt: new Date().toISOString(),
          fit: {
            archetype: fitted.archetype,
            params,
            iou: score.iou,
            deltaE: score.deltaE,
            elevation: fitted.elevation,
            views,
            crop: cropAsset,
            cropPx: { width: crop.width, height: crop.height },
            assists,
          },
        };
        return { output: saved, assets, usage, model, requestId };
      },
      requestSignal(request),
    );
    const latest = store.memory(mode);
    if (modelTarget(latest, object.id)) {
      setModel(latest, object.id, runOutput(event, 'item')!);
      store.saveMemory(latest);
    }
    return { run: event, memory: latest };
  });
  /**
   * Fit the model to its crop again, after edits: no model calls, and the
   * parts a person locked stay as they are.
   */
  app.post('/refit', async (request) => {
    const { mode, objectId, item } = parseInput(itemRefitBodySchema, request.body);
    const target = modelTarget(store.memory(mode), objectId);
    const fit = target?.item?.fit;
    const png = fit?.crop ? store.readAsset(fit.crop) : null;
    if (!target?.item || !fit || !png)
      throw new LabError('item_source', 'Draft the model from a photo first, then refit it.', 409);
    const material = (item ?? target.item).parts.find((p) => p.id === 'body')?.material ?? null;
    const input = { ...(await cropInput(png, target.label)), archetype: fit.archetype, material };
    // A flat thing's height can't be measured from above: keep the one it has.
    const knownHeight = fit.params.family === 'flat' ? fit.params.h : null;
    const fitted = await fitItemAsync({ ...input, elevation: fit.elevation, knownHeight });
    const refitted = keepLocked(fitted.item, item ?? target.item);
    const score = scoreAgainst(refitted, input, fitted.elevation);
    const memory = store.memory(mode);
    setModel(memory, target.id, {
      ...target.item,
      ...uniqueParts(refitted),
      updatedAt: new Date().toISOString(),
      fit: { ...fit, params: fitted.params, ...score, elevation: fitted.elevation },
    });
    store.saveMemory(memory);
    return memory;
  });
  /** The masked crop a model was fitted to, to lay the model over in the editor. */
  app.get('/crop', async (request, reply) => {
    const { mode, objectId } = parseInput(itemCropQuerySchema, request.query);
    const crop = modelTarget(store.memory(mode), objectId)?.item?.fit?.crop;
    const png = crop ? store.readAsset(crop) : null;
    if (!png) throw new LabError('item_source', 'This model has no crop.', 404);
    return reply.type('image/png').header('cache-control', 'no-store').send(png);
  });
}
