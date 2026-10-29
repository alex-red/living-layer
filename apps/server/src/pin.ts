import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  META_PRICES,
  fixtureSourceKey,
  modeSchema,
  pinFromMask,
  promptBox,
  type Detection,
  type EvidenceRun,
  type Quad,
  type Segmentation,
} from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import { fixturePhotoInventory, fixturePhotoSegmentation } from './fixtures.js';
import { validateImage } from './images.js';
import type { Runner } from './item.js';
import type { MetaAdapter } from './meta.js';
import type { EvidenceStore } from './store.js';

export interface AutoPin {
  /** The SAM run that outlined the desk, kept as evidence like any segmentation. */
  run: EvidenceRun<Segmentation>;
  /** Corners in frame pixels, clockwise from the back left, or null when no desk was found. */
  pin: { corners: Quad; iou: number; frame: Segmentation['frame'] } | null;
}

/** The illustrated desk's own outline, from the offline photo draft's box-prompted masks. */
async function fixtureDesk(): Promise<Segmentation> {
  const segmentation = await fixturePhotoSegmentation();
  const index = fixturePhotoInventory.things.findIndex(
    (t) => t.id === 'desk' && promptBox(t, segmentation.frame),
  );
  const desk = segmentation.detections.filter((d) => d.objectId === String(index + 1));
  return { ...segmentation, concept: 'desk', detections: desk };
}
const areaOf = (d: Detection) =>
  (d.mask.foregroundPixels * d.box.width * d.box.height) / (d.mask.width * d.mask.height);

/**
 * Pin a desk on a close photo by itself. SAM outlines "desk" (one call, live),
 * and the photo pipeline's surface fitter measures the top's corners from the
 * biggest outline. Nothing is saved: the person checks the corners, drags any
 * that are off, and saves them through `desk/surface` like a hand-made pin.
 */
export function pinRoutes(
  app: FastifyInstance,
  { store, meta, run }: { store: EvidenceStore; meta: MetaAdapter; run: Runner },
) {
  app.post('/api/desk/auto-pin', async (request): Promise<AutoPin> => {
    const input = parseInput(
      z.object({ mode: modeSchema, imageDataUrl: z.string().max(7_000_000).optional() }).strict(),
      request.body,
    );
    const live = input.mode === 'live';
    if (!live && input.imageDataUrl)
      throw new LabError('fixture_image', 'Fixture mode uses only the bundled illustrated desk.');
    if (live && !meta.canAfford(META_PRICES.samPerImage))
      throw new LabError(
        'spend_limit',
        "Finding the desk would pass today's Meta spending limit. Raise the limit, or pin the corners by hand.",
        429,
      );
    const segment = (await run('segment', input.mode, async (id) => {
      if (!live) {
        const output = await fixtureDesk();
        return {
          output: { ...output, sourceKey: fixtureSourceKey() },
          assets: [store.asset(id, 'synthetic-sam.txt', 'The illustrated desk’s outline.')],
        };
      }
      const image = await validateImage(input.imageDataUrl);
      const result = await meta.segment(image.dataUrl, 'desk', image.width, image.height);
      return {
        ...result,
        output: {
          ...result.output,
          sourceKey: createHash('sha256').update(image.bytes).digest('hex'),
        },
        assets: [
          store.asset(id, 'source.png', image.bytes),
          store.asset(id, 'sam-output.txt', result.raw),
        ],
      };
    })) as EvidenceRun<Segmentation>;
    const segmentation = segment.output;
    const desk = [...(segmentation.detections ?? [])].sort((a, b) => areaOf(b) - areaOf(a))[0];
    const fitted = desk ? pinFromMask(desk, segmentation.frame) : null;
    return {
      run: segment,
      pin: fitted && { ...fitted, frame: segmentation.frame },
    };
  });
}
