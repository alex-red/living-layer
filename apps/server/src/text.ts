import type { FastifyInstance } from 'fastify';
import { modeOnlySchema } from '@livinglayer/domain';
import { parseInput } from './errors.js';
import type { RouteDeps } from './route-deps.js';

/** The connection check: one small model request, or the demo's canned reply. */
export async function textRoutes(
  app: FastifyInstance,
  { meta, run }: Pick<RouteDeps, 'meta' | 'run'>,
) {
  app.post('/', { prefixTrailingSlash: 'no-slash' }, async (request) => {
    const { mode } = parseInput(modeOnlySchema, request.body);
    return run('text', mode, async () =>
      mode === 'demo'
        ? { output: { text: 'Demo connection ready. No model request was sent.' } }
        : meta.text(),
    );
  });
}
