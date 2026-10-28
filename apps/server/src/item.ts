import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import {
  FIXTURE_POSITIONS,
  applyCheck,
  archetypeOf,
  buildItem,
  describeFit,
  fitItem,
  fuseFits,
  isMugConcept,
  isoItemSchema,
  isoSurface,
  labRgb,
  modeSchema,
  modelTarget,
  renderView,
  scoreAgainst,
  setModel,
  uniqueParts,
  voxelize,
  type Archetype,
  type DeskMemory,
  type Detection,
  type EvidenceRun,
  type FitInput,
  type IsoItem,
  type ItemClass,
  type ItemFitRecord,
  type Mode,
  type RunKind,
  type SavedItem,
  type Segmentation,
  type Usage,
} from '@livinglayer/domain';
import { PROJECT_ROOT } from './config.js';
import { LabError, parseInput } from './errors.js';
import { detectionBits, maskedCrop } from './images.js';
import type { MetaAdapter, ProviderResult } from './meta.js';
import type { EvidenceStore } from './store.js';

export type Runner = (
  kind: RunKind,
  mode: Mode,
  operation: (
    id: string,
  ) => Promise<Partial<ProviderResult<unknown>> & { output: unknown; assets?: string[] }>,
) => Promise<EvidenceRun>;

/** What a Spark class looks like offline: the illustrated mug is a glossy mug. */
export const fixtureItemClass: ItemClass = {
  archetype: 'mug',
  material: 'gloss',
  description: 'A cream mug with coffee in it and a handle on the right.',
  backside: null,
};
/** SAM concepts worth asking for inside a crop, per archetype: parts the fitter can use. */
const PART_CONCEPTS: Partial<Record<Archetype, { handle?: string; inside?: string }>> = {
  mug: { handle: 'mug handle', inside: 'coffee' },
  cup: { inside: 'drink' },
  plant: { inside: 'soil' },
};

/** The fixture desk is an SVG the web draws; rasterize it once, as the camera would see it. */
let fixtureDesk: Buffer | null = null;
export async function fixturePhoto(): Promise<Buffer> {
  fixtureDesk ??= await sharp(readFileSync(resolve(PROJECT_ROOT, 'apps/web/public/desk.svg')))
    .png()
    .toBuffer();
  return fixtureDesk;
}
/**
 * The detection's masked crop. In fixture mode the desk is always drawn with
 * the mug in the centre, so a moved detection is cut from where the mug was drawn.
 */
export async function itemCrop(
  store: EvidenceStore,
  mode: Mode,
  segment: EvidenceRun,
  detection: Detection,
) {
  if (mode === 'fixture') {
    const output = segment.output as Segmentation & { sourceKey?: string };
    const position = (output.sourceKey?.split('@')[1] ??
      'centre') as keyof typeof FIXTURE_POSITIONS;
    const { dx, dy } = FIXTURE_POSITIONS[position] ?? FIXTURE_POSITIONS.centre;
    return maskedCrop(await fixturePhoto(), {
      ...detection,
      box: { ...detection.box, x: detection.box.x - dx, y: detection.box.y - dy },
    });
  }
  const photo = segment.assets.find((a) => a.endsWith('/source.png'));
  const bytes = photo ? store.readAsset(photo) : null;
  if (!bytes) throw new LabError('item_source', 'The photo behind this sighting is missing.', 409);
  return maskedCrop(bytes, detection);
}

/**
 * The camera's angle above the pinned surface: a rectangle seen at elevation
 * e looks sin(e) times as deep as it is. Null without a pin of this frame, or
 * for the fixture, whose illustration has no real camera.
 */
export function pinElevation(memory: DeskMemory, mode: Mode): number | null {
  const pin = memory.surface;
  if (mode === 'fixture' || !pin) return null;
  const surface = isoSurface(pin.scene, pin.surfaceId, memory.scene);
  if (!surface) return null;
  const [a, b, c, d] = pin.corners;
  const dist = (p: typeof a, q: typeof a) => Math.hypot(q.x - p.x, q.y - p.y);
  const width = (dist(a, b) + dist(d, c)) / 2;
  const depth = (dist(a, d) + dist(b, c)) / 2;
  const sin = depth / width / (surface.rect.d / surface.rect.w);
  return (Math.asin(Math.max(0.1, Math.min(1, sin))) * 180) / Math.PI;
}

function addUsage(a: Usage | null, b: Usage | null | undefined): Usage | null {
  if (!b) return a;
  if (!a) return b;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
/** The model drawn from the photo's camera in flat colours, as a PNG for Spark to compare. */
async function viewPng(item: IsoItem, elevation: number, width: number): Promise<Buffer> {
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

export function itemRoutes(
  app: FastifyInstance,
  { store, meta, run }: { store: EvidenceStore; meta: MetaAdapter; run: Runner },
) {
  /**
   * Draft a model of a remembered object from its current sighting's mask.
   * Both sources measure the model from the mask with the local fitter.
   * `spark` also asks Meta's models for help: Spark names the archetype and
   * material, SAM segments parts (a handle, the liquid) inside the crop, and
   * Spark compares a render with the photo and suggests bounded corrections,
   * kept only when the silhouette still matches.
   */
  app.post('/api/item/draft', async (request) => {
    const { mode, source, objectId } = parseInput(
      z
        .object({
          mode: modeSchema,
          source: z.enum(['sampled', 'spark']),
          objectId: z.string().uuid().optional(),
        })
        .strict(),
      request.body,
    );
    const object = modelTarget(store.memory(mode), objectId);
    const sighting = object?.observation;
    if (!object || !sighting)
      throw new LabError(
        'item_identity',
        'Confirm the object by hand first, then draft its model.',
        409,
      );
    const elevation = pinElevation(store.memory(mode), mode);
    const event = await run('item', mode, async (id) => {
      const segment = store.getRun(sighting.segmentRunId);
      const segmentation = segment?.output as Segmentation | undefined;
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
      const cropUrl = `data:image/png;base64,${crop.png.toString('base64')}`;
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
          : { output: fixtureItemClass, usage: null, model: undefined, requestId: null };
        ({ archetype, material } = result.output);
        usage = addUsage(usage, result.usage);
        model = result.model ?? model;
        requestId = result.requestId ?? requestId;
        assists.push(`Spark: ${archetype}, ${material}. ${result.output.description}`);
      }
      // 2. Part masks from SAM, inside the crop.
      const parts: FitInput['parts'] = {};
      if (live)
        for (const [key, concept] of Object.entries(PART_CONCEPTS[archetype] ?? {})) {
          const result = await meta.segment(cropUrl, concept, crop.width, crop.height);
          const bits = await detectionBits(result.output.detections, crop.width, crop.height);
          parts[key as 'handle' | 'inside'] = bits;
          assists.push(`SAM: ${concept} ${bits ? 'found' : 'not found'}`);
        }
      // 3. Measure and refine against the mask.
      const input: FitInput = {
        rgba: crop.rgba,
        width: crop.width,
        height: crop.height,
        label: object.label,
        archetype,
        material,
        elevation,
        parts,
      };
      const fitted = fitItem(input);
      let params = fitted.params;
      let item = fitted.item;
      let score = fitted.score;
      // 4. Spark checks the render against the photo; keep its nudge only if it holds up.
      if (live) {
        const render = await viewPng(item, fitted.elevation, crop.width);
        assets.push(store.asset(id, 'item-render.png', render));
        const check = await meta.itemCheck(
          cropUrl,
          `data:image/png;base64,${render.toString('base64')}`,
          describeFit(params),
        );
        usage = addUsage(usage, check.usage);
        const nudged = applyCheck(params, check.output);
        const nudgedItem = buildItem(object.label, nudged);
        const nudgedScore = scoreAgainst(nudgedItem, input, fitted.elevation);
        const kept = nudgedScore.iou >= score.iou - 0.01;
        if (kept) {
          params = nudged;
          item = nudgedItem;
          score = nudgedScore;
        }
        assists.push(`Spark check (${kept ? 'kept' : 'not kept'}): ${check.output.note}`);
      }
      // 5. Another sighting of the same object: average the shape with what came before.
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
        assists.push(`Fused with ${previous.views} earlier view${previous.views === 1 ? '' : 's'}`);
      }
      item = keepLocked(item, object.item);
      const saved: SavedItem = {
        ...uniqueParts(item),
        source: mode === 'fixture' ? 'fixture' : source,
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
          assists,
        },
      };
      return { output: saved, assets, usage, model, requestId };
    });
    const latest = store.memory(mode);
    if (modelTarget(latest, object.id)) {
      setModel(latest, object.id, event.output as SavedItem);
      store.saveMemory(latest);
    }
    return { run: event, memory: latest };
  });
  /**
   * Fit the model to its crop again, after edits: no model calls, and the
   * parts a person locked stay as they are.
   */
  app.post('/api/item/refit', async (request) => {
    const { mode, objectId, item } = parseInput(
      z
        .object({
          mode: modeSchema,
          objectId: z.string().uuid().optional(),
          item: isoItemSchema.optional(),
        })
        .strict(),
      request.body,
    );
    const target = modelTarget(store.memory(mode), objectId);
    const fit = target?.item?.fit;
    const png = fit?.crop ? store.readAsset(fit.crop) : null;
    if (!target?.item || !fit || !png)
      throw new LabError('item_source', 'Draft the model from a photo first, then refit it.', 409);
    const material = (item ?? target.item).parts.find((p) => p.id === 'body')?.material ?? null;
    const input = { ...(await cropInput(png, target.label)), archetype: fit.archetype, material };
    const fitted = fitItem({ ...input, elevation: fit.elevation });
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
  app.get('/api/item/crop', async (request, reply) => {
    const { mode, objectId } = parseInput(
      z
        .object({
          mode: modeSchema,
          objectId: z.string().uuid().optional(),
          /** Changes with the crop, so a browser never shows a stale one. */
          v: z.string().max(200).optional(),
        })
        .strict(),
      request.query,
    );
    const crop = modelTarget(store.memory(mode), objectId)?.item?.fit?.crop;
    const png = crop ? store.readAsset(crop) : null;
    if (!png) throw new LabError('item_source', 'This model has no crop.', 404);
    return reply.type('image/png').header('cache-control', 'no-store').send(png);
  });
}
