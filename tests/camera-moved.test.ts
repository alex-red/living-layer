import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cameraEdges,
  demoFrame,
  DEMO_CALIBRATION,
  MOVED_CAMERA,
  type LumaFrame,
} from '@livinglayer/domain';
import type { DeskTracking } from '../apps/server/src/desk.js';
import type { FrameSource } from '../apps/server/src/frames.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { Watcher } from '../apps/server/src/watcher.js';

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** The demo room in grey, `shiftX` pixels aside as a knocked camera sees it. */
function grey(shiftX = 0): LumaFrame {
  const picture = demoFrame('centre');
  const { width, height } = picture;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + Math.min(width - 1, Math.max(0, x + shiftX))) * 4;
      data[y * width + x] =
        picture.rgba[i]! * 0.3 + picture.rgba[i + 1]! * 0.59 + picture.rgba[i + 2]! * 0.11;
    }
  return { width, height, data };
}

describe('the watcher telling the camera moved', () => {
  it('needs several checks in a row to block the rules, and frees them once the view lines up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livinglayer-moved-'));
    dirs.push(dir);
    const store = new EvidenceStore(dir);
    const blocked = { input: {}, output: { decision: 'blocked', reason: MOVED_CAMERA } };
    store.saveMemory({
      ...store.memory('live'),
      camera: { ...DEMO_CALIBRATION, reference: cameraEdges(grey()) },
      watch: { on: true, camera: { id: 'cam:a', name: 'Desk', url: 'rtsp://cam/a' } },
    });
    let now = 10_000;
    let push: (f: LumaFrame) => void = () => {};
    const source: FrameSource = {
      start: async (onFrame) => {
        push = onFrame;
      },
      stop: () => {},
      snapshot: async () => ({ png: Buffer.alloc(0), width: 0, height: 0 }),
    };
    const watcher = new Watcher({
      mode: 'live',
      store,
      tracking: {} as DeskTracking,
      segment: async () => {
        throw new Error('not asked');
      },
      photoOf: async () => null,
      appearance: async () => null,
      source: () => source,
      now: () => now,
    });
    await watcher.start();
    // One check a frame, 10 s apart.
    const show = (frame: LumaFrame) => {
      now += 10_000;
      push(frame);
      return store.memory('live').camera!.moved ?? false;
    };
    // One odd frame, as when the stream opens, then the room again: nothing blocked.
    expect(show(grey(36))).toBe(false);
    expect(show(grey())).toBe(false);
    expect(show(grey(36))).toBe(false);
    expect(show(grey(36))).toBe(false);
    expect(show(grey(36))).toBe(true);
    store.updateMemory('live', (m) => {
      m.lastDecision = blocked as never;
    });
    // Back where it was calibrated: one frame doesn't free the rules, a few in a row do.
    expect(show(grey())).toBe(true);
    expect(show(grey(36))).toBe(true);
    expect(show(grey())).toBe(true);
    expect(show(grey())).toBe(true);
    expect(show(grey())).toBe(false);
    expect(store.memory('live').lastDecision ?? null).toBeNull();
    watcher.stop();
  });
});
