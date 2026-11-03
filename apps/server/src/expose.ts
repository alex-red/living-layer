import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  exposeLearnEmptyBodySchema,
  exposeSaveBodySchema,
  modeIdSchema,
  modeOnlySchema,
  commandOf,
  commandTopics,
  configTopic,
  evaluateExposed,
  zoneEvent,
  exposeMessages,
  exposeProblem,
  type ExposedEntity,
  type ExposeMessage,
  type ExposeOptions,
  type ExposeView,
  type ExposeWatch,
  type Mode,
} from '@livinglayer/domain';
import { LabError, parseInput, safeError } from './errors.js';
import type { MqttLink } from './mqtt.js';
import type { EvidenceStore } from './store.js';

const LOG_LIMIT = 40;
/** Config topics published in live mode, so ones deleted while the server was down are cleared. */
const KNOWN_KEY = 'mqtt_config_topics';

/** What Home Assistant's commands do: exactly what the lab's own buttons do. */
interface ExposeActions {
  setWatching: (on: boolean) => Promise<unknown>;
  checkRules: () => Promise<unknown>;
}

/**
 * One mode's entities: works out their states from desk memory and the
 * watcher, tells the lab, and keeps the broker's retained topics the same as
 * what it worked out. Live publishes through the MQTT link and takes
 * commands for its switches and buttons; demo never touches the network and
 * keeps a log of what it would have sent.
 */
export class Exposer {
  /** Each topic's last published payload. */
  private sent = new Map<string, string>();
  private known: Set<string>;
  private log: ExposeView['log'] = [];
  private listeners = new Set<(view: ExposeView) => void>();
  private last = '';
  /** Each event entity's last published decision, so each entered or left goes out once. */
  private events = new Map<string, string>();
  private commands: ExposeView['commands'] = [];
  constructor(
    private deps: {
      mode: Mode;
      store: EvidenceStore;
      watch: () => ExposeWatch | null;
      options: ExposeOptions;
      link: MqttLink | null;
      actions?: ExposeActions;
      now?: () => number;
    },
  ) {
    const saved = deps.mode === 'live' ? deps.store.setting(KNOWN_KEY) : null;
    this.known = new Set(saved ? (JSON.parse(saved) as string[]) : []);
    if (deps.mode === 'live' && deps.link)
      for (const filter of commandTopics(deps.options))
        deps.link.listen(filter, (topic, payload) => void this.command(topic, payload));
  }
  /**
   * A command from Home Assistant. Only our own switches and buttons, only
   * their exact payloads; anything else on those topics is ignored.
   */
  async command(topic: string, payload: string) {
    const memory = this.deps.store.memory(this.deps.mode);
    const cmd = commandOf(memory, this.deps.options, topic, payload);
    if (!cmd || !this.deps.actions) return;
    let result = 'done';
    try {
      if (cmd.entity.source.kind === 'watching')
        await this.deps.actions.setWatching(cmd.action === 'on');
      else if (cmd.entity.source.kind === 'check_rules') await this.deps.actions.checkRules();
    } catch (error) {
      result = safeError(error).message;
    }
    this.commands = [
      { at: new Date().toISOString(), key: cmd.entity.key, action: cmd.action, result },
      ...this.commands,
    ].slice(0, 10);
    this.sync();
    this.emit(true);
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
      commands: this.commands,
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
    // Each entered or left once, not retained: Home Assistant fires it as it arrives.
    for (const e of memory.exposed ?? []) {
      if (e.kind !== 'event') continue;
      const event = zoneEvent(memory, e);
      const seen = this.events.get(e.id);
      this.events.set(e.id, event?.decisionId ?? seen ?? '');
      // A new entity starts from what is already decided, so nothing old goes out.
      if (seen === undefined || !event || event.decisionId === seen) continue;
      out.push({
        topic: `${options.baseTopic}/${e.key}/state`,
        payload: JSON.stringify({ event_type: event.type, ...event.attributes }),
        retain: false,
      });
    }
    if (out.length) this.publish(out);
    this.emit();
  }
  private publish(messages: ExposeMessage[]) {
    const { link, mode, store, options } = this.deps;
    for (const m of messages) {
      if (mode === 'live' && !link?.publish(m)) {
        // An event can't wait for a reconnect; retained messages are sent again on it.
        if (m.retain === false) continue;
        return;
      }
      if (m.retain === false) {
        // Not retained, so nothing to keep in step.
      } else if (m.payload === '') this.sent.delete(m.topic);
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
export async function exposeRoutes(
  app: FastifyInstance,
  exposers: Record<Mode, Exposer>,
  store: EvidenceStore,
  learnEmpty: (mode: Mode, zoneId: string) => Promise<'features' | 'pixels'>,
) {
  app.get('/:mode', async (request) => {
    const { mode } = parseInput(modeOnlySchema, request.params);
    return exposers[mode].view();
  });
  app.post('/save', async (request) => {
    const { mode, entity: input } = parseInput(exposeSaveBodySchema, request.body);
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
  /** The person says the zone is empty now: remember how it looks, to tell when someone is there. */
  app.post('/learn-empty', async (request) => {
    const { mode, zoneId } = parseInput(exposeLearnEmptyBodySchema, request.body);
    const method = await learnEmpty(mode, zoneId);
    return { zoneId, method, view: exposers[mode].view() };
  });
  app.post('/delete', async (request) => {
    const { mode, id } = parseInput(modeIdSchema, request.body);
    const memory = store.memory(mode);
    memory.exposed = (memory.exposed ?? []).filter((e) => e.id !== id);
    store.saveMemory(memory);
    return memory;
  });
}
