import type { Job } from '@livinglayer/domain';
import { api } from '../../api';

/**
 * Hear a running job's progress as it changes: over the server's event stream
 * (`/api/jobs/:id/events`), or, where that can't be had (no `EventSource`, or
 * the stream failed before the job ended), by asking every `pollMs`.
 * Returns how to stop following.
 */
export function followJob(
  jobId: string,
  onJob: (job: Job) => void,
  { pollMs = 350 }: { pollMs?: number } = {},
): () => void {
  let stopped = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const poll = async () => {
    if (stopped) return;
    const job = await api<Job>(`jobs/${jobId}`).catch(() => null);
    if (job && !stopped) onJob(job);
    if (!stopped) timer = setTimeout(() => void poll(), pollMs);
  };
  if (typeof EventSource === 'undefined') void poll();
  else {
    source = new EventSource(`/api/jobs/${jobId}/events`);
    source.onmessage = (event) => {
      try {
        const job = JSON.parse(event.data) as Job;
        if (job.done) ended = true;
        if (!stopped) onJob(job);
      } catch {
        // A malformed frame: the next change sends the job again.
      }
    };
    source.onerror = () => {
      // The server closes the stream when the job ends; before that, an error
      // (a 404 while the job isn't registered yet, a dropped connection) means polling.
      source?.close();
      source = undefined;
      if (!stopped && !ended) void poll();
    };
  }
  return () => {
    stopped = true;
    source?.close();
    clearTimeout(timer);
  };
}
