import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LumaFrame } from '@livinglayer/domain';
import type { DeskTracking } from '../apps/server/src/desk.js';
import { Y4mReader, type FrameSource } from '../apps/server/src/frames.js';
import { EvidenceStore, STREAM_STATS_FILE } from '../apps/server/src/store.js';
import { Watcher } from '../apps/server/src/watcher.js';

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const frame: LumaFrame = { width: 4, height: 2, data: new Uint8Array(8) };

describe('stream stats', () => {
  it('logs how a live camera’s frames arrived when watching stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livinglayer-stream-'));
    dirs.push(dir);
    const store = new EvidenceStore(dir);
    store.saveMemory({
      ...store.memory('live'),
      watch: { on: true, camera: { id: 'cam:a', name: 'Desk', url: 'rtsp://cam/a' } },
    });
    let now = 10_000;
    let push: (f: LumaFrame) => void = () => {};
    const source: FrameSource = {
      start: async (onFrame) => {
        now += 400;
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
    // The first frame 100 ms after opening, then 10 a second with one 300 ms gap.
    for (const step of [100, 100, 100, 300, 100]) {
      now += step;
      push(frame);
    }
    watcher.stop();
    const [record] = readFileSync(join(dir, STREAM_STATS_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(record).toMatchObject({
      source: 'watcher',
      camera: 'cam:a',
      outcome: 'stopped',
      openMs: 400,
      firstFrameMs: 500,
      frames: 5,
      fps: 6.7,
      maxGapMs: 300,
    });
  });

  it('reads grey frames out of YUV4MPEG however the pipe cuts it', () => {
    const header = 'YUV4MPEG2 W4 H2 F10:1 Ip A1:1 Cmono XCOLORRANGE=FULL\n';
    // Pixel values include a newline (10), which mustn't be taken for the end of a line.
    const pixels = [
      [10, 10, 1, 2, 3, 4, 5, 6],
      [7, 10, 9, 10, 11, 12, 13, 14],
    ];
    const bytes = new Uint8Array([
      ...new TextEncoder().encode(header),
      ...pixels.flatMap((p) => [...new TextEncoder().encode('FRAME\n'), ...p]),
    ]);
    for (const step of [1, 3, 7, bytes.length]) {
      const frames: LumaFrame[] = [];
      const reader = new Y4mReader((f) => frames.push(f));
      for (let at = 0; at < bytes.length; at += step) reader.push(bytes.slice(at, at + step));
      expect(reader.started).toBe(true);
      expect(frames.map((f) => [f.width, f.height, [...f.data]])).toEqual(
        pixels.map((p) => [4, 2, p]),
      );
    }
    expect(() =>
      new Y4mReader(() => {}).push(new TextEncoder().encode('YUV4MPEG2 W4 H2 C420\n')),
    ).toThrow('grey');
  });
});
