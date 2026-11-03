import type { HaLink } from '@livinglayer/domain';
import type { HaConnection } from './control.js';
import type { OpenSocket } from './ha.js';

/** An entity's state as Home Assistant reports it. */
export interface HaState {
  state: string;
  attributes: Record<string, unknown>;
}
/** How long a command over the socket may take before it counts as lost. */
const COMMAND_MS = 5000;
/** A ping this often; an unanswered one closes the socket, which then reconnects. */
const PING_MS = 30_000;
/** Waits between reconnects, longest last; a refused token waits the longest. */
const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 30_000];
const REFUSED_MS = 5 * 60_000;

/** One entity in `subscribe_entities`' compact messages. */
interface Compact {
  s?: string;
  a?: Record<string, unknown>;
}
interface Message {
  id?: number;
  type?: string;
  success?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
  event?: {
    a?: Record<string, Compact>;
    c?: Record<string, { '+'?: Compact; '-'?: { a?: string[] } }>;
    r?: string[];
  };
}

/**
 * One websocket to Home Assistant, kept open while there is a connection:
 * it signs in with the token, subscribes to every entity's state (one full
 * list, then only what changes) and keeps that list, so a state is read here
 * rather than asked for. Every (re)connect starts from Home Assistant's full
 * list again, so a restart of either side, or a dropped network, comes back
 * to the states as they are. Actions go over the same socket; nothing is
 * retried on it.
 *
 * Nothing opens until `start`: a server that never listens (tests) never
 * connects. `refresh` reconnects after a sign-in or a sign-out.
 */
export class HaLive {
  link: HaLink = 'off';
  private states = new Map<string, HaState>();
  /** The full list has arrived since the socket opened: `states` is Home Assistant's. */
  private synced = false;
  private started = false;
  private socket: ReturnType<OpenSocket> | null = null;
  /** The URL and token the socket was opened with, to notice a new sign-in. */
  private key = '';
  private nextId = 1;
  private subscription = 0;
  private pending = new Map<
    number,
    {
      resolve: (m: Message) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private tries = 0;
  private ping: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(changed: string[]) => void>();

  constructor(
    private connection: () => HaConnection,
    private openSocket: OpenSocket,
  ) {}

  start() {
    this.started = true;
    this.refresh();
  }
  stop() {
    this.started = false;
    this.close('off');
  }
  /** Opens the socket for the current connection, or closes it when there is none or it changed. */
  refresh() {
    if (!this.started) return;
    const { url, token } = this.connection();
    const key = url && token ? `${url}\n${token}` : '';
    if (key === this.key && (this.socket || this.retry)) return;
    this.close(key ? 'connecting' : 'off');
    this.key = key;
    this.tries = 0;
    if (key) this.open(url, token);
  }
  /** Whether `state` is Home Assistant's own list, as of now. */
  ready() {
    return this.link === 'connected' && this.synced;
  }
  state(entity: string): HaState | undefined {
    return this.ready() ? this.states.get(entity) : undefined;
  }
  /** Every entity's state, or null while the list isn't Home Assistant's. */
  all(): ReadonlyMap<string, HaState> | null {
    return this.ready() ? this.states : null;
  }
  /** Hears which entities changed; an empty list when the link itself did. */
  subscribe(listener: (changed: string[]) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  /** Calls a service over the socket. Throws when Home Assistant refuses it or the socket goes. */
  async callService(domain: string, service: string, data: Record<string, unknown>) {
    const m = await this.command({ type: 'call_service', domain, service, service_data: data });
    if (!m.success)
      throw new Error(m.error?.message ?? m.error?.code ?? 'Home Assistant refused the action.');
  }
  /**
   * The entity's state once `done` holds for it (at once if it already does),
   * `timeout` with its latest state when it doesn't within `ms`, or `lost`
   * when the link goes first, since the list is then no longer Home Assistant's.
   */
  waitFor(
    entity: string,
    done: (s: HaState) => boolean,
    ms: number,
  ): Promise<{ kind: 'done' | 'timeout'; state: HaState | undefined } | { kind: 'lost' }> {
    return new Promise((resolve) => {
      const check = (changed: string[]) => {
        if (!this.ready()) return finish({ kind: 'lost' });
        if (changed.length && !changed.includes(entity)) return;
        const s = this.states.get(entity);
        if (s && done(s)) finish({ kind: 'done', state: s });
      };
      const off = this.subscribe(check);
      const timer = setTimeout(
        () => finish({ kind: 'timeout', state: this.states.get(entity) }),
        ms,
      );
      let ended = false;
      function finish(r: Parameters<typeof resolve>[0]) {
        if (ended) return;
        ended = true;
        off();
        clearTimeout(timer);
        resolve(r);
      }
      check([entity]);
    });
  }

  private open(url: string, token: string) {
    let socket: ReturnType<OpenSocket>;
    try {
      socket = this.openSocket(`${url.replace(/^http/, 'ws')}/api/websocket`);
    } catch {
      return this.lost('unreachable');
    }
    this.socket = socket;
    this.set('connecting');
    const mine = () => this.socket === socket;
    socket.addEventListener('message', (e) => {
      if (!mine()) return;
      let m: Message;
      try {
        m = JSON.parse(String(e.data)) as Message;
      } catch {
        return;
      }
      this.receive(m, token);
    });
    const gone = () => {
      if (mine()) this.lost(this.link === 'unauthorized' ? 'unauthorized' : 'unreachable');
    };
    socket.addEventListener('close', gone);
    socket.addEventListener('error', gone);
  }
  private receive(m: Message, token: string) {
    if (m.type === 'auth_required') return this.send({ type: 'auth', access_token: token });
    if (m.type === 'auth_invalid') return this.lost('unauthorized');
    if (m.type === 'auth_ok') {
      this.tries = 0;
      this.synced = false;
      this.subscription = this.nextId++;
      this.send({ id: this.subscription, type: 'subscribe_entities' });
      this.ping = setInterval(() => {
        this.command({ type: 'ping' }).catch(() => this.socket?.close());
      }, PING_MS);
      this.ping.unref?.();
      return;
    }
    if (m.id === this.subscription && m.type === 'result' && !m.success)
      return this.lost('unreachable');
    if (m.id === this.subscription && m.type === 'event' && m.event) return this.apply(m.event);
    const waiting = m.id === undefined ? undefined : this.pending.get(m.id);
    if (waiting && (m.type === 'result' || m.type === 'pong')) {
      this.pending.delete(m.id!);
      clearTimeout(waiting.timer);
      waiting.resolve(m);
    }
  }
  /** One `subscribe_entities` message: the full list first, then additions, changes and removals. */
  private apply(event: NonNullable<Message['event']>) {
    const changed: string[] = [];
    if (!this.synced) this.states.clear();
    for (const [id, c] of Object.entries(event.a ?? {})) {
      this.states.set(id, { state: String(c.s ?? 'unknown'), attributes: c.a ?? {} });
      changed.push(id);
    }
    for (const [id, diff] of Object.entries(event.c ?? {})) {
      const was = this.states.get(id);
      if (!was) continue;
      const attributes = { ...was.attributes, ...diff['+']?.a };
      for (const key of diff['-']?.a ?? []) delete attributes[key];
      this.states.set(id, { state: diff['+']?.s ?? was.state, attributes });
      changed.push(id);
    }
    for (const id of event.r ?? []) {
      this.states.delete(id);
      changed.push(id);
    }
    if (!this.synced) {
      this.synced = true;
      this.link = 'connected';
      return this.emit([]);
    }
    if (changed.length) this.emit(changed);
  }
  private command(body: Record<string, unknown>): Promise<Message> {
    if (!this.socket || this.link !== 'connected')
      return Promise.reject(new Error('Home Assistant isn’t connected.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Home Assistant didn’t answer in time.'));
      }, COMMAND_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, ...body });
    });
  }
  private send(body: Record<string, unknown>) {
    try {
      this.socket?.send(JSON.stringify(body));
    } catch {
      this.socket?.close();
    }
  }
  /** The socket went: say so, fail what waits on it, and try again after a while. */
  private lost(link: 'unreachable' | 'unauthorized') {
    this.close(link);
    if (!this.started || !this.key) return;
    const wait =
      link === 'unauthorized'
        ? REFUSED_MS
        : BACKOFF_MS[Math.min(this.tries++, BACKOFF_MS.length - 1)]!;
    this.retry = setTimeout(() => {
      this.retry = null;
      const { url, token } = this.connection();
      if (`${url}\n${token}` === this.key) this.open(url, token);
      else this.refresh();
    }, wait);
    this.retry.unref?.();
  }
  private close(link: HaLink) {
    const socket = this.socket;
    this.socket = null;
    this.synced = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Home Assistant’s connection closed.'));
      this.pending.delete(id);
    }
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
    this.set(link);
  }
  private set(link: HaLink) {
    if (link === this.link) return;
    this.link = link;
    this.emit([]);
  }
  private emit(changed: string[]) {
    for (const listener of [...this.listeners]) {
      try {
        listener(changed);
      } catch {
        // One listener's failure never stops the others or the link.
      }
    }
  }
}
