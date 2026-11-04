import { describe, expect, it } from 'bun:test';
import type { WatchView } from '@livinglayer/domain';
import { watchersOf } from '../apps/server/src/app.js';
import type { Fetcher } from '../apps/server/src/config.js';
import type { FrameSource } from '../apps/server/src/frames.js';
import { CameraRelay, type Relay } from '../apps/server/src/relay.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, testApp } from './lib/app.js';

const GPU = { GPU_TRACKER_URL: 'http://gpu.test:43450', GPU_TRACKER_TOKEN: 'secret' };
const CAMERA_URL = 'rtsp://admin:pw@192.168.1.20:554/stream1';

/** The GPU node as the server calls it: each request recorded; its results stream stays open. */
function gpuNode() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({
      method: init?.method ?? 'GET',
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (path === '/tracks') return new Response(new ReadableStream({ start() {} }));
    return Response.json({});
  };
  return { calls, fetcher };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  return check();
}
/** A camera relay on this machine's loopback only, which the GPU node can't reach. */
const loopbackRelay: Relay = {
  sync: async () => {},
  whepFor: () => null,
  rtspFor: (camera) => `rtsp://127.0.0.1:43434/cam-${camera.id}`,
  stop() {},
};
/** The same relay also served on the network to the GPU node. */
const RELAYED = (id: string) => `rtsp://gpu:secret@192.168.1.50:43434/cam-${id}`;
const networkRelay: Relay = { ...loopbackRelay, remoteRtspFor: (camera) => RELAYED(camera.id) };
async function setup(env: Record<string, string> = {}, fetcher?: Fetcher, relay?: Relay) {
  const t = await testApp({
    name: 'tracker-backend',
    env,
    ...(fetcher ? { fetcher } : {}),
    ...(relay ? { relay } : {}),
    appearance: async () => null,
    browseCameras: async () => [],
    frames: (): FrameSource => ({
      start: async () => {},
      stop() {},
      snapshot: async () => ({ png: Buffer.alloc(0), width: 0, height: 0 }),
    }),
  });
  const backend = (backend: string) =>
    t.app.inject({ method: 'POST', url: '/api/watch/backend', payload: { backend } });
  const live = async () => (await t.get('watch/live')).json<WatchView>();
  return { ...t, backend, live };
}

describe('the tracker backend', () => {
  it('is this machine, and refuses the GPU node until one is configured', async () => {
    const s = await setup();
    expect(await s.live()).toMatchObject({ backend: 'local', backends: ['local'] });
    const refused = await s.backend('gpu');
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('tracker_backend');
    expect((await s.live()).backend).toBe('local');
  });

  it('switches to the GPU node once configured, and keeps that choice across a restart', async () => {
    const dataDir = tempDir('tracker-backend');
    const s = await setup({ ...GPU, DATA_DIR: dataDir });
    expect((await s.live()).backends).toEqual(['local', 'gpu']);
    const switched = await s.backend('gpu');
    expect(switched.statusCode).toBe(200);
    expect(switched.json<WatchView>().backend).toBe('gpu');
    await s.app.close();
    const again = await setup({ ...GPU, DATA_DIR: dataDir });
    expect((await again.live()).backend).toBe('gpu');
  });

  /** Watching a saved camera, with the GPU node as the backend: what the node was asked to read. */
  async function watchedOnGpu(relay: Relay) {
    const node = gpuNode();
    const s = await setup(GPU, node.fetcher, relay);
    const saved = await s.app.inject({
      method: 'POST',
      url: '/api/cameras/save',
      payload: { name: 'Office cam', url: CAMERA_URL, scene: null },
    });
    const camera = saved.json<{ camera: { id: string } }>().camera.id;
    await s.app.inject({
      method: 'POST',
      url: '/api/watch',
      payload: { mode: 'live', on: true, streamId: `cam:${camera}` },
    });
    await watchersOf(s.app).live.idle();
    expect(node.calls).toEqual([]);
    await s.backend('gpu');
    expect(await until(() => node.calls.some((c) => c.path === '/tracks'))).toBe(true);
    return { s, node, camera, session: node.calls[0] };
  }

  it('has the GPU node read the camera through this machine’s relay, so the camera keeps one client', async () => {
    const { camera, session } = await watchedOnGpu(networkRelay);
    expect(session).toMatchObject({
      method: 'PUT',
      path: '/session',
      body: { source: RELAYED(camera), things: [] },
    });
  });

  it('has the GPU node read the camera itself when the relay is on this machine’s loopback only', async () => {
    const { session } = await watchedOnGpu(loopbackRelay);
    expect(session).toMatchObject({ body: { source: CAMERA_URL } });
  });

  it('opens the watched camera on the GPU node when switched to it, and closes it when switched back', async () => {
    const { s, node } = await watchedOnGpu(networkRelay);
    expect((await s.live()).gpu?.state).toBe('connecting');

    await s.backend('local');
    expect(await until(() => node.calls.some((c) => c.method === 'DELETE'))).toBe(true);
    expect((await s.live()).gpu).toBeUndefined();
  });
});

describe('the camera relay with the GPU tracker as a reader', () => {
  it('serves its RTSP on the network to that reader alone, with its password, from its address', async () => {
    const dir = tempDir('relay-reader');
    // `true` exits at once: the relay writes its file and is then not running.
    const relay = new CameraRelay(dir, Bun.which('true')!, 47733, undefined, {
      host: '192.168.1.50',
      pass: 'secret',
      ips: ['192.168.1.51'],
    });
    const camera = {
      id: 'aa11',
      name: 'Office cam',
      url: CAMERA_URL,
      scene: null,
      crop: null,
      createdAt: '2026-11-04T00:00:00.000Z',
    };
    await relay.sync([camera]);
    const text = readFileSync(join(dir, 'relay', 'mediamtx.yml'), 'utf8');
    expect(text).toContain('rtspAddress: :47734');
    expect(text).toContain(
      ['  - user: gpu', '    pass: "secret"', '    ips: ["192.168.1.51"]'].join('\n'),
    );
    // Others on the network still read nothing: the open user is loopback only.
    expect(text).toContain(['  - user: any', '    ips: ["127.0.0.1", "::1"]'].join('\n'));
    expect(relay.remoteRtspFor(camera)).toBeNull();
  });
});
