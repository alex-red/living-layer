import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { substreamUrl, type CameraView, type LumaFrame } from '@livinglayer/domain';
import { FfmpegSource, LUMA_WIDTH } from '../apps/server/src/frames.js';
import { CameraRelay } from '../apps/server/src/relay.js';
import { tempDir, testApp } from './lib/app.js';

const MAIN = 'rtsp://thingino:secret@192.168.30.66/ch0';

describe('substreamUrl', () => {
  it('borrows the stream’s login for a substream on the same camera', () => {
    expect(substreamUrl('rtsp://192.168.30.66/ch1', MAIN)).toBe(
      'rtsp://thingino:secret@192.168.30.66/ch1',
    );
  });

  it('keeps a substream’s own login, and one on another host as it is', () => {
    expect(substreamUrl('rtsp://other:pw@192.168.30.66/ch1', MAIN)).toBe(
      'rtsp://other:pw@192.168.30.66/ch1',
    );
    expect(substreamUrl('rtsp://192.168.30.99/ch1', MAIN)).toBe('rtsp://192.168.30.99/ch1');
  });
});

describe('a camera’s substream', () => {
  async function saved(body: object) {
    const t = await testApp({ name: 'substream' });
    const save = (payload: object) =>
      t.app.inject({ method: 'POST', url: '/api/cameras/save', payload });
    const first = (await save({ name: 'Office cam', url: MAIN, scene: null, ...body })).json<{
      camera: CameraView;
    }>().camera;
    return { t, save, first };
  }

  it('is saved with the stream’s login and shown with its password hidden', async () => {
    const { first } = await saved({ substream: 'rtsp://192.168.30.66/ch1' });
    expect(first.substream).toBe('rtsp://thingino:***@192.168.30.66/ch1');
  });

  it('is kept when an edit leaves it out, and cleared when it is empty', async () => {
    const { save, first } = await saved({ substream: 'rtsp://192.168.30.66/ch1' });
    const kept = await save({ id: first.id, name: 'Desk cam', scene: null });
    expect(kept.json<{ camera: CameraView }>().camera.substream).toBe(first.substream);
    const cleared = await save({ id: first.id, name: 'Desk cam', scene: null, substream: '' });
    expect(cleared.json<{ camera: CameraView }>().camera.substream).toBeNull();
  });

  it('is relayed on a path of its own, so the camera keeps one client for it too', async () => {
    const dir = tempDir('relay-substream');
    // `true` exits at once: the relay writes its file and is then not running.
    const relay = new CameraRelay(dir, Bun.which('true')!, 47733);
    await relay.sync([
      {
        id: 'aa11',
        name: 'Office cam',
        url: MAIN,
        substream: 'rtsp://thingino:secret@192.168.30.66/ch1',
        scene: null,
        crop: null,
        createdAt: '2026-11-04T00:00:00.000Z',
      },
    ]);
    const text = readFileSync(join(dir, 'relay', 'mediamtx.yml'), 'utf8');
    expect(text).toContain(
      ['  cam-aa11-sub:', '    source: "rtsp://thingino:secret@192.168.30.66/ch1"'].join('\n'),
    );
  });
});

const hasFfmpeg = Bun.which('ffmpeg') !== null;
describe.skipIf(!hasFfmpeg)('reading a camera with a substream', () => {
  /** A 2 s test clip at this size, a keyframe every second. */
  function clip(dir: string, name: string, size: string) {
    const path = join(dir, name);
    const made = Bun.spawnSync([
      'ffmpeg',
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${size}:rate=10`,
      '-t',
      '2',
      '-g',
      '10',
      '-pix_fmt',
      'yuv420p',
      path,
    ]);
    expect(made.exitCode).toBe(0);
    return path;
  }

  it('follows on the substream and keeps the main stream’s keyframes as stills', async () => {
    const dir = tempDir('substream');
    const main = clip(dir, 'main.mp4', '1280x720');
    const small = clip(dir, 'small.mp4', '384x216');
    const source = new FfmpegSource(main, 'ffmpeg', null, small);
    const frames: LumaFrame[] = [];
    await source.start(
      (f) => frames.push(f),
      () => {},
    );
    // A keyframe of the main stream, kept while the grey frames come from the small one.
    const kept = (source as unknown as { stillPath: string }).stillPath;
    for (let i = 0; i < 50 && !existsSync(kept); i++) await Bun.sleep(50);
    expect(existsSync(kept)).toBe(true);
    const shot = await source.snapshot({ since: Date.now() });
    expect(shot).toMatchObject({ width: 1280, height: 720 });
    expect(frames[0]).toMatchObject({ width: LUMA_WIDTH, height: 180 });
    source.stop();
  }, 15_000);
});
