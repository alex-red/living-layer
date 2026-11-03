import { describe, expect, it } from 'bun:test';
import { INTENT_KINDS, opCatalog, RECIPE_OPS } from '@livinglayer/domain';
import { DEMO_GAPS, INTENT_CASES } from '../scripts/lib/intent-cases.js';

/**
 * Every op the brush can do is reachable: it has a request in the intent
 * cases the demo's reader is checked on (`tests/intent.test.ts`, `bun run
 * bench:intent`), or is listed in `DEMO_GAPS` with why not. A new op can't
 * land with only its schema.
 */
const OPS = [...Object.keys(RECIPE_OPS), ...INTENT_KINDS];

describe('every op', () => {
  const cased = new Set(INTENT_CASES.flatMap((c) => c.ops.map((o) => o.op)));
  for (const op of OPS)
    it(op, () => {
      const gap = DEMO_GAPS[op as keyof typeof DEMO_GAPS];
      if (gap) {
        expect(cased.has(op as never), `${op} has a case now: take it out of DEMO_GAPS`).toBe(
          false,
        );
        expect(gap.length).toBeGreaterThan(10);
      } else
        expect(cased.has(op as never), `${op} needs an intent case, or a DEMO_GAPS reason`).toBe(
          true,
        );
      // Spark's prompt lists it, from the registries.
      expect(opCatalog()).toContain(`- ${op}: `);
    });
});
