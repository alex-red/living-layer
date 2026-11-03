import { describe, expect, it } from 'bun:test';
import { isRun, runOutput, type EvidenceRun, type Segmentation } from '@livinglayer/domain';

const run = (kind: EvidenceRun['kind'], output: unknown): EvidenceRun => ({
  id: 'r',
  kind,
  mode: 'demo',
  status: 'completed',
  createdAt: '2026-01-01T00:00:00Z',
  durationMs: 1,
  model: null,
  requestId: null,
  promptVersion: 'v',
  usage: null,
  output,
  assets: [],
});

describe('run outputs by kind', () => {
  it('narrows a run to its kind and gives nothing for another', () => {
    const seg = run('segment', { concept: 'mug', detections: [] } as unknown as Segmentation);
    expect(isRun(seg, 'segment')).toBe(true);
    expect(isRun(seg, 'lamp')).toBe(false);
    expect(runOutput(seg, 'segment')?.concept).toBe('mug');
    expect(runOutput(seg, 'discover')).toBeUndefined();
    expect(runOutput(undefined, 'segment')).toBeUndefined();
  });
});
