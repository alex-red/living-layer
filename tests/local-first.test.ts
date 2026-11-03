import { describe, expect, it } from 'bun:test';
import { sighting } from './lib/mug.js';
import { testApp } from './lib/app.js';
import { watchersOf } from '../apps/server/src/app.js';
import { demoPng, demoSegmentation } from '../apps/server/src/demo.js';
import { lumaOf, type FrameSource } from '../apps/server/src/frames.js';
import {
  maskBits,
  LOCAL_OUTLINE_MODEL,
  DEMO_FRAME,
  type DeskMemory,
  type EvidenceRun,
  type LabStatus,
  type LumaFrame,
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

describe('tracking with no AI calls', () => {
  it('is the default: SAM and Spark are refused, and a box drawn around a thing is outlined here', async () => {
    const { post, get } = await testApp({ name: 'local-first', trackingAi: false });
    expect((await get('status')).json<LabStatus>().tracking).toEqual({ ai: false });
    const sam = await post('segment', { concept: 'mug' });
    expect(sam.statusCode).toBe(409);
    expect(sam.json().error.code).toBe('tracking_ai_off');
    expect((await post('discover')).json().error.code).toBe('tracking_ai_off');

    const run = (await post('segment', { concept: 'mug', shape: await aroundMug() })).json<
      EvidenceRun<Segmentation>
    >();
    expect(run).toMatchObject({ status: 'completed', model: LOCAL_OUTLINE_MODEL, usage: null });
    // Close to the render's own pixels of the mug, which is what SAM's stand-in returns.
    const truth = (await demoSegmentation('mug')).output.detections[0]!;
    const mine = run.output.detections[0]!;
    const a = maskBits(truth, DEMO_FRAME, 1);
    const b = maskBits(mine, DEMO_FRAME, 1);
    let both = 0;
    let either = 0;
    for (let i = 0; i < a.data.length; i++) {
      both += a.data[i]! & b.data[i]!;
      either += a.data[i]! | b.data[i]!;
    }
    expect(both / either).toBeGreaterThan(0.6);

    // Confirmed like any outline, and turned on later only by a person.
    const selected = await post('desk/select', { segmentRunId: run.id, detectionId: '1' });
    expect(selected.statusCode, selected.body).toBe(200);
    expect(sighting(selected.json<DeskMemory>())!.identity).toBe('manual');
    expect(sighting(selected.json<DeskMemory>())!.boxOnly).toBeUndefined();
    expect((await post('settings/tracking-ai', { on: true, mode: undefined })).json()).toEqual({
      on: true,
    });
    expect((await post('segment', { concept: 'mug' })).statusCode).toBe(200);
  });

  it('says when what was drawn is kept as the outline, nothing standing out in it', async () => {
    const { post } = await testApp({ name: 'local-box-only', trackingAi: false });
    // A patch of bare wall.
    const shape = { kind: 'rect', box: { x1: 20, y1: 20, x2: 80, y2: 80 } };
    const run = (await post('segment', { concept: 'mug', shape })).json<
      EvidenceRun<Segmentation>
    >();
    expect(run.output.detections[0]).toMatchObject({ boxOnly: true });
    const selected = await post('desk/select', { segmentRunId: run.id, detectionId: '1' });
    expect(sighting(selected.json<DeskMemory>())).toMatchObject({ boxOnly: true });
  });

  it('tracks the confirmed mug in a new frame from a box drawn round it', async () => {
    const { post } = await testApp({ name: 'local-track', trackingAi: false });
    const shape = await aroundMug();
    const first = (await post('segment', { concept: 'mug', shape })).json<EvidenceRun>();
    await post('desk/select', { segmentRunId: first.id, detectionId: '1' });

    const again = (await post('segment', { concept: 'mug', shape })).json<EvidenceRun>();
    expect(again.model).toBe(LOCAL_OUTLINE_MODEL);
    const tracked = await post('desk/track', { segmentRunId: again.id });
    expect(tracked.statusCode, tracked.body).toBe(200);
    const memory = tracked.json<{ memory: DeskMemory }>().memory;
    expect(sighting(memory)).toMatchObject({ segmentRunId: again.id, identity: 'tracked' });
  });

  it('counts what it watches again once something is confirmed', async () => {
    const photo = await demoPng();
    const { app, post } = await testApp({
      name: 'local-watch-note',
      trackingAi: false,
      appearance: async () => null,
      browseCameras: async () => [],
      frames: (): FrameSource => ({
        start: async () => {},
        stop() {},
        snapshot: async () => ({ png: photo, width: DEMO_FRAME.width, height: DEMO_FRAME.height }),
      }),
    });
    const watcher = watchersOf(app).demo;
    await post('watch', { on: true });
    await watcher.idle();
    expect(watcher.view().note).toContain('nothing is confirmed yet');
    const run = (await post('segment', { concept: 'mug', shape: await aroundMug() })).json<
      EvidenceRun<Segmentation>
    >();
    await post('desk/select', { segmentRunId: run.id, detectionId: '1' });
    await watcher.idle();
    expect(watcher.view().note).toContain('Watching 1 thing');
  });

  it('looks for a lost thing on this machine instead of asking SAM', async () => {
    let push: (frame: LumaFrame) => void = () => {};
    const photo = await demoPng();
    const { app, post } = await testApp({
      name: 'local-watch',
      trackingAi: false,
      appearance: async () => null,
      browseCameras: async () => [],
      frames: (): FrameSource => ({
        start: async (onFrame) => {
          push = onFrame;
        },
        stop() {},
        snapshot: async () => ({ png: photo, width: DEMO_FRAME.width, height: DEMO_FRAME.height }),
      }),
    });
    const run = (await post('segment', { concept: 'mug', shape: await aroundMug() })).json<
      EvidenceRun<Segmentation>
    >();
    await post('desk/select', { segmentRunId: run.id, detectionId: '1' });
    const watcher = watchersOf(app).demo;
    await post('watch', { on: true });
    await watcher.idle();
    expect(watcher.view()).toMatchObject({ state: 'watching', ai: false });
    expect(watcher.view().note).toContain('on this machine only');

    const seen = await lumaOf(photo);
    push(seen);
    // The mug is gone: a blank view.
    const blank = { ...seen, data: new Uint8Array(seen.data.length).fill(128) };
    for (let k = 0; k < 6; k++) push(blank);
    await watcher.idle();
    const view = watcher.view();
    expect(view.things[0]!.status).toBe('unsure');
    expect(view.checks).toBe(0);
    expect(view.note).toContain('Nothing on this machine can see');
    const runs = (await app.inject('/api/runs')).json<EvidenceRun[]>();
    expect(runs.filter((r) => r.kind === 'segment').map((r) => r.model)).toEqual([
      LOCAL_OUTLINE_MODEL,
    ]);
  });
});
