import { randomUUID } from 'node:crypto';
import type {
  EvidenceRun,
  LampResult,
  Mode,
  RunFailure,
  RunKind,
  Segmentation,
} from '@livinglayer/domain';
import { safeError } from './errors.js';
import type { ProviderResult } from './meta.js';
import type { EvidenceStore } from './store.js';

/**
 * Runs one operation as a recorded run: its output, assets, model, usage and
 * time are saved, whether it succeeds or fails, and a failure carries the run's
 * id so the page can open it in the inspector.
 */
export type Runner = (
  kind: RunKind,
  mode: Mode,
  operation: (
    id: string,
    signal?: AbortSignal,
  ) => Promise<Partial<ProviderResult<unknown>> & { output: unknown; assets?: string[] }>,
  /** Aborts the operation's model calls, such as when the client goes away. */
  signal?: AbortSignal,
) => Promise<EvidenceRun>;

export function createRunner(store: EvidenceStore): Runner {
  return async function run(kind, mode, operation, signal) {
    const start = performance.now();
    const id = randomUUID();
    const base = {
      id,
      kind,
      mode,
      createdAt: new Date().toISOString(),
      promptVersion: `${kind}-v1`,
      assets: [] as string[],
      model: null,
      requestId: null,
      usage: null,
    };
    try {
      const result = await operation(id, signal);
      let status: EvidenceRun['status'] = 'completed';
      if (kind === 'segment' && !(result.output as Segmentation).detections.length)
        status = 'no_match';
      if (kind === 'lamp' && !(result.output as LampResult).stateConfirmed) status = 'unconfirmed';
      const evidence: EvidenceRun = {
        ...base,
        output: result.output,
        assets: result.assets ?? [],
        model: result.model ?? null,
        requestId: result.requestId ?? null,
        usage: result.usage ?? null,
        status,
        durationMs: Math.round(performance.now() - start),
      };
      store.save(evidence);
      return evidence;
    } catch (error) {
      const safe = safeError(error, kind);
      const failure: RunFailure = {
        error: {
          code: safe.code,
          message: safe.message,
          ...(safe.detail ? { detail: safe.detail } : {}),
        },
      };
      store.save({
        ...base,
        // What the provider reported, so a failed call shows its model and cost too.
        model: safe.detail?.model ?? null,
        requestId: safe.detail?.requestId ?? null,
        usage: safe.detail?.usage ?? null,
        status: 'failed',
        durationMs: Math.round(performance.now() - start),
        output: failure,
      });
      // The run id lets the page open the failed run in the inspector.
      throw Object.assign(safe, { runId: id });
    }
  };
}
