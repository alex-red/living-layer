import { createSocket, type RemoteInfo } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { CameraScene } from '@livinglayer/domain';
import type { Config } from './config.js';

/** What `scripts/share-camera.sh` advertises. */
export const CAMERA_SERVICE = '_livinglayer-cam._tcp.local';

export interface NetworkStream {
  id: string;
  name: string;
  host: string;
  /** WebRTC-HTTP egress endpoint: POST an SDP offer, get the answer back. Empty when a tab can't play it. */
  whep: string;
  /** A URL the server reads with ffmpeg; a saved camera's is shown with its password hidden. */
  rtsp?: string;
  /** The room a saved camera is assigned to. */
  scene?: CameraScene;
  /** Where a tab gets a still from a camera only the server can read. */
  snapshot?: string;
  /** Where a tab gets a live MJPEG picture of a camera only the server can read. */
  preview?: string;
  source: 'mdns' | 'config' | 'phone' | 'saved';
}

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;

export type DnsRecord =
  | { name: string; type: typeof TYPE.PTR; target: string }
  | { name: string; type: typeof TYPE.SRV; port: number; target: string }
  | { name: string; type: typeof TYPE.TXT; text: Record<string, string> }
  | { name: string; type: typeof TYPE.A; address: string };

function encodeName(name: string) {
  const labels = name.replace(/\.$/, '').split('.');
  return Buffer.concat([
    ...labels.map((l) => {
      const bytes = Buffer.from(l, 'utf8');
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    }),
    Buffer.from([0]),
  ]);
}

/** One DNS query packet. */
export function encodeQuery(questions: [name: string, type: number][]) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(questions.length, 4);
  return Buffer.concat([
    header,
    ...questions.map(([name, type]) => {
      const tail = Buffer.alloc(4);
      tail.writeUInt16BE(type, 0);
      tail.writeUInt16BE(1, 2);
      return Buffer.concat([encodeName(name), tail]);
    }),
  ]);
}

function readName(buf: Buffer, start: number): [string, number] {
  const labels: string[] = [];
  let offset = start;
  let next = -1;
  for (let jumps = 0; jumps < 64; jumps++) {
    const len = buf.readUInt8(offset);
    if (len === 0) return [labels.join('.'), next < 0 ? offset + 1 : next];
    if ((len & 0xc0) === 0xc0) {
      if (next < 0) next = offset + 2;
      offset = buf.readUInt16BE(offset) & 0x3fff;
      continue;
    }
    labels.push(buf.toString('utf8', offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  throw new Error('DNS name has too many labels or a compression loop.');
}

/** The PTR, SRV, TXT and A records in one DNS response; anything else is skipped. Throws on a malformed packet. */
export function decodeRecords(buf: Buffer): DnsRecord[] {
  if (buf.length < 12 || !(buf.readUInt16BE(2) & 0x8000)) return [];
  let offset = 12;
  for (let q = buf.readUInt16BE(4); q > 0; q--) offset = readName(buf, offset)[1] + 4;
  const count = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  const records: DnsRecord[] = [];
  for (let i = 0; i < count; i++) {
    const [name, at] = readName(buf, offset);
    const type = buf.readUInt16BE(at);
    const length = buf.readUInt16BE(at + 8);
    const data = at + 10;
    if (data + length > buf.length) throw new Error('DNS record runs past the packet.');
    offset = data + length;
    if (type === TYPE.PTR) records.push({ name, type, target: readName(buf, data)[0] });
    else if (type === TYPE.SRV)
      records.push({
        name,
        type,
        port: buf.readUInt16BE(data + 4),
        target: readName(buf, data + 6)[0],
      });
    else if (type === TYPE.A && length === 4)
      records.push({ name, type, address: [...buf.subarray(data, data + 4)].join('.') });
    else if (type === TYPE.TXT) {
      const text: Record<string, string> = {};
      for (let p = data; p < data + length;) {
        const entry = buf.toString('utf8', p + 1, p + 1 + buf.readUInt8(p));
        p += 1 + buf.readUInt8(p);
        const eq = entry.indexOf('=');
        if (eq > 0) text[entry.slice(0, eq).toLowerCase()] = entry.slice(eq + 1);
      }
      records.push({ name, type, text });
    }
  }
  return records;
}

/** Turns what the browse heard into streams. `from` is the responder's address per instance, used when no A record arrived. */
export function assemble(records: DnsRecord[], from: Map<string, string> = new Map()) {
  const lower = (s: string) => s.toLowerCase();
  const pick = <T extends DnsRecord['type']>(type: T, name: string) =>
    records.find(
      (r): r is Extract<DnsRecord, { type: T }> => r.type === type && lower(r.name) === lower(name),
    );
  const instances = new Set(
    records
      .filter((r) => r.type === TYPE.PTR && lower(r.name) === CAMERA_SERVICE)
      .map((r) => (r as { target: string }).target),
  );
  const streams: NetworkStream[] = [];
  for (const instance of instances) {
    const srv = pick(TYPE.SRV, instance);
    const host = (srv && pick(TYPE.A, srv.target)?.address) ?? from.get(lower(instance));
    if (!srv || !host) continue;
    const text = pick(TYPE.TXT, instance)?.text ?? {};
    const path = /^[\w-]+$/.test(text.path ?? '') ? text.path! : 'cam';
    const rtsp = Number(text.rtsp);
    streams.push({
      id: instance,
      name: (text.name || instance.slice(0, -CAMERA_SERVICE.length - 1)).slice(0, 80),
      host,
      whep: `http://${host}:${srv.port}/${path}/whep`,
      ...(Number.isInteger(rtsp) && rtsp > 0 && rtsp < 65536
        ? { rtsp: `rtsp://${host}:${rtsp}/${path}` }
        : {}),
      source: 'mdns',
    });
  }
  return streams.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Asks the LAN for shared cameras over mDNS and collects answers for `timeoutMs`.
 * Asks again for SRV/TXT/A when a responder leaves them out. Never throws: no
 * network means no streams.
 */
export function browseCameras(timeoutMs = 1200): Promise<NetworkStream[]> {
  return new Promise((resolve) => {
    const records: DnsRecord[] = [];
    const from = new Map<string, string>();
    const asked = new Set<string>();
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const interfaces = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i?.family === 'IPv4')
      .map((i) => i!.address);
    let closed = false;
    // One interface at a time: `send` is async, so switching the interface
    // between queued sends would put them all out on the last one.
    const send = async (questions: [string, number][]) => {
      const packet = encodeQuery(questions);
      for (const address of interfaces) {
        if (closed) return;
        await new Promise<void>((done) => {
          try {
            socket.setMulticastInterface(address);
            socket.send(packet, 5353, '224.0.0.251', () => done());
          } catch {
            done(); // An interface that can't multicast is skipped.
          }
        });
      }
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(assemble(records, from));
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on('error', finish);
    socket.on('message', (message: Buffer, remote: RemoteInfo) => {
      let heard: DnsRecord[];
      try {
        heard = decodeRecords(message);
      } catch {
        return;
      }
      records.push(...heard);
      const follow: [string, number][] = [];
      for (const r of heard) {
        if (r.type !== TYPE.PTR || r.name.toLowerCase() !== CAMERA_SERVICE) continue;
        from.set(r.target.toLowerCase(), remote.address);
        if (
          !records.some((s) => s.type === TYPE.SRV && s.name === r.target) &&
          !asked.has(r.target)
        ) {
          asked.add(r.target);
          follow.push([r.target, TYPE.SRV], [r.target, TYPE.TXT]);
        }
      }
      if (follow.length) void send(follow);
    });
    // Shares 5353 with the system responder (address reuse), so replies sent to
    // the group, including ones from this machine, reach this socket too.
    socket.bind(5353, () => {
      for (const address of interfaces) {
        try {
          socket.addMembership('224.0.0.251', address);
        } catch {
          // Already joined through another address, or no multicast here.
        }
      }
      void send([[CAMERA_SERVICE, TYPE.PTR]]);
    });
  });
}

/**
 * Every camera the lab knows of: paired phones and saved cameras, cameras
 * found over mDNS, and configured ones. A configured `rtsp://` URL is a camera only the server can
 * read: the watcher can use it, a tab can't play it.
 */
export async function listStreams(
  config: Config,
  browse: () => Promise<NetworkStream[]> = browseCameras,
  known: () => NetworkStream[] = () => [],
): Promise<NetworkStream[]> {
  const found = await browse();
  const configured: NetworkStream[] = config.cameraStreams.map((url) => {
    const parsed = new URL(url);
    const rtsp = parsed.protocol === 'rtsp:';
    return {
      id: url,
      name: parsed.host,
      host: parsed.hostname,
      whep: rtsp ? '' : url,
      ...(rtsp ? { rtsp: url } : {}),
      source: 'config',
    };
  });
  const seen = new Set(found.flatMap((s) => [s.whep, s.rtsp]));
  return [...known(), ...found, ...configured.filter((s) => !seen.has(s.whep || s.rtsp))];
}

export function streamRoutes(
  app: FastifyInstance,
  config: Config,
  browse: () => Promise<NetworkStream[]> = browseCameras,
  /** Cameras the lab already knows of, like a paired phone or a saved camera. */
  known: () => NetworkStream[] = () => [],
) {
  app.get('/api/streams', async () => ({ streams: await listStreams(config, browse, known) }));
}
