import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  cameraForScene,
  cameraUrlProblem,
  redactCameraUrl,
  type CameraCrop,
  type CameraView,
  type DeskMemory,
  type SavedCamera,
  type WatchCamera,
} from '@livinglayer/domain';
import { buildApp, watchersOf } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import type { FrameSource } from '../apps/server/src/frames.js';
import { CameraRelay, type Relay } from '../apps/server/src/relay.js';
import { RemoteCamera } from '../apps/server/src/remote.js';
import type { NetworkStream } from '../apps/server/src/streams.js';

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const URL_WITH_PASSWORD = 'rtsp://admin:hunter2@192.168.1.20:554/stream1';

async function setup(
  snapshot?: (url: string, crop: CameraCrop | null) => Promise<Buffer>,
  preview?: (
    url: string,
    crop: CameraCrop | null,
  ) => { stream: ReadableStream<Uint8Array>; stop: () => void },
  {
    dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-cameras-')),
    remote,
    relay,
  }: { dataDir?: string; remote?: RemoteCamera; relay?: Relay } = {},
) {
  dirs.push(dataDir);
  const opened: (WatchCamera | null)[] = [];
  const app = await buildApp(parseConfig({ DATA_DIR: dataDir }), {
    fetcher: mock<Fetcher>(),
    serveWeb: false,
    appearance: async () => null,
    browseCameras: async () => [],
    ...(remote ? { remote } : {}),
    ...(relay ? { relay } : {}),
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
          snapshots: (url: string, crop: CameraCrop | null) => ({
            snapshot: async () => ({ png: await snapshot(url, crop), width: 4, height: 4 }),
          }),
        }
      : {}),
    ...(preview ? { previews: preview } : {}),
  });
  const post = (path: string, payload: object) =>
    app.inject({ method: 'POST', url: `/api/${path}`, payload });
  const add = async (body: object) =>
    (await post('cameras/save', body)).json<{ camera: CameraView }>().camera;
  return { app, post, add, opened, dataDir };
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
      crop: null,
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

describe('a camera’s zoomed view', () => {
  const crop = { x: 0.25, y: 0.1, w: 0.5, h: 0.6 };
  const streamOf = async (s: Awaited<ReturnType<typeof setup>>, id: string) =>
    (await s.app.inject('/api/streams'))
      .json<{ streams: NetworkStream[] }>()
      .streams.find((x) => x.id === id);

  it('cuts every still and preview of a saved camera, and outlasts an edit and a restart', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#888' } })
      .png()
      .toBuffer();
    const stills: (CameraCrop | null)[] = [];
    const previews: (CameraCrop | null)[] = [];
    const preview = (_url: string, c: CameraCrop | null) => {
      previews.push(c);
      return { stream: new Response('--ffmpeg\r\n').body!, stop() {} };
    };
    const s = await setup(async (_url, c) => (stills.push(c), png), preview);
    const camera = await s.add({ name: 'Cam', url: URL_WITH_PASSWORD, scene: 'office' });
    const id = `cam:${camera.id}`;
    const set = await s.post('streams/crop', { streamId: id, crop });
    expect(set.statusCode, set.body).toBe(200);
    expect((await streamOf(s, id))?.crop).toEqual(crop);
    await s.app.inject(`/api/cameras/${camera.id}/snapshot`);
    await s.app.inject(`/api/cameras/${camera.id}/stream`);
    expect(stills).toEqual([crop]);
    expect(previews).toEqual([crop]);
    // Renaming it keeps its view; so does the server starting again.
    expect((await s.add({ id: camera.id, name: 'Office cam', scene: 'office' })).crop).toEqual(
      crop,
    );
    await s.app.close();
    const again = await setup(async (_url, c) => (stills.push(c), png), preview, {
      dataDir: s.dataDir,
    });
    expect((await streamOf(again, id))?.crop).toEqual(crop);
    await again.app.inject(`/api/cameras/${camera.id}/snapshot`);
    expect(stills.at(-1)).toEqual(crop);
    // Back to the whole frame.
    expect((await again.post('streams/crop', { streamId: id, crop: null })).statusCode).toBe(200);
    expect((await streamOf(again, id))?.crop).toBeNull();
  });

  it('keeps the phone’s view across pairings and restarts', async () => {
    const remote = new RemoteCamera();
    const s = await setup(undefined, undefined, { remote });
    const first = remote.pair();
    void remote.next(first, { name: 'iPhone', address: '192.168.1.30' }, 50);
    const phoneId = remote.streams()[0]!.id;
    expect((await s.post('streams/crop', { streamId: phoneId, crop })).statusCode).toBe(200);
    // A new QR code is a new stream id, the same phone on the same mount.
    const second = remote.pair();
    void remote.next(second, { name: 'iPhone', address: '192.168.1.30' }, 50);
    expect(remote.streams()[0]).toMatchObject({ source: 'phone', crop });
    expect((await streamOf(s, remote.streams()[0]!.id))?.crop).toEqual(crop);
    remote.end();
    await s.app.close();
    const restarted = new RemoteCamera();
    const again = await setup(undefined, undefined, { dataDir: s.dataDir, remote: restarted });
    expect(restarted.crop).toEqual(crop);
    await again.app.close();
  });

  it('starts watching again on the new view', async () => {
    const s = await setup();
    const camera = await s.add({ name: 'Cam', url: URL_WITH_PASSWORD, scene: 'office' });
    const id = `cam:${camera.id}`;
    expect((await s.post('watch', { mode: 'live', on: true, streamId: id })).statusCode).toBe(200);
    await watchersOf(s.app).live.idle();
    const opened = s.opened.length;
    expect((await s.post('streams/crop', { streamId: id, crop })).statusCode).toBe(200);
    await watchersOf(s.app).live.idle();
    expect(s.opened.length).toBe(opened + 1);
  });

  it('refuses a view outside the frame, too small, or of a camera it can’t keep one for', async () => {
    const s = await setup();
    const camera = await s.add({ name: 'Cam', url: URL_WITH_PASSWORD, scene: null });
    const id = `cam:${camera.id}`;
    for (const bad of [
      { x: 0.6, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 0.05, h: 0.5 },
    ])
      expect((await s.post('streams/crop', { streamId: id, crop: bad })).statusCode).toBe(400);
    const shared = await s.post('streams/crop', { streamId: 'rtsp://cam.local/live', crop });
    expect(shared.statusCode).toBe(400);
    expect(shared.json<{ error: { code: string } }>().error.code).toBe('crop_camera');
    expect((await s.post('streams/crop', { streamId: 'cam:nope', crop })).statusCode).toBe(404);
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

/** A relay that runs while `on`, with its WHEP on `whep`; records what it was asked to relay. */
function fakeRelay(whep = 'http://127.0.0.1:1') {
  const relay = {
    on: true,
    synced: [] as string[][],
    async sync(cameras: SavedCamera[]) {
      relay.synced.push(cameras.map((c) => c.id));
    },
    whepFor: (c: SavedCamera) => (relay.on ? `${whep}/cam-${c.id}/whep` : null),
    rtspFor: (c: SavedCamera) => (relay.on ? `rtsp://127.0.0.1:2/cam-${c.id}` : null),
    stop() {},
  };
  return relay;
}

describe('camera relay', () => {
  it('lists a saved camera with the lab’s WHEP only while the relay runs', async () => {
    const relay = fakeRelay();
    const s = await setup(undefined, undefined, { relay });
    const camera = await s.add({ name: 'Cam', url: URL_WITH_PASSWORD, scene: null });
    expect(relay.synced.at(-1)).toEqual([camera.id]);
    const whepOf = async () =>
      (await s.app.inject('/api/streams'))
        .json<{ streams: NetworkStream[] }>()
        .streams.find((x) => x.id === `cam:${camera.id}`)?.whep;
    expect(await whepOf()).toBe(`/api/cameras/${camera.id}/whep`);
    relay.on = false;
    expect(await whepOf()).toBe('');
    const refused = await s.app.inject({
      method: 'POST',
      url: `/api/cameras/${camera.id}/whep`,
      headers: { 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(refused.statusCode).toBe(409);
  });

  it('forwards a WHEP offer and closes the session through the lab', async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const url = new URL(request.url);
        seen.push(`${request.method} ${url.pathname} ${await request.text()}`);
        return request.method === 'POST'
          ? new Response('v=0 answer', {
              status: 201,
              headers: { 'content-type': 'application/sdp', location: `${url.pathname}/abc-123` },
            })
          : new Response(null, { status: 200 });
      },
    });
    try {
      const s = await setup(undefined, undefined, {
        relay: fakeRelay(`http://127.0.0.1:${server.port}`),
      });
      const camera = await s.add({ name: 'Cam', url: URL_WITH_PASSWORD, scene: null });
      const answer = await s.app.inject({
        method: 'POST',
        url: `/api/cameras/${camera.id}/whep`,
        headers: { 'content-type': 'application/sdp' },
        payload: 'v=0 offer',
      });
      expect(answer.statusCode).toBe(201);
      expect(answer.body).toBe('v=0 answer');
      expect(answer.headers.location).toBe(`/api/cameras/${camera.id}/whep/abc-123`);
      const closed = await s.app.inject({
        method: 'DELETE',
        url: `/api/cameras/${camera.id}/whep/abc-123`,
      });
      expect(closed.statusCode).toBe(200);
      expect(seen).toEqual([
        `POST /cam-${camera.id}/whep v=0 offer`,
        `DELETE /cam-${camera.id}/whep/abc-123 `,
      ]);
    } finally {
      server.stop(true);
    }
  });

  it('reads stills, previews and the watcher through the relay, the camera when it stops', async () => {
    const urls: string[] = [];
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#888' } })
      .png()
      .toBuffer();
    const relay = fakeRelay();
    const s = await setup(
      async (url) => (urls.push(url), png),
      (url) => (urls.push(url), { stream: new Response('--ffmpeg\r\n').body!, stop() {} }),
      { relay },
    );
    const camera = await s.add({ name: 'Cam', url: URL_WITH_PASSWORD, scene: null });
    await s.app.inject(`/api/cameras/${camera.id}/snapshot`);
    await s.app.inject(`/api/cameras/${camera.id}/stream`);
    const relayed = `rtsp://127.0.0.1:2/cam-${camera.id}`;
    expect(urls).toEqual([relayed, relayed]);
    relay.on = false;
    await s.app.inject(`/api/cameras/${camera.id}/snapshot`);
    expect(urls.at(-1)).toBe(URL_WITH_PASSWORD);
  });

  it('writes a loopback-only config that only its owner can read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livinglayer-relay-'));
    dirs.push(dir);
    // `true` exits at once: the relay writes its file and is then not running.
    const relay = new CameraRelay(dir, Bun.which('true')!, 47733);
    const saved = (id: string, url: string): SavedCamera => ({
      id,
      name: id,
      url,
      scene: null,
      crop: null,
      createdAt: '2026-10-31T00:00:00.000Z',
    });
    const rtsp = saved('aa11', URL_WITH_PASSWORD);
    await relay.sync([rtsp, saved('bb22', 'http://192.168.1.5:8080/video.mjpg')]);
    const file = join(dir, 'relay', 'mediamtx.yml');
    const text = readFileSync(file, 'utf8');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(text).toContain(`source: "${URL_WITH_PASSWORD}"`);
    expect(text).not.toContain('bb22');
    for (const line of ['rtspAddress: 127.0.0.1:47734', 'webrtcAddress: 127.0.0.1:47733'])
      expect(text).toContain(line);
    expect(relay.whepFor(rtsp)).toBeNull();
    expect(CameraRelay.find(dir, 'off', 43433)).toBeNull();
    expect(() =>
      parseConfig({ CAMERA_RELAY_PORT: '43430', REMOTE_CAMERA_PORT: '43432' }),
    ).toThrow();
  });
});

describe('watching by default', () => {
  const watchOf = async (s: Awaited<ReturnType<typeof setup>>) => {
    await watchersOf(s.app).live.idle();
    return (await s.app.inject('/api/desk/live')).json<DeskMemory>().watch;
  };

  it('watches the one camera the server can read on a desk that never chose', async () => {
    const s = await setup();
    const camera = await s.add({ name: 'Office cam', url: URL_WITH_PASSWORD, scene: 'office' });
    expect(await watchOf(s)).toMatchObject({ on: true, camera: { id: `cam:${camera.id}` } });
    expect(s.opened.at(-1)?.id).toBe(`cam:${camera.id}`);
  });

  it('keeps watching off once it was turned off, and skips a camera it can’t read', async () => {
    const off = await setup();
    expect((await off.post('watch', { mode: 'live', on: false })).statusCode).toBe(200);
    await off.add({ name: 'Cam', url: URL_WITH_PASSWORD, scene: null });
    expect(await watchOf(off)).toEqual({ on: false, camera: null });

    const web = await setup();
    await web.add({ name: 'Web', url: 'http://192.168.1.5:8080/video.mjpg', scene: null });
    expect(await watchOf(web)).toBeUndefined();
  });
});
