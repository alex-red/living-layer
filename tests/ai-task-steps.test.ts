import { describe, expect, it } from 'bun:test';
import type { Job } from '@livinglayer/domain';
import { brushSending } from '../apps/web/src/workspace/brushSending';
import { taskSteps, type AiTask } from '../apps/web/src/workspace/state/ai-task-store';

const task = (over: Partial<AiTask> = {}): AiTask => ({
  title: 'AI brush',
  jobId: 'job-1',
  job: null,
  status: 'running',
  open: true,
  startedAt: 1000,
  ...over,
});
const job: Job = {
  id: 'job-1',
  createdAt: '2026-11-04T16:00:00.000Z',
  done: false,
  steps: [
    { id: 'frame', label: 'Hold the frame', state: 'running' },
    { id: 'select', label: 'Find what you selected', state: 'waiting' },
  ],
};
const box = { kind: 'rect' as const, box: { x1: 0.4, y1: 0.3, x2: 0.6, y2: 0.5 } };

describe('the AI dialog’s first step', () => {
  it('shows sending the request, running, before the server’s job is heard', () => {
    const steps = taskSteps(
      task({ sending: { detail: 'The frame', image: 'data:image/png;base64,AA' } }),
    );
    expect(steps).toEqual([
      {
        id: 'send',
        label: 'Send the request',
        state: 'running',
        detail: 'The frame',
        image: 'data:image/png;base64,AA',
        startedAt: 1000,
      },
    ]);
  });

  it('is done when the job is heard, timed to then, followed by the job’s steps', () => {
    const steps = taskSteps(task({ job, heardAt: 1300 }));
    expect(steps.map((s) => [s.id, s.state])).toEqual([
      ['send', 'done'],
      ['frame', 'running'],
      ['select', 'pending'],
    ]);
    expect(steps[0]).toMatchObject({ startedAt: 1000, endedAt: 1300 });
  });

  it('says it is still waiting, and why it might be, once the server has been quiet a while', () => {
    expect(taskSteps(task({ stalled: true }))[0]!.detail).toContain('Still waiting for the server');
    expect(taskSteps(task({ stalled: true, job }))[0]!.detail).not.toContain('Still waiting');
  });

  it('fails with the request when it failed before reaching the server', () => {
    expect(taskSteps(task({ status: 'failed' }))[0]!.state).toBe('failed');
  });

  it('leaves it out of a past run opened to look back at', () => {
    expect(taskSteps(task({ job, review: true, status: 'done' })).map((s) => s.id)).toEqual([
      'frame',
      'select',
    ]);
  });
});

describe('what an AI brush request says it sends', () => {
  it('names the words, the selection and the held frame’s size, with the frame as its picture', () => {
    const frame = `data:image/png;base64,${'A'.repeat(4096)}`;
    expect(brushSending('make this a black coaster Thing', box, frame)).toEqual({
      detail: '“make this a black coaster Thing”, your selection and the frame you drew on (3 KB)',
      image: frame,
    });
  });

  it('sends only the words for a follow-up, and no frame in the demo', () => {
    expect(brushSending('make it red', null, null).detail).toBe(
      '“make it red”, about your last request',
    );
    expect(brushSending('make it red', box, null)).toEqual({
      detail: '“make it red” and your selection',
    });
  });

  it('cuts long words short', () => {
    const { detail } = brushSending('a'.repeat(100), null, null);
    expect(detail).toContain(`${'a'.repeat(59)}…`);
  });
});
