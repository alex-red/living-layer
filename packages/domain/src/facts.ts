import { z } from 'zod';
import { hexColorSchema, ITEM_MATERIALS } from './iso-item.js';
import { factSourceSchema, RECIPE_ROLES, type FactSource } from './recipe.js';

/**
 * What is known about a product before a model of it is built: its real
 * size, its parts, its colours ([plan](../../../docs/plans/ai-brush.md#5-gathering-facts)).
 * Facts come from several places (what the person said, a saved catalog,
 * the web, the photo); `mergeFacts` takes each field from the first that
 * has it, and every fact keeps where it came from for the review.
 */
export const FACT_NEEDS = ['size', 'parts', 'colors', 'materials'] as const;
export type FactNeed = (typeof FACT_NEEDS)[number];

const cmSize = z
  .object({
    w: z.number().positive().max(600),
    d: z.number().positive().max(600),
    h: z.number().positive().max(300),
  })
  .strict();
const productPartSchema = z
  .object({
    name: z.string().min(1).max(40),
    role: z.enum(RECIPE_ROLES).optional(),
    sizeCm: cmSize.partial().optional(),
    count: z.number().int().min(1).max(24).optional(),
    note: z.string().max(120).optional(),
  })
  .strict();
export const productFactsSchema = z
  .object({
    /** What was looked up: "IKEA Alex desk". */
    query: z.string().min(1).max(120),
    /** The product's own name, when a source gave one. */
    name: z.string().min(1).max(120).optional(),
    sizeCm: cmSize.optional(),
    parts: z.array(productPartSchema).max(24).optional(),
    colors: z
      .array(z.object({ name: z.string().min(1).max(40), hex: hexColorSchema }).strict())
      .max(8)
      .optional(),
    materials: z.array(z.enum(ITEM_MATERIALS)).max(6).optional(),
    sources: z.array(factSourceSchema).max(8),
    /** How sure the source is that these facts are of this product, 0 to 1. */
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type ProductFacts = z.infer<typeof productFactsSchema>;

const FIELD: Record<FactNeed, 'sizeCm' | 'parts' | 'colors' | 'materials'> = {
  size: 'sizeCm',
  parts: 'parts',
  colors: 'colors',
  materials: 'materials',
};
const has = (facts: ProductFacts, need: FactNeed) => {
  const v = facts[FIELD[need]];
  return Array.isArray(v) ? v.length > 0 : v !== undefined;
};
/** The needs these facts don't answer yet. */
export function missingFacts(facts: ProductFacts | null, need: readonly FactNeed[]): FactNeed[] {
  return need.filter((n) => !facts || !has(facts, n));
}

/** Facts merged from several sources, with the kind of source each field came from. */
export interface MergedFacts extends ProductFacts {
  origin: Partial<Record<FactNeed | 'name', FactSource['kind']>>;
}
/**
 * One set of facts from several, in order of trust: each field from the
 * first that has it (what the person said, then the catalog, then the web,
 * then the photo). Sources are kept only for the sets a field was taken
 * from, and confidence is the lowest of theirs.
 */
export function mergeFacts(query: string, ordered: ProductFacts[]): MergedFacts {
  const merged: MergedFacts = { query, sources: [], confidence: 1, origin: {} };
  const used = new Set<ProductFacts>();
  const take = (key: FactNeed | 'name', from: ProductFacts) => {
    used.add(from);
    merged.origin[key] = from.sources[0]?.kind ?? 'person';
  };
  for (const f of ordered) {
    if (f.name && !merged.name) {
      merged.name = f.name;
      take('name', f);
    }
    for (const need of FACT_NEEDS)
      if (has(f, need) && !has(merged, need)) {
        Object.assign(merged, { [FIELD[need]]: f[FIELD[need]] });
        take(need, f);
      }
  }
  for (const f of used) {
    for (const s of f.sources)
      if (!merged.sources.some((t) => t.title === s.title && t.url === s.url))
        merged.sources.push(s);
    merged.confidence = Math.min(merged.confidence, f.confidence);
  }
  merged.sources = merged.sources.slice(0, 8);
  if (!used.size) merged.confidence = 0;
  return merged;
}

/** How far a looked-up size may be from the camera's estimate before the review flags it. */
const SIZE_TOLERANCE = 0.25;
/**
 * The axes on which a looked-up size and the camera's own estimate
 * disagree by more than `SIZE_TOLERANCE`: a web answer of 131 cm against a
 * camera that sees 80 cm is likely another product, or the wrong thing
 * selected, and the review says so rather than taking either.
 */
export function sizeDisagreement(
  facts: ProductFacts['sizeCm'],
  photo: Partial<NonNullable<ProductFacts['sizeCm']>> | null,
): { axis: 'w' | 'd' | 'h'; factCm: number; photoCm: number }[] {
  if (!facts || !photo) return [];
  return (['w', 'd', 'h'] as const).flatMap((axis) => {
    const p = photo[axis];
    if (!p) return [];
    return Math.abs(facts[axis] / p - 1) > SIZE_TOLERANCE
      ? [{ axis, factCm: facts[axis], photoCm: p }]
      : [];
  });
}

/** The words of a product name, for matching a request to a catalog entry. */
export function productWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}
const STOP_WORDS = new Set(['the', 'an', 'its', 'it', 'is', 'my', 'this', 'of', 'from', 'by']);

/**
 * What Spark answers when it looks a product up on the web. Every field is
 * present (null or empty when unknown), as a strict schema needs. Sources
 * are not part of it: they are read from the search's own citations, so a
 * URL is never one the model wrote.
 */
const nullableCm = z.number().positive().max(600).nullable();
export const productLookupSchema = z
  .object({
    found: z.boolean(),
    name: z.string().min(1).max(120).nullable(),
    sizeCm: z
      .object({
        w: z.number().positive().max(600),
        d: z.number().positive().max(600),
        h: z.number().positive().max(300),
      })
      .strict()
      .nullable(),
    parts: z
      .array(
        z
          .object({
            name: z.string().min(1).max(40),
            role: z.enum(RECIPE_ROLES).nullable(),
            sizeCm: z.object({ w: nullableCm, d: nullableCm, h: nullableCm }).strict().nullable(),
            count: z.number().int().min(1).max(24).nullable(),
          })
          .strict(),
      )
      .max(24),
    colors: z
      .array(z.object({ name: z.string().min(1).max(40), hex: hexColorSchema }).strict())
      .max(8),
    materials: z.array(z.enum(ITEM_MATERIALS)).max(6),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type ProductLookup = z.infer<typeof productLookupSchema>;

/** A lookup as facts, with the sources its search cited; null when it found nothing. */
export function factsFromLookup(
  query: string,
  lookup: ProductLookup,
  sources: FactSource[],
): ProductFacts | null {
  if (!lookup.found) return null;
  const parts = lookup.parts.map((p) => {
    const size = p.sizeCm
      ? Object.fromEntries(Object.entries(p.sizeCm).filter(([, v]) => v !== null))
      : {};
    return {
      name: p.name,
      ...(p.role ? { role: p.role } : {}),
      ...(Object.keys(size).length ? { sizeCm: size } : {}),
      ...(p.count ? { count: p.count } : {}),
    };
  });
  return productFactsSchema.parse({
    query,
    ...(lookup.name ? { name: lookup.name } : {}),
    ...(lookup.sizeCm ? { sizeCm: lookup.sizeCm } : {}),
    ...(parts.length ? { parts } : {}),
    ...(lookup.colors.length ? { colors: lookup.colors } : {}),
    ...(lookup.materials.length ? { materials: lookup.materials } : {}),
    sources: sources.slice(0, 8),
    // Facts no source backs are worth less, however sure the model was.
    confidence: sources.length ? lookup.confidence : Math.min(lookup.confidence, 0.3),
  });
}
