import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { haChosenBodySchema, haLoginBodySchema, entityIdSchema } from '@livinglayer/domain';
import type { Config, Fetcher } from './config.js';
import type { ControlAdapter, HaConnection } from './control.js';
import { LabError, parseInput } from './errors.js';
import type { EvidenceStore } from './store.js';

/** The most devices the lab lets someone tick; rules and fixtures pick from these. */
const KEY = 'ha_entities';

/** The Home Assistant devices ticked in the lab, beside the ones `.env` names. */
export function chosenEntities(store: EvidenceStore): string[] {
  try {
    const parsed = z.array(entityIdSchema).safeParse(JSON.parse(store.setting(KEY) ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** A sign-in from the lab: the long-lived token it made, never the password. */
const LOGIN = 'ha_login';
const loginSchema = z.object({ url: z.string(), token: z.string(), user: z.string() });
type HaLogin = z.infer<typeof loginSchema>;
function savedLogin(store: EvidenceStore): HaLogin | null {
  try {
    const parsed = loginSchema.safeParse(JSON.parse(store.setting(LOGIN) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
/** `.env`'s URL and token when both are set, else the lab's sign-in, else nothing. */
export function haConnection(
  config: Config,
  store: EvidenceStore,
): HaConnection & {
  via: 'env' | 'login' | null;
  user: string;
} {
  if (config.haUrl && config.haToken)
    return { url: config.haUrl, token: config.haToken, via: 'env', user: '' };
  const login = savedLogin(store);
  return login
    ? { url: login.url, token: login.token, via: 'login', user: login.user }
    : { url: '', token: '', via: null, user: '' };
}

/** An origin like `http://homeassistant.local:8123`, without a path, a query or credentials. */
function haOrigin(raw: string): string {
  const url = URL.parse(raw.trim());
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    throw new LabError(
      'ha_url',
      'Use Home Assistant’s address as you open it in a browser, like http://homeassistant.local:8123.',
      400,
    );
  return url.origin;
}

/** The part of a WebSocket the sign-in uses, so tests can pass their own. */
export type OpenSocket = (url: string) => {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  addEventListener(type: 'error' | 'close', listener: () => void): void;
};
type Step = { kind: 'done'; login: HaLogin } | { kind: 'code'; flowId: string; message: string };

/**
 * Signs in to Home Assistant as a person does (its login flow, then the
 * authorization code for a token), and trades that short session for a
 * long-lived token named for Living Layer, which Home Assistant lists under
 * the user's tokens. The short session is revoked; the password is never kept.
 * A user with two-factor login answers `code` with the code, and its flow id.
 */
async function signIn(
  input: { url: string; username: string; password: string; code?: string; flowId?: string },
  {
    fetcher,
    openSocket,
    clientId,
    timeoutMs,
    now = new Date(),
  }: {
    fetcher: Fetcher;
    openSocket: OpenSocket;
    /** This server's own address, as Home Assistant's sign-in wants a client to name itself. */
    clientId: string;
    timeoutMs: number;
    now?: Date;
  },
): Promise<Step> {
  const origin = haOrigin(input.url);
  const signal = AbortSignal.timeout(timeoutMs);
  const post = async (path: string, body: Record<string, unknown> | URLSearchParams) => {
    let response: Response;
    try {
      response = await fetcher(`${origin}${path}`, {
        method: 'POST',
        signal,
        redirect: 'error',
        ...(body instanceof URLSearchParams
          ? { body }
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch {
      throw new LabError(
        'ha_unreachable',
        `Home Assistant didn’t answer at ${origin}. Open that address in a browser on this machine; use the one that works, with its port (usually :8123).`,
        502,
      );
    }
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !data)
      throw new LabError(
        'ha_login',
        `Home Assistant didn’t accept the sign-in (HTTP ${response.status}).`,
        502,
      );
    return data;
  };
  let flowId = input.flowId;
  let step: Record<string, unknown>;
  if (flowId && input.code) {
    step = await post(`/auth/login_flow/${encodeURIComponent(flowId)}`, {
      client_id: clientId,
      code: input.code.trim(),
    });
  } else {
    const start = await post('/auth/login_flow', {
      client_id: clientId,
      handler: ['homeassistant', null],
      redirect_uri: clientId,
    });
    flowId = String(start.flow_id ?? '');
    step = await post(`/auth/login_flow/${encodeURIComponent(flowId)}`, {
      client_id: clientId,
      username: input.username.trim(),
      password: input.password,
    });
  }
  // With more than one kind of two-factor login, Home Assistant asks which: take the first.
  if (step.type === 'form' && step.step_id === 'select_mfa_module') {
    const field = (step.data_schema as { options?: unknown }[] | undefined)?.[0]?.options;
    const first = Array.isArray(field)
      ? field[0]
      : field && typeof field === 'object'
        ? Object.keys(field)[0]
        : undefined;
    step = await post(`/auth/login_flow/${encodeURIComponent(flowId)}`, {
      client_id: clientId,
      multi_factor_auth_module: Array.isArray(first) ? first[0] : first,
    });
  }
  if (step.type === 'form') {
    const errors = (step.errors ?? {}) as Record<string, string>;
    if (step.step_id === 'mfa')
      return {
        kind: 'code',
        flowId,
        message: errors.base
          ? 'That code didn’t work. Try the newest one.'
          : 'This user has two-factor login: enter the code from the app.',
      };
    throw new LabError(
      'ha_login',
      errors.base === 'invalid_auth'
        ? 'Home Assistant didn’t accept that username and password.'
        : 'Home Assistant didn’t accept the sign-in.',
      401,
    );
  }
  if (step.type !== 'create_entry' || typeof step.result !== 'string')
    throw new LabError(
      'ha_login',
      'Home Assistant ended the sign-in early. Start again from the username.',
      401,
    );
  const session = await post(
    '/auth/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: step.result,
      client_id: clientId,
    }),
  );
  const access = String(session.access_token ?? '');
  if (!access) throw new LabError('ha_login', 'Home Assistant gave no session.', 502);
  try {
    const token = await longLivedToken(origin, access, openSocket, timeoutMs, now);
    return { kind: 'done', login: { url: origin, token, user: input.username.trim() } };
  } finally {
    // The short session has done its job; its token would otherwise linger in the user's list.
    if (typeof session.refresh_token === 'string')
      await fetcher(`${origin}/auth/revoke`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
        body: new URLSearchParams({ token: session.refresh_token }),
      }).catch(() => {});
  }
}

/** Asks Home Assistant's websocket for a long-lived token, as its profile page does. */
function longLivedToken(
  origin: string,
  access: string,
  openSocket: OpenSocket,
  timeoutMs: number,
  now: Date,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = openSocket(`${origin.replace(/^http/, 'ws')}/api/websocket`);
    const fail = (message: string) => {
      clearTimeout(timer);
      socket.close();
      reject(new LabError('ha_login', message, 502));
    };
    const timer = setTimeout(() => fail('Home Assistant didn’t make a token in time.'), timeoutMs);
    // Names are unique per user; the time keeps a second sign-in from clashing with the first.
    const name = `Living Layer ${now.toISOString().slice(0, 16).replace('T', ' ')}`;
    socket.addEventListener('message', (e) => {
      let m: { type?: string; success?: boolean; result?: unknown; error?: { message?: string } };
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.type === 'auth_required')
        socket.send(JSON.stringify({ type: 'auth', access_token: access }));
      else if (m.type === 'auth_ok')
        socket.send(
          JSON.stringify({
            id: 1,
            type: 'auth/long_lived_access_token',
            client_name: name,
            lifespan: 3650,
          }),
        );
      else if (m.type === 'auth_invalid') fail('Home Assistant refused the new session.');
      else if (m.type === 'result') {
        if (m.success && typeof m.result === 'string') {
          clearTimeout(timer);
          socket.close();
          resolve(m.result);
        } else
          fail(
            `Home Assistant wouldn’t make a token${m.error?.message ? `: ${m.error.message}` : ''}.`,
          );
      }
    });
    socket.addEventListener('error', () => fail('Home Assistant’s websocket couldn’t be opened.'));
  });
}

/**
 * Home Assistant from the lab: sign in (or sign out), list what it has, keep
 * the devices ticked. `.env`'s URL and token, when set, win over a sign-in.
 */
export async function haRoutes(
  app: FastifyInstance,
  {
    config,
    store,
    lamp,
    fixed,
    fetcher = fetch,
    openSocket = (url) => new WebSocket(url),
  }: {
    config: Config;
    store: EvidenceStore;
    lamp: ControlAdapter;
    /** The ones `.env` names, always allowed and not changed here. */
    fixed: () => string[];
    fetcher?: Fetcher | undefined;
    openSocket?: OpenSocket | undefined;
  },
) {
  app.post('/login', async (request) => {
    const input = parseInput(haLoginBodySchema, request.body);
    if (config.haUrl && config.haToken)
      throw new LabError(
        'ha_env',
        'HA_URL and HA_TOKEN in .env already connect Home Assistant; remove them to sign in here.',
        409,
      );
    if (!input.flowId && (!input.username.trim() || !input.password))
      throw new LabError('ha_login', 'Enter the username and the password.', 400);
    const step = await signIn(input, {
      fetcher,
      openSocket,
      clientId: `http://127.0.0.1:${config.port}/`,
      timeoutMs: config.timeoutMs,
    });
    if (step.kind === 'code') return step;
    store.setSetting(LOGIN, JSON.stringify(step.login));
    return { kind: 'done', url: step.login.url, user: step.login.user };
  });
  /** Forgets the token. Home Assistant still lists it until it's deleted there. */
  app.post('/logout', async () => {
    store.deleteSetting(LOGIN);
    return { ok: true };
  });
  app.get('/entities', async () => ({ entities: await lamp.entities() }));
  app.post('/chosen', async (request) => {
    const { entityIds } = parseInput(haChosenBodySchema, request.body);
    const env = new Set(fixed());
    const chosen = [...new Set(entityIds)].filter((e) => !env.has(e));
    store.setSetting(KEY, JSON.stringify(chosen));
    return { chosen };
  });
}
