/**
 * The lab's run log, with no server: the latest runs (what, when, how long,
 * what it cost, why it failed), or one run in full. For one run it prints
 * what each model did and the steps of the job that made it, and saves its
 * assets and the steps' pictures to out/runs/<id>/ to open, rather than
 * reading them off the page.
 *
 *   bun run runs                    the latest 15
 *   bun run runs --kind photo --mode live --limit 5
 *   bun run runs c692f66f           one run: steps, assists, error → out/runs/c692f66f/
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { runCost, type EvidenceRun, type Mode, type RunKind } from '@livinglayer/domain';
import { flag, parseArgs } from './lib/args.js';
import { openEvidence } from './lib/evidence.js';

const args = parseArgs();
const store = openEvidence();
const when = (iso: string) => iso.replace('T', ' ').slice(0, 19);
const cost = (r: EvidenceRun) => {
  const usd = runCost(r);
  return usd == null ? '' : `$${usd.toFixed(3)}`;
};
const why = (r: EvidenceRun) => {
  const out = r.output as { error?: { message?: string } | string } | null;
  const e = out?.error;
  return typeof e === 'string' ? e : (e?.message ?? '');
};

const ref = args.positional[0];
if (!ref) {
  const runs = store.runs({
    ...(flag(args, 'kind') ? { kind: flag(args, 'kind') as RunKind } : {}),
    ...(flag(args, 'mode') ? { mode: flag(args, 'mode') as Mode } : {}),
    limit: Number(flag(args, 'limit') ?? 15),
  });
  for (const r of runs)
    console.log(
      [
        r.id.slice(0, 8),
        when(r.createdAt),
        r.kind.padEnd(12),
        r.mode.padEnd(4),
        r.status.padEnd(11),
        `${(r.durationMs / 1000).toFixed(1)}s`.padStart(6),
        cost(r).padStart(7),
        why(r),
      ]
        .join('  ')
        .trimEnd(),
    );
  store.close();
  process.exit(0);
}

const run = store.run(ref);
const short = run.id.slice(0, 8);
console.log(
  `${run.kind} run ${run.id} (${run.mode}), ${when(run.createdAt)}: ${run.status} in ${(run.durationMs / 1000).toFixed(1)}s ${cost(run)}`,
);
if (run.model)
  console.log(`  model ${run.model}${run.requestId ? `, request ${run.requestId}` : ''}`);
if (why(run)) console.log(`  failed: ${why(run)}`);
const job = store.jobOf(run.id);
const dir = resolve(import.meta.dir, '..', 'out', 'runs', short);
mkdirSync(dir, { recursive: true });
if (job) {
  console.log(`\n${job.title ?? 'Job'} (${job.outcome ?? 'running'}):`);
  job.steps.forEach((s, i) => {
    console.log(
      `  ${s.state === 'done' ? '✓' : s.state === 'failed' ? '✗' : '·'} ${s.label}${s.detail ? `: ${s.detail}` : ''}`,
    );
    const picture = s.image && /^data:image\/(\w+);base64,(.+)$/.exec(s.image);
    if (picture)
      writeFileSync(
        resolve(dir, `step-${i + 1}-${s.id}.${picture[1]}`),
        Buffer.from(picture[2]!, 'base64'),
      );
  });
  if (job.error) console.log(`  error: ${job.error}`);
}
const assists = (run.output as { assists?: string[] } | null)?.assists;
if (assists?.length) console.log(`\n${assists.map((a) => `· ${a}`).join('\n')}`);
let saved = 0;
for (const a of run.assets) {
  const content = store.asset(a);
  if (!content) continue;
  writeFileSync(resolve(dir, basename(a)), content);
  saved++;
}
console.log(`\n${saved} assets${job ? ' and the steps’ pictures' : ''} in ${dir}`);
store.close();
