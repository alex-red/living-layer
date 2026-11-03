import { describe, expect, test } from 'bun:test';
import { deskMemorySchema } from '@livinglayer/domain';

describe('deskMemorySchema', () => {
  const base = { mode: 'live', object: null, observation: null, zone: null, lastDecision: null };

  test('upgrades earlier memory before checking it', () => {
    const old = {
      ...base,
      rules: [
        { id: 'r', label: 'Desk', objectId: 'o1', lightId: 'light.desk', placement: 'inside' },
      ],
    };
    const memory = deskMemorySchema.parse(old);
    expect(memory.rules?.[0]).toMatchObject({
      entityId: 'light.desk',
      objects: ['o1'],
      inside: ['o1'],
    });
  });

  test('refuses what is not memory', () => {
    expect(deskMemorySchema.safeParse({ ...base, mode: 'nope' }).success).toBe(false);
    expect(deskMemorySchema.safeParse(null).success).toBe(false);
    expect(deskMemorySchema.safeParse({ ...base, rules: 3 }).success).toBe(false);
  });
});
