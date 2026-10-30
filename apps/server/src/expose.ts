import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  configTopic,
  evaluateExposed,
  exposedInputSchema,
  exposeMessages,
  exposeProblem,
  modeSchema,
  type ExposedEntity,
  type ExposeMessage,
  type ExposeOptions,
  type ExposeView,
  type ExposeWatch,
  type Mode,
} from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import type { MqttLink } from './mqtt.js';
import type { EvidenceStore } from './store.js';

const LOG_LIMIT = 40;
/** Config topics published in live mode, so ones deleted while the server was down are cleared. */
const KNOWN_KEY = 'mqtt_config_topics';

/**
 * One mode's entities: works out their states from desk memory and the
 * watcher, tells the lab, and keeps the broker's retained topics the same as
 * what it worked out. Live publishes through the MQTT link; demo never
 * touches the network and keeps a log of what it would have sent.
 */
export class Exposer {
  /** Each topic's last published payload. */
  private sent = new Map<string, string>();
  private known: Set<string>;
  private log: ExposeView['log'] = [];
  private listeners = new Set<(view: ExposeView) => void>();
  private last = '';
  constructor(
    private deps: {
      mode: Mode;
      store: EvidenceStore;
      watch: () => ExposeWatch | null;
      options: ExposeOptions;
      link: MqttLink | null;
      now?: () => number;
    },
  ) {
    const saved = deps.mode === 'live' ? deps.store.setting(KNOWN_KEY) : null;
    this.known = new Set(saved ? (JSON.parse(saved) as string[]) : []);
  }
  private states() {
    return evaluateExposed(
      this.deps.store.memory(this.deps.mode),
      this.deps.watch(),
      this.deps.now?.() ?? Date.now(),
    );
  }
  view(states = this.states()): ExposeView {
    const { link, mode } = this.deps;
    return {
      mode,
      broker:
        mode === 'demo'
          ? { state: 'off', note: 'Demo mode never publishes; this is what it would send.' }
          : link
            ? { state: link.state, note: link.note }
            : { state: 'off', note: 'Set MQTT_URL and MQTT_LIVE_ENABLED to publish entities.' },
      states,
      log: this.log,
    };
  }
  subscribe(listener: (view: ExposeView) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Tell the lab, whenever what it would show changed. */
  emit(force = false) {
    const view = this.view();
    const now = JSON.stringify({ broker: view.broker, states: view.states, log: view.log[0] });
    if (!force && now === this.last) return;
    this.last = now;
    for (const l of this.listeners) l(view);
  }
  /**
   * Work out every state, publish what changed and clear what went away.
   * `resend` publishes everything again, as after a (re)connect.
   */
  sync(resend = false) {
    // Called from timers and other parts' events: a failure here must never reach them.
    try {
      this.syncNow(resend);
    } catch {
      // The next change or tick tries again.
    }
  }
  private syncNow(resend: boolean) {
    const memory = this.deps.store.memory(this.deps.mode);
    const states = this.states();
    const { options } = this.deps;
    const wanted = exposeMessages(memory, states, options);
    const out: ExposeMessage[] = [];
    const keys = new Set((memory.exposed ?? []).map((e) => e.key));
    const configs = new Set((memory.exposed ?? []).map((e) => configTopic(options, e)));
    // Gone first, so a renamed key's old entity is deleted before the new one appears.
    for (const topic of new Set([...this.known, ...this.sent.keys()])) {
      if (configs.has(topic) || wanted.some((m) => m.topic === topic)) continue;
      const config = topic.match(/\/ll_([a-z0-9_]+)\/config$/);
      if (config) {
        out.push({ topic, payload: '' });
        const key = config[1]!;
        if (!keys.has(key))
          for (const part of ['state', 'attributes', 'availability'])
            out.push({ topic: `${options.baseTopic}/${key}/${part}`, payload: '' });
        continue;
      }
      // A state topic of an entity that is only unavailable keeps its last value.
      const key = topic.slice(options.baseTopic.length + 1).split('/')[0]!;
      if (!keys.has(key)) out.push({ topic, payload: '' });
    }
    for (const m of wanted) if (resend || this.sent.get(m.topic) !== m.payload) out.push(m);
    if (out.length) this.publish(out);
    this.emit();
  }
  private publish(messages: ExposeMessage[]) {
    const { link, mode, store, options } = this.deps;
    for (const m of messages) {
      if (mode === 'live' && !link?.publish(m)) return;
      if (m.payload === '') this.sent.delete(m.topic);
      else this.sent.set(m.topic, m.payload);
      if (mode === 'demo')
        this.log = [
          { at: new Date().toISOString(), topic: m.topic, payload: m.payload },
          ...this.log,
        ].slice(0, LOG_LIMIT);
    }
    const configs = [...this.sent.keys()].filter((t) =>
      t.startsWith(`${options.discoveryPrefix}/`),
    );
    if (configs.join() !== [...this.known].join()) {
      this.known = new Set(configs);
      if (mode === 'live') store.setSetting(KNOWN_KEY, JSON.stringify(configs));
    }
  }
}

/** The lab's routes for entities shown in Home Assistant. */
export function exposeRoutes(
  app: FastifyInstance,
  exposers: Record<Mode, Exposer>,
  store: EvidenceStore,
) {
  // Whatever a person changes, the entities follow.
  app.addHook('onResponse', async (request, reply) => {
    if (request.method !== 'POST' || reply.statusCode >= 400) return;
    if (!/^\/api\/(desk|fixtures|scene|item|expose|watch)\b/.test(request.url)) return;
    exposers.demo.sync();
    exposers.live.sync();
  });
  app.get('/api/expose/:mode', async (request) => {
    const { mode } = parseInput(z.object({ mode: modeSchema }).strict(), request.params);
    return exposers[mode].view();
  });
  app.get('/api/expose/:mode/events', (request, reply) => {
    const { mode } = parseInput(z.object({ mode: modeSchema }).strict(), request.params);
    const exposer = exposers[mode];
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (view: ExposeView) => reply.raw.write(`data: ${JSON.stringify(view)}\n\n`);
    send(exposer.view());
    const off = exposer.subscribe(send);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    request.raw.on('close', () => {
      off();
      clearInterval(ping);
    });
  });
  app.post('/api/expose/save', async (request) => {
    const { mode, entity: input } = parseInput(
      z.object({ mode: modeSchema, entity: exposedInputSchema }).strict(),
      request.body,
    );
    const memory = store.memory(mode);
    const list = memory.exposed ?? [];
    if (input.id && !list.some((e) => e.id === input.id))
      throw new LabError('expose_missing', 'That entity is gone. Add it again.', 404);
    const problem = exposeProblem(memory, input);
    if (problem) throw new LabError('expose_invalid', problem, 400);
    const entity: ExposedEntity = { ...input, id: input.id ?? randomUUID() };
    memory.exposed = input.id
      ? list.map((e) => (e.id === input.id ? entity : e))
      : [...list, entity];
    store.saveMemory(memory);
    return memory;
  });
  app.post('/api/expose/delete', async (request) => {
    const { mode, id } = parseInput(
      z.object({ mode: modeSchema, id: z.string().uuid() }).strict(),
      request.body,
    );
    const memory = store.memory(mode);
    memory.exposed = (memory.exposed ?? []).filter((e) => e.id !== id);
    store.saveMemory(memory);
    return memory;
  });
}
