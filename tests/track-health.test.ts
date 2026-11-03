import { describe, expect, it } from 'bun:test';
import { DEMO_FRAME, HealthMeter, TRACK_HEALTH, type LumaFrame } from '@livinglayer/domain';
import { watchersOf } from '../apps/server/src/app.js';
import { demoPng } from '../apps/server/src/demo.js';
import { lumaOf, type FrameSource } from '../apps/server/src/frames.js';
import { cpuSeconds } from '../apps/server/src/health.js';
import { testApp } from './lib/app.js';

/** A meter fed `n` frames `gap` ms apart, each `work` ms long, read just after the last. */
function fed(n: number, gap: number, work: number | ((i: number) => number), paced = true) {
  const meter = new HealthMeter(10, paced);
  for (let i = 0; i < n; i++) meter.frame(i * gap, typeof work === 'number' ? work : work(i));
  return { meter, last: (n - 1) * gap };
}

describe('tracker health', () => {
  it('waits for a first frame, then is healthy at the wanted rate', () => {
    expect(new HealthMeter(10).read(0).verdict).toBe('waiting');
    const { meter, last } = fed(20, 100, 8);
    const h = meter.read(last + 10, { things: 2 });
    expect(h).toMatchObject({ verdict: 'healthy', fps: 10, workP50: 8, budgetMs: 100, queued: 0 });
    expect(h.busy).toBeCloseTo(0.08, 2);
    expect(h.reason).toBe('10.0 fps · 8 ms a frame');
  });

  it('is strained past half the interval and lagging past all of it', () => {
    expect(fed(20, 100, 60).meter.read(1900).verdict).toBe('strained');
    const h = fed(20, 100, 140).meter.read(1900);
    expect(h.verdict).toBe('lagging');
    expect(h.reason).toBe('frame work 140 ms of 100 ms');
  });

  it('is lagging when frames come slowly or queued, and stalled when they stop', () => {
    expect(fed(20, 200, 5).meter.read(3800).reason).toBe('5.0 fps of 10');
    // Two at once, then a gap: still 10 a second, but each pair waited on the last.
    const meter = new HealthMeter(10);
    for (let i = 0; i < 20; i++) meter.frame(Math.floor(i / 2) * 200 + (i % 2) * 5, 5);
    expect(meter.read(1910).reason).toBe('frames queuing: behind the camera');
    const stalled = fed(20, 100, 5).meter.read(1900 + TRACK_HEALTH.stalledMs + 500);
    expect(stalled).toMatchObject({ verdict: 'stalled', reason: 'no frame for 2.5 s' });
  });

  it('judges only work when frames come one move at a time', () => {
    const h = fed(3, 5000, 4, false).meter.read(60_000);
    expect(h).toMatchObject({ verdict: 'healthy', fps: null, busy: null, queued: 0 });
  });

  it('is strained by late timers, and by lost things last', () => {
    const { meter, last } = fed(20, 100, 5);
    expect(meter.read(last, { driftMs: 80 }).reason).toBe('process busy: timers 80 ms late');
    expect(meter.read(last, { driftMs: 300 }).verdict).toBe('lagging');
    expect(meter.read(last, { lost: 1, things: 3 }).reason).toBe('1 of 3 things lost');
  });

  it('keeps the window and the sparkline to their lengths', () => {
    const { meter, last } = fed(80, 100, (i) => i);
    const h = meter.read(last);
    expect(h.recent).toHaveLength(TRACK_HEALTH.recentFrames);
    expect(h.recent.at(-1)).toBe(79);
    expect(h.workP50).toBe(80 - TRACK_HEALTH.windowFrames / 2);
  });

  it("reads ps's CPU time", () => {
    expect(cpuSeconds('  0:01.25\n')).toBe(1.25);
    expect(cpuSeconds('1:02:03')).toBe(3723);
    expect(cpuSeconds('2-00:00:01')).toBe(172_801);
    expect(cpuSeconds('')).toBeNull();
  });

  it("is in the watcher's view while it watches, and gone when it stops", async () => {
    let push: (frame: LumaFrame) => void = () => {};
    const photo = await demoPng();
    const { app, post } = await testApp({
      name: 'track-health',
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
    const watcher = watchersOf(app).demo;
    await post('watch', { on: true });
    await watcher.idle();
    expect(watcher.view().health?.verdict).toBe('waiting');
    push(await lumaOf(photo));
    const h = watcher.view().health!;
    expect(h).toMatchObject({ verdict: 'healthy', fps: null, wantFps: 10 });
    expect(h.recent).toHaveLength(1);
    await post('watch', { on: false });
    expect(watcher.view().health).toBeUndefined();
  });
});
