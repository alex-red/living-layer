/**
 * Shared bench reporting: every case is a row of metrics, each with a target
 * and a direction, so the table shows how much room is left (the margin)
 * and not only pass or fail. Benches take the same flags:
 *
 *   --json <file>      write the rows, for a baseline (see `bun run bench:at`)
 *   --compare <file>   print what moved against a baseline and flag regressions
 *   --set form.key=v,… sweep furniture measurements (scripts that build scenes)
 *
 * A bench exits non-zero when a case misses a target (known gaps aside) or,
 * with --compare, when a case that met its targets no longer does.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { flag, type Args, type Variant } from './args.js';

export interface Metric {
  value: number;
  target: number;
  /** Which way is better: values at or under the target, or at or over it. */
  better: 'lower' | 'higher';
  /** How to print a value; plain fixed-point by default. */
  unit?: '%' | 'tiles' | '';
  digits?: number;
}
export interface Row {
  case: string;
  /** The `--set` variant, `as built` without one. */
  variant: string;
  metrics: Record<string, Metric>;
  /** Shown as they are, not judged: a camera angle, a time. */
  notes?: Record<string, string>;
  /** Reported against the targets, but a miss doesn't fail the run. */
  knownGap?: boolean;
}
/** Room left before a metric misses its target: negative is a miss. */
export const margin = (m: Metric) =>
  m.better === 'lower' ? m.target - m.value : m.value - m.target;
const meets = (r: Row) => Object.values(r.metrics).every((m) => margin(m) >= 0);
const show = (m: Metric, v = m.value) => {
  if (!Number.isFinite(v)) return String(v);
  const scale = m.unit === '%' ? 100 : 1;
  return `${(v * scale).toFixed(m.digits ?? 2)}${m.unit === '%' ? '%' : ''}`;
};
const key = (r: Pick<Row, 'case' | 'variant'>) => `${r.case}|${r.variant}`;

/** Print the rows, write or compare a baseline, and return the exit code. */
export function report(rows: Row[], args: Args, title = 'bench', swept: Variant[] = []): number {
  const names = [...new Set(rows.flatMap((r) => Object.keys(r.metrics)))];
  const notes = [...new Set(rows.flatMap((r) => Object.keys(r.notes ?? {})))];
  const variants = new Set(rows.map((r) => r.variant)).size > 1;
  const caseW = Math.max(4, ...rows.map((r) => r.case.length)) + 1;
  const varW = variants ? Math.max(7, ...rows.map((r) => r.variant.length)) + 1 : 0;
  const cell = (m?: Metric) =>
    m ? `${show(m)} (${margin(m) >= 0 ? '+' : ''}${show(m, margin(m))})` : '';
  const noteW = notes.map(
    (n) => Math.max(n.length, ...rows.map((r) => r.notes?.[n]?.length ?? 0)) + 2,
  );
  const colW = names.map(
    (n) => Math.max(n.length, ...rows.map((r) => cell(r.metrics[n]).length)) + 2,
  );
  console.log(
    [
      'case'.padEnd(caseW),
      variants ? 'variant'.padEnd(varW) : '',
      ...names.map((n, i) => n.padEnd(colW[i]!)),
      ...notes.map((n, i) => n.padEnd(noteW[i]!)),
    ].join(''),
  );
  let misses = 0;
  for (const r of rows) {
    const ok = meets(r);
    if (!ok && !r.knownGap) misses++;
    console.log(
      [
        r.case.padEnd(caseW),
        variants ? r.variant.padEnd(varW) : '',
        ...names.map((n, i) => cell(r.metrics[n]).padEnd(colW[i]!)),
        ...notes.map((n, i) => (r.notes?.[n] ?? '').padEnd(noteW[i]!)),
        ok ? '' : r.knownGap ? '← below target (known gap)' : '← below target',
      ].join(''),
    );
  }
  console.log('\n(value (margin): room left before the target; negative is a miss)');
  if (variants) {
    console.log(
      '\nvariant summary: misses, then the tightest margin per metric (known gaps aside)',
    );
    for (const v of new Set(rows.map((r) => r.variant))) {
      const own = rows.filter((r) => r.variant === v);
      const tight = names.map((n) => {
        const ms = own
          .filter((r) => !r.knownGap)
          .map((r) => r.metrics[n])
          .filter((m): m is Metric => !!m);
        const worst = ms.reduce<Metric | null>(
          (a, m) => (!a || margin(m) < margin(a) ? m : a),
          null,
        );
        return worst ? `${n} ${show(worst, margin(worst))}` : '';
      });
      const miss = own.filter((r) => !meets(r) && !r.knownGap).length;
      console.log(`  ${v.padEnd(varW)} ${String(miss).padEnd(3)} ${tight.join('  ')}`);
    }
  }

  if (swept.length > 1) stability(rows, swept);

  const json = flag(args, 'json');
  if (json) {
    mkdirSync(dirname(json), { recursive: true });
    writeFileSync(json, JSON.stringify({ title, rows }, null, 2));
    console.log(`\n→ ${json}`);
  }
  const compare = flag(args, 'compare');
  let regressions = 0;
  if (compare) {
    const base = new Map(
      (JSON.parse(readFileSync(compare, 'utf8')) as { rows: Row[] }).rows.map((r) => [key(r), r]),
    );
    console.log(`\nagainst ${compare}:`);
    for (const r of rows) {
      const b = base.get(key(r)) ?? base.get(key({ case: r.case, variant: 'as built' }));
      if (!b) {
        console.log(`  ${r.case}: new case`);
        continue;
      }
      const moved = names
        .filter((n) => r.metrics[n] && b.metrics[n])
        .map((n) => {
          const d = margin(r.metrics[n]!) - margin(b.metrics[n]!);
          return Math.abs(d) < 1e-9 ? '' : `${n} ${d > 0 ? '+' : ''}${show(r.metrics[n]!, d)}`;
        })
        .filter(Boolean);
      const lost = meets(b) && !meets(r);
      if (lost) regressions++;
      console.log(
        `  ${`${r.case}${variants ? ` · ${r.variant}` : ''}`.padEnd(caseW + varW)} ${
          moved.length ? moved.join('  ') : 'unchanged'
        }${lost ? '  ← REGRESSION: met its targets before' : meets(r) && !meets(b) ? '  ← fixed' : ''}`,
      );
    }
    console.log('(margin moved: + is more room, − is less)');
  }
  return misses || regressions ? 1 : 0;
}

/**
 * A sweep read one measurement at a time: a value passes when every
 * variant with it meets its targets (known gaps aside). A value that passes
 * while a neighbour misses sits in a narrow pocket: a change elsewhere can
 * tip it over, so it isn't a safe choice even though the table is green.
 */
function stability(rows: Row[], swept: Variant[]) {
  const passed = new Map(
    swept.map((v) => [
      v.label,
      rows.filter((r) => r.variant === v.label && !r.knownGap).every(meets),
    ]),
  );
  const keys = [...new Set(swept.flatMap((v) => Object.keys(v.values)))];
  if (!keys.length) return;
  console.log('\nstability: ✓ every variant with this value passes, ✗ some miss');
  for (const key of keys) {
    const values = [...new Set(swept.map((v) => v.values[key]!))].sort((a, b) =>
      typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)),
    );
    const ok = values.map((value) =>
      swept.filter((v) => v.values[key] === value).every((v) => passed.get(v.label)),
    );
    const narrow = values.filter(
      (_, i) => ok[i] && values.length > 2 && (ok[i - 1] === false || ok[i + 1] === false),
    );
    console.log(
      `  ${key.padEnd(22)} ${values.map((v, i) => `${v} ${ok[i] ? '✓' : '✗'}`).join('  ')}${
        narrow.length
          ? `\n  ${''.padEnd(22)} ← ${narrow.join(', ')} pass${narrow.length > 1 ? '' : 'es'} beside a miss: a narrow pocket, not a safe choice`
          : ''
      }`,
    );
  }
}
