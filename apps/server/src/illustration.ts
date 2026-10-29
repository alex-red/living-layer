import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import {
  ILLUSTRATION_PROMPT,
  META_PRICES,
  alignCorners,
  illustrationRef,
  isoSurface,
  modeSchema,
  pictureDesk,
  type DeskMemory,
  type Detection,
  type EvidenceRun,
  type Quad,
  type SceneIllustration,
  type Segmentation,
} from '@livinglayer/domain';
import { PROJECT_ROOT } from './config.js';
import { LabError, parseInput } from './errors.js';
import { validateImage } from './images.js';
import type { Runner } from './item.js';
import type { MetaAdapter } from './meta.js';
import type { EvidenceStore } from './store.js';

/**
 * The illustrated demo desk as Muse Image redrew it, and where SAM found its
 * top, so demo mode shows a picture without any model call.
 */
const DEMO_PICTURE = resolve(PROJECT_ROOT, 'apps/server/assets/demo-illustration.webp');
/** The top's corners, as shares of the picture's width and height, in the order the demo pin's corners take. */
export const DEMO_PICTURE_DESK: Quad = [
  { x: 0.0505, y: 0.639 },
  { x: 0.668, y: 0.293 },
  { x: 0.949, y: 0.517 },
  { x: 0.311, y: 0.879 },
];
const areaOf = (d: Detection) =>
  (d.mask.foregroundPixels * d.box.width * d.box.height) / (d.mask.width * d.mask.height);

export interface Illustrated {
  /** The picture's run, and the SAM run that outlined its desk (live only). */
  run: EvidenceRun<{ illustration: SceneIllustration }>;
  segment: EvidenceRun<Segmentation> | null;
  illustration: SceneIllustration;
  memory: DeskMemory;
}

/**
 * Draw a person's room as a clean isometric picture. Muse Image redraws the
 * photo (one image, $0.01), SAM outlines the desk in the picture (one call),
 * and the surface fitter finds its top, which is tied to the pinned surface so
 * the mug and the zones can be drawn on the picture. The scene and its pin
 * stay what they were; the picture is how the room is shown.
 */
export function illustrationRoutes(
  app: FastifyInstance,
  { store, meta, run }: { store: EvidenceStore; meta: MetaAdapter; run: Runner },
) {
  app.post('/api/scene/illustrate', async (request): Promise<Illustrated> => {
    const input = parseInput(
      z.object({ mode: modeSchema, imageDataUrl: z.string().max(7_000_000).optional() }).strict(),
      request.body,
    );
    const { mode } = input;
    const live = mode === 'live';
    if (!live && input.imageDataUrl)
      throw new LabError('demo_image', 'Demo mode uses only the bundled illustrated desk.');
    const memory = store.memory(mode);
    const pin = memory.surface;
    if (
      !memory.scene ||
      !pin ||
      pin.scene !== 'custom' ||
      !isoSurface('custom', pin.surfaceId, memory.scene)
    )
      throw new LabError(
        'illustration_pin',
        'Draft your room from a photo and pin its desk first: the picture is tied to the pinned desk.',
        409,
      );
    if (live && !meta.canAfford(META_PRICES.imagePerImage + META_PRICES.samPerImage))
      throw new LabError(
        'spend_limit',
        "Drawing the room would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.",
        429,
      );
    const image = live ? await validateImage(input.imageDataUrl) : null;

    // 1. The picture.
    let png: Buffer = Buffer.alloc(0);
    const drawn = await run('illustration', mode, async (id) => {
      const result = image
        ? await meta.illustrate(image.dataUrl, ILLUSTRATION_PROMPT)
        : { output: readFileSync(DEMO_PICTURE), model: 'demo', requestId: null, usage: null };
      png = await sharp(result.output).png().toBuffer();
      const asset = store.asset(id, 'illustration.png', png);
      return {
        ...result,
        output: { asset },
        assets: [asset, ...(image ? [store.asset(id, 'source.png', image.bytes)] : [])],
      };
    });
    const asset = (drawn.output as { asset: string }).asset;
    const size = await sharp(png).metadata();
    const frame = { width: size.width!, height: size.height! };

    // 2. Its desk top, tied to the pin.
    let segment: EvidenceRun<Segmentation> | null = null;
    let desk: Quad | null;
    if (!live)
      desk = DEMO_PICTURE_DESK.map((p) => ({
        x: p.x * frame.width,
        y: p.y * frame.height,
      })) as Quad;
    else {
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
      segment = (await run('segment', mode, async (id) => {
        const result = await meta.segment(dataUrl, 'desk', frame.width, frame.height);
        return { ...result, assets: [store.asset(id, 'sam-output.txt', result.raw)] };
      })) as EvidenceRun<Segmentation>;
      const top = [...(segment.output.detections ?? [])].sort((a, b) => areaOf(b) - areaOf(a))[0];
      const found = top ? pictureDesk(top, frame) : null;
      desk = found && alignCorners(found, pin.corners);
    }
    const illustration: SceneIllustration = {
      asset,
      frame,
      surfaceId: pin.surfaceId,
      desk,
      createdAt: new Date().toISOString(),
    };
    store.saveMemory({ ...store.memory(mode), illustration });
    return {
      memory: store.memory(mode),
      run: { ...drawn, output: { illustration } } as EvidenceRun<{
        illustration: SceneIllustration;
      }>,
      segment,
      illustration,
    };
  });
  /** A room's picture. */
  app.get('/api/scene/illustration', async (request, reply) => {
    const { asset } = parseInput(z.object({ asset: illustrationRef }).strict(), request.query);
    const png = store.readAsset(asset);
    if (!png) throw new LabError('illustration_missing', 'This picture is gone.', 404);
    return reply.type('image/png').header('cache-control', 'no-cache').send(png);
  });
}
