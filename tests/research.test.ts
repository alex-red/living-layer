import { afterEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { MetaAdapter } from '../apps/server/src/meta.js';
import {
  BUNDLED_CATALOG,
  Catalog,
  personFacts,
  research,
  type Researcher,
} from '../apps/server/src/research.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import {
  factsFromLookup,
  mergeFacts,
  missingFacts,
  sizeDisagreement,
  type ProductFacts,
  type ProductLookup,
} from '../packages/domain/src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'livinglayer-research-'));
  dirs.push(dir);
  return dir;
};

const web: ProductFacts = {
  query: 'IKEA Alex desk',
  name: 'ALEX Desk, white',
  sizeCm: { w: 132, d: 58, h: 76 },
  parts: [{ name: 'Drawer', role: 'drawer', count: 5 }],
  colors: [{ name: 'White', hex: '#ffffff' }],
  sources: [{ kind: 'web', title: 'Product page', url: 'https://example.com/alex' }],
  confidence: 0.8,
};

describe('merging facts', () => {
  it('takes each field from the most trusted source that has it, and keeps only their sources', () => {
    const said = personFacts('IKEA Alex desk', { sizeCm: { w: 140, d: 60, h: 76 } });
    const photo: ProductFacts = {
      query: 'IKEA Alex desk',
      materials: ['wood'],
      sizeCm: { w: 120, d: 55, h: 70 },
      sources: [{ kind: 'photo', title: 'The camera' }],
      confidence: 0.5,
    };
    const merged = mergeFacts('IKEA Alex desk', [said, web, photo]);
    expect(merged.sizeCm).toEqual({ w: 140, d: 60, h: 76 });
    expect(merged.parts).toEqual(web.parts);
    expect(merged.materials).toEqual(['wood']);
    expect(merged.origin).toEqual({
      size: 'person',
      name: 'web',
      parts: 'web',
      colors: 'web',
      materials: 'photo',
    });
    expect(merged.sources.map((s) => s.kind)).toEqual(['person', 'web', 'photo']);
    expect(merged.confidence).toBe(0.5);
    expect(missingFacts(merged, ['size', 'parts'])).toEqual([]);
    expect(missingFacts(mergeFacts('x', [said]), ['size', 'parts', 'colors'])).toEqual([
      'parts',
      'colors',
    ]);
  });

  it('flags a looked-up size the camera disagrees with', () => {
    expect(sizeDisagreement({ w: 131, d: 60, h: 76 }, { w: 80, d: 58 })).toEqual([
      { axis: 'w', factCm: 131, photoCm: 80 },
    ]);
    expect(sizeDisagreement({ w: 131, d: 60, h: 76 }, { w: 120, h: 72 })).toEqual([]);
    expect(sizeDisagreement(undefined, { w: 1 })).toEqual([]);
  });

  it('reads a lookup as facts, dropping what it left empty', () => {
    const lookup: ProductLookup = {
      found: true,
      name: 'ALEX Desk',
      sizeCm: { w: 131, d: 60, h: 76 },
      parts: [{ name: 'Drawer', role: 'drawer', sizeCm: { w: 33, d: null, h: null }, count: 5 }],
      colors: [],
      materials: [],
      confidence: 0.9,
    };
    const facts = factsFromLookup('alex', lookup, [{ kind: 'web', title: 'Page' }])!;
    expect(facts.parts).toEqual([{ name: 'Drawer', role: 'drawer', sizeCm: { w: 33 }, count: 5 }]);
    expect(facts.colors).toBeUndefined();
    expect(facts.confidence).toBe(0.9);
    // Without a source, however sure the model was.
    expect(factsFromLookup('alex', lookup, [])!.confidence).toBe(0.3);
    expect(factsFromLookup('alex', { ...lookup, found: false }, [])).toBeNull();
  });
});

describe('the product catalog', () => {
  it('finds a bundled product from how a person says it, and not another one', async () => {
    const catalog = new Catalog([BUNDLED_CATALOG]);
    expect(catalog.find("It's an Ikea Alex Office Desk")?.facts.name).toBe('IKEA ALEX desk');
    expect(catalog.find('my alex desk')?.facts.name).toBe('IKEA ALEX desk');
    expect(catalog.find('IKEA Malm desk')).toBeNull();
    expect(catalog.find('desk')).toBeNull();
    const facts = (await catalog.lookup('IKEA Alex desk'))!;
    expect(facts.sources[0]).toEqual({ kind: 'catalog', title: 'Saved product: IKEA ALEX desk' });
    expect(facts.sizeCm).toEqual({ w: 131, d: 60, h: 76 });
  });

  it('saves a product where it can write, and finds it next time by either name', async () => {
    const dir = tempDir();
    const catalog = new Catalog([join(dir, 'products'), BUNDLED_CATALOG]);
    const file = catalog.save({ ...web, query: 'the white alex' });
    expect(existsSync(file)).toBe(true);
    expect(file.startsWith(join(dir, 'products'))).toBe(true);
    expect(catalog.find('ALEX desk white')?.facts.name).toBe('ALEX Desk, white');
    expect(catalog.find('the white alex')?.facts.name).toBe('ALEX Desk, white');
  });

  it('saves merged facts without where each field came from', async () => {
    const catalog = new Catalog([join(tempDir(), 'products')]);
    const merged = mergeFacts('my alex', [web]);
    expect(merged.origin).not.toEqual({});
    catalog.save(merged);
    expect(await catalog.lookup('my alex')).not.toHaveProperty('origin');
  });
});

describe('research', () => {
  const counting = (kind: Researcher['kind'], facts: ProductFacts | null) => {
    const lookup = mock(async () => facts);
    return { researcher: { kind, lookup } as Researcher, lookup };
  };

  it('stops at the catalog when it has everything needed, so the web is never paid for', async () => {
    const paid = counting('web', web);
    const r = await research(
      "it's an IKEA Alex office desk",
      ['size', 'parts'],
      [new Catalog([BUNDLED_CATALOG]), paid.researcher],
    );
    expect(paid.lookup).not.toHaveBeenCalled();
    expect(r.asked).toEqual([{ kind: 'catalog', found: true }]);
    expect(r.missing).toEqual([]);
    expect(r.facts.origin.size).toBe('catalog');
  });

  it('asks further down only for what is still missing, and says what nobody knew', async () => {
    const said = personFacts('alex', { sizeCm: { w: 140, d: 60, h: 76 } });
    const none = counting('catalog', null);
    const paid = counting('web', { ...web, colors: undefined });
    const r = await research(
      'alex',
      ['size', 'parts', 'colors'],
      [none.researcher, paid.researcher],
      {
        given: [said],
      },
    );
    expect(r.asked).toEqual([
      { kind: 'catalog', found: false },
      { kind: 'web', found: true },
    ]);
    expect(r.facts.sizeCm?.w).toBe(140);
    expect(r.missing).toEqual(['colors']);
    // Nothing missing from the start: nobody is asked.
    const again = await research('alex', ['size'], [paid.researcher], { given: [said] });
    expect(again.asked).toEqual([]);
  });
});

describe('looking a product up with Spark’s web search, against a mocked Meta API', () => {
  const lookup: ProductLookup = {
    found: true,
    name: 'ALEX Desk',
    sizeCm: { w: 131, d: 60, h: 76 },
    parts: [],
    colors: [{ name: 'White', hex: '#ffffff' }],
    materials: ['matte'],
    confidence: 0.85,
  };
  const reply = (body: object, text = JSON.stringify(body)) =>
    new Response(
      JSON.stringify({
        id: 'resp_lookup',
        object: 'response',
        model: 'muse-spark-1.3',
        status: 'completed',
        output: [
          {
            type: 'web_search_call',
            id: 'ws_1',
            status: 'completed',
            results: [
              {
                type: 'text_result',
                title: 'ALEX Desk',
                url: 'https://www.ikea.com/alex',
                snippet: '…',
              },
              { type: 'text_result', title: 'Bad', url: 'javascript:alert(1)', snippet: '' },
            ],
          },
          { type: 'web_search_call', id: 'ws_2', status: 'completed' },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text,
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://www.ikea.com/alex',
                    title: 'ALEX Desk, white',
                    start_index: 0,
                    end_index: 4,
                  },
                ],
              },
            ],
          },
        ],
        usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
      }),
      { headers: { 'content-type': 'application/json', 'x-request-id': 'req-lookup' } },
    );

  it('asks with the web_search tool, reads sources from the citations, and bills each search', async () => {
    const config = parseConfig({
      DATA_DIR: tempDir(),
      MODEL_API_KEY: 'test-key',
      META_LIVE_ENABLED: 'true',
    });
    const store = new EvidenceStore(config.dataDir);
    let sent: Record<string, unknown> = {};
    const fetcher = mock<Fetcher>().mockImplementation(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return reply(lookup);
    });
    const result = await new MetaAdapter(config, store, fetcher).lookupProduct('IKEA Alex desk', [
      'size',
      'colors',
    ]);
    expect(sent.tools).toEqual([{ type: 'web_search' }]);
    expect(sent.include).toEqual(['web_search_call.results']);
    expect((sent.text as { format: { name: string } }).format.name).toBe('product_lookup');
    const { facts, searches } = result.output;
    expect(searches).toBe(2);
    // The cited page once, under its cited title; the unsafe URL is dropped.
    expect(facts!.sources).toEqual([
      { kind: 'web', title: 'ALEX Desk, white', url: 'https://www.ikea.com/alex' },
    ]);
    expect(facts!.sizeCm).toEqual({ w: 131, d: 60, h: 76 });
    // Tokens, and two searches at $0.0025 each.
    expect(store.spentToday()).toBeCloseTo((1000 * 1.25 + 500 * 4.25) / 1e6 + 2 * 0.0025, 8);
  });

  it('reads the answer when Spark says a sentence around its JSON', async () => {
    const config = parseConfig({
      DATA_DIR: tempDir(),
      MODEL_API_KEY: 'test-key',
      META_LIVE_ENABLED: 'true',
    });
    const store = new EvidenceStore(config.dataDir);
    const fetcher = mock<Fetcher>().mockImplementation(async () =>
      reply(
        lookup,
        `Here is what I found on the maker's page:\n\`\`\`json\n${JSON.stringify(lookup)}\n\`\`\``,
      ),
    );
    const result = await new MetaAdapter(config, store, fetcher).lookupProduct('IKEA Alex desk', [
      'size',
    ]);
    expect(result.output.facts!.sizeCm).toEqual({ w: 131, d: 60, h: 76 });
  });
});
