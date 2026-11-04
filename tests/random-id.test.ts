import { describe, expect, test } from 'bun:test';
import { randomId } from '../apps/web/src/workspace/state/random-id';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomId', () => {
  test('uses randomUUID when the context has it', () => {
    const source = {
      randomUUID: () => 'from-crypto',
      getRandomValues: crypto.getRandomValues.bind(crypto),
    };
    expect(randomId(source as never)).toBe('from-crypto');
  });

  test('builds a v4 UUID from random bytes without randomUUID, as on plain HTTP', () => {
    const source = {
      getRandomValues: <T extends ArrayBufferView>(a: T) => (
        new Uint8Array(a.buffer).fill(0xff),
        a
      ),
    };
    expect(randomId(source as never)).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(randomId(source as never)).toMatch(UUID_V4);
  });
});
