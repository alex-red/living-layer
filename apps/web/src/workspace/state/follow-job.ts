import type { Job } from '@livinglayer/domain';
import { api } from '../../api';

/**
 * Hear a running job's progress as it changes: over the server's event stream
 * (`/api/jobs/:id/events`), or, where that can't be had (no `EventSource`, or
 * the stream kept failing), by asking every `pollMs` until the job is done.
 *
 * The stream is usually opened before the request that starts the job, so the
 * server answers 404 until the job is registered: a stream that fails is
 * opened again after a short, growing wait, `tries` times, before polling.
 * Returns how to stop following.
 */
export function followJob(
  jobId: string,
  onJob: (job: Job) => void,
  {
    pollMs = 350,
    retryMs = 150,
    tries = 6,
  }: { pollMs?: number; retryMs?: number; tries?: number } = {},
): () => void {
  let stopped = false;
  let ended = false;
  let failures = 0;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hear = (job: Job) => {
    if (job.done) ended = true;
    if (!stopped) onJob(job);
  };
  const poll = async () => {
    if (stopped || ended) return;
    const job = await api(`jobs/${jobId}`).catch(() => null);
    if (job) hear(job);
    if (!stopped && !ended) timer = setTimeout(() => void poll(), pollMs);
  };
  const listen = () => {
    if (stopped || ended) return;
    source = new EventSource(`/api/jobs/${jobId}/events`);
    source.onmessage = (event) => {
      // A stream that answers is a good one again: a later drop starts the waits over.
      failures = 0;
      try {
        hear(JSON.parse(event.data) as Job);
      } catch {
        // A malformed frame: the next change sends the job again.
      }
    };
    source.onerror = () => {
      // The server closes the stream when the job ends; before that, an error is
      // a 404 while the job isn't registered yet or a dropped connection.
      source?.close();
      source = undefined;
      if (stopped || ended) return;
      failures++;
      if (failures > tries) return void poll();
      timer = setTimeout(listen, retryMs * 2 ** (failures - 1));
    };
  };
  if (typeof EventSource === 'undefined') void poll();
  else listen();
  return () => {
    stopped = true;
    source?.close();
    clearTimeout(timer);
  };
}

/**
 * The job once it is done, heard through `followJob`; rejects when `signal`
 * aborts first.
 */
export function jobDone(jobId: string, signal: AbortSignal): Promise<Job> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Stopped.'));
    let stop = () => {};
    const onAbort = () => {
      stop();
      reject(new Error('Stopped.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    stop = followJob(jobId, (job) => {
      if (!job.done) return;
      stop();
      signal.removeEventListener('abort', onAbort);
      resolve(job);
    });
  });
}
