import sharp from 'sharp';
import type { Job } from '@livinglayer/domain';

/** How long a finished or abandoned job stays readable. */
const KEEP_MS = 10 * 60_000;
const THUMB = 160;

/**
 * Long jobs the page asked to follow, by the id it chose: each job's steps
 * move from waiting to running to done as the work goes, so the page can
 * show where it is while its request is still open. Kept in memory only.
 */
export class Jobs {
  private jobs = new Map<string, Job & { touched: number }>();

  /** Start following a job; with no id, steps are still taken but nobody reads them. */
  start(id: string | undefined, steps: { id: string; label: string }[]): JobTracker {
    this.prune();
    const job = {
      id: id ?? '',
      steps: steps.map((s) => ({ ...s, state: 'waiting' as const })),
      createdAt: new Date().toISOString(),
      done: false,
      touched: Date.now(),
    };
    if (id) this.jobs.set(id, job);
    return new JobTracker(job);
  }
  get(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const { touched: _t, ...rest } = job;
    return rest;
  }
  private prune() {
    const old = Date.now() - KEEP_MS;
    for (const [id, job] of this.jobs) if (job.touched < old) this.jobs.delete(id);
  }
}

export class JobTracker {
  constructor(private job: Job & { touched: number }) {}
  private step(id: string) {
    this.job.touched = Date.now();
    return this.job.steps.find((s) => s.id === id);
  }
  run(id: string, detail?: string) {
    const s = this.step(id);
    if (!s) return;
    s.state = 'running';
    s.startedAt = new Date().toISOString();
    if (detail) s.detail = detail;
  }
  /** Finish a step, with what it found and, for a picture, a thumbnail of it. */
  async done(id: string, detail?: string, png?: Buffer) {
    const s = this.step(id);
    if (!s) return;
    if (png) s.image = await thumbnail(png).catch(() => undefined);
    s.state = 'done';
    s.startedAt ??= new Date().toISOString();
    s.endedAt = new Date().toISOString();
    if (detail) s.detail = detail;
  }
  /** The step that was running failed, with the reason shown. */
  fail(detail: string) {
    const s = this.job.steps.find((x) => x.state === 'running');
    if (s) {
      s.state = 'failed';
      s.detail = detail;
      s.endedAt = new Date().toISOString();
    }
    this.finish();
  }
  finish() {
    this.job.done = true;
    this.job.touched = Date.now();
  }
}

async function thumbnail(png: Buffer): Promise<string> {
  const small = await sharp(png)
    .resize(THUMB, THUMB, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  return `data:image/png;base64,${small.toString('base64')}`;
}
