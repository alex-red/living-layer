import type { FastifyInstance } from 'fastify';
import { settingsSpendLimitBodySchema } from '@livinglayer/domain';
import { parseInput } from './errors.js';
import type { RouteDeps } from './route-deps.js';

/** Settings the page changes: the daily spending limit. */
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
}
