import { describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../apps/server/src/config.js';
import { MetaAdapter } from '../apps/server/src/meta.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { demoIntent } from '../apps/server/src/demo-intent.js';
import { BUNDLED_CATALOG, Catalog } from '../apps/server/src/research.js';
import {
  describeContext,
  opCatalog,
  readIntent,
  sparkIntentSchema,
  type SparkIntent,
} from '@livinglayer/domain';
import {
  ALEX,
  INTENT_CASES,
  checkIntentCase,
  type IntentCase,
} from '../scripts/lib/intent-cases.js';

describe('checkIntentCase', () => {
  it('passes for every case in INTENT_CASES', () => {
    for (const c of INTENT_CASES) expect(checkIntentCase(c)).toEqual([]);
  });

  it('catches a case asking for legs on ALEX', () => {
    const invalidCase: IntentCase = {
      name: 'metal legs',
      sentence: 'the legs are metal',
      ctx: {
        target: { kind: 'fixture', id: 'f1', label: 'IKEA Alex desk' },
        recipe: ALEX,
        entities: [],
      },
      ops: [{ op: 'rematerial', parts: { roles: ['leg' as any] }, material: 'metal' }],
    };
    const problems = checkIntentCase(invalidCase);
    expect(problems.length).toBe(1);
    expect(problems[0]).toBe(
      'op rematerial selector {"roles":["leg"]} matches no part of recipe "IKEA Alex desk"',
    );
  });

  it('catches a selector when context has no recipe', () => {
    const invalidCase: IntentCase = {
      name: 'recolor without recipe',
      sentence: 'make it green',
      ctx: { target: null, recipe: null, entities: [] },
      ops: [{ op: 'recolor', parts: { roles: ['drawer' as any] } }],
    };
    const problems = checkIntentCase(invalidCase);
    expect(problems.length).toBe(1);
    expect(problems[0]).toBe('op recolor selector {"roles":["drawer"]} has no recipe in context');
  });
});

describe('reading a request (the demo reader)', () => {
  for (const c of INTENT_CASES)
    it(c.name, () => {
      const raw = demoIntent(c.sentence);
      // The demo answers in the shape Spark must.
      expect(sparkIntentSchema.safeParse(raw).success).toBe(true);
      const intent = readIntent(raw, c.ctx);
      expect(intent.ops.map((o) => o.op)).toEqual(c.ops.map((o) => o.op));
      c.ops.forEach((o, i) => expect(intent.ops[i]).toMatchObject(o));
      if (c.product === null) expect(intent.product).toBeNull();
      for (const w of c.product ?? []) expect(intent.product?.toLowerCase()).toContain(w);
      if (c.needs !== undefined) expect(intent.needs).toEqual(c.needs);
    });

  it('finds the product it names in the catalog, with what to look up', () => {
    const intent = readIntent(demoIntent(INTENT_CASES[0]!.sentence), INTENT_CASES[0]!.ctx);
    expect(new Catalog([BUNDLED_CATALOG]).find(intent.product!)?.facts.name).toBe('IKEA ALEX desk');
    expect(intent.needs).toEqual(['size', 'parts', 'colors']);
  });
});

describe('readIntent', () => {
  const empty = {
    parts: null,
    color: null,
    material: null,
    sizeCm: null,
    part: null,
    label: null,
    form: null,
    as: null,
    control: null,
    question: null,
    subject: null,
    occupant: null,
    state: null,
  };
  const ctx = {
    target: { kind: 'fixture' as const, id: 'f1', label: 'Desk' },
    recipe: ALEX,
    entities: ['switch.fan'],
  };

  it('keeps what can be done and says why the rest was left out', () => {
    const raw: SparkIntent = {
      ops: [
        { ...empty, op: 'recolor', color: '#112233' },
        { ...empty, op: 'recolor' },
        { ...empty, op: 'set_control', control: { kind: 'switch', entityId: 'switch.tv' } },
      ],
      product: null,
      needs: ['size'],
      targetDisagrees: null,
    };
    const intent = readIntent(raw, ctx);
    expect(intent.ops).toEqual([{ op: 'recolor', parts: {}, color: '#112233' }]);
    expect(intent.dropped).toEqual([
      'The recolor was incomplete: Invalid input: expected string, received null.',
      "switch.tv isn't one of the configured entities.",
    ]);
    // Nothing is being made, so nothing is looked up.
    expect(intent.needs).toEqual([]);
  });

  it('asks back alone when it is unsure, and turns nothing doable into a question', () => {
    const ask: SparkIntent = {
      ops: [
        { ...empty, op: 'recolor', color: '#112233' },
        { ...empty, op: 'clarify', question: 'Which drawer?' },
      ],
      product: null,
      needs: [],
      targetDisagrees: null,
    };
    expect(readIntent(ask, ctx).ops).toEqual([{ op: 'clarify', question: 'Which drawer?' }]);
    const none = readIntent({ ...ask, ops: [{ ...empty, op: 'rebase' }] }, ctx);
    expect(none.ops).toEqual([{ op: 'clarify', question: 'The form to build from was missing.' }]);
  });

  it('adds a part Spark measured, checked like any recipe part', () => {
    const raw: SparkIntent = {
      ops: [
        {
          ...empty,
          op: 'add_part',
          part: {
            name: 'shelf',
            role: 'shelf',
            atCm: { x: 2.5, y: 0, z: 30 },
            sizeCm: { w: 92, d: 30, h: 2 },
            color: null,
          },
        },
      ],
      product: null,
      needs: [],
      targetDisagrees: null,
    };
    expect(readIntent(raw, ctx).ops[0]).toMatchObject({
      op: 'add_part',
      part: { name: 'shelf', role: 'shelf', shape: 'rbox' },
    });
  });

  it('tells Spark the model and every op it may use', () => {
    const text = describeContext(ctx);
    expect(text).toContain('drawer-1 (drawer): 34 × 2 × 23 cm');
    expect(text).toContain('switch.fan');
    for (const op of ['recolor', 'resize', 'create', 'set_control', 'clarify'])
      expect(opCatalog()).toContain(`- ${op}:`);
  });
});

describe('MetaAdapter.intent, against a mocked Meta API', () => {
  it('sends the request, the model and the ops, and checks the answer against the schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livinglayer-intent-'));
    try {
      const config = parseConfig({
        DATA_DIR: dir,
        MODEL_API_KEY: 'test-key',
        META_LIVE_ENABLED: 'true',
      });
      let sent: { text: { format: { name: string } }; input: { content: { text?: string }[] }[] };
      const answer = demoIntent('make the drawers green');
      const fetcher = mock(async (_url: unknown, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: 'resp_intent',
            object: 'response',
            model: 'muse-spark-1.3',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: JSON.stringify(answer), annotations: [] }],
              },
            ],
            usage: { input_tokens: 900, output_tokens: 200, total_tokens: 1100 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });
      const ctx = {
        target: { kind: 'fixture' as const, id: 'f1', label: 'Desk' },
        recipe: ALEX,
        entities: [],
      };
      const result = await new MetaAdapter(config, new EvidenceStore(dir), fetcher).intent(
        'make the drawers green',
        ctx,
      );
      expect(sent!.text.format.name).toBe('edit_intent');
      const prompt = sent!.input[0]!.content[0]!.text!;
      expect(prompt).toContain('"make the drawers green"');
      expect(prompt).toContain('drawer-1 (drawer)');
      expect(prompt).toContain('- remove_part:');
      expect(readIntent(result.output, ctx).ops[0]).toMatchObject({
        op: 'recolor',
        parts: { roles: ['drawer'] },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
