import { connect as mqttConnect, type IClientOptions, type MqttClient } from 'mqtt';
import type { BrokerState, ExposeMessage } from '@livinglayer/domain';
import type { Config } from './config.js';

/** The part of an MQTT.js client the link uses, so tests can pass their own. */
export type MqttConnect = (url: string, options: IClientOptions) => MqttClient;

/** Whether a topic matches a subscription filter with `+` and `#`. */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

/**
 * One connection to the broker that Home Assistant reads. What it publishes
 * is retained unless a message says otherwise, `<base>/status` goes
 * `offline` by the broker's last will, and `ready` runs whenever everything
 * should be sent again: on every connect, and when Home Assistant announces
 * it has (re)started. `listen` hears commands and devices' states.
 */
export class MqttLink {
  state: BrokerState = 'off';
  note = '';
  private client: MqttClient | null = null;
  private listeners = new Map<string, Set<(topic: string, payload: string) => void>>();
  constructor(
    private config: Config['mqtt'],
    private clientId: string,
    private ready: () => void,
    private changed: () => void,
    private connect: MqttConnect = mqttConnect,
  ) {}
  private get status() {
    return `${this.config.baseTopic}/status`;
  }
  private set(state: BrokerState, note: string) {
    if (state === this.state && note === this.note) return;
    this.state = state;
    this.note = note;
    this.changed();
  }
  start() {
    if (this.client) return;
    this.set('connecting', 'Connecting to the MQTT broker…');
    const client = this.connect(this.config.url, {
      clientId: this.clientId,
      ...(this.config.username
        ? { username: this.config.username, password: this.config.password }
        : {}),
      will: { topic: this.status, payload: Buffer.from('offline'), retain: true, qos: 1 },
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
    });
    this.client = client;
    const birth = `${this.config.discoveryPrefix}/status`;
    client.on('connect', () => {
      client.publish(this.status, 'online', { retain: true, qos: 1 });
      client.subscribe(birth, { qos: 1 });
      if (this.listeners.size) client.subscribe([...this.listeners.keys()], { qos: 1 });
      this.set('connected', 'Publishing to Home Assistant over MQTT.');
      this.ready();
    });
    client.on('message', (topic, payload) => {
      // Home Assistant asks discovery publishers to send everything again when it starts.
      if (topic === birth && payload.toString() === 'online') return this.ready();
      for (const [filter, handlers] of this.listeners)
        if (topicMatches(filter, topic))
          for (const handle of handlers) {
            try {
              handle(topic, payload.toString());
            } catch {
              // One listener's failure never stops the others or the connection.
            }
          }
    });
    client.on('reconnect', () => this.set('connecting', 'Reconnecting to the MQTT broker…'));
    client.on('offline', () =>
      this.set('connecting', 'The MQTT broker is unreachable. Trying again.'),
    );
    // Broker errors can echo the URL; the lab only gets a generic sentence.
    client.on('error', (error) =>
      this.set(
        'error',
        /auth|not authorized|bad user/i.test(error.message)
          ? 'The MQTT broker refused MQTT_USERNAME and MQTT_PASSWORD.'
          : 'The MQTT broker could not be reached. Check MQTT_URL.',
      ),
    );
  }
  /** Publish one message; while disconnected, retained ones wait for the full resend on connect. */
  publish(message: ExposeMessage): boolean {
    if (!this.client || this.state !== 'connected') return false;
    this.client.publish(message.topic, message.payload, {
      retain: message.retain ?? true,
      qos: 1,
    });
    return true;
  }
  /** Hear messages on a topic filter, from now and after every reconnect. Returns a stop function. */
  listen(filter: string, handle: (topic: string, payload: string) => void): () => void {
    const handlers = this.listeners.get(filter) ?? new Set();
    const fresh = !handlers.size;
    handlers.add(handle);
    this.listeners.set(filter, handlers);
    if (fresh && this.client && this.state === 'connected')
      this.client.subscribe(filter, { qos: 1 });
    return () => {
      handlers.delete(handle);
      if (handlers.size) return;
      this.listeners.delete(filter);
      if (this.client && this.state === 'connected') this.client.unsubscribe(filter);
    };
  }
  async stop() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    if (this.state === 'connected')
      await client.publishAsync(this.status, 'offline', { retain: true, qos: 1 }).catch(() => {});
    await client.endAsync().catch(() => {});
    this.set('off', '');
  }
}
