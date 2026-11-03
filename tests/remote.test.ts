import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig } from '../apps/server/src/config.js';
import { RemoteCamera, phoneApp, phoneName } from '../apps/server/src/remote.js';
import type { NetworkStream } from '../apps/server/src/streams.js';
import { STREAM_STATS_FILE } from '../apps/server/src/store.js';

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const phone = { name: 'iPhone', address: '192.168.1.30' };
const OFFER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n';
const STATS = {
  codec: 'video/H264',
  encoder: 'VideoToolbox',
  powerEfficient: true,
  width: 1280,
  height: 720,
  fps: 30,
  kbps: 4100,
  targetKbps: 5000,
  limitedBy: 'none',
  limitedS: { none: 60, bandwidth: 2 },
  rttMs: 4,
  capture: { width: 1280, height: 720, fps: 30 },
  held: false,
};

describe('remote phone camera', () => {
  it('relays the lab offer to a waiting phone and the answer back', async () => {
    const remote = new RemoteCamera();
    const token = remote.pair();
    expect(remote.streams()).toEqual([]);
    const polled = remote.next(token, phone, 1000);
    expect(remote.phoneState()).toBe('ready');
    expect(remote.streams()[0]).toMatchObject({
      name: 'iPhone camera',
      host: '192.168.1.30',
      whep: `/api/remote/${token}/whep`,
      source: 'phone',
    });
    const answered = remote.connect(token, OFFER);
    const event = await polled;
    expect(event).toMatchObject({ type: 'offer', sdp: OFFER });
    remote.answer(token, (event as { id: string }).id, 'v=0 answer');
    expect(await answered).toBe('v=0 answer');
  });

  it('queues an offer that arrives between polls, and sends hangups', async () => {
    const remote = new RemoteCamera();
    const token = remote.pair();
    await remote.next(token, phone, 1);
    const answered = remote.connect(token, OFFER);
    const event = await remote.next(token, phone, 1000);
    expect(event?.type).toBe('offer');
    remote.answer(token, (event as { id: string }).id, 'v=0 a');
    await answered;
    remote.hangup(token);
    expect(await remote.next(token, phone, 1000)).toEqual({ type: 'hangup' });
  });

  it('refuses an offer before the phone is there, and old or unknown tokens', async () => {
    const remote = new RemoteCamera();
    const old = remote.pair();
    const token = remote.pair();
    await expect(remote.connect(token, OFFER)).rejects.toMatchObject({ code: 'remote_absent' });
    expect(() => remote.next(old, phone)).toThrow('pairing has ended');
    expect(() => remote.answer(token, 'nope', 'v=0')).toThrow('Stopped waiting');
  });

  it('retires a code nobody scanned, and a phone that went away', async () => {
    let now = 0;
    const remote = new RemoteCamera(() => now);
    remote.pair();
    now = 15 * 60_000 + 1;
    expect(remote.current()).toBeNull();
    const token = remote.pair();
    await remote.next(token, phone, 1);
    now += 30_000;
    expect(remote.phoneState()).toBe('ready');
    now += 10_000;
    expect(remote.current()).toBeNull();
  });

  it('names phones by kind only', () => {
    expect(phoneName('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)')).toBe('iPhone');
    expect(phoneName('Mozilla/5.0 (Linux; Android 16; Pixel 10)')).toBe('Android phone');
    expect(phoneName(undefined)).toBe('Phone');
  });

  it('carries the SDPs between the lab API and the phone page', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-remote-'));
    dirs.push(dataDir);
    const remote = new RemoteCamera();
    const lab = await buildApp(parseConfig({ DATA_DIR: dataDir }), { serveWeb: false, remote });
    const phones = phoneApp(remote);
    try {
      expect((await lab.inject({ url: '/api/remote' })).json()).toEqual({ pairing: null });
      const token = remote.pair();

      const page = await phones.inject({ url: `/r/${token}` });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-security-policy']).toContain("default-src 'none'");
      expect(page.body).toContain('Opening the camera');
      const gone = await phones.inject({ url: `/r/${'x'.repeat(32)}` });
      expect(gone.body).toContain('This pairing has ended');

      const polled = phones.inject({
        url: `/r/${token}/next`,
        headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 16)' },
      });
      // Let the poll register before the lab offers.
      await new Promise((r) => setTimeout(r, 20));
      const streams = (await lab.inject({ url: '/api/streams' })).json<{
        streams: NetworkStream[];
      }>().streams;
      expect(streams.find((s) => s.source === 'phone')?.name).toBe('Android phone camera');

      const offered = lab.inject({
        method: 'POST',
        url: `/api/remote/${token}/whep`,
        headers: { 'content-type': 'application/sdp' },
        payload: OFFER,
      });
      const event = (await polled).json<{ type: string; id: string; sdp: string }>();
      expect(event).toMatchObject({ type: 'offer', sdp: OFFER });
      const sent = await phones.inject({
        method: 'POST',
        url: `/r/${token}/answer`,
        payload: { id: event.id, sdp: 'v=0 answer' },
      });
      expect(sent.statusCode).toBe(204);
      const answer = await offered;
      expect(answer.statusCode).toBe(201);
      expect(answer.headers['content-type']).toContain('application/sdp');
      expect(answer.headers.location).toBe(`/api/remote/${token}/whep`);
      expect(answer.body).toBe('v=0 answer');

      const ended = await lab.inject({ method: 'DELETE', url: `/api/remote/${token}/whep` });
      expect(ended.statusCode).toBe(204);
      expect((await phones.inject({ url: `/r/${token}/next` })).json()).toEqual({
        type: 'hangup',
      });
      expect((await lab.inject({ method: 'DELETE', url: '/api/remote' })).statusCode).toBe(200);
      expect((await phones.inject({ url: `/r/${token}/next` })).statusCode).toBe(404);
    } finally {
      await lab.close();
      await phones.close();
    }
  });

  it('tells listeners when the pairing, the phone or its report changes', async () => {
    const remote = new RemoteCamera(() => 1_000);
    let changes = 0;
    remote.subscribe(() => changes++);
    const token = remote.pair();
    expect(changes).toBe(1);
    await remote.next(token, phone, 1);
    expect(changes).toBe(2);
    // Polling again while it's there is no news.
    await remote.next(token, phone, 1);
    expect(changes).toBe(2);
    remote.noteStats(token, STATS);
    expect(changes).toBe(3);
    remote.end();
    expect(changes).toBe(4);
  });

  it('logs what the tab played and what the phone sent', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-remote-'));
    dirs.push(dataDir);
    const remote = new RemoteCamera();
    const lab = await buildApp(parseConfig({ DATA_DIR: dataDir }), { serveWeb: false, remote });
    const phones = phoneApp(remote);
    try {
      const token = remote.pair();
      await remote.next(token, phone, 1);
      for (const fps of [30, 29]) {
        const sent = await phones.inject({
          method: 'POST',
          url: `/r/${token}/stats`,
          payload: { ...STATS, fps },
        });
        expect(sent.statusCode).toBe(204);
      }
      const bad = await phones.inject({
        method: 'POST',
        url: `/r/${token}/stats`,
        payload: { ...STATS, sdp: 'v=0' },
      });
      expect(bad.statusCode).toBe(400);
      // The lab sees the latest report; the log keeps one in three.
      expect((await lab.inject({ url: '/api/remote' })).json().pairing.sending.fps).toBe(29);

      const played = await lab.inject({
        method: 'POST',
        url: '/api/streams/stats',
        payload: {
          stream: '/api/remote/…/whep',
          outcome: 'closed',
          connectMs: 120,
          firstFrameMs: 180,
          durationMs: 60_000,
          frames: 1790,
          fps: 29.8,
          kbps: 4200,
          jitterMs: 12.5,
          freezes: 0,
          freezeMs: 0,
          decodeMs: 1.2,
          width: 1280,
          height: 720,
          codec: 'video/H264',
          decoder: 'VideoToolbox',
        },
      });
      expect(played.statusCode).toBe(204);
      const log = readFileSync(join(dataDir, STREAM_STATS_FILE), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(log.map((r) => [r.source, r.fps])).toEqual([
        ['phone', 30],
        ['tab', 29.8],
      ]);
      expect(log[0].phone).toBe('iPhone');
    } finally {
      await lab.close();
      await phones.close();
    }
  });

  it('checks the remote camera settings', () => {
    expect(() => parseConfig({ REMOTE_CAMERA_CERT: 'cert.pem' })).toThrow();
    expect(() => parseConfig({ REMOTE_CAMERA_HOST: 'http://x' })).toThrow();
    expect(() => parseConfig({ PORT: '43432' })).toThrow();
    expect(parseConfig({ REMOTE_CAMERA_HOST: 'lab.local' }, '/p').remoteCamera).toEqual({
      port: 43432,
      host: 'lab.local',
      cert: '',
      key: '',
    });
  });
});
