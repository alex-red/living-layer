import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runFailure, type EvidenceRun, type Job } from '@livinglayer/domain';
import { CALL_LIMITS, type CallKind } from '../../apps/server/src/meta.js';
import type { MetaCallRecord } from '../../apps/server/src/store.js';
import { dataDir } from './evidence.js';

export interface CallStats {
  kind: CallKind;
  count: number;
  p50LatencyMs: number;
  maxLatencyMs: number;
  timeoutMs: number;
  timeoutShare: number;
  p50OutputTokens: number | null;
  maxOutputTokens: number | null;
  tokenLimit: number | null;
  tokenShare: number;
  failures: Record<string, number>;
  flagged: boolean;
  overrunKinds: ('timeout' | 'tokens')[];
}

export function loadCalls(dbOrDir?: Database | string): MetaCallRecord[] {
  let db: Database;
  let shouldClose = false;
  if (dbOrDir instanceof Database) {
    db = dbOrDir;
  } else {
    const dir = typeof dbOrDir === 'string' ? dbOrDir : dataDir();
    const file = join(dir, 'livinglayer.sqlite');
    if (!existsSync(file)) return [];
    db = new Database(file, { readonly: true });
    shouldClose = true;
  }

  try {
    const calls: MetaCallRecord[] = [];
    const hasCallNear = (kind: string, timeMs: number) =>
      calls.some((c) => c.kind === kind && Math.abs(Date.parse(c.createdAt) - timeMs) < 5000);

    // 1. Read rows from meta_calls if table exists
    const metaTable = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get('meta_calls');
    if (metaTable) {
      const rows = db
        .query<{ payload: string }, []>('SELECT payload FROM meta_calls ORDER BY id ASC')
        .all();
      for (const r of rows) {
        try {
          calls.push(JSON.parse(r.payload) as MetaCallRecord);
        } catch {}
      }
    }

    // 2. Also reconstruct historical live calls from jobs and evidence
    const jobsTable = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get('jobs');
    const jobs = jobsTable
      ? db
          .query<{ payload: string }, []>('SELECT payload FROM jobs')
          .all()
          .map((r) => {
            try {
              return JSON.parse(r.payload) as Job;
            } catch {
              return null;
            }
          })
          .filter((j): j is Job => j !== null && j.mode === 'live')
      : [];

    for (const job of jobs) {
      for (const step of job.steps ?? []) {
        if (!step.startedAt || !step.endedAt) continue;
        const durationMs = Date.parse(step.endedAt) - Date.parse(step.startedAt);
        let kind: CallKind | null = null;
        let cause: string | null = null;
        let outputTokens: number | null = null;
        let maxOutputTokens: number | null = null;
        let timeoutMs: number | null = null;

        if (job.title?.includes('Working on your selection')) {
          if (step.id === 'select' && !step.detail?.startsWith('Skipped')) kind = 'segment';
          else if (step.id === 'read') kind = 'intent';
          else if (step.id === 'lookup' && step.detail !== 'catalog ✓') kind = 'productLookup';
          else if (step.id === 'check') {
            kind = 'refine';
            const text = `${step.detail ?? ''} ${job.error ?? ''}`;
            const tokenMatch =
              /hit its ([\d,]+)-token output limit after ([\d,]+) output tokens/.exec(text);
            if (tokenMatch && tokenMatch[1] && tokenMatch[2]) {
              maxOutputTokens = Number(tokenMatch[1].replace(/,/g, ''));
              outputTokens = Number(tokenMatch[2].replace(/,/g, ''));
              cause = 'max_output_tokens';
            } else if (text.includes('timed out') || text.includes('Request timed out')) {
              cause = 'timeout';
              if (durationMs >= 29_000 && durationMs <= 35_000) {
                timeoutMs = 30_000;
              }
            }
          }
        } else if (job.title?.includes('Setting up the room')) {
          if (step.id === 'list') kind = 'photoInventory';
          else if (step.id === 'outline') kind = 'segment';
          else if (step.id === 'check') kind = 'photoCheck';
        } else if (job.title?.includes('Scanning and mapping')) {
          if (step.id === 'list') kind = 'fixtureScan';
          else if (step.id === 'outline') kind = 'segment';
        } else if (job.title?.includes('Drawing the desk')) {
          if (step.id === 'draw') kind = 'illustrate';
        }

        if (kind) {
          if (!cause && step.state === 'failed') {
            const text = `${step.detail ?? ''} ${job.error ?? ''}`;
            if (text.includes('timed out') || text.includes('Request timed out')) {
              cause = 'timeout';
              if (durationMs >= 29_000 && durationMs <= 35_000) {
                timeoutMs = 30_000;
              }
            }
          }
          const timeMs = Date.parse(step.startedAt);
          if (!hasCallNear(kind, timeMs)) {
            const limit = CALL_LIMITS[kind];
            calls.push({
              kind,
              createdAt: step.startedAt,
              durationMs,
              outputTokens,
              maxOutputTokens: maxOutputTokens ?? limit.tokens,
              timeoutMs: timeoutMs ?? limit.timeoutMs,
              cause:
                cause ?? (step.state === 'failed' ? step.detail?.slice(0, 40) || 'failed' : null),
            });
          }
        }
      }
    }

    // 3. Evidence
    const evidenceTable = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get('evidence');
    if (evidenceTable) {
      const runs = db
        .query<{ payload: string }, []>('SELECT payload FROM evidence')
        .all()
        .map((r) => {
          try {
            return JSON.parse(r.payload) as EvidenceRun;
          } catch {
            return null;
          }
        })
        .filter((r): r is EvidenceRun => r !== null && r.mode === 'live');

      const singleKinds: Record<string, CallKind> = {
        segment: 'segment',
        discover: 'discover',
        text: 'text',
        classify: 'classify',
        layout: 'layout',
      };

      for (const run of runs) {
        const timeMs = Date.parse(run.createdAt);
        if (singleKinds[run.kind]) {
          const kind = singleKinds[run.kind]!;
          if (!hasCallNear(kind, timeMs)) {
            const limit = CALL_LIMITS[kind];
            const outErr = runFailure(run);
            const cause =
              run.status === 'failed' ? (outErr?.detail?.reason ?? outErr?.code ?? 'failed') : null;
            calls.push({
              kind,
              createdAt: run.createdAt,
              durationMs: run.durationMs,
              outputTokens: run.usage?.outputTokens ?? null,
              maxOutputTokens: limit.tokens,
              timeoutMs: limit.timeoutMs,
              cause,
            });
          }
        } else if (['photo', 'fixture', 'assist', 'illustration'].includes(run.kind)) {
          if (run.status === 'failed') {
            const inJob = jobs.some((j) => JSON.stringify(j).includes(run.id));
            if (!inJob) {
              const outErr = runFailure(run);
              const code = outErr?.code ?? '';
              const isMetaSpark = ['incomplete_response', 'timeout', 'upstream_failure'].includes(
                code,
              );
              if (isMetaSpark) {
                const mappedKind: CallKind =
                  run.kind === 'photo'
                    ? 'photoInventory'
                    : run.kind === 'fixture'
                      ? 'fixtureClass'
                      : run.kind === 'assist'
                        ? 'refine'
                        : 'illustrate';
                if (!hasCallNear(mappedKind, timeMs)) {
                  const limit = CALL_LIMITS[mappedKind];
                  calls.push({
                    kind: mappedKind,
                    createdAt: run.createdAt,
                    durationMs: run.durationMs,
                    outputTokens: run.usage?.outputTokens ?? null,
                    maxOutputTokens: limit.tokens,
                    timeoutMs: limit.timeoutMs,
                    cause: outErr?.detail?.reason ?? (code || 'failed'),
                  });
                }
              }
            }
          }
        }
      }
    }

    return calls;
  } finally {
    if (shouldClose) db.close();
  }
}

export function summarizeCalls(calls: MetaCallRecord[], days = 7): CallStats[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const filtered = calls.filter((c) => Date.parse(c.createdAt) >= cutoff);

  const byKind = new Map<CallKind, MetaCallRecord[]>();
  for (const c of filtered) {
    const k = c.kind as CallKind;
    if (!CALL_LIMITS[k]) continue;
    const list = byKind.get(k) ?? [];
    list.push(c);
    byKind.set(k, list);
  }

  const result: CallStats[] = [];

  for (const [kind, group] of byKind.entries()) {
    const limit = CALL_LIMITS[kind];
    const count = group.length;

    // Latency
    const latencies = group.map((c) => c.durationMs).sort((a, b) => a - b);
    const p50LatencyMs = latencies[Math.floor(latencies.length / 2)] ?? 0;
    const maxLatencyMs = latencies[latencies.length - 1] ?? 0;
    const timeoutMs = limit.timeoutMs;
    const timeoutShares = group.map((c) => c.durationMs / (c.timeoutMs || limit.timeoutMs));
    const timeoutShare = Math.max(...timeoutShares, maxLatencyMs / timeoutMs);

    // Tokens
    const withTokens = group
      .filter((c) => c.outputTokens != null)
      .map((c) => c.outputTokens as number)
      .sort((a, b) => a - b);
    const p50OutputTokens =
      withTokens.length > 0 ? withTokens[Math.floor(withTokens.length / 2)]! : null;
    const maxOutputTokens = withTokens.length > 0 ? withTokens[withTokens.length - 1]! : null;
    const tokenLimit = limit.tokens;
    const tokenShares = group
      .filter((c) => c.outputTokens != null && (c.maxOutputTokens || tokenLimit))
      .map((c) => c.outputTokens! / (c.maxOutputTokens ?? tokenLimit!));
    const tokenShare = Math.max(
      ...tokenShares,
      maxOutputTokens != null && tokenLimit != null ? maxOutputTokens / tokenLimit : 0,
      0,
    );

    // Failures
    const failures: Record<string, number> = {};
    for (const c of group) {
      if (c.cause) {
        failures[c.cause] = (failures[c.cause] ?? 0) + 1;
      }
    }

    const hasTimeoutOverrun = timeoutShare >= 1.0 || (failures['timeout'] ?? 0) > 0;
    const hasTokenOverrun = tokenShare >= 1.0 || (failures['max_output_tokens'] ?? 0) > 0;
    const flagged = timeoutShare > 0.8 || tokenShare > 0.8 || hasTimeoutOverrun || hasTokenOverrun;

    const overrunKinds: ('timeout' | 'tokens')[] = [];
    if (hasTimeoutOverrun) overrunKinds.push('timeout');
    if (hasTokenOverrun) overrunKinds.push('tokens');

    result.push({
      kind,
      count,
      p50LatencyMs,
      maxLatencyMs,
      timeoutMs,
      timeoutShare,
      p50OutputTokens,
      maxOutputTokens,
      tokenLimit,
      tokenShare,
      failures,
      flagged,
      overrunKinds,
    });
  }

  // Sort: flagged first, then by count descending
  result.sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    return b.count - a.count;
  });

  return result;
}
