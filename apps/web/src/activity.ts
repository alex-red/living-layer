import { useSyncExternalStore } from 'react';
import type { EvidenceRun, Mode, ProviderFailure } from '@livinglayer/domain';

/**
 * Calls that reach Meta's models, tracked wherever they start (the probe
 * bench, the iso view, the scene editor) so the page can show what is
 * running, for how long, and how it ended.
 */
export interface ProviderCall {
  id: number;
  path: string;
  mode: Mode;
  title: string;
  /** The provider steps in order; a demo call runs them offline. */
  steps: string[];
  startedAt: number;
  endedAt?: number;
  outcome?: 'done' | 'failed';
  run?: EvidenceRun;
  message?: string;
}

/** Which API paths call a provider, and the steps each one runs. */
export function providerPlan(
  path: string,
  body: Record<string, unknown>,
): { title: string; steps: string[] } | null {
  switch (path) {
    case 'text':
      return { title: 'Checking the Spark connection', steps: ['Spark · reply'] };
    case 'discover':
      return { title: 'Discovering objects', steps: ['Spark · read the photo'] };
    case 'segment':
      return { title: `Outlining “${String(body.concept ?? 'object')}”`, steps: ['SAM · masks'] };
    case 'scene/classify':
      return { title: 'Guessing the scene', steps: ['Spark · pick a preset'] };
    case 'scene/draft':
      return { title: 'Drafting a room', steps: ['Spark · lay out templates'] };
    case 'scene/from-photo':
      return {
        title: 'Drafting a scene from the photo',
        steps: [
          'Spark · list what is there',
          'SAM · outline each thing',
          'Local · measure the layout',
          ...(body.check
            ? ['Spark · compare with the photo', 'SAM · outline what is missing']
            : []),
        ],
      };
    case 'item/draft':
      return body.source === 'spark'
        ? {
            title: 'Drafting a model with Spark',
            steps: ['Spark · name the shape', 'SAM · find parts', 'Spark · check the fit'],
          }
        : null;
    default:
      return null;
  }
}

let calls: ProviderCall[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function update(id: number, patch: Partial<ProviderCall>) {
  calls = calls.map((c) => (c.id === id ? { ...c, ...patch } : c));
  emit();
}

export function startCall(path: string, body: Record<string, unknown>): number | null {
  const plan = providerPlan(path, body);
  if (!plan) return null;
  const call: ProviderCall = {
    id: nextId++,
    path,
    mode: body.mode === 'live' ? 'live' : 'demo',
    startedAt: Date.now(),
    ...plan,
  };
  // Keep the running calls and the last few finished ones.
  calls = [
    ...calls.filter((c) => !c.endedAt).slice(-4),
    ...calls.filter((c) => c.endedAt).slice(-2),
    call,
  ];
  emit();
  return call.id;
}
export function endCall(id: number | null, result: { run?: EvidenceRun; error?: string }) {
  if (id == null) return;
  update(id, {
    endedAt: Date.now(),
    outcome: result.error ? 'failed' : 'done',
    run: result.run,
    message: result.error,
  });
}
export function dismissCall(id: number) {
  calls = calls.filter((c) => c.id !== id);
  emit();
}
export function useProviderCalls(): ProviderCall[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => calls,
  );
}

/** An error from the local API, with what the provider said when there was one. */
export class ApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public detail?: ProviderFailure,
    public runId?: string,
  ) {
    super(message);
  }
}
