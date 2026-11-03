import { describe, expect, test } from 'bun:test';
import {
  haChosenBodySchema,
  modeOnlySchema,
  remoteTokenParamsSchema,
  settingsSpendLimitBodySchema,
  type ModeOnly,
} from '@livinglayer/domain';

describe('request schemas', () => {
  test('are strict, as the routes were', () => {
    const ok: ModeOnly = { mode: 'live' };
    expect(modeOnlySchema.safeParse(ok).success).toBe(true);
    expect(modeOnlySchema.safeParse({ mode: 'live', extra: 1 }).success).toBe(false);
    expect(modeOnlySchema.safeParse({ mode: 'nope' }).success).toBe(false);
  });

  test('keep their limits', () => {
    expect(settingsSpendLimitBodySchema.safeParse({ usd: 1001 }).success).toBe(false);
    expect(settingsSpendLimitBodySchema.safeParse({ usd: null }).success).toBe(true);
    expect(haChosenBodySchema.safeParse({ entityIds: [] }).success).toBe(true);
    expect(remoteTokenParamsSchema.safeParse({ token: 'x'.repeat(32) }).success).toBe(true);
    expect(remoteTokenParamsSchema.safeParse({ token: 'short' }).success).toBe(false);
  });
});
