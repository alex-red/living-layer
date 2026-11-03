import type { Job } from '@livinglayer/domain';
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
}

/** The task as it is now. Its job is replaced every 350 ms while it runs, so it lives outside the lab's state. */
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
