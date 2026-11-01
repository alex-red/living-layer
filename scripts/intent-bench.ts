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
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  describeContext,
  opCatalog,
  PROP_FORMS,
  readIntent,
  type EditIntent,
  type IntentOp,
  type SparkIntent,
} from '@livinglayer/domain';
import { parseConfig } from '../apps/server/src/config.js';
import { demoIntent } from '../apps/server/src/demo-intent.js';
import { MetaAdapter } from '../apps/server/src/meta.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { flag, has, parseArgs } from './lib/args.js';
import { checkIntentCase, INTENT_CASES, type IntentCase } from './lib/intent-cases.js';

const args = parseArgs();
const live = has(args, 'live');
const only = flag(args, 'only');
const repeatRaw = flag(args, 'repeat');
const repeat = Math.max(1, repeatRaw && !Number.isNaN(Number(repeatRaw)) ? Number(repeatRaw) : 1);
const showRepeat = has(args, 'repeat') || repeat > 1;
const noCache = has(args, 'no-cache') || has(args, 'refresh');

let cases = INTENT_CASES;
if (only) {
  const needle = only.toLowerCase();
  cases = cases.filter((c) => c.name.toLowerCase().includes(needle));
  if (cases.length === 0) {
    throw new Error(`--only "${only}": no case matches`);
  }
}

const store = live ? new EvidenceStore(mkdtempSync(join(tmpdir(), 'intent-bench-'))) : null;
const meta = store ? new MetaAdapter(parseConfig(process.env), store) : null;

const cachePath = join(process.env.DATA_DIR ?? '.data', 'intent-cache.json');
let cache: Record<string, SparkIntent> = {};
if (live && !noCache) {
  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    cache = {};
  }
}

function saveCache() {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // Ignore cache write errors.
  }
}

function promptHash(c: IntentCase, runIdx = 0, repeatCount = 1): string {
  const inputs = [
    c.sentence,
    describeContext(c.ctx),
    opCatalog(),
    PROP_FORMS,
    ...(repeatCount > 1 ? [runIdx] : []),
  ];
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

let cacheHits = 0;
let billedCalls = 0;

async function read(c: IntentCase, runIdx = 0, repeatCount = 1): Promise<SparkIntent> {
  if (!meta) return demoIntent(c.sentence);
  const key = promptHash(c, runIdx, repeatCount);
  if (!noCache && key in cache) {
    cacheHits++;
    return cache[key]!;
  }
  billedCalls++;
  const raw = (await meta.intent(c.sentence, c.ctx)).output;
  cache[key] = raw;
  saveCache();
  return raw;
}

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

function checkIntent(intent: EditIntent, c: IntentCase): boolean {
  const opsOk =
    intent.ops.length === c.ops.length && c.ops.every((o, i) => matches(intent.ops[i], o));
  const productOk =
    c.product === undefined ||
    (c.product === null
      ? intent.product === null
      : Boolean(
          intent.product && c.product.every((w) => intent.product!.toLowerCase().includes(w)),
        ));
  const needsOk = c.needs === undefined || isDeepStrictEqual(intent.needs, c.needs);
  return opsOk && productOk && needsOk;
}

const short = (o: IntentOp) => {
  const { op, ...rest } = o;
  const detail = JSON.stringify(rest);
  return detail === '{}' ? op : `${op} ${detail.length > 70 ? `${detail.slice(0, 67)}…` : detail}`;
};

function formatActual(intent: EditIntent, c: IntentCase): string {
  const parts: string[] = [intent.ops.map(short).join(' · ') || '(no ops)'];
  if (intent.product) {
    parts.push(`product “${intent.product}”`);
  } else if (c.product !== undefined) {
    parts.push('product null');
  }
  if (intent.needs.length > 0 || c.needs !== undefined) {
    parts.push(`needs [${intent.needs.join(', ')}]`);
  }
  return parts.join(' · ');
}

function formatWanted(c: IntentCase): string {
  const parts: string[] = [c.ops.map((o) => short(o as IntentOp)).join(' · ')];
  if (c.product !== undefined) {
    parts.push(`product ${c.product === null ? 'null' : c.product.join(' ')}`);
  }
  if (c.needs !== undefined) {
    parts.push(`needs [${c.needs.join(', ')}]`);
  }
  return parts.join(' · ');
}

console.log(`reader: ${live ? 'Spark (live)' : 'demo, offline'}\n`);
let misses = 0;
for (const c of cases) {
  const problems = checkIntentCase(c);
  const valid = problems.length === 0;

  let passCount = 0;
  let lastIntent: (EditIntent & { dropped: string[] }) | null = null;
  for (let r = 0; r < repeat; r++) {
    const raw = await read(c, r, repeat);
    const intent = readIntent(raw, c.ctx);
    lastIntent = intent;
    if (valid && checkIntent(intent, c)) passCount++;
  }

  const ok = valid && passCount === repeat;
  if (!ok) misses++;

  const steadyOrFlaky = passCount === 0 || passCount === repeat ? 'steady' : 'flaky';
  const repeatLabel = showRepeat ? `${steadyOrFlaky} (${passCount}/${repeat}) · ` : '';

  console.log(
    `${ok ? '✓' : '✗'} ${c.name.padEnd(26)} ${repeatLabel}${formatActual(lastIntent!, c)}`,
  );
  if (!ok) {
    console.log(`  wanted ${formatWanted(c)}`);
    for (const p of problems) console.log(`  invalid case: ${p}`);
  }
  if (lastIntent?.dropped.length) console.log(`  left out: ${lastIntent.dropped.join(' ')}`);
}

console.log(`\n${cases.length - misses}/${cases.length} read as wanted`);
if (live) {
  console.log(`${billedCalls} billed call${billedCalls === 1 ? '' : 's'}, ${cacheHits} from cache`);
}
if (store) console.log(`spent $${store.spentToday().toFixed(4)}`);
if (misses) process.exit(1);
