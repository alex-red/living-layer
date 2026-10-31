import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import {
  ARCHETYPES,
  archetypeOf,
  cleanInventory,
  fitItem,
  demoSourceKey,
  DEMO_FRAME,
  calibrationOf,
  floorSolid,
  elevationAt,
  layoutRoom,
  renderRoom,
  sceneSolids,
  type LayoutInput,
  type RoomCalibration,
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
  type PhotoLayout,
  type SavedItem,
  type Segmentation,
  type Usage,
} from '@livinglayer/domain';
import type { Config } from './config.js';
import { LabError, parseInput } from './errors.js';
import { demoPhotoCheck, demoPhotoInventory, demoPhotoSegmentation } from './demo.js';
import { maskedCrop, validateImage } from './images.js';
import { demoPhoto, type Runner } from './item.js';
import { SPARK_BUDGET, type MetaAdapter } from './meta.js';
import type { EvidenceStore } from './store.js';
import { following, jobs } from './jobs.js';
import { listedPreview, outlinedPreview } from './scan-preview.js';

/** How wide a step's picture is kept, so it reads in the dialog. */
const PREVIEW = 640;
/** A photo draft's steps, as the page follows them; Spark's check only when asked for. */
const draftSteps = (check: boolean) => [
  { id: 'photo', label: 'Send the photo' },
  { id: 'list', label: 'Spark lists what is in the room' },
  { id: 'outline', label: 'SAM outlines each thing' },
  { id: 'layout', label: 'Measure the room from the outlines' },
  ...(check ? [{ id: 'check', label: 'Spark compares the drafted room with the photo' }] : []),
  { id: 'models', label: 'Fit a model to each object' },
];
/** The drafted room as the room's camera would see it: what Spark compares with the photo. */
async function renderLayout(layout: PhotoLayout, calibration: RoomCalibration) {
  const picture = renderRoom(calibration.camera, [
    floorSolid(layout.scene.grid),
    ...sceneSolids(layout.scene),
  ]);
  return sharp(Buffer.from(picture.rgba), {
    raw: { width: picture.width, height: picture.height, channels: 4 },
  })
    .png()
    .toBuffer();
}
/** Why a frame can't be scanned without the room's camera. */
export const NOT_CALIBRATED =
  'Calibrate the room’s corner camera first: a scan places everything through it.';

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
 * A scene from one frame of the room's calibrated corner camera. Spark lists
 * what is in it with loose boxes (one call), SAM outlines every box (one
 * call), and `layoutRoom` places each thing through the camera: where it
 * stands, its turn, and how well its drawing matches. Each object gets a
 * model from the local fitter. Spark may then look at the drawing beside the photo (one more call,
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
        sourceKey: live ? createHash('sha256').update(photo).digest('hex') : demoSourceKey(),
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
          /** The page's id for following the steps as they go. */
          jobId: z.string().uuid().optional(),
        })
        .strict(),
      request.body,
    );
    const { mode } = input;
    const live = mode === 'live';
    if (!live && input.imageDataUrl)
      throw new LabError('demo_image', 'Demo mode uses only the demo room’s camera.');
    if (!calibrationOf(store.memory(mode)))
      throw new LabError('not_calibrated', NOT_CALIBRATED, 409);
    // Refuse up front rather than stop halfway, with the inventory already paid for.
    if (live && !meta.canAfford(photoDraftCeiling(Boolean(input.check))))
      throw new LabError(
        'spend_limit',
        `A photo draft could cost up to $${photoDraftCeiling(Boolean(input.check)).toFixed(3)}, which would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.`,
        429,
      );
    const job = jobs.start(input.jobId, draftSteps(Boolean(input.check)), {
      title: 'Drafting the room',
      mode,
    });
    return following(job, async () => {
      const drafted = await run('photo', mode, async (id) => {
        job.link(id);
        job.run('photo');
        const assists: string[] = [];
        let usage: Usage | null = null;
        let model: string | undefined;
        let requestId: string | null = null;
        const image = live ? await validateImage(input.imageDataUrl) : null;
        const photo = image ? image.bytes : await demoPhoto();
        const frame = image ? { width: image.width, height: image.height } : { ...DEMO_FRAME };
        // Everything is placed through the room's camera, so the frame must be one of its.
        const calibration = calibrationOf(store.memory(mode));
        if (!calibration) throw new LabError('not_calibrated', NOT_CALIBRATED, 409);
        const { width, height } = calibration.camera.frame;
        if (width !== frame.width || height !== frame.height)
          throw new LabError(
            'not_calibrated',
            `This frame is ${frame.width} × ${frame.height}, but the room’s camera was calibrated on ${width} × ${height} frames. Send a frame from that camera, or calibrate again.`,
            409,
          );
        const lay = (args: LayoutInput) => layoutRoom({ ...args, calibration });
        const assets = image ? [store.asset(id, 'source.png', image.bytes)] : [];
        await job.done(
          'photo',
          image
            ? `${image.width} × ${image.height}`
            : 'Demo: the office from its corner camera, no model calls',
          photo,
          PREVIEW,
        );
        job.check();

        // 1. What is there, roughly where.
        job.run('list');
        let inventory: PhotoInventory;
        if (image) {
          const result = await meta.photoInventory(image.dataUrl, job.signal);
          inventory = cleanInventory(result.output);
          usage = addUsage(usage, result.usage);
          model = result.model;
          requestId = result.requestId;
        } else inventory = cleanInventory(demoPhotoInventory);
        assists.push(`Spark: ${inventory.things.length} things. ${inventory.summary}`);
        job.check();
        await job.done(
          'list',
          `${inventory.things.length} things. ${inventory.summary}`,
          await listedPreview(photo, frame, inventory.things),
          PREVIEW,
        );
        job.run('outline');

        // 2. One SAM call outlines every box.
        const prompts = inventory.things
          .map((t, i) => ({ thing: t.id, id: i + 1, box: promptBox(t, frame) }))
          .filter((p): p is typeof p & { box: NonNullable<typeof p.box> } => Boolean(p.box));
        let segmentation: Segmentation;
        let raw: string;
        if (image) {
          const result = await meta.segmentBoxes(
            image.dataUrl,
            prompts,
            frame.width,
            frame.height,
            job.signal,
          );
          // SAM bills per image through its own segment run, not by tokens here.
          segmentation = result.output;
          raw = result.raw;
        } else {
          segmentation = await demoPhotoSegmentation();
          raw = 'Synthetic box-prompted segmentation of the demo room’s render.';
        }
        const detections: Record<string, string> = {};
        for (const p of prompts)
          if (segmentation.detections.some((d) => d.objectId === String(p.id)))
            detections[p.thing] = String(p.id);
        assists.push(
          `SAM: ${Object.keys(detections).length} of ${inventory.things.length} outlined in one call`,
        );
        job.check();
        await job.done(
          'outline',
          `${Object.keys(detections).length} of ${inventory.things.length} outlined`,
          await outlinedPreview(
            photo,
            frame,
            prompts.map((p) => inventory.things.find((t) => t.id === p.thing)?.label ?? ''),
            prompts.map(
              (p) => segmentation.detections.find((d) => d.objectId === String(p.id)) ?? null,
            ),
          ),
          PREVIEW,
        );
        let segmentRunId = saveSegment(mode, segmentation, photo, image ? raw : null, live);

        // 3. Measure the scene from the masks.
        job.run('layout');
        let layout = lay({ inventory, segmentation, detections });
        assists.push(
          `Laid out through the calibrated room camera (fit ${calibration.error.toFixed(1)} px)`,
        );
        const drawn = await renderLayout(layout, calibration);
        await job.done(
          'layout',
          `${layout.things.filter((t) => t.status === 'placed').length} placed. ${assists.at(-1)}`,
          drawn ?? undefined,
          PREVIEW,
        );
        job.check();

        // 4. Spark looks at the drawing beside the photo.
        let check: PhotoDraft['check'] = null;
        if (input.check) job.run('check');
        if (input.check) {
          assets.push(store.asset(id, 'scene-render.png', drawn));
          const listing = layout.things
            .filter((t) => t.status === 'placed' || t.status === 'object')
            .map((t) => `${t.id} (${t.label}, ${t.as})`)
            .join('; ');
          const result = image
            ? await meta.photoCheck(
                image.dataUrl,
                `data:image/png;base64,${drawn.toString('base64')}`,
                listing,
                job.signal,
              )
            : { output: demoPhotoCheck, usage: null };
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
              const extra = await meta.segmentBoxes(
                image.dataUrl,
                more,
                frame.width,
                frame.height,
                job.signal,
              );
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
              const next = lay({
                inventory: nextInventory,
                segmentation: nextSegmentation,
                detections: nextDetections,
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
        if (input.check) {
          job.check();
          await job.done(
            'check',
            check
              ? `${check.kept ? `Added ${check.added.join(', ')}. ` : 'Nothing added. '}${check.note}`
              : 'Nothing to compare',
            check?.kept ? await renderLayout(layout, calibration) : undefined,
            PREVIEW,
          );
        }

        // 5. A model for each object, fitted to its own mask.
        job.run('models');
        const items: Record<string, SavedItem> = {};
        const objects = layout.things.filter((t) => t.status === 'object').slice(0, MAX_FITTED);
        for (const t of objects) {
          const detection = segmentation.detections.find((d) => d.objectId === t.detectionId);
          if (!detection) continue;
          try {
            const crop = await maskedCrop(photo, detection);
            job.run('models', t.label);
            await job.show('models', crop.png);
            const archetype = isArchetype(t.as) ? t.as : archetypeOf(t.label);
            const fitted = fitItem({
              rgba: crop.rgba,
              width: crop.width,
              height: crop.height,
              label: t.label,
              archetype,
              material: null,
              // How far the room's camera looks down on it, where it stands.
              elevation: t.foot
                ? elevationAt(calibration.camera, {
                    x: t.foot.at.x + t.foot.size.w / 2,
                    y: t.foot.at.y + t.foot.size.d / 2,
                    z: t.foot.at.z,
                  })
                : null,
            });
            const cropAsset = store.asset(id, `crop-${t.id}.png`, crop.png);
            items[t.id] = {
              ...uniqueParts(fitted.item),
              label: t.label,
              source: live ? 'sampled' : 'demo',
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
        job.check();
        await job.done(
          'models',
          objects.length
            ? `${Object.keys(items).length} of ${objects.length} objects modelled, no model calls`
            : 'No objects to model',
        );

        const output: PhotoDraft = {
          inventory,
          segmentRunId,
          segmentation,
          detections,
          layout,
          items,
          check,
          assists,
          calibration,
        };
        return { output, assets, usage, model, requestId };
      });
      job.finish();
      return drafted;
    });
  });
}
