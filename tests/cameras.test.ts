import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  cameraForScene,
  cameraUrlProblem,
  redactCameraUrl,
  type CameraView,
  type DeskMemory,
  type WatchCamera,
} from '@livinglayer/domain';
import { buildApp, watchersOf } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import type { FrameSource } from '../apps/server/src/frames.js';
import type { NetworkStream } from '../apps/server/src/streams.js';

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const URL_WITH_PASSWORD = 'rtsp://admin:hunter2@192.168.1.20:554/stream1';

async function setup(
  snapshot?: (url: string) => Promise<Buffer>,
  preview?: (url: string) => { stream: ReadableStream<Uint8Array>; stop: () => void },
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-cameras-'));
  dirs.push(dataDir);
  const opened: (WatchCamera | null)[] = [];
  const app = await buildApp(parseConfig({ DATA_DIR: dataDir }), {
    fetcher: mock<Fetcher>(),
    serveWeb: false,
    appearance: async () => null,
    browseCameras: async () => [],
    frames: (camera): FrameSource => {
      opened.push(camera);
      return {
        start: async () => {},
        stop() {},
        snapshot: async () => ({ png: Buffer.alloc(0), width: 0, height: 0 }),
      };
    },
    ...(snapshot
      ? {
          snapshots: (url: string) => ({
            snapshot: async () => ({ png: await snapshot(url), width: 4, height: 4 }),
          }),
        }
      : {}),
    ...(preview ? { previews: preview } : {}),
  });
  const post = (path: string, payload: object) =>
    app.inject({ method: 'POST', url: `/api/${path}`, payload });
  const add = async (body: object) =>
    (await post('cameras/save', body)).json<{ camera: CameraView }>().camera;
  return { app, post, add, opened };
}

describe('stream camera URLs', () => {
  it('takes RTSP, RTSPS and HTTP streams and nothing ffmpeg would read off the disk', () => {
    expect(cameraUrlProblem('rtsp://cam.local/live')).toBeNull();
    expect(cameraUrlProblem('rtsps://cam.local:322/live')).toBeNull();
    expect(cameraUrlProblem('http://192.168.1.5:8080/video.mjpg')).toBeNull();
    for (const bad of [
      'file:///etc/passwd',
      'concat:a|b',
      '-i rtsp://x',
      'rtsp://',
      'rtsp://cam/a#b',
    ])
      expect(cameraUrlProblem(bad)).not.toBeNull();
  });
  it('hides a password but keeps the user name', () => {
    expect(redactCameraUrl(URL_WITH_PASSWORD)).toBe('rtsp://admin:***@192.168.1.20:554/stream1');
    expect(redactCameraUrl('rtsp://cam.local/live')).toBe('rtsp://cam.local/live');
  });
  it('picks a room’s camera, then one on the room it is a close view of', () => {
    const office = { id: 'o', scene: 'office' as const };
    const fridge = { id: 'f', scene: 'fridge' as const };
    expect(cameraForScene([fridge, office], 'office')).toBe(office);
    expect(cameraForScene([fridge, office], 'desk')).toBe(office);
    expect(cameraForScene([fridge, { id: 'd', scene: 'desk' as const }], 'office')?.id).toBe('d');
    expect(cameraForScene([fridge, office], 'custom')).toBeNull();
    expect(cameraForScene<{ id: string; scene?: null }>([{ id: 'x' }], 'office')).toBeNull();
  });
});

describe('saved cameras', () => {
  it('keeps the password on the server and lists the camera for watching', async () => {
    const s = await setup();
    const camera = await s.add({ name: 'Office cam', url: URL_WITH_PASSWORD, scene: 'office' });
    expect(camera).toMatchObject({
      name: 'Office cam',
      url: 'rtsp://admin:***@192.168.1.20:554/stream1',
      host: '192.168.1.20:554',
      hasPassword: true,
      scene: 'office',
    });
    const listed = await s.app.inject('/api/cameras');
    const streams = await s.app.inject('/api/streams');
    for (const res of [listed, streams]) expect(res.body).not.toContain('hunter2');
    expect(streams.json<{ streams: NetworkStream[] }>().streams).toContainEqual({
      id: `cam:${camera.id}`,
      name: 'Office cam',
      host: '192.168.1.20:554',
      whep: '',
      rtsp: 'rtsp://admin:***@192.168.1.20:554/stream1',
      scene: 'office',
      snapshot: `/api/cameras/${camera.id}/snapshot`,
      preview: `/api/cameras/${camera.id}/stream`,
      source: 'saved',
    });
  });

  it('changes the name and room without being sent the URL again', async () => {
    const s = await setup();
    const camera = await s.add({ name: 'Cam', url: URL_WITH_PASSWORD, scene: null });
    const changed = await s.add({ id: camera.id, name: 'Fridge cam', scene: 'fridge' });
    expect(changed).toMatchObject({
      id: camera.id,
      name: 'Fridge cam',
      scene: 'fridge',
      hasPassword: true,
    });
    expect(changed.createdAt).toBe(camera.createdAt);
  });

  it('refuses a bad URL, the same stream twice and a camera that is gone', async () => {
    const s = await setup();
    expect(
      (await s.post('cameras/save', { name: 'x', url: 'file:///etc/passwd', scene: null }))
        .statusCode,
    ).toBe(400);
    expect((await s.post('cameras/save', { name: 'x', scene: null })).statusCode).toBe(400);
    await s.add({ name: 'a', url: 'rtsp://cam.local/live', scene: null });
    expect(
      (await s.post('cameras/save', { name: 'b', url: 'rtsp://cam.local/live', scene: null }))
        .statusCode,
    ).toBe(409);
    expect((await s.post('cameras/save', { id: 'nope', name: 'b', scene: null })).statusCode).toBe(
      404,
    );
    expect((await s.post('cameras/delete', { id: 'nope' })).statusCode).toBe(404);
  });

  it('serves a still from the stream, and a clear error when there is none', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#888' } })
      .png()
      .toBuffer();
    const asked: string[] = [];
    const s = await setup(async (url) => {
      asked.push(url);
      if (url.includes('broken')) throw new Error('ffmpeg failed');
      return png;
    });
    const good = await s.add({ name: 'Cam', url: URL_WITH_PASSWORD, scene: null });
    const res = await s.app.inject(`/api/cameras/${good.id}/snapshot`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(asked).toEqual([URL_WITH_PASSWORD]);
    const bad = await s.add({ name: 'Broken', url: 'rtsp://broken.local/x', scene: null });
    const failed = await s.app.inject(`/api/cameras/${bad.id}/snapshot`);
    expect(failed.statusCode).toBe(502);
    expect(failed.json<{ error: { code: string } }>().error.code).toBe('camera_unreachable');
  });

  it('relays a live MJPEG picture from its real URL and stops ffmpeg after', async () => {
    const asked: string[] = [];
    let stopped = 0;
    const s = await setup(undefined, (url) => {
      asked.push(url);
      return {
        stream: new Response('--ffmpeg\r\nContent-Type: image/jpeg\r\n\r\nJPEG\r\n').body!,
        stop: () => void stopped++,
      };
    });
    const camera = await s.add({ name: 'Cam', url: URL_WITH_PASSWORD, scene: null });
    const res = await s.app.inject(`/api/cameras/${camera.id}/stream`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('multipart/x-mixed-replace;boundary=ffmpeg');
    expect(res.body).toContain('JPEG');
    expect(asked).toEqual([URL_WITH_PASSWORD]);
    expect(stopped).toBeGreaterThan(0);
    expect((await s.app.inject('/api/cameras/nope/stream')).statusCode).toBe(404);
  });

  it('is watched by its id, reads its real URL, and stops being watched when removed', async () => {
    const s = await setup();
    const camera = await s.add({ name: 'Office cam', url: URL_WITH_PASSWORD, scene: 'office' });
    const id = `cam:${camera.id}`;
    const on = await s.post('watch', { mode: 'live', on: true, streamId: id });
    expect(on.statusCode).toBe(200);
    await watchersOf(s.app).live.idle();
    const memory = (await s.app.inject('/api/desk/live')).json<DeskMemory>();
    expect(memory.watch).toEqual({
      on: true,
      camera: { id, name: 'Office cam', url: 'rtsp://admin:***@192.168.1.20:554/stream1' },
    });
    expect(s.opened.at(-1)?.id).toBe(id);

    expect((await s.post('cameras/delete', { id: camera.id })).statusCode).toBe(200);
    const after = (await s.app.inject('/api/desk/live')).json<DeskMemory>();
    expect(after.watch).toEqual({ on: false, camera: null });
    expect((await s.app.inject('/api/cameras')).json<{ cameras: CameraView[] }>().cameras).toEqual(
      [],
    );
  });
});

describe('the camera registry', () => {
  it('gives the watcher a saved camera’s real URL, and null once it is removed', async () => {
    const { EvidenceStore } = await import('../apps/server/src/store.js');
    const { CameraRegistry } = await import('../apps/server/src/cameras.js');
    const dir = mkdtempSync(join(tmpdir(), 'livinglayer-registry-'));
    dirs.push(dir);
    const store = new EvidenceStore(dir);
    const cameras = new CameraRegistry(store);
    const saved = cameras.save({ name: 'Cam', url: URL_WITH_PASSWORD, scene: null });
    const watch = cameras.watchCamera(saved.id)!;
    expect(watch.url).not.toContain('hunter2');
    expect(cameras.urlOf(watch)).toBe(URL_WITH_PASSWORD);
    expect(cameras.urlOf({ id: 'rtsp://x/cam', name: 'x', url: 'rtsp://x/cam' })).toBe(
      'rtsp://x/cam',
    );
    cameras.remove(saved.id);
    expect(cameras.urlOf(watch)).toBeNull();
    store.close();
  });
});
