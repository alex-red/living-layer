import { idOnlySchema, jobsQuerySchema } from '@livinglayer/domain';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import type { Job } from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';

/** Where ended jobs are kept, so a past run can be reviewed step by step. */
export interface JobHistory {
  saveJob(job: Job): void;
  getJob(id: string): Job | undefined;
  listJobs(options?: { pictures?: boolean }): Job[];
}

/** How long a finished or abandoned job stays readable. */
const KEEP_MS = 10 * 60_000;
const THUMB = 160;

/**
 * Long jobs the page asked to follow, by the id it chose: each job's steps
 * move from waiting to running to done as the work goes, so the page can
 * show where it is while its request is still open. Running jobs are kept in
 * memory; once one ends it is kept in the history, if there is one.
 */
export class Jobs {
  private jobs = new Map<string, Job & { touched: number }>();
  private trackers = new Map<string, JobTracker>();
  private history: JobHistory | null = null;

  /** Keep each job that ends, with its steps and pictures, for review. */
  keepIn(history: JobHistory) {
    this.history = history;
  }
  /** Start following a job; with no id, steps are still taken but nobody reads them. */
  start(
    id: string | undefined,
    steps: { id: string; label: string }[],
    about: Pick<Job, 'title' | 'mode'> = {},
  ): JobTracker {
    this.prune();
    const job = {
      id: id ?? '',
      ...about,
      steps: steps.map((s) => ({ ...s, state: 'waiting' as const })),
      createdAt: new Date().toISOString(),
      done: false,
      runIds: [],
      touched: Date.now(),
    };
    const tracker = new JobTracker(job, (ended) => {
      if (!id || !this.history) return;
      const { touched: _t, ...kept } = ended;
      this.history.saveJob(structuredClone(kept));
    });
    if (id) {
      this.jobs.set(id, job);
      this.trackers.set(id, tracker);
    }
    return tracker;
  }
  /** Stop a job the page gave up on: its running call is aborted and nothing after it runs. */
  stop(id: string): boolean {
    const tracker = this.trackers.get(id);
    if (!tracker) return false;
    tracker.stop();
    return true;
  }
  /** A running or recent job, else an ended one from the history. */
  get(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return this.history?.getJob(id) ?? null;
    const { touched: _t, ...rest } = job;
    return rest;
  }
  private prune() {
    const old = Date.now() - KEEP_MS;
    for (const [id, job] of this.jobs)
      if (job.touched < old) {
        this.jobs.delete(id);
        this.trackers.delete(id);
      }
  }
}

export class JobTracker {
  private abort = new AbortController();
  constructor(
    private job: Job & { touched: number },
    private ended: (job: Job & { touched: number }) => void = () => {},
  ) {}
  /** Note an evidence run the job made, so its history links to it. */
  link(runId: string) {
    this.job.runIds = [...(this.job.runIds ?? []), runId];
  }
  /** Aborts once the page stops the job; pass it to each model call. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }
  get stopped(): boolean {
    return this.abort.signal.aborted;
  }
  get title(): string {
    return this.job.title ?? 'An AI task';
  }
  /** Between steps: give up here if the page stopped the job. */
  check() {
    if (this.stopped) throw stoppedError();
  }
  stop() {
    if (this.job.done) return;
    this.abort.abort();
    for (const s of this.job.steps)
      if (s.state === 'running' || s.state === 'waiting') {
        if (s.state === 'running') s.endedAt = new Date().toISOString();
        s.state = 'stopped';
      }
    this.job.stopped = true;
    this.finish('stopped');
  }
  private step(id: string) {
    this.job.touched = Date.now();
    return this.job.steps.find((s) => s.id === id);
  }
  run(id: string, detail?: string) {
    const s = this.step(id);
    if (!s || this.stopped) return;
    s.state = 'running';
    s.startedAt = new Date().toISOString();
    if (detail) s.detail = detail;
  }
  /** Show a picture on a running step, such as the frame it is sending. */
  async show(id: string, png: Buffer, size = THUMB) {
    const s = this.step(id);
    if (!s || this.stopped) return;
    s.image = await thumbnail(png, size).catch(() => undefined);
  }
  /** Finish a step, with what it found and, for a picture, a thumbnail of it. */
  async done(id: string, detail?: string, png?: Buffer, size = THUMB) {
    const s = this.step(id);
    if (!s || this.stopped) return;
    if (png) s.image = await thumbnail(png, size).catch(() => undefined);
    s.state = 'done';
    s.startedAt ??= new Date().toISOString();
    s.endedAt = new Date().toISOString();
    if (detail) s.detail = detail;
  }
  /** The step that was running failed, with the reason shown. */
  fail(detail: string) {
    if (this.stopped) return;
    const s = this.job.steps.find((x) => x.state === 'running');
    if (s) {
      s.state = 'failed';
      s.detail = detail;
      s.endedAt = new Date().toISOString();
    }
    this.job.error = detail;
    this.finish('failed');
  }
  finish(outcome: NonNullable<Job['outcome']> = 'done') {
    if (this.job.outcome) return;
    this.job.done = true;
    this.job.outcome = outcome;
    this.job.endedAt = new Date().toISOString();
    this.job.touched = Date.now();
    this.ended(this.job);
  }
}

/** Jobs whose steps are still running, whether or not a request still waits on them. */
const working = new Set<JobTracker>();
/** The titles of the jobs still running, so `bun run dev` can wait for them before a reload. */
export function runningJobs(): string[] {
  return [...working].map((job) => job.title);
}

/** Run a job's steps; a stop ends it with a plain message, a failure shows on the step that failed. */
export async function following<T>(job: JobTracker, steps: () => Promise<T>): Promise<T> {
  working.add(job);
  try {
    const result = await steps();
    job.check();
    return result;
  } catch (error) {
    if (job.stopped) throw stoppedError();
    job.fail(error instanceof Error ? error.message : 'It failed.');
    throw error;
  } finally {
    working.delete(job);
  }
}

/** The error a stopped job's request ends with. */
export function stoppedError() {
  return new LabError('stopped', 'Stopped. Nothing was saved.', 409);
}

async function thumbnail(png: Buffer, size = THUMB): Promise<string> {
  const resized = sharp(png).resize(size, size, { fit: 'inside', withoutEnlargement: true });
  // Large previews are kept in the job's history, so they are stored as WebP to stay small.
  if (size > THUMB) {
    const webp = await resized.webp({ quality: 82 }).toBuffer();
    return `data:image/webp;base64,${webp.toString('base64')}`;
  }
  const small = await resized.png().toBuffer();
  return `data:image/png;base64,${small.toString('base64')}`;
}

/** The jobs that have ended, newest first, for the page's history of AI runs. */
export function jobRoutes(app: FastifyInstance, jobs: Jobs, history: JobHistory) {
  /** Where a long job the page follows has got to. */
  app.get('/api/jobs/:id', async (request) => {
    const { id } = parseInput(idOnlySchema, request.params);
    const job = jobs.get(id);
    if (!job) throw new LabError('job_missing', 'That job isn’t running here.', 404);
    return job;
  });
  /** Stop a job the page is following: its running call is aborted and nothing more is saved. */
  app.post('/api/jobs/:id/stop', async (request) => {
    const { id } = parseInput(idOnlySchema, request.params);
    if (!jobs.stop(id)) throw new LabError('job_missing', 'That job isn’t running here.', 404);
    return jobs.get(id);
  });
  app.get('/api/jobs', async (request) => {
    const { pictures } = parseInput(jobsQuerySchema, request.query);
    // The list is light: each step's picture is fetched with its job (dropped in SQL).
    return history.listJobs({ pictures: pictures === '1' });
  });
}
