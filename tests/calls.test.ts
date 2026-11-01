import { Database } from 'bun:sqlite';
import { describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../apps/server/src/config.js';
import {
  CALL_LIMITS,
  MetaAdapter,
  SPARK_BUDGET,
  SPARK_CALLS,
  type CallKind,
} from '../apps/server/src/meta.js';
import { EvidenceStore, type MetaCallRecord } from '../apps/server/src/store.js';
import { loadCalls, summarizeCalls } from '../scripts/lib/calls.js';

describe('D2: SPARK_CALLS, CALL_LIMITS and SPARK_BUDGET', () => {
  it('SPARK_BUDGET matches SPARK_CALLS tokens for every budget key', () => {
    for (const [key, tokens] of Object.entries(SPARK_BUDGET)) {
      const call = SPARK_CALLS[key as keyof typeof SPARK_CALLS];
      expect(call).toBeDefined();
      expect(Number(tokens)).toBe(call.tokens);
    }
  });

  it('CALL_LIMITS contains every SPARK_CALLS key plus SAM and illustrate', () => {
    for (const key of Object.keys(SPARK_CALLS)) {
      expect(CALL_LIMITS[key as CallKind]).toBeDefined();
    }
    expect(CALL_LIMITS.segment).toEqual({ tokens: null, timeoutMs: 30_000 });
    expect(CALL_LIMITS.illustrate).toEqual({ tokens: null, timeoutMs: 120_000 });
    expect(CALL_LIMITS.refine).toEqual({ tokens: 16_384, timeoutMs: 150_000 });
  });
});

describe('MetaAdapter call telemetry recording', () => {
  it('records successful calls into EvidenceStore.recordCall', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livinglayer-calls-'));
    try {
      const config = parseConfig({
        DATA_DIR: dir,
        MODEL_API_KEY: 'test-key',
        META_LIVE_ENABLED: 'true',
      });
      const store = new EvidenceStore(dir);
      const fetcher = mock(async () => {
        return new Response(
          JSON.stringify({
            id: 'resp_text',
            object: 'response',
            model: 'muse-spark-1.3',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: 'LivingLayer connection ready.',
                    annotations: [],
                  },
                ],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });

      const meta = new MetaAdapter(config, store, fetcher);
      const res = await meta.text();
      expect(res.output.text).toBe('LivingLayer connection ready.');

      const calls = store.listCalls();
      expect(calls.length).toBe(1);
      expect(calls[0]!.kind).toBe('text');
      expect(calls[0]!.cause).toBeNull();
      expect(calls[0]!.outputTokens).toBe(4);
      expect(calls[0]!.maxOutputTokens).toBe(1024);
      expect(calls[0]!.timeoutMs).toBe(30_000);
      expect(calls[0]!.durationMs).toBeGreaterThanOrEqual(0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records failed calls on max_output_tokens with output tokens used', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livinglayer-calls-'));
    try {
      const config = parseConfig({
        DATA_DIR: dir,
        MODEL_API_KEY: 'test-key',
        META_LIVE_ENABLED: 'true',
      });
      const store = new EvidenceStore(dir);
      const fetcher = mock(async () => {
        return new Response(
          JSON.stringify({
            id: 'resp_disc',
            object: 'response',
            model: 'muse-spark-1.3',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [],
            usage: { input_tokens: 500, output_tokens: 8192, total_tokens: 8692 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });

      const meta = new MetaAdapter(config, store, fetcher);
      await expect(meta.discover('data:image/png;base64,abc')).rejects.toThrow(
        /output limit after 8,192 output tokens/,
      );

      const calls = store.listCalls();
      expect(calls.length).toBe(1);
      expect(calls[0]!.kind).toBe('discover');
      expect(calls[0]!.cause).toBe('max_output_tokens');
      expect(calls[0]!.outputTokens).toBe(8192);
      expect(calls[0]!.maxOutputTokens).toBe(8192);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records failed calls on timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livinglayer-calls-'));
    try {
      const config = parseConfig({
        DATA_DIR: dir,
        MODEL_API_KEY: 'test-key',
        META_LIVE_ENABLED: 'true',
      });
      const store = new EvidenceStore(dir);
      const fetcher = mock(async () => {
        const err = new Error('Request timed out.');
        err.name = 'TimeoutError';
        throw err;
      });

      const meta = new MetaAdapter(config, store, fetcher);
      await expect(
        meta.intent('test request', {
          target: { kind: 'fixture', id: '1', label: 'Desk' },
          recipe: null,
          entities: [],
        }),
      ).rejects.toThrow(/timed out/i);

      const calls = store.listCalls();
      expect(calls.length).toBe(1);
      expect(calls[0]!.kind).toBe('intent');
      expect(calls[0]!.cause).toBe('timeout');
      expect(calls[0]!.outputTokens).toBeNull();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('D1: Call summary and limit flagging', () => {
  it('flags calls exceeding 80% of token or timeout limit', () => {
    const now = new Date().toISOString();
    const records: MetaCallRecord[] = [
      // 26s out of 30s timeout = 86.7% (>80%)
      {
        kind: 'classify',
        createdAt: now,
        durationMs: 26_000,
        outputTokens: 500,
        maxOutputTokens: 8192,
        timeoutMs: 30_000,
        cause: null,
      },
      // 7000 out of 8192 tokens = 85.4% (>80%)
      {
        kind: 'intent',
        createdAt: now,
        durationMs: 5000,
        outputTokens: 7000,
        maxOutputTokens: 8192,
        timeoutMs: 30_000,
        cause: null,
      },
      // Low usage: 500ms and 50 tokens
      {
        kind: 'text',
        createdAt: now,
        durationMs: 500,
        outputTokens: 50,
        maxOutputTokens: 1024,
        timeoutMs: 30_000,
        cause: null,
      },
    ];

    const stats = summarizeCalls(records, 7);
    const classify = stats.find((s) => s.kind === 'classify')!;
    const intent = stats.find((s) => s.kind === 'intent')!;
    const text = stats.find((s) => s.kind === 'text')!;

    expect(classify.flagged).toBe(true);
    expect(classify.timeoutShare).toBeGreaterThan(0.8);

    expect(intent.flagged).toBe(true);
    expect(intent.tokenShare).toBeGreaterThan(0.8);

    expect(text.flagged).toBe(false);
  });

  it('reconstructs refinement timeout and 8,192-token overrun from job steps', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
    `);

    const now = Date.now();
    const job1 = {
      id: 'job-1',
      title: 'Working on your selection',
      mode: 'live',
      createdAt: new Date(now - 30_000).toISOString(),
      steps: [
        {
          id: 'check',
          label: 'Check it against the camera',
          state: 'done',
          detail: 'Spark’s refinement failed, so it is as built: Request timed out.',
          startedAt: new Date(now - 60_000).toISOString(),
          endedAt: new Date(now - 29_970).toISOString(), // 30,030 ms
        },
      ],
    };

    const job2 = {
      id: 'job-2',
      title: 'Working on your selection',
      mode: 'live',
      createdAt: new Date(now - 10_000).toISOString(),
      steps: [
        {
          id: 'check',
          label: 'Check it against the camera',
          state: 'done',
          detail:
            'Spark’s refinement failed, so it is as built: Spark ran out of room before finishing the model check: it hit its 8,192-token output limit after 8,192 output tokens. The answer was cut off, so nothing was kept.',
          startedAt: new Date(now - 50_000).toISOString(),
          endedAt: new Date(now - 10_800).toISOString(), // 39,200 ms
        },
      ],
    };

    db.run('INSERT INTO jobs VALUES (?, ?, ?)', [job1.id, job1.createdAt, JSON.stringify(job1)]);
    db.run('INSERT INTO jobs VALUES (?, ?, ?)', [job2.id, job2.createdAt, JSON.stringify(job2)]);

    const calls = loadCalls(db);
    const refineCalls = calls.filter((c) => c.kind === 'refine');
    expect(refineCalls.length).toBe(2);

    const timeoutCall = refineCalls.find((c) => c.cause === 'timeout')!;
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall.durationMs).toBe(30_030);
    expect(timeoutCall.timeoutMs).toBe(30_000);

    const tokenCall = refineCalls.find((c) => c.cause === 'max_output_tokens')!;
    expect(tokenCall).toBeDefined();
    expect(tokenCall.outputTokens).toBe(8192);
    expect(tokenCall.maxOutputTokens).toBe(8192);

    const summary = summarizeCalls(calls, 7);
    const refineStats = summary.find((s) => s.kind === 'refine')!;
    expect(refineStats).toBeDefined();
    expect(refineStats.flagged).toBe(true);
    expect(refineStats.overrunKinds).toContain('timeout');
    expect(refineStats.overrunKinds).toContain('tokens');
    expect(refineStats.failures.timeout).toBe(1);
    expect(refineStats.failures.max_output_tokens).toBe(1);

    db.close();
  });
});
