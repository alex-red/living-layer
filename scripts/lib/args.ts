/**
 * Command-line helpers shared by the scripts: flags, and `--set` overrides
 * of furniture measurements (`--set desk.topCm=3,4,5 --set chair.arms=false`)
 * and of the room layout's numbers (`--set layout.pastTop=2,4,8`, from
 * LAYOUT_TUNING), expanded into every combination for a sweep.
 */
import {
  FURNITURE_SPECS,
  LAYOUT_TUNING,
  withFurniture,
  withLayout,
  type FurnitureOverrides,
  type LayoutTuning,
  type PropForm,
} from '@livinglayer/domain';

export interface Args {
  /** `--name value` and `--name=value`; a bare `--name` is `true`. Repeats collect. */
  flags: Map<string, string[]>;
  positional: string[];
}
export function parseArgs(argv = process.argv.slice(2)): Args {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const next = argv[i + 1];
    const value =
      eq >= 0
        ? arg.slice(eq + 1)
        : next !== undefined && !next.startsWith('--')
          ? (i++, next)
          : 'true';
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { flags, positional };
}
export const flag = (a: Args, name: string) => a.flags.get(name)?.at(-1);
export const has = (a: Args, name: string) => a.flags.has(name);

/** One combination of overrides, with a short label for tables. */
export interface Variant {
  label: string;
  overrides: FurnitureOverrides;
  /** The layout's numbers this variant changes. */
  layout: Partial<LayoutTuning>;
  /** The swept values, by `form.key`, for reading a sweep axis by axis. */
  values: Record<string, number | boolean>;
}
/**
 * Every combination of the `--set form.key=v1,v2` values, checked against
 * FURNITURE_SPECS so a typo fails loudly instead of measuring nothing.
 */
export function variants(sets: string[] = []): Variant[] {
  let out: Variant[] = [{ label: 'as built', overrides: {}, layout: {}, values: {} }];
  for (const set of sets) {
    const m = /^([a-z-]+)\.([A-Za-z]+)=(.+)$/.exec(set);
    if (!m) throw new Error(`--set ${set}: expected form.key=value[,value…]`);
    const [, form, key, list] = m as unknown as [string, PropForm | 'layout', string, string];
    const spec =
      form === 'layout'
        ? (LAYOUT_TUNING as Record<string, unknown>)
        : (FURNITURE_SPECS as Record<string, Record<string, unknown>>)[form];
    if (!spec)
      throw new Error(
        `--set ${set}: no form "${form}" (layout, ${Object.keys(FURNITURE_SPECS).join(', ')})`,
      );
    if (!(key in spec))
      throw new Error(`--set ${set}: ${form} has no "${key}" (${Object.keys(spec).join(', ')})`);
    const values = list.split(',').map((v) => {
      if (typeof spec[key] === 'boolean') {
        if (v !== 'true' && v !== 'false') throw new Error(`--set ${set}: ${key} is true or false`);
        return v === 'true';
      }
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`--set ${set}: ${v} isn't a number`);
      return n;
    });
    out = out.flatMap((base) =>
      values.map((value) => ({
        label: `${base.label === 'as built' ? '' : `${base.label} `}${form}.${key}=${value}`,
        overrides:
          form === 'layout'
            ? base.overrides
            : { ...base.overrides, [form]: { ...base.overrides[form], [key]: value } },
        layout: form === 'layout' ? { ...base.layout, [key]: value } : base.layout,
        values: { ...base.values, [`${form}.${key}`]: value },
      })),
    );
  }
  return out;
}

/** Runs `fn` with a variant's furniture measurements and layout numbers in force. */
export const withVariant = <T>(v: Variant, fn: () => T): T =>
  withFurniture(v.overrides, () => withLayout(v.layout, fn));
