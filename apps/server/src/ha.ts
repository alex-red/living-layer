import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { entityIdSchema, modeSchema } from '@livinglayer/domain';
import type { ControlAdapter } from './control.js';
import { parseInput } from './errors.js';
import type { EvidenceStore } from './store.js';

/** The most devices the lab lets someone tick; rules and fixtures pick from these. */
export const MAX_CHOSEN = 24;
const KEY = 'ha_entities';

/** The Home Assistant devices ticked in the lab, beside the ones `.env` names. */
export function chosenEntities(store: EvidenceStore): string[] {
  try {
    const parsed = z.array(entityIdSchema).safeParse(JSON.parse(store.setting(KEY) ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Choosing which Home Assistant devices Living Layer may switch, from the
 * lab: list what Home Assistant has, keep the ones ticked. Connecting (the
 * URL and token) and turning switching on stay in `.env`.
 */
export function haRoutes(
  app: FastifyInstance,
  {
    store,
    lamp,
    fixed,
  }: {
    store: EvidenceStore;
    lamp: ControlAdapter;
    /** The ones `.env` names, always allowed and not changed here. */
    fixed: () => string[];
  },
) {
  app.get('/api/ha/entities', async () => ({ entities: await lamp.entities() }));
  app.post('/api/ha/chosen', async (request) => {
    const { entityIds } = parseInput(
      // `mode` rides along from the lab; the choice is for live mode, demo has its own devices.
      z
        .object({ mode: modeSchema.optional(), entityIds: z.array(entityIdSchema).max(MAX_CHOSEN) })
        .strict(),
      request.body,
    );
    const env = new Set(fixed());
    const chosen = [...new Set(entityIds)].filter((e) => !env.has(e));
    store.setSetting(KEY, JSON.stringify(chosen));
    return { chosen };
  });
}
