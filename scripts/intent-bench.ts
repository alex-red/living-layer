/**
 * How requests typed beside a selection are read. Runs every case in
 * `lib/intent-cases.ts` through a reader and `readIntent`, and prints the
 * ops each gave against the ops expected. Exits non-zero on a miss.
 *
 *   bun run bench:intent           the demo's reader, offline
 *   bun run bench:intent --live    Spark, one billed call per case
 *
 * Live calls keep their spend in a throwaway store under the configured
 * daily limit, so a running server's ledger isn't touched; each case costs
 * at most a Spark call with no image (about $0.04 at its output ceiling).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readIntent, type IntentOp, type SparkIntent } from '@livinglayer/domain';
import { parseConfig } from '../apps/server/src/config.js';
import { demoIntent } from '../apps/server/src/demo-intent.js';
import { MetaAdapter } from '../apps/server/src/meta.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { has, parseArgs } from './lib/args.js';
import { INTENT_CASES, type IntentCase } from './lib/intent-cases.js';

const args = parseArgs();
const live = has(args, 'live');
const store = live ? new EvidenceStore(mkdtempSync(join(tmpdir(), 'intent-bench-'))) : null;
const meta = store ? new MetaAdapter(parseConfig(process.env), store) : null;

/** Whether `actual` has every field `wanted` gives, recursively. */
function matches(actual: unknown, wanted: unknown): boolean {
  if (wanted && typeof wanted === 'object' && !Array.isArray(wanted))
    return (
      !!actual &&
      typeof actual === 'object' &&
      Object.entries(wanted).every(([k, v]) => matches((actual as Record<string, unknown>)[k], v))
    );
  return isDeepStrictEqual(actual, wanted);
}
const short = (o: IntentOp) => {
  const { op, ...rest } = o;
  const detail = JSON.stringify(rest);
  return detail === '{}' ? op : `${op} ${detail.length > 70 ? `${detail.slice(0, 67)}…` : detail}`;
};
async function read(c: IntentCase): Promise<SparkIntent> {
  if (!meta) return demoIntent(c.sentence);
  return (await meta.intent(c.sentence, c.ctx)).output;
}

console.log(`reader: ${live ? 'Spark (live)' : 'demo, offline'}\n`);
let misses = 0;
for (const c of INTENT_CASES) {
  const intent = readIntent(await read(c), c.ctx);
  const ok =
    intent.ops.length === c.ops.length &&
    c.ops.every((o, i) => matches(intent.ops[i], o)) &&
    (c.product === undefined ||
      (c.product === null
        ? intent.product === null
        : c.product.every((w) => intent.product?.toLowerCase().includes(w))));
  if (!ok) misses++;
  console.log(`${ok ? '✓' : '✗'} ${c.name.padEnd(26)} ${intent.ops.map(short).join(' · ')}`);
  if (!ok)
    console.log(
      `  wanted ${c.ops.map((o) => o.op).join(' · ')}${c.product ? `, product ${c.product.join(' ')}` : ''}`,
    );
  if (intent.dropped.length) console.log(`  left out: ${intent.dropped.join(' ')}`);
}
console.log(`\n${INTENT_CASES.length - misses}/${INTENT_CASES.length} read as wanted`);
if (store) console.log(`spent $${store.spentToday().toFixed(4)}`);
if (misses) process.exit(1);
