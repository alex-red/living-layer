import type { Job } from '@livinglayer/domain';
import type { AIStep } from '../../AIRichPreviewDialog';
import { createStore, useStore } from './store';

/** A long AI action the dialog follows: its job's steps and how it ended. */
export interface AiTask {
  title: string;
  description?: string;
  jobId: string;
  job: Job | null;
  status: 'running' | 'done' | 'failed' | 'stopped';
  error?: string;
  /** Shown; hiding it lets the action go on. */
  open: boolean;
  startedAt: number;
  /** A past action opened to look back at, not one running now. */
  review?: boolean;
  /** What to do after it stopped short: the dialog stays open and offers it. */
  next?: { label: string; run: () => void };
  /** What the request carries to the server, in a line, and a picture of it (the held frame). */
  sending?: { detail: string; image?: string };
  /** When the server's job was first heard: the request had reached it. */
  heardAt?: number;
  /** No word from the server for a while after sending. */
  stalled?: boolean;
}

/** How long without word from the server before the dialog says it is still waiting. */
export const AI_STALL_MS = 4000;
const STALLED =
  'Still waiting for the server to take it. With several tabs of the lab open, the browser can run out of connections to it: close one.';

/**
 * The task's steps as the dialog lists them: first sending the request, from
 * the moment it was asked for until the server's job is heard, then the
 * job's own. A past run opened to look back at has only its job's.
 */
export function taskSteps(task: AiTask): AIStep[] {
  const steps: AIStep[] = (task.job?.steps ?? []).map((s) => ({
    ...s,
    state: s.state === 'waiting' ? 'pending' : s.state,
  }));
  if (task.review) return steps;
  const heard = Boolean(task.job);
  const detail = task.sending?.detail ?? 'Your request, to the server';
  const start: AIStep = {
    id: 'send',
    label: 'Send the request',
    state: heard ? 'done' : task.status === 'running' ? 'running' : task.status,
    detail: !heard && task.stalled && task.status === 'running' ? `${detail}. ${STALLED}` : detail,
    ...(task.sending?.image ? { image: task.sending.image } : {}),
    startedAt: task.startedAt,
    ...(heard && task.heardAt ? { endedAt: task.heardAt } : {}),
  };
  return [start, ...steps];
}

/** The task as it is now. Its job is replaced with each step while it runs, so it lives outside the lab's state. */
export const aiTaskStore = createStore<AiTask | null>(null);

export const setAiTask = aiTaskStore.set;
/** Change the task with this job id, if it is still the current one. */
export const updateAiTask = (jobId: string, change: Partial<AiTask>) =>
  aiTaskStore.set((t) => (t?.jobId === jobId ? { ...t, ...change } : t));

/** The whole task; the caller renders with every step. */
export const useAiTask = () => useStore(aiTaskStore);
/** One part of the task, for a caller that need not render with each step. */
export const useAiTaskPart = <S>(select: (task: AiTask | null) => S) =>
  useStore(aiTaskStore, select);
