import type { FastifyInstance } from 'fastify';
import { lampBodySchema, type LampResult } from '@livinglayer/domain';
import { demoLamp, demoLampFor } from './demo.js';
import { LabError, parseInput } from './errors.js';
import type { RouteDeps } from './route-deps.js';

/** The by-hand switch. `switchLive` goes over MQTT or Home Assistant, whichever the device is on. */
export async function lampRoutes(
  app: FastifyInstance,
  {
    run,
    entities,
    switchLive,
  }: Pick<RouteDeps, 'run' | 'entities'> & {
    switchLive: (entity: string | undefined, action: 'on' | 'off') => Promise<LampResult>;
  },
) {
  /** Switch one device by hand: the main light on, unless it names another and which way. */
  app.post('/', { prefixTrailingSlash: 'no-slash' }, async (request) => {
    const { mode, entityId, action } = parseInput(lampBodySchema, request.body);
    if (entityId && !entities(mode).includes(entityId))
      throw new LabError(
        'lamp_unknown',
        `${entityId} isn’t one of the devices Living Layer may switch.`,
        409,
      );
    return run('lamp', mode, async () => ({
      output:
        mode === 'demo'
          ? entityId
            ? demoLampFor(entityId, action)
            : demoLamp
          : await switchLive(entityId, action),
    }));
  });
}
