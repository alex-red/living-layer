/**
 * The node's HTTP API as one fetch handler, so tests drive it without a socket.
 *
 *   GET  /info     who it is and what it can do; open to anyone
 *   POST /pair     the first caller gets the token (trust on first use)
 *   GET  /status   what it last did; needs the token
 *   POST /command  display, open or banner; needs the token
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DESKTOP_NODE_VERSION,
  desktopNodeCommandSchema,
  desktopNodePairSchema,
  type DesktopKind,
  type DesktopNodeCommand,
  type DesktopNodeInfo,
  type DesktopNodeStatus,
} from '@livinglayer/domain';
import { commandArgv, desktopCaps } from './desktop.js';

/** What the node keeps between runs. */
export interface Identity {
  id: string;
  name: string;
  token: string | null;
  adoptedBy: string | null;
}

/** Runs one command; never throws. */
export type Runner = (argv: string[]) => Promise<{ ok: boolean; error?: string }>;

export interface NodeOptions {
  identity: Identity;
  save: (identity: Identity) => void;
  desktop: DesktopKind;
  os: DesktopNodeInfo['os'];
  run: Runner;
  /** Kiosk browsers on `PATH`. */
  browsers?: readonly string[];
  now?: () => Date;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const refuse = (status: number, error: string) => json({ ok: false, error }, status);

function sameToken(given: string, token: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createNode(options: NodeOptions) {
  const { identity, desktop, run } = options;
  const now = options.now ?? (() => new Date());
  const status: DesktopNodeStatus = { display: null, last: null };

  const info = (): DesktopNodeInfo => ({
    id: identity.id,
    name: identity.name,
    version: DESKTOP_NODE_VERSION,
    os: options.os,
    desktop,
    caps: desktopCaps(desktop),
    adopted: identity.token !== null,
  });

  async function carry(command: DesktopNodeCommand) {
    const steps = commandArgv(command, desktop, options.browsers);
    let result: { ok: boolean; error?: string } = steps
      ? { ok: true }
      : { ok: false, error: `This desktop (${desktop}) can't do ${command.kind}.` };
    for (const argv of steps ?? []) {
      result = await run(argv);
      if (!result.ok) break;
    }
    status.last = {
      kind: command.kind,
      at: now().toISOString(),
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
    };
    if (command.kind === 'display' && result.ok) status.display = command.to;
    return result;
  }

  async function body(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return undefined;
    }
  }

  return {
    info,
    status: () => status,
    carry,
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      const route = `${request.method} ${pathname}`;
      if (route === 'GET /info') return json(info());
      if (route === 'POST /pair') {
        if (identity.token) return refuse(409, 'This node is adopted already.');
        const parsed = desktopNodePairSchema.safeParse(await body(request));
        if (!parsed.success) return refuse(400, 'Say who is adopting it.');
        identity.token = randomBytes(24).toString('base64url');
        identity.adoptedBy = parsed.data.by;
        options.save(identity);
        // Shown on the screen itself, so whoever sits there sees it was adopted.
        void carry({
          kind: 'banner',
          title: 'Living Layer',
          text: `Adopted by ${parsed.data.by}.`,
        });
        return json({ token: identity.token, info: info() });
      }
      if (route !== 'GET /status' && route !== 'POST /command') return refuse(404, 'Nothing here.');
      const given = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (!identity.token || !sameToken(given, identity.token))
        return refuse(401, 'That token is not this node’s.');
      if (route === 'GET /status') return json(status);
      const parsed = desktopNodeCommandSchema.safeParse(await body(request));
      if (!parsed.success) return refuse(400, parsed.error.issues[0]?.message ?? 'Bad command.');
      const result = await carry(parsed.data);
      return result.ok ? json({ ok: true, status }) : refuse(502, result.error ?? 'It failed.');
    },
  };
}
