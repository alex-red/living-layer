import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  demoSourceKey,
  detectionFromBits,
  LOCAL_OUTLINE_MODEL,
  outlineIn,
  segmentBodySchema,
  selectionMask,
  type DemoPosition,
  type EvidenceRun,
  type Mode,
  type Segmentation,
  type SelectionShape,
} from '@livinglayer/domain';
import { demoPng, demoSegmentation } from './demo.js';
import { LabError, liveImage, parseInput } from './errors.js';
import { samDataUrl, samReadyPng, validateImage } from './images.js';
import { requestSignal } from './request-signal.js';
import type { RouteDeps } from './route-deps.js';
import { requireTrackingAi } from './settings.js';

/**
 * One segmentation, recorded as a run: the lab's button, or the watcher. With
 * a `shape`, the thing inside it is outlined on this machine; otherwise SAM
 * outlines every match of the concept, billed.
 */
type Segment = (
  input: {
    mode: Mode;
    concept: string;
    imageDataUrl?: string;
    demoPosition?: DemoPosition;
    shape?: SelectionShape;
  },
  signal?: AbortSignal,
) => Promise<EvidenceRun<Segmentation>>;

export function createSegment({
  store,
  meta,
  run,
}: Pick<RouteDeps, 'store' | 'meta' | 'run'>): Segment {
  return function segment(input, signal) {
    return run(
      'segment',
      input.mode,
      async (id) => {
        if (input.shape) return outlineLocally(input, input.shape, id);
        if (input.mode === 'demo') {
          liveImage(input.mode, input.imageDataUrl);
          const result = await demoSegmentation(input.concept, input.demoPosition);
          return {
            output: { ...result.output, sourceKey: demoSourceKey(input.demoPosition) },
            assets: [store.asset(id, 'synthetic-sam.txt', result.raw)],
          };
        }
        if (input.demoPosition)
          throw new LabError('demo_position', 'Demo positions apply only in demo mode.');
        const options = signal ? { signal } : {};
        // A plain PNG (the watcher's frames) goes to SAM as it came, while the stored copy
        // is encoded alongside: the lossless WebP takes about 100 ms, and SAM needn't wait.
        const ready = await samReadyPng(input.imageDataUrl);
        const [image, result] = ready
          ? await Promise.all([
              validateImage(input.imageDataUrl),
              meta.segment(input.imageDataUrl!, input.concept, ready.width, ready.height, options),
            ])
          : await validateImage(input.imageDataUrl).then(
              async (image) =>
                [
                  image,
                  await meta.segment(
                    await samDataUrl(image),
                    input.concept,
                    image.width,
                    image.height,
                    options,
                  ),
                ] as const,
            );
        return {
          ...result,
          output: {
            ...result.output,
            sourceKey: createHash('sha256').update(image.bytes).digest('hex'),
          },
          assets: [
            store.asset(id, `source.${image.ext}`, image.bytes),
            store.asset(id, 'sam-output.txt', result.raw),
          ],
        };
      },
      signal,
    ) as Promise<EvidenceRun<Segmentation>>;
  };

  /**
   * The thing inside the shape a person drew, outlined with no model call
   * (`outlineIn`): on the demo's render, or on the frame sent. Recorded as an
   * ordinary segmentation with one detection, so confirming and following it
   * go the same way as SAM's.
   */
  async function outlineLocally(input: Parameters<Segment>[0], shape: SelectionShape, id: string) {
    liveImage(input.mode, input.imageDataUrl);
    if (input.mode !== 'demo' && input.demoPosition)
      throw new LabError('demo_position', 'Demo positions apply only in demo mode.');
    const image =
      input.mode === 'demo'
        ? { bytes: await demoPng(input.demoPosition), ext: 'png' }
        : await validateImage(input.imageDataUrl);
    const { data, info } = await sharp(image.bytes)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const frame = { width: info.width, height: info.height };
    const outline = outlineIn(
      { ...frame, data: new Uint8Array(data.buffer, data.byteOffset, data.length) },
      selectionMask(shape, frame),
    );
    const detection = outline && detectionFromBits('1', outline.bits);
    const output: Segmentation = {
      concept: input.concept,
      frame,
      detections: detection
        ? [
            {
              ...detection,
              confidence: null,
              ...(outline.fallback ? { boxOnly: true as const } : {}),
            },
          ]
        : [],
      sourceKey:
        input.mode === 'demo'
          ? demoSourceKey(input.demoPosition)
          : createHash('sha256').update(image.bytes).digest('hex'),
    };
    return {
      output,
      model: LOCAL_OUTLINE_MODEL,
      assets: [
        store.asset(id, `source.${image.ext}`, image.bytes),
        store.asset(
          id,
          'local-outline.json',
          JSON.stringify({
            shape,
            share: outline?.share ?? 0,
            fallback: outline?.fallback ?? null,
          }),
        ),
      ],
    };
  }
}

export async function segmentRoutes(
  app: FastifyInstance,
  { segment, store }: { segment: Segment } & Pick<RouteDeps, 'store'>,
) {
  app.post('/', { prefixTrailingSlash: 'no-slash' }, async (request) => {
    const input = parseInput(segmentBodySchema, request.body);
    liveImage(input.mode, input.imageDataUrl);
    if (!input.shape) requireTrackingAi(store, 'SAM');
    return segment(input, requestSignal(request));
  });
}
