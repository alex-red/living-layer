import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import {
  ARCHETYPES,
  archetypeOf,
  cleanInventory,
  fitItem,
  fixtureSourceKey,
  flatView,
  layoutPhoto,
  modeSchema,
  promptBox,
  sparkCeiling,
  META_PRICES,
  uniqueParts,
  type Archetype,
  type EvidenceRun,
  type Mode,
  type PhotoDraft,
  type PhotoInventory,
  type SavedItem,
  type Segmentation,
  type Usage,
} from '@livinglayer/domain';
import type { Config } from './config.js';
import { LabError, parseInput } from './errors.js';
import { fixturePhotoCheck, fixturePhotoInventory, fixturePhotoSegmentation } from './fixtures.js';
import { maskedCrop, validateImage } from './images.js';
import { fixturePhoto, type Runner } from './item.js';
import { SPARK_BUDGET, type MetaAdapter } from './meta.js';
import type { EvidenceStore } from './store.js';

/** The most a live photo draft can cost: the inventory and SAM, then the check and SAM again. */
const photoDraftCeiling = (check: boolean) =>
  sparkCeiling(SPARK_BUDGET.photoInventory, 1) +
  META_PRICES.samPerImage +
  (check ? sparkCeiling(SPARK_BUDGET.photoCheck, 2) + META_PRICES.samPerImage : 0);
/** At most this many objects get a fitted model in one draft; the rest can be modelled later. */
const MAX_FITTED = 8;
export type { PhotoDraft };

function addUsage(a: Usage | null, b: Usage | null | undefined): Usage | null {
  if (!b) return a;
  if (!a) return b;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
const isArchetype = (as: string): as is Archetype => (ARCHETYPES as readonly string[]).includes(as);

/**
 * A scene from one photo. Spark lists what is in it with loose boxes (one
 * call), SAM outlines every box (one call), and the layout measures the rest
 * from the masks: the desktop's corners, the camera, where each thing stands,
 * and how well the drawing matches. Each object gets a model from the local
 * fitter. Spark may then look at the drawing beside the photo (one more call,
 * and one more SAM call for anything it says is missing). Nothing is saved to
 * desk memory until the person saves the review.
 */
export function photoRoutes(
  app: FastifyInstance,
  { store, meta, run }: { store: EvidenceStore; meta: MetaAdapter; run: Runner; config: Config },
) {
  /** Save the box-prompted segmentation as a segment run, like any other. */
  function saveSegment(
    mode: Mode,
    segmentation: Segmentation,
    photo: Buffer,
    raw: string | null,
    live: boolean,
  ): string {
    const sid = randomUUID();
    const segment: EvidenceRun<Segmentation> = {
      id: sid,
      kind: 'segment',
      mode,
      status: segmentation.detections.length ? 'completed' : 'no_match',
      createdAt: new Date().toISOString(),
      durationMs: 0,
      model: null,
      requestId: null,
      promptVersion: 'segment-boxes-v1',
      usage: null,
      output: {
        ...segmentation,
        sourceKey: live ? createHash('sha256').update(photo).digest('hex') : fixtureSourceKey(),
      },
      assets: live
        ? [store.asset(sid, 'source.png', photo), store.asset(sid, 'sam-output.txt', raw ?? '')]
        : [store.asset(sid, 'synthetic-sam.txt', raw ?? '')],
    };
    store.save(segment);
    return sid;
  }
  app.post('/api/scene/from-photo', async (request) => {
    const input = parseInput(
      z
        .object({
          mode: modeSchema,
          imageDataUrl: z.string().max(7_000_000).optional(),
          check: z.boolean().optional(),
        })
        .strict(),
      request.body,
    );
    const { mode } = input;
    const live = mode === 'live';
    if (!live && input.imageDataUrl)
      throw new LabError('fixture_image', 'Fixture mode uses only the bundled illustrated desk.');
    // Refuse up front rather than stop halfway, with the inventory already paid for.
    if (live && !meta.canAfford(photoDraftCeiling(Boolean(input.check))))
      throw new LabError(
        'spend_limit',
        `A photo draft could cost up to $${photoDraftCeiling(Boolean(input.check)).toFixed(3)}, which would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.`,
        429,
      );
    return run('photo', mode, async (id) => {
      const assists: string[] = [];
      let usage: Usage | null = null;
      let model: string | undefined;
      let requestId: string | null = null;
      const image = live ? await validateImage(input.imageDataUrl) : null;
      const photo = image ? image.bytes : await fixturePhoto();
      const frame = image
        ? { width: image.width, height: image.height }
        : { width: 960, height: 640 };
      const assets = image ? [store.asset(id, 'source.png', image.bytes)] : [];

      // 1. What is there, roughly where.
      let inventory: PhotoInventory;
      if (image) {
        const result = await meta.photoInventory(image.dataUrl);
        inventory = cleanInventory(result.output);
        usage = addUsage(usage, result.usage);
        model = result.model;
        requestId = result.requestId;
      } else inventory = cleanInventory(fixturePhotoInventory);
      assists.push(`Spark: ${inventory.things.length} things. ${inventory.summary}`);

      // 2. One SAM call outlines every box.
      const prompts = inventory.things
        .map((t, i) => ({ thing: t.id, id: i + 1, box: promptBox(t, frame) }))
        .filter((p): p is typeof p & { box: NonNullable<typeof p.box> } => Boolean(p.box));
      let segmentation: Segmentation;
      let raw: string;
      if (image) {
        const result = await meta.segmentBoxes(image.dataUrl, prompts, frame.width, frame.height);
        // SAM bills per image through its own segment run, not by tokens here.
        segmentation = result.output;
        raw = result.raw;
      } else {
        segmentation = await fixturePhotoSegmentation();
        raw = 'Synthetic box-prompted segmentation of the illustrated desk.';
      }
      const detections: Record<string, string> = {};
      for (const p of prompts)
        if (segmentation.detections.some((d) => d.objectId === String(p.id)))
          detections[p.thing] = String(p.id);
      assists.push(
        `SAM: ${Object.keys(detections).length} of ${inventory.things.length} outlined in one call`,
      );
      let segmentRunId = saveSegment(mode, segmentation, photo, image ? raw : null, live);

      // 3. Measure the scene from the masks.
      let layout = layoutPhoto({ inventory, segmentation, detections, refine: true });
      assists.push(
        layout.pin
          ? `Pinned the ${layout.things.find((t) => t.id === layout.surfaceThing)?.label} from its mask (camera ${Math.round(layout.camera!.elevation)}° up)`
          : 'No surface to pin: things are spread by where they are in the photo',
      );

      // 4. Spark looks at the drawing beside the photo.
      let check: PhotoDraft['check'] = null;
      if (input.check && layout.camera) {
        const view = flatView(layout, Math.min(960, frame.width));
        if (view) {
          const png = await sharp(Buffer.from(view.rgba), {
            raw: { width: view.width, height: view.height, channels: 4 },
          })
            .png()
            .toBuffer();
          assets.push(store.asset(id, 'scene-render.png', png));
          const listing = layout.things
            .filter((t) => t.status === 'placed' || t.status === 'object')
            .map((t) => `${t.id} (${t.label}, ${t.as})`)
            .join('; ');
          const result = image
            ? await meta.photoCheck(
                image.dataUrl,
                `data:image/png;base64,${png.toString('base64')}`,
                listing,
              )
            : { output: fixturePhotoCheck, usage: null };
          usage = addUsage(usage, result.usage);
          const added: string[] = [];
          let kept = false;
          const missing = cleanInventory({
            kind: inventory.kind,
            things: [...inventory.things, ...result.output.missing],
            summary: inventory.summary,
          }).things.slice(inventory.things.length);
          // Anything missing gets one more SAM call, only if today's spending limit has room.
          if (image && missing.length && meta.canAfford(META_PRICES.samPerImage)) {
            const more = missing
              .map((t, i) => ({
                thing: t.id,
                id: prompts.length + i + 1,
                box: promptBox(t, frame),
              }))
              .filter((p): p is typeof p & { box: NonNullable<typeof p.box> } => Boolean(p.box));
            if (more.length) {
              const extra = await meta.segmentBoxes(image.dataUrl, more, frame.width, frame.height);
              const nextInventory = { ...inventory, things: [...inventory.things, ...missing] };
              const nextSegmentation = {
                ...segmentation,
                detections: [...segmentation.detections, ...extra.output.detections],
              };
              const nextDetections = { ...detections };
              for (const p of more)
                if (extra.output.detections.some((d) => d.objectId === String(p.id))) {
                  nextDetections[p.thing] = String(p.id);
                  added.push(p.thing);
                }
              const next = layoutPhoto({
                inventory: nextInventory,
                segmentation: nextSegmentation,
                detections: nextDetections,
                refine: true,
              });
              // Keep the additions only if the scene still matches the photo as well.
              kept = added.length > 0 && (next.score ?? 0) >= (layout.score ?? 0) - 0.02;
              if (kept) {
                inventory = nextInventory;
                segmentation = nextSegmentation;
                Object.assign(detections, nextDetections);
                layout = next;
                // A new segment run holds every mask, so a sighting can point at any of them.
                raw = `${raw}\n${extra.raw}`;
                segmentRunId = saveSegment(mode, segmentation, photo, raw, live);
              }
            }
          }
          check = { ...result.output, kept, added: kept ? added : [] };
          assists.push(
            `Spark check (${kept ? `added ${added.join(', ')}` : 'nothing added'}): ${result.output.note}`,
          );
        }
      }

      // 5. A model for each object, fitted to its own mask.
      const items: Record<string, SavedItem> = {};
      const objects = layout.things.filter((t) => t.status === 'object').slice(0, MAX_FITTED);
      for (const t of objects) {
        const detection = segmentation.detections.find((d) => d.objectId === t.detectionId);
        if (!detection) continue;
        try {
          const crop = await maskedCrop(photo, detection);
          const archetype = isArchetype(t.as) ? t.as : archetypeOf(t.label);
          const fitted = fitItem({
            rgba: crop.rgba,
            width: crop.width,
            height: crop.height,
            label: t.label,
            archetype,
            material: null,
            // The illustration has no real camera; a photo's comes from the pin.
            elevation: live ? (layout.camera?.elevation ?? null) : null,
          });
          const cropAsset = store.asset(id, `crop-${t.id}.png`, crop.png);
          items[t.id] = {
            ...uniqueParts(fitted.item),
            label: t.label,
            source: live ? 'sampled' : 'fixture',
            segmentRunId,
            swatches: fitted.swatches,
            updatedAt: new Date().toISOString(),
            fit: {
              archetype: fitted.archetype,
              params: fitted.params,
              iou: fitted.score.iou,
              deltaE: fitted.score.deltaE,
              elevation: fitted.elevation,
              views: 1,
              crop: cropAsset,
              assists: ['Fitted from the photo draft'],
            },
          };
        } catch {
          // A crop too small to fit stays without a model; it can be drafted later.
        }
      }
      if (objects.length)
        assists.push(`Fitted ${Object.keys(items).length} object models locally, no model calls`);

      const output: PhotoDraft = {
        inventory,
        segmentRunId,
        segmentation,
        detections,
        layout,
        items,
        check,
        assists,
      };
      return { output, assets, usage, model, requestId };
    });
  });
}
