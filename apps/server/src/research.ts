import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  fixtureRecipeSchema,
  mergeFacts,
  missingFacts,
  productFactsSchema,
  productWords,
  type FactNeed,
  type FactSource,
  type FixtureRecipe,
  type MergedFacts,
  type ProductFacts,
} from '@livinglayer/domain';
import { PROJECT_ROOT } from './config.js';
import type { MetaAdapter } from './meta.js';

/**
 * Gathering what is known about a product before modelling it
 * ([plan](../../../docs/plans/ai-brush.md#5-gathering-facts)). Each source
 * is a `Researcher`; `research` asks them in order of trust until nothing
 * needed is missing, and merges what they found field by field.
 */
export interface Researcher {
  kind: FactSource['kind'];
  lookup(
    query: string,
    need: readonly FactNeed[],
    signal?: AbortSignal,
  ): Promise<ProductFacts | null>;
}

/** One saved product: its facts, other names it goes by, and a model a person accepted. */
export const catalogEntrySchema = z
  .object({
    facts: productFactsSchema,
    aliases: z.array(z.string().min(1).max(120)).max(12).optional(),
    recipe: fixtureRecipeSchema.optional(),
  })
  .strict();
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** Products that ship with the lab, so the demo needs no lookup. */
export const BUNDLED_CATALOG = resolve(PROJECT_ROOT, 'apps/server/catalog');
const slug = (text: string) => productWords(text).join('-').slice(0, 80) || 'product';

/**
 * Saved products, as one JSON file each. A lookup that was accepted once
 * is never paid for again. Entries are read from every folder, the first
 * one being where new ones are saved (`DATA_DIR/products`); the bundled
 * catalog comes last and is never written.
 */
export class Catalog implements Researcher {
  readonly kind = 'catalog' as const;
  constructor(private dirs: string[]) {}
  entries(): CatalogEntry[] {
    return this.dirs.flatMap((dir) => {
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        return [];
      }
      return files.flatMap((f) => {
        const entry = catalogEntrySchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
        return entry.success ? [entry.data] : [];
      });
    });
  }
  /**
   * The entry whose name (or an alias) has every word in the request, the
   * one matching most words if several do: "it's an IKEA Alex office desk"
   * finds "IKEA Alex desk".
   */
  find(query: string): CatalogEntry | null {
    const asked = new Set(productWords(query));
    let best: { entry: CatalogEntry; words: number } | null = null;
    for (const entry of this.entries())
      for (const name of [entry.facts.name ?? entry.facts.query, ...(entry.aliases ?? [])]) {
        const words = productWords(name);
        if (words.length && words.every((w) => asked.has(w)) && words.length > (best?.words ?? 0))
          best = { entry, words: words.length };
      }
    return best?.entry ?? null;
  }
  async lookup(query: string): Promise<ProductFacts | null> {
    const entry = this.find(query);
    if (!entry) return null;
    // Facts read back from the catalog say so, keeping where they first came from.
    const title = `Saved product: ${entry.facts.name ?? entry.facts.query}`;
    return {
      ...entry.facts,
      query,
      sources: [{ kind: 'catalog' as const, title }, ...entry.facts.sources].slice(0, 8),
    };
  }
  /** Keep a product for next time, with the model a person accepted for it. */
  save(facts: ProductFacts, recipe?: FixtureRecipe): string {
    const dir = this.dirs[0]!;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${slug(facts.name ?? facts.query)}.json`);
    const entry: CatalogEntry = {
      facts: productFactsSchema.parse(facts),
      aliases: facts.name && facts.name !== facts.query ? [facts.query] : undefined,
      ...(recipe ? { recipe } : {}),
    };
    writeFileSync(file, JSON.stringify(catalogEntrySchema.parse(entry), null, 2));
    return file;
  }
}

/** Spark with web search: billed, and only in live mode. */
export function webResearcher(meta: MetaAdapter): Researcher {
  return {
    kind: 'web',
    async lookup(query, need, signal) {
      return (await meta.lookupProduct(query, need, signal)).output.facts;
    },
  };
}
/** What the person said ("it's 140 cm wide"), as the most trusted source. */
export function personFacts(
  query: string,
  said: Omit<ProductFacts, 'query' | 'sources' | 'confidence'>,
): ProductFacts {
  return { ...said, query, sources: [{ kind: 'person', title: 'What you said' }], confidence: 1 };
}

export interface Research {
  facts: MergedFacts;
  /** Each source asked, in order, and whether it had anything. */
  asked: { kind: FactSource['kind']; found: boolean }[];
  /** What no source answered. */
  missing: FactNeed[];
}
/**
 * Ask each researcher in turn, most trusted first, and stop once nothing
 * needed is missing: a product in the catalog never reaches the web. Facts
 * given up front (what the person said) come before all of them.
 */
export async function research(
  query: string,
  need: readonly FactNeed[],
  researchers: Researcher[],
  { given = [], signal }: { given?: ProductFacts[]; signal?: AbortSignal } = {},
): Promise<Research> {
  const found = [...given];
  const asked: Research['asked'] = [];
  for (const r of researchers) {
    if (!missingFacts(mergeFacts(query, found), need).length) break;
    const facts = await r.lookup(query, need, signal);
    asked.push({ kind: r.kind, found: Boolean(facts) });
    if (facts) found.push(facts);
  }
  const facts = mergeFacts(query, found);
  return { facts, asked, missing: missingFacts(facts, need) };
}
