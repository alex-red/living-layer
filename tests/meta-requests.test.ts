import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../apps/server/src/config.js';
import { MetaAdapter } from '../apps/server/src/meta.js';
import { EvidenceStore } from '../apps/server/src/store.js';

/**
 * The exact request each Spark call kind sends, the spend it reserves and
 * what it records, through a mock fetcher that answers "ran out of room".
 * Any change here changes what the live model is asked.
 */
it('every Spark call kind sends the same request body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'livinglayer-requests-'));
  try {
    const config = parseConfig({ DATA_DIR: dir, MODEL_API_KEY: 'k', META_LIVE_ENABLED: 'true' });
    const store = new EvidenceStore(dir);
    let last: { url: string; body: unknown } | null = null;
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      last = { url: String(input), body: JSON.parse(String(init?.body)) };
      return new Response(
        JSON.stringify({
          id: 'r',
          object: 'response',
          model: 'm',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [],
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    const meta = new MetaAdapter(config, store, fetcher);
    const img = 'data:image/png;base64,AAAA';
    const box = { x1: 1, y1: 2, x2: 3, y2: 4 };
    const recipe = { label: 'desk', sizeCm: { w: 100, d: 50, h: 75 }, parts: [] } as never;
    const ctx = { target: null, recipe: null, entities: [] } as never;
    const calls: Record<string, () => Promise<unknown>> = {
      text: () => meta.text(),
      discover: () => meta.discover(img),
      classify: () => meta.classify(img),
      layout: () => meta.layout(img),
      itemClass: () => meta.itemClass(img, 'mug'),
      fixtureClass: () => meta.fixtureClass(img, 'a lamp'),
      fixtureClassPlain: () => meta.fixtureClass(img),
      fixtureScan: () => meta.fixtureScan(img, ['mug'], undefined, { known: ['lamp'], only: true }),
      fixtureScanPlain: () => meta.fixtureScan(img, []),
      pictureFind: () => meta.pictureFind(img, [{ label: 'lamp', near: box }]),
      sculpt: () => meta.sculpt(img, img, 'prompt', '[]'),
      sculptLow: () => meta.sculpt(img, img, 'prompt', '[]', undefined, 20, 'low'),
      itemCheck: () => meta.itemCheck(img, img, 'summary'),
      photoInventory: () => meta.photoInventory(img),
      setupInventory: () => meta.setupInventory(img),
      photoCheck: () => meta.photoCheck(img, img, 'listing'),
      productLookup: () => meta.lookupProduct('IKEA Alex desk', ['size', 'parts']),
      intent: () => meta.intent('make it red', ctx, img),
      intentNoCrop: () => meta.intent('make it red', ctx),
      refine: () => meta.refineRecipe(recipe, { report: 'missed' } as never, img),
    };
    const sent: Record<string, unknown> = {};
    for (const [name, call] of Object.entries(calls)) {
      const before = store.spentToday();
      last = null;
      await call().catch(() => undefined);
      sent[name] = { request: last, spend: +(store.spentToday() - before).toFixed(8) };
    }
    const recorded = store
      .listCalls()
      .map((c) => [c.kind, c.maxOutputTokens, c.timeoutMs, c.cause, c.outputTokens]);
    expect({ sent, recorded }).toMatchSnapshot();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
