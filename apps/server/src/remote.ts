import {
  phoneStatsSchema,
  remoteAnswerSchema,
  remoteTokenParamsSchema,
  type PhoneStats,
} from '@livinglayer/domain';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import QRCode from 'qrcode';
import type { CameraCrop } from '@livinglayer/domain';
import type { Config } from './config.js';
import { LabError, parseInput } from './errors.js';
import type { NetworkStream } from './streams.js';
import { phonePage } from './remote-page.js';
import { appendStreamStats } from './store.js';

/**
 * A phone as the lab's camera. The lab shows a QR code for a page on the LAN;
 * the phone opens it, shares its camera, and long-polls for offers. The lab
 * plays the phone like any WHEP camera: `openStream` posts a receive-only offer
 * to `/api/remote/<token>/whep`, which is handed to the phone, and the phone's
 * answer comes back as the response. Media goes peer to peer; the server only
 * carries the two SDPs.
 */
type PhoneEvent = { type: 'offer'; id: string; sdp: string } | { type: 'hangup' };

/** A phone's poll is held open this long when nothing is waiting for it. */
const POLL_MS = 25_000;
/** A phone counts as connected while it polled this recently. */
const SEEN_MS = POLL_MS + 10_000;
/** A QR code nobody scanned stops working after this. */
const UNCLAIMED_MS = 15 * 60_000;
/** How long the lab waits for the phone to answer an offer. */
const ANSWER_MS = 7_000;
/** The phone reports every 10 s; one report in three is kept in the log. */
const STATS_LOG_MS = 30_000;

interface Pairing {
  token: string;
  createdAt: number;
  /** 0 until the phone first polls. */
  seenAt: number;
  phone: { name: string; address: string };
  events: PhoneEvent[];
  waiter: ((event: PhoneEvent | null) => void) | null;
  answers: Map<string, (sdp: string) => void>;
  /** The phone's latest report, and when one was last logged. */
  sending: PhoneStats | null;
  loggedAt: number;
}

/** What kind of phone, from its user agent; nothing else of it is kept. */
export function phoneName(userAgent = '') {
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return 'Android phone';
  return 'Phone';
}

/** One pairing at a time: pairing again retires the last QR code. */
export class RemoteCamera {
  private pairing: Pairing | null = null;
  /** The phone's zoomed view, kept across pairings; the lab cuts the phone's frames to it. */
  crop: CameraCrop | null = null;
  /** Where the phone's reports are logged; the lab sets it to its stream log. */
  log: ((record: { source: 'phone' } & Record<string, unknown>) => void) | null = null;

  private listeners = new Set<() => void>();

  constructor(private now = () => Date.now()) {}

  /** Calls `listener` whenever the pairing, the phone's presence or its report changes. */
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private changed() {
    for (const listener of this.listeners) listener();
  }

  pair() {
    this.end();
    this.pairing = {
      token: randomBytes(24).toString('base64url'),
      createdAt: this.now(),
      seenAt: 0,
      phone: { name: 'Phone', address: '' },
      events: [],
      waiter: null,
      answers: new Map(),
      sending: null,
      loggedAt: 0,
    };
    this.changed();
    return this.pairing.token;
  }

  /** The live pairing, dropping it first if its QR code went unused or its phone went away. */
  current() {
    const p = this.pairing;
    if (!p) return null;
    const t = this.now();
    if (p.seenAt ? !p.waiter && t - p.seenAt > SEEN_MS : t - p.createdAt > UNCLAIMED_MS) this.end();
    return this.pairing;
  }

  end() {
    const p = this.pairing;
    this.pairing = null;
    p?.waiter?.(null);
    if (p) this.changed();
  }

  phoneState(): 'waiting' | 'ready' {
    const p = this.current();
    return p?.seenAt && (p.waiter || this.now() - p.seenAt <= SEEN_MS) ? 'ready' : 'waiting';
  }

  /** The phone, as a stream the camera pickers list, once it is there. */
  streams(): NetworkStream[] {
    const p = this.current();
    if (!p || this.phoneState() !== 'ready') return [];
    return [
      {
        id: `phone:${p.token.slice(0, 8)}`,
        name: `${p.phone.name} camera`,
        host: p.phone.address || 'phone',
        whep: `/api/remote/${p.token}/whep`,
        crop: this.crop,
        source: 'phone',
      },
    ];
  }

  private find(token: string) {
    const p = this.current();
    if (!p || p.token !== token)
      throw new LabError('remote_unpaired', 'This phone pairing has ended. Pair again.', 404);
    return p;
  }

  private emit(p: Pairing, event: PhoneEvent) {
    // Only the newest offer matters; an older one's lab request has given up.
    p.events = [...p.events.filter((e) => e.type !== 'offer'), event];
    if (p.waiter) {
      const deliver = p.waiter;
      p.waiter = null;
      deliver(p.events.shift()!);
    }
  }

  /** Lab side: hands the offer to the phone and resolves with its answer. */
  async connect(token: string, sdp: string) {
    const p = this.find(token);
    if (this.phoneState() !== 'ready')
      throw new LabError('remote_absent', 'The phone is not connected. Open the page on it.', 409);
    const id = randomUUID();
    const answer = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        p.answers.delete(id);
        reject(new LabError('remote_timeout', 'The phone did not answer in time.', 504));
      }, ANSWER_MS);
      p.answers.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    this.emit(p, { type: 'offer', id, sdp });
    return answer;
  }

  /** Lab side: the lab stopped playing the phone, so the phone can stop sending. */
  hangup(token: string) {
    const p = this.find(token);
    p.answers.clear();
    this.emit(p, { type: 'hangup' });
  }

  /** Phone side: the next thing for the phone to do, or null after `waitMs` of nothing. */
  next(token: string, phone: { name: string; address: string }, waitMs = POLL_MS) {
    const p = this.find(token);
    const arrived = this.phoneState() !== 'ready';
    p.seenAt = this.now();
    p.phone = phone;
    // A second tab on the phone takes over from the first.
    p.waiter?.(null);
    p.waiter = null;
    if (arrived) this.changed();
    const queued = p.events.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<PhoneEvent | null>((resolve) => {
      const timer = setTimeout(() => {
        if (p.waiter === finish) p.waiter = null;
        p.seenAt = this.now();
        resolve(null);
      }, waitMs);
      const finish = (event: PhoneEvent | null) => {
        clearTimeout(timer);
        p.seenAt = this.now();
        resolve(event);
      };
      p.waiter = finish;
    });
  }

  /** Phone side: what its encoder did lately. Kept for the lab, and logged now and then. */
  noteStats(token: string, stats: PhoneStats) {
    const p = this.find(token);
    p.sending = stats;
    this.changed();
    if (this.now() - p.loggedAt < STATS_LOG_MS) return;
    p.loggedAt = this.now();
    this.log?.({ source: 'phone', phone: p.phone.name, ...stats });
  }

  /** Phone side: the answer to offer `id`. */
  answer(token: string, id: string, sdp: string) {
    const p = this.find(token);
    const deliver = p.answers.get(id);
    if (!deliver) throw new LabError('remote_stale', 'Stopped waiting for this answer.', 410);
    p.answers.delete(id);
    deliver(sdp);
  }
}

/**
 * The address a phone on the same network can reach this machine at: the
 * Wi-Fi or Ethernet one first, never loopback, link-local or a VM bridge.
 */
export function lanAddress() {
  const found = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? [])
      .filter((i) => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
      .filter(() => !/^(lo|bridge|docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap)/.test(name))
      .map((i) => ({ name, address: i.address })),
  );
  return (found.find((i) => /^(en|eth|wl)/.test(i.name)) ?? found[0])?.address;
}

const run = promisify(execFile);

/** The configured certificate, or a self-signed one made once in the data directory. */
async function certificate(config: Config) {
  if (config.remoteCamera.cert)
    return {
      cert: readFileSync(config.remoteCamera.cert),
      key: readFileSync(config.remoteCamera.key),
    };
  const dir = join(config.dataDir, 'remote-camera');
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  if (!existsSync(cert) || !existsSync(key)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const host = config.remoteCamera.host || lanAddress();
    const names = [
      'DNS:localhost',
      ...(host ? [/^[\d.]+$/.test(host) ? `IP:${host}` : `DNS:${host}`] : []),
    ];
    try {
      // 825 days is the longest validity iOS accepts.
      await run('openssl', [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '825',
        '-subj',
        '/CN=LivingLayer remote camera',
        '-addext',
        `subjectAltName=${names.join(',')}`,
        '-keyout',
        key,
        '-out',
        cert,
      ]);
    } catch {
      throw new LabError(
        'remote_cert',
        'Could not make a certificate for the phone page. Install openssl, or set REMOTE_CAMERA_CERT and REMOTE_CAMERA_KEY.',
        500,
      );
    }
  }
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

/** The phone-facing routes, on their own server so the lab's API stays loopback-only. */
export function phoneApp(remote: RemoteCamera, https?: { cert: Buffer; key: Buffer }) {
  const options = { logger: false, bodyLimit: 64_000 };
  const app = (https ? Fastify({ ...options, https }) : Fastify(options)) as FastifyInstance;
  app.addHook('onSend', async (_request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('Referrer-Policy', 'no-referrer');
  });
  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof LabError;
    void reply.code(known ? error.statusCode : 400).send({
      error: {
        code: known ? error.code : 'invalid_request',
        message: known ? error.message : 'The request could not be processed.',
      },
    });
  });
  app.get('/r/:token', async (request, reply) => {
    const { token } = parseInput(remoteTokenParamsSchema, request.params);
    const nonce = randomBytes(16).toString('base64');
    return reply
      .header(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; media-src 'self' blob: mediastream:; img-src data:; base-uri 'none'; form-action 'none'`,
      )
      .type('text/html; charset=utf-8')
      .send(phonePage(nonce, remote.current()?.token === token));
  });
  app.get('/r/:token/next', async (request, reply) => {
    const { token } = parseInput(remoteTokenParamsSchema, request.params);
    const event = await remote.next(token, {
      name: phoneName(request.headers['user-agent']),
      address: request.ip.replace(/^::ffff:/, ''),
    });
    return event ?? reply.code(204).send();
  });
  app.post('/r/:token/answer', async (request, reply) => {
    const { token } = parseInput(remoteTokenParamsSchema, request.params);
    const { id, sdp } = parseInput(remoteAnswerSchema, request.body);
    remote.answer(token, id, sdp);
    return reply.code(204).send();
  });
  app.post('/r/:token/stats', async (request, reply) => {
    const { token } = parseInput(remoteTokenParamsSchema, request.params);
    remote.noteStats(token, parseInput(phoneStatsSchema, request.body));
    return reply.code(204).send();
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: { code: 'not_found', message: 'Route not found.' } });
  });
  return app;
}

/**
 * The lab's side: pairing, the QR code, and the WHEP-shaped relay. The phone
 * server only starts listening on the network with the first pairing.
 */
export function remoteRoutes(app: FastifyInstance, config: Config, remote: RemoteCamera) {
  remote.log ??= (record) => appendStreamStats(config.dataDir, record);
  let phones: Promise<FastifyInstance> | null = null;
  const listen = () => {
    phones ??= (async () => {
      const server = phoneApp(remote, await certificate(config));
      await server.listen({ host: '0.0.0.0', port: config.remoteCamera.port });
      return server;
    })().catch((e) => {
      phones = null;
      throw e instanceof LabError
        ? e
        : new LabError(
            'remote_listen',
            `Could not open port ${config.remoteCamera.port} for the phone. Set REMOTE_CAMERA_PORT to a free one.`,
            500,
          );
    });
    return phones;
  };
  app.addHook('onClose', async () => {
    remote.end();
    await (await phones?.catch(() => null))?.close();
  });
  app.addContentTypeParser(
    'application/sdp',
    { parseAs: 'string', bodyLimit: 64_000 },
    (_request, body, done) => done(null, body),
  );

  const describe = async () => {
    const p = remote.current();
    if (!p) return { pairing: null };
    const host = config.remoteCamera.host || lanAddress();
    if (!host)
      throw new LabError(
        'remote_offline',
        'This machine has no network address a phone could reach. Join a Wi-Fi or wired network.',
        409,
      );
    const url = `https://${host}:${config.remoteCamera.port}/r/${p.token}`;
    return {
      pairing: {
        url,
        qr: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
        phone: remote.phoneState(),
        stream: remote.streams()[0] ?? null,
        sending: p.sending,
      },
    };
  };
  app.get('/api/remote', describe);
  // The pairing as it changes; resent every few seconds, since a phone that goes away
  // is only noticed by the time since its last poll.
  app.get('/api/remote/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = () =>
      void describe()
        .then((view) => reply.raw.write(`data: ${JSON.stringify(view)}\n\n`))
        .catch(() => {});
    send();
    const off = remote.subscribe(send);
    const again = setInterval(send, 5_000);
    request.raw.on('close', () => {
      off();
      clearInterval(again);
    });
  });
  app.post('/api/remote/pair', async () => {
    await listen();
    remote.pair();
    return describe();
  });
  app.delete('/api/remote', async () => {
    remote.end();
    return { pairing: null };
  });
  app.post('/api/remote/:token/whep', async (request, reply) => {
    const { token } = parseInput(remoteTokenParamsSchema, request.params);
    if (typeof request.body !== 'string' || !request.body.startsWith('v=0'))
      throw new LabError('invalid_request', 'Send an SDP offer.', 415);
    const answer = await remote.connect(token, request.body);
    return reply
      .code(201)
      .header('Content-Type', 'application/sdp')
      .header('Location', `/api/remote/${token}/whep`)
      .send(answer);
  });
  app.delete('/api/remote/:token/whep', async (request, reply) => {
    const { token } = parseInput(remoteTokenParamsSchema, request.params);
    remote.hangup(token);
    return reply.code(204).send();
  });
}
