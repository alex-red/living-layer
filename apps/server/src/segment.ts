import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import {
  demoSourceKey,
  segmentRequestSchema,
  type DemoPosition,
  type EvidenceRun,
  type Mode,
  type Segmentation,
} from '@livinglayer/domain';
import { demoSegmentation } from './demo.js';
import { LabError, liveImage, parseInput } from './errors.js';
import { samDataUrl, samReadyPng, validateImage } from './images.js';
import { requestSignal } from './request-signal.js';
import type { RouteDeps } from './route-deps.js';

/** One SAM segmentation, recorded and billed as a run: the lab's button, or the watcher. */
type Segment = (
  input: { mode: Mode; concept: string; imageDataUrl?: string; demoPosition?: DemoPosition },
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
}

export async function segmentRoutes(app: FastifyInstance, { segment }: { segment: Segment }) {
  app.post('/', { prefixTrailingSlash: 'no-slash' }, async (request) =>
    segment(parseInput(segmentRequestSchema, request.body), requestSignal(request)),
  );
}
