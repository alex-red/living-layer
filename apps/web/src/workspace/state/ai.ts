import { useEffect, useRef, useState, useCallback } from 'react';
import type { IsoScene, Job, DeskMemory } from '@livinglayer/domain';
import { DEMO_CAMERA, groupInFrame } from '@livinglayer/domain';
import { followJob } from './follow-job';
import { api } from '../../api';
import { useBrush, type Brush } from '../useBrush';
import { aiTaskStore, setAiTask, updateAiTask, type AiTask } from './ai-task-store';
import { SHORTCUTS } from '../../shortcuts';
import { UNDO_LIMIT, stoppedJob } from './helpers';
import type { ViewSlice } from './view';
import type { FeedbackSlice } from './feedback';
import type { RunLogSlice } from './runlog';
import type { DeskSlice } from './desk';
import type { FollowStateSlice } from './follow-state';
import type { CameraSlice } from './camera';
import type { ObservationSlice } from './observation';
import type { TrackingSlice } from './tracking';
import type { NavigationSlice } from './navigation';
import { useStableSlice } from './stable';
import type { Dispatch, RefObject, SetStateAction } from 'react';

/** The Ai slice of the lab's state. */
export function useAiSlice(
  deps: ViewSlice &
    FeedbackSlice &
    RunLogSlice &
    DeskSlice &
    FollowStateSlice &
    CameraSlice &
    ObservationSlice &
    TrackingSlice &
    NavigationSlice,
): AiSlice {
  const {
    busy,
    chooseTool,
    edits,
    frameNow,
    memories,
    memory,
    mode,
    mounted,
    openModel,
    redo,
    refresh,
    restoreDesk,
    setBusy,
    setError,
    setHistoryTick,
    setMemory,
    setMessage,
    setWorkScene,
    undo,
  } = deps;
  /**
   * A long AI action shown step by step in its dialog: the job's steps as the
   * server reports them, kept after it ends until the dialog is closed.
   */
  // The task lives in `aiTaskStore`: its job is replaced as it changes and only the dialog shows it.
  /** The action running now; a stop bumps the generation so its answer is dropped. */
  const aiGeneration = useRef(0);
  const aiRun = useRef<{ generation: number; jobId: string; abort: AbortController } | null>(null);
  const aiClose = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The last AI action that finished, with the desk from just before it, to revert to. */
  const [lastAiRun, setLastAiRun] = useState<{ jobId: string; desk: DeskMemory } | null>(null);
  /** Past AI actions, newest first, without their pictures: each is fetched to review. */
  const [aiHistory, setAiHistory] = useState<Job[]>([]);
  const loadAiHistory = useCallback(
    () =>
      api('jobs')
        .then((list) => mounted.current && setAiHistory(list))
        .catch(() => {}),
    [mounted],
  );
  useEffect(() => {
    void loadAiHistory();
  }, [loadAiHistory]);
  /** Open a past AI action in the dialog, read-only, to see what each step did. */
  async function reviewAiRun(jobId: string) {
    if (aiRun.current) return;
    clearTimeout(aiClose.current);
    const job = await api(`jobs/${jobId}`).catch(() => null);
    if (!job) return setError('That AI run is no longer kept.');
    setAiTask({
      title: job.title ?? 'AI run',
      jobId,
      job,
      status: job.outcome ?? (job.stopped ? 'stopped' : 'done'),
      error: job.error,
      open: true,
      startedAt: Date.parse(job.createdAt),
      review: true,
    });
  }
  /**
   * Put a past modelling run's model back on its fixture, as it was saved then
   * (no model call), and open it to edit; undo puts the model it replaces back.
   */
  async function reapplyAiRun(jobId: string) {
    if (busy) return;
    setBusy('reapply');
    setError('');
    try {
      const result = await api('fixtures/sculpt/reapply', { mode, jobId });
      setMemory(result.memory);
      closeAiTask();
      setMessage(
        `Applied that run’s model to the ${result.label.toLowerCase()} again. Undo puts the old model back.`,
      );
      openModel(result.fixtureId);
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'That run’s model could not be applied again.');
    } finally {
      setBusy((b) => (b === 'reapply' ? '' : b));
    }
  }
  /**
   * Put the desk back as it was before the last AI action: what it saved goes,
   * and so do edits made since. Undo brings it all back.
   */
  async function revertLastAiRun() {
    const last = lastAiRun;
    const current = last && memories[last.desk.mode];
    if (!last || !current || busy || aiRun.current) return;
    setBusy('revert');
    setError('');
    try {
      await restoreDesk(last.desk);
      const m = last.desk.mode;
      undo.current[m] = [...undo.current[m], current].slice(-UNDO_LIMIT);
      redo.current[m] = [];
      edits.current++;
      setHistoryTick((t) => t + 1);
      setLastAiRun(null);
      const title = aiHistory.find((j) => j.id === last.jobId)?.title ?? aiTaskStore.get()?.title;
      closeAiTask();
      setMessage(
        `Reverted${title ? `: ${title.toLowerCase()}` : ' the last AI run'}. The desk is as it was before it; undo with ${SHORTCUTS.find((k) => k.action === 'undo')!.keys}.`,
      );
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The AI run could not be reverted.');
    } finally {
      setBusy((b) => (b === 'revert' ? '' : b));
    }
  }
  /** Stop the running AI action: the server aborts its model call and saves nothing. */
  function stopAiTask() {
    const running = aiRun.current;
    if (!running) return;
    aiRun.current = null;
    aiGeneration.current++;
    const { jobId } = running;
    updateAiTask(jobId, { status: 'stopped' });
    setAiTask((t) => (t?.jobId === jobId && t.job ? { ...t, job: stoppedJob(t.job) } : t));
    setBusy('');
    setMessage(
      `Stopped: ${aiTaskStore.get()?.title.toLowerCase() ?? 'the AI call'}. Nothing was saved.`,
    );
    // Tell the server first, then drop the request. The job may not be registered
    // yet in the first moments, so the stop is tried again briefly.
    void (async () => {
      for (let tries = 0; tries < 5; tries++) {
        // A stop the server hasn't registered yet answers 404, which throws: try again.
        const job = await api(`jobs/${jobId}/stop`, undefined, { method: 'POST' }).catch(
          () => null,
        );
        if (job) {
          if (job.done && !job.stopped) {
            // It had already finished: what it saved stays, so show it.
            updateAiTask(jobId, { job, status: 'done' });
            setMessage('It had already finished, so the result was kept.');
            void refresh().catch(() => {});
          } else updateAiTask(jobId, { job });
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      running.abort.abort();
      void loadAiHistory();
    })();
  }
  /** Close the dialog; a running action is stopped first. */
  function closeAiTask() {
    if (aiRun.current) stopAiTask();
    clearTimeout(aiClose.current);
    setAiTask(null);
  }
  /** Hide the dialog of a clean finish after a moment to look at it; the next action cancels this. */
  function closeAiTaskSoon(ms: number) {
    clearTimeout(aiClose.current);
    aiClose.current = setTimeout(() => setAiTask(null), ms);
  }
  const brush = useStableSlice(
    useBrush({
      mode,
      frameNow,
      followAi,
      closeAiTaskSoon,
      setMemory,
      showOwnScene: () => setWorkScene('custom'),
      setMessage,
      setError,
    }),
  );
  /**
   * The AI brush on a prop picked in the room rather than drawn round on the
   * picture: its box, seen through the room's camera, is the selection.
   */
  function brushGroup(scene: IsoScene, group: string) {
    const camera = mode === 'demo' ? DEMO_CAMERA : memory?.camera?.camera;
    if (!camera)
      return setError(
        'Calibrate the room’s camera first: the AI brush reads what you pick through it.',
      );
    // A little wider than its box: the room may draw it too small, and SAM needs all of it in view.
    const box = groupInFrame(camera, scene, group, 0.15);
    if (!box)
      return setError('The room’s camera doesn’t see all of it, so the AI brush can’t pick it.');
    const { width, height } = camera.frame;
    chooseTool('brush');
    void brush.finish({
      kind: 'rect',
      a: { x: box.left / width, y: box.top / height },
      b: { x: box.right / width, y: box.bottom / height },
    });
  }
  /**
   * Run an AI call that reports its steps under a job id, followed in the
   * dialog until it ends. Resolves to its answer, or null when it was stopped.
   */
  async function followAi<T>(
    task: Pick<AiTask, 'title' | 'description'>,
    call: (jobId: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T | null> {
    const generation = ++aiGeneration.current;
    const jobId = crypto.randomUUID();
    // The desk as it was, for reverting what this action saves.
    const before = memory;
    const abort = new AbortController();
    aiRun.current = { generation, jobId, abort };
    clearTimeout(aiClose.current);
    setAiTask({ ...task, jobId, job: null, status: 'running', open: true, startedAt: Date.now() });
    const current = () => mounted.current && generation === aiGeneration.current;
    /** In development, say why a result goes nowhere: a newer task started, or this one was stopped. */
    const dropped = (what: string) => {
      if (!import.meta.env.DEV || !mounted.current) return;
      const why =
        aiRun.current && aiRun.current.jobId !== jobId
          ? 'a newer AI task started'
          : 'it was stopped';
      console.warn(`AI task "${task.title}" (${jobId.slice(0, 8)}): ${what} dropped, ${why}`);
    };
    const stopFollowing = followJob(jobId, (job) => {
      if (current()) updateAiTask(jobId, { job });
    });
    try {
      const result = await call(jobId, abort.signal);
      if (current()) {
        if (before) setLastAiRun({ jobId, desk: before });
        return result;
      }
      dropped('its result');
      return null;
    } catch (e) {
      if (!current()) {
        dropped(`its failure (${e instanceof Error ? e.message : String(e)})`);
        return null;
      }
      updateAiTask(jobId, {
        status: 'failed',
        error: e instanceof Error ? e.message : 'It failed.',
      });
      throw e;
    } finally {
      stopFollowing();
      if (current()) {
        aiRun.current = null;
        // The last word on every step, success or not.
        const job = await api(`jobs/${jobId}`).catch(() => null);
        setAiTask((t) =>
          t?.jobId !== jobId
            ? t
            : {
                ...t,
                job: job ?? t.job,
                status: t.status === 'running' ? 'done' : t.status,
              },
        );
        void loadAiHistory();
      }
    }
  }
  return useStableSlice({
    aiHistory,
    aiRun,
    brush,
    brushGroup,
    closeAiTask,
    closeAiTaskSoon,
    followAi,
    lastAiRun,
    reapplyAiRun,
    revertLastAiRun,
    reviewAiRun,
    setLastAiRun,
    stopAiTask,
  });
}
/** What the Ai slice of the lab offers: its state, derived values and actions. */
export interface AiSlice {
  aiHistory: Job[];
  aiRun: RefObject<{
    generation: number;
    jobId: string;
    abort: AbortController;
  } | null>;
  brush: Brush;
  brushGroup: (scene: IsoScene, group: string) => void;
  closeAiTask: () => void;
  closeAiTaskSoon: (ms: number) => void;
  followAi: <T>(
    task: Pick<AiTask, 'title' | 'description'>,
    call: (jobId: string, signal: AbortSignal) => Promise<T>,
  ) => Promise<T | null>;
  lastAiRun: {
    jobId: string;
    desk: DeskMemory;
  } | null;
  reapplyAiRun: (jobId: string) => Promise<void>;
  revertLastAiRun: () => Promise<void>;
  reviewAiRun: (jobId: string) => Promise<void>;
  setLastAiRun: Dispatch<
    SetStateAction<{
      jobId: string;
      desk: DeskMemory;
    } | null>
  >;
  stopAiTask: () => void;
}
