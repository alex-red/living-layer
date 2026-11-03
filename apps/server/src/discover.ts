import type { FastifyInstance } from 'fastify';
import { imageRequestSchema } from '@livinglayer/domain';
import { liveImage, parseInput } from './errors.js';
import { validateImage } from './images.js';
import { demoScene } from './demo.js';
import type { RouteDeps } from './route-deps.js';

/** Name what a photo shows, with no layout: Spark's discovery, or the demo's. */
export async function discoverRoutes(
  app: FastifyInstance,
  { store, meta, run }: Pick<RouteDeps, 'store' | 'meta' | 'run'>,
) {
  app.post('/', { prefixTrailingSlash: 'no-slash' }, async (request) => {
    const input = parseInput(imageRequestSchema, request.body);
    return run('discover', input.mode, async (id) => {
      if (input.mode === 'demo') {
        liveImage(input.mode, input.imageDataUrl);
        return { output: demoScene };
      }
      const image = await validateImage(input.imageDataUrl);
      const result = await meta.discover(image.dataUrl);
      return { ...result, assets: [store.asset(id, `source.${image.ext}`, image.bytes)] };
    });
  });
}
