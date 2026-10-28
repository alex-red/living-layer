import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig } from '../apps/server/src/config.js';
import {
  CAMERA_SERVICE,
  assemble,
  decodeRecords,
  encodeQuery,
  type NetworkStream,
} from '../apps/server/src/streams.js';

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const name = (n: string) =>
  Buffer.concat([
    ...n.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
    Buffer.from([0]),
  ]);
const u16 = (...values: number[]) => {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeUInt16BE(v, i * 2));
  return b;
};
const record = (owner: Buffer, type: number, data: Buffer) =>
  Buffer.concat([owner, u16(type, 1), Buffer.from([0, 0, 0, 120]), u16(data.length), data]);
const txt = (...entries: string[]) =>
  Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from([e.length]), Buffer.from(e)])));

/** A response like dns-sd's: the PTR answer names the service with a compression pointer back into the question. */
function response() {
  const question = Buffer.concat([name(CAMERA_SERVICE), u16(12, 1)]);
  const servicePtr = Buffer.from([0xc0, 12]);
  const instance = Buffer.concat([Buffer.from([8]), Buffer.from('Desk cam'), servicePtr]);
  const answers = [
    record(servicePtr, 12, instance),
    record(instance, 33, Buffer.concat([u16(0, 0, 8889), name('pi.local')])),
    record(instance, 16, txt('path=cam', 'rtsp=8554', 'name=Desk cam')),
    record(name('pi.local'), 1, Buffer.from([192, 168, 1, 20])),
  ];
  return Buffer.concat([u16(0, 0x8400, 1, 1, 0, 3), question, ...answers]);
}

describe('network camera discovery', () => {
  it('encodes a PTR query for the camera service', () => {
    const q = encodeQuery([[CAMERA_SERVICE, 12]]);
    expect(q.readUInt16BE(4)).toBe(1);
    expect(q.subarray(12).toString('latin1')).toContain('_livinglayer-cam');
    expect(q.readUInt16BE(q.length - 4)).toBe(12);
  });

  it('decodes compressed PTR, SRV, TXT and A records into a WHEP stream', () => {
    const records = decodeRecords(response());
    expect(records.map((r) => r.type)).toEqual([12, 33, 16, 1]);
    expect(assemble(records)).toEqual([
      {
        id: `Desk cam.${CAMERA_SERVICE}`,
        name: 'Desk cam',
        host: '192.168.1.20',
        whep: 'http://192.168.1.20:8889/cam/whep',
        rtsp: 'rtsp://192.168.1.20:8554/cam',
        source: 'mdns',
      },
    ]);
  });

  it('falls back to the responder address and ignores queries and bad packets', () => {
    const records = decodeRecords(response()).filter((r) => r.type !== 1);
    const from = new Map([[`desk cam.${CAMERA_SERVICE}`, '10.0.0.7']]);
    expect(assemble(records, from)[0]?.whep).toBe('http://10.0.0.7:8889/cam/whep');
    expect(decodeRecords(encodeQuery([[CAMERA_SERVICE, 12]]))).toEqual([]);
    const loop = Buffer.concat([u16(0, 0x8400, 0, 1, 0, 0), Buffer.from([0xc0, 12])]);
    expect(() => decodeRecords(loop)).toThrow();
  });

  it('lists discovered and configured streams without duplicates', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-streams-'));
    dirs.push(dataDir);
    const found: NetworkStream = {
      id: 'a',
      name: 'Desk cam',
      host: '192.168.1.20',
      whep: 'http://192.168.1.20:8889/cam/whep',
      source: 'mdns',
    };
    const config = parseConfig({
      DATA_DIR: dataDir,
      CAMERA_STREAMS: `${found.whep}, http://10.0.0.9:8889/cam/whep`,
    });
    const app = await buildApp(config, { serveWeb: false, browseCameras: async () => [found] });
    const body = (await app.inject({ url: '/api/streams' })).json<{ streams: NetworkStream[] }>();
    expect(body.streams.map((s) => [s.source, s.whep])).toEqual([
      ['mdns', found.whep],
      ['config', 'http://10.0.0.9:8889/cam/whep'],
    ]);
    await app.close();
    expect(() => parseConfig({ CAMERA_STREAMS: 'rtsp://cam/whep' })).toThrow();
  });
});
