import type { FastifyInstance } from 'fastify';
import { settingsSpendLimitBodySchema, settingsTrackingAiBodySchema } from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import type { RouteDeps } from './route-deps.js';
import type { EvidenceStore } from './store.js';

/** Settings the page changes: the daily spending limit, and whether tracking may call AI. */
export async function settingsRoutes(
  app: FastifyInstance,
  { store, config }: Pick<RouteDeps, 'store' | 'config'>,
) {
  /** Change the daily Meta spending limit; null goes back to the one in `.env`. */
  app.post('/spend-limit', async (request) => {
    const { usd } = parseInput(settingsSpendLimitBodySchema, request.body);
    store.setSpendLimit(usd === null ? null : Math.round(usd * 100) / 100);
    return {
      spendLimit: store.spendLimit(config.spendLimitUsd),
      spentToday: store.spentToday(),
    };
  });
  /** Let tracking call SAM and Spark, or keep it to what runs on this machine. */
  app.post('/tracking-ai', async (request) => {
    const { on } = parseInput(settingsTrackingAiBodySchema, request.body);
    store.setTrackingAi(on);
    return { on: store.trackingAi() };
  });
}

/** Refuses with 409 `tracking_ai_off` unless tracking may call SAM or Spark. */
export function requireTrackingAi(store: EvidenceStore, what: string) {
  if (!store.trackingAi())
    throw new LabError(
      'tracking_ai_off',
      `Tracking makes no AI calls unless they are turned on in Settings, so ${what} isn’t asked. Drag a box around the thing to outline it on this machine instead.`,
      409,
    );
}
