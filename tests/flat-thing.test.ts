import { describe, expect, it } from 'bun:test';
import { testApp } from './lib/app.js';
import { demoFrame, roomMask, type AssistDraft, type EvidenceRun } from '@livinglayer/domain';
import { maskBox, rectShape } from '../scripts/lib/brush.js';

/** A rectangle a little larger than the demo frame's coaster, in thousandths of the frame. */
function aroundCoaster() {
  const frame = demoFrame();
  const b = maskBox(roomMask(frame, 'coaster'))!;
  const [sx, sy] = [1000 / frame.width, 1000 / frame.height];
  return rectShape({
    x1: (b.x1 - 3) * sx,
    y1: (b.y1 - 3) * sy,
    x2: (b.x2 + 3) * sx,
    y2: (b.y2 + 3) * sy,
  });
}

describe('a flat thing the brush makes from the room’s camera', () => {
  it('is as thick as its kind, not as tall as its outline looks from the corner', async () => {
    const { app } = await testApp({ name: 'flat-thing' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/assist',
      payload: {
        mode: 'demo',
        shape: aroundCoaster(),
        prompt: 'Turn this into its own thing, it’s a coaster',
        jobId: crypto.randomUUID(),
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json<EvidenceRun<AssistDraft>>().output;
    // The demo's coaster is a 10 cm cork disc. Measured as tall as it looked, it was a box
    // 8 × 2 × 4 cm, and refitted a 11 × 7.5 cm slab that missed a fifth of the outline.
    expect(d.recipe!.sizeCm.h).toBeLessThan(1);
    expect(Math.abs(d.recipe!.sizeCm.w - 10)).toBeLessThan(1.5);
    expect(Math.abs(d.recipe!.sizeCm.d - 10)).toBeLessThan(1.5);
    expect(d.check!.iou).toBeGreaterThan(0.9);
  }, 20_000);
});
