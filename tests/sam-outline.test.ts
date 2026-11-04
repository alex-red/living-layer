import { describe, expect, it } from 'bun:test';
import { testApp } from './lib/app.js';
import { demoSegmentation } from '../apps/server/src/demo.js';
import {
  DEMO_FRAME,
  LOCAL_OUTLINE_MODEL,
  maskBits,
  type EvidenceRun,
  type Segmentation,
} from '@livinglayer/domain';

/** The demo mug's box as SAM's stand-in outlines it, grown a little, in thousandths. */
async function aroundMug() {
  const mug = (await demoSegmentation('mug')).output.detections[0]!;
  const { width, height } = DEMO_FRAME;
  const grow = 4;
  return {
    kind: 'rect' as const,
    box: {
      x1: Math.round(((mug.box.x - grow) / width) * 1000),
      y1: Math.round(((mug.box.y - grow) / height) * 1000),
      x2: Math.round(((mug.box.x + mug.box.width + grow) / width) * 1000),
      y2: Math.round(((mug.box.y + mug.box.height + grow) / height) * 1000),
    },
  };
}

describe('drawing round a thing for SAM to outline', () => {
  it('runs while tracking may not call AI, as the person asked for it', async () => {
    const { post } = await testApp({ name: 'sam-box-off', trackingAi: false });
    const res = await post('segment', { concept: 'mug', shape: await aroundMug(), sam: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<EvidenceRun<Segmentation>>().output.detections).toHaveLength(1);
    // SAM by name, which tracking asks for on its own, is still refused.
    expect((await post('segment', { concept: 'mug' })).json().error.code).toBe('tracking_ai_off');
  });

  it('outlines the thing inside the box as SAM does, one outline to confirm', async () => {
    const { post } = await testApp({ name: 'sam-box' });
    const run = (
      await post('segment', { concept: 'mug', shape: await aroundMug(), sam: true })
    ).json<EvidenceRun<Segmentation>>();
    expect(run.status).toBe('completed');
    expect(run.model).not.toBe(LOCAL_OUTLINE_MODEL);
    expect(run.output.detections.map((d) => d.objectId)).toEqual(['1']);
    // In the demo SAM's answer is the render's own pixels of the mug.
    const truth = maskBits((await demoSegmentation('mug')).output.detections[0]!, DEMO_FRAME, 1);
    const mine = maskBits(run.output.detections[0]!, DEMO_FRAME, 1);
    expect(mine.data).toEqual(truth.data);
    const selected = await post('desk/select', { segmentRunId: run.id, detectionId: '1' });
    expect(selected.statusCode, selected.body).toBe(200);
  });
});
