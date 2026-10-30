/**
 * Entities Living Layer publishes to Home Assistant over MQTT discovery,
 * such as `binary_sensor.ll_office_presence`. A person makes each one in the
 * lab: a name, a key, a kind and what its state comes from. Everything here
 * is pure: `evaluateExposed` works out every state from desk memory and the
 * watcher, and `exposeMessages` turns them into retained MQTT messages, so
 * the lab and the broker always show the same thing.
 */
import { z } from 'zod';
import type { DeskMemory, DeskObservation, ZoneRect } from './index.js';
import type { WatchStatus, WatchView } from './watch.js';

export const EXPOSE_KINDS = ['binary_sensor', 'sensor'] as const;
export type ExposeKind = (typeof EXPOSE_KINDS)[number];
export const MAX_EXPOSED = 16;
/** The main zone's id in a source; rules go by their own id. */
export const MAIN_ZONE = 'main';

const zoneId = z.string().min(1).max(64);
export const exposeSourceSchema = z.discriminatedUnion('kind', [
  /** The zone's last SAM verdict: inside or outside. */
  z.object({ kind: z.literal('in_zone'), zoneId }).strict(),
  /** Whether any of these zones holds its object; as a sensor, how many do. */
  z.object({ kind: z.literal('any_inside'), zoneIds: z.array(zoneId).min(1).max(9) }).strict(),
  /** Which of an object's zones it is in, or `none`. Sensor only. */
  z.object({ kind: z.literal('zone_of'), objectId: z.string().min(1).max(64) }).strict(),
  /** Whether an object or a tracked fixture is seen, being looked for, or missing. */
  z.object({ kind: z.literal('status'), thingId: z.string().min(1).max(64) }).strict(),
  /** On while pixels change inside the zone, off after `holdS` seconds of stillness. No SAM. */
  z
    .object({
      kind: z.literal('motion'),
      zoneId,
      holdS: z.number().int().min(5).max(3600),
    })
    .strict(),
  /** Whether the server is watching the camera. */
  z.object({ kind: z.literal('watching') }).strict(),
]);
export type ExposeSource = z.infer<typeof exposeSourceSchema>;

export const exposeKeySchema = z.string().regex(/^[a-z0-9_]{1,48}$/);
export const exposedInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    key: exposeKeySchema,
    name: z.string().trim().min(1).max(60),
    kind: z.enum(EXPOSE_KINDS),
    source: exposeSourceSchema,
    /** Home Assistant's device class: occupancy, presence, motion, problem… */
    deviceClass: z
      .string()
      .regex(/^[a-z_]{1,32}$/)
      .optional(),
    icon: z
      .string()
      .regex(/^mdi:[a-z0-9-]{1,64}$/)
      .optional(),
  })
  .strict();
export type ExposedInput = z.infer<typeof exposedInputSchema>;
export interface ExposedEntity extends Omit<ExposedInput, 'id'> {
  id: string;
}

/** What one entity shows now. `state` is null only while it's unavailable. */
export interface ExposedState {
  id: string;
  key: string;
  name: string;
  kind: ExposeKind;
  /** The entity id Home Assistant gives it, unless someone renames it there. */
  entityId: string;
  state: string | null;
  available: boolean;
  /** Why it's unavailable, in a sentence. */
  reason?: string;
  attributes: Record<string, string | number | boolean | null>;
}
/** What the evaluation needs from the watcher. */
export interface ExposeWatch {
  state: WatchView['state'];
  things: { id: string; status: WatchStatus }[];
  /** When pixels last changed in each zone, by zone id, in ms. */
  motionAt: Record<string, number>;
}

/** `binary_sensor.ll_office_presence` for the key `office_presence`. */
export const exposedEntityId = (e: Pick<ExposedEntity, 'kind' | 'key'>) => `${e.kind}.ll_${e.key}`;
/** A key from a name: `Office presence` → `office_presence`. */
export function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
    .replace(/_+$/, '');
}

/** Every zone in desk memory, the main one as `main`, with its object and last verdict. */
export function zonesIn(memory: DeskMemory): {
  id: string;
  label: string;
  objectId: string;
  rect: ZoneRect;
  placement: 'inside' | 'outside' | null;
  decidedAt: string | null;
}[] {
  return [
    ...(memory.zone && memory.object
      ? [
          {
            id: MAIN_ZONE,
            label: 'Main zone',
            objectId: memory.object.id,
            rect: memory.zone.rect,
            placement: memory.placement ?? null,
            decidedAt: memory.lastDecision?.createdAt ?? null,
          },
        ]
      : []),
    ...(memory.rules ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      objectId: r.objectId,
      rect: r.zone.rect,
      placement: r.placement ?? null,
      decidedAt: r.lastDecision?.createdAt ?? null,
    })),
  ];
}
/** The mug, other objects and tracked fixtures, by id. */
function thingsIn(memory: DeskMemory): {
  id: string;
  label: string;
  observation: DeskObservation | null;
  missing?: boolean;
}[] {
  return [
    ...(memory.object
      ? [{ id: memory.object.id, label: memory.object.label, observation: memory.observation }]
      : []),
    ...(memory.others ?? []).map((o) => ({ id: o.id, label: o.label, observation: o.observation })),
    ...(memory.fixtures ?? [])
      .filter((f) => f.track)
      .map((f) => ({
        id: f.id,
        label: f.label,
        observation: f.track!.observation,
        missing: f.track!.status === 'missing',
      })),
  ];
}
/** Kinds each source can be shown as. */
export const SOURCE_KINDS: Record<ExposeSource['kind'], readonly ExposeKind[]> = {
  in_zone: ['binary_sensor', 'sensor'],
  any_inside: ['binary_sensor', 'sensor'],
  zone_of: ['sensor'],
  status: ['binary_sensor', 'sensor'],
  motion: ['binary_sensor'],
  watching: ['binary_sensor', 'sensor'],
};
/** What a source names that no longer exists, or null. */
function missingPart(memory: DeskMemory, source: ExposeSource): string | null {
  const zones = new Set(zonesIn(memory).map((z) => z.id));
  const things = new Set(thingsIn(memory).map((t) => t.id));
  switch (source.kind) {
    case 'in_zone':
    case 'motion':
      return zones.has(source.zoneId) ? null : 'Its zone is gone.';
    case 'any_inside':
      return source.zoneIds.every((z) => zones.has(z)) ? null : 'One of its zones is gone.';
    case 'zone_of':
      return things.has(source.objectId) ? null : 'Its object is gone.';
    case 'status':
      return things.has(source.thingId) ? null : 'What it follows is gone.';
    case 'watching':
      return null;
  }
}
/** Why an entity can't be saved, or null. */
export function exposeProblem(memory: DeskMemory, input: ExposedInput): string | null {
  const others = (memory.exposed ?? []).filter((e) => e.id !== input.id);
  if (others.some((e) => e.key === input.key && e.kind === input.kind))
    return `${exposedEntityId(input)} is taken. Choose another key.`;
  if (!input.id && others.length >= MAX_EXPOSED)
    return `Up to ${MAX_EXPOSED} entities can be shown in Home Assistant.`;
  if (!SOURCE_KINDS[input.source.kind].includes(input.kind))
    return `That can only be a ${SOURCE_KINDS[input.source.kind].join(' or ').replace(/_/g, ' ')}.`;
  return missingPart(memory, input.source);
}

/** The values a sensor can take, for Home Assistant's `enum` device class. */
export function sensorOptions(memory: DeskMemory, e: ExposedEntity): string[] | null {
  if (e.kind !== 'sensor') return null;
  switch (e.source.kind) {
    case 'in_zone':
      return ['inside', 'outside'];
    case 'zone_of': {
      const id = e.source.objectId;
      return [
        ...zonesIn(memory)
          .filter((z) => z.objectId === id)
          .map((z) => z.label),
        'none',
      ];
    }
    case 'status':
      return ['seen', 'searching', 'missing'];
    case 'watching':
      return ['off', 'starting', 'watching', 'paused', 'camera_lost'];
    default:
      return null;
  }
}

const running = (watch: ExposeWatch | null) =>
  watch?.state === 'watching' || watch?.state === 'paused';
const binary = (on: boolean) => (on ? 'ON' : 'OFF');

/** Every entity's state now, from desk memory and what the watcher sees. */
export function evaluateExposed(
  memory: DeskMemory,
  watch: ExposeWatch | null,
  now = Date.now(),
): ExposedState[] {
  const zones = zonesIn(memory);
  const things = thingsIn(memory);
  // While the watcher runs, a verdict stands until SAM changes it; without it, nobody is looking.
  const stale = !running(watch);
  return (memory.exposed ?? []).map((e) => {
    const base = { id: e.id, key: e.key, name: e.name, kind: e.kind, entityId: exposedEntityId(e) };
    const off = (reason: string): ExposedState => ({
      ...base,
      state: null,
      available: false,
      reason,
      attributes: {},
    });
    const on = (state: string, attributes: ExposedState['attributes']): ExposedState => ({
      ...base,
      state,
      available: true,
      attributes,
    });
    const missing = missingPart(memory, e.source);
    if (missing) return off(missing);
    const s = e.source;
    switch (s.kind) {
      case 'in_zone': {
        const zone = zones.find((z) => z.id === s.zoneId)!;
        if (!zone.placement) return off(`No verdict for "${zone.label}" yet.`);
        const inside = zone.placement === 'inside';
        return on(e.kind === 'sensor' ? zone.placement : binary(inside), {
          source: 'sam',
          zone: zone.label,
          object: things.find((t) => t.id === zone.objectId)?.label ?? null,
          last_confirmed: zone.decidedAt,
          stale,
        });
      }
      case 'any_inside': {
        const picked = zones.filter((z) => s.zoneIds.includes(z.id));
        if (picked.every((z) => !z.placement)) return off('None of its zones has a verdict yet.');
        const inside = picked.filter((z) => z.placement === 'inside');
        return on(e.kind === 'sensor' ? String(inside.length) : binary(inside.length > 0), {
          source: 'sam',
          inside: inside.map((z) => z.label).join(', ') || null,
          stale,
        });
      }
      case 'zone_of': {
        const mine = zones.filter((z) => z.objectId === s.objectId);
        if (mine.every((z) => !z.placement)) return off('None of its zones has a verdict yet.');
        const thing = things.find((t) => t.id === s.objectId)!;
        return on(mine.find((z) => z.placement === 'inside')?.label ?? 'none', {
          source: 'sam',
          object: thing.label,
          observed_at: thing.observation?.observedAt ?? null,
          stale,
        });
      }
      case 'status': {
        const thing = things.find((t) => t.id === s.thingId)!;
        const watched = running(watch) ? watch!.things.find((t) => t.id === s.thingId) : null;
        const status: 'seen' | 'searching' | 'missing' = watched
          ? watched.status === 'following'
            ? 'seen'
            : watched.status === 'unsure'
              ? 'searching'
              : 'missing'
          : thing.missing
            ? 'missing'
            : thing.observation
              ? 'seen'
              : 'missing';
        return on(e.kind === 'sensor' ? status : binary(status === 'missing'), {
          source: watched ? 'watcher' : 'memory',
          thing: thing.label,
          observed_at: thing.observation?.observedAt ?? null,
          stale: !watched,
        });
      }
      case 'motion': {
        if (!running(watch)) return off('Motion needs the server watching the camera.');
        if (!memory.fixedCamera) return off('Motion needs the camera marked fixed.');
        const at = watch!.motionAt[s.zoneId];
        const moving = at !== undefined && now - at < s.holdS * 1000;
        return on(binary(moving), {
          source: 'motion',
          zone: zones.find((z) => z.id === s.zoneId)!.label,
          last_motion: at === undefined ? null : new Date(at).toISOString(),
          hold_s: s.holdS,
        });
      }
      case 'watching': {
        const state = watch?.state ?? 'off';
        return on(e.kind === 'sensor' ? state : binary(running(watch)), { source: 'watcher' });
      }
    }
  });
}

export type BrokerState = 'off' | 'connecting' | 'connected' | 'error';
/** What the lab shows of one mode's entities in Home Assistant; sent on every change. */
export interface ExposeView {
  mode: 'demo' | 'live';
  broker: { state: BrokerState; note: string };
  states: ExposedState[];
  /** Demo only: what would have been published, newest first. */
  log: { at: string; topic: string; payload: string }[];
}
export interface ExposeOptions {
  installId: string;
  discoveryPrefix: string;
  baseTopic: string;
  version: string;
}
/** A retained MQTT message; an empty payload clears the topic. */
export interface ExposeMessage {
  topic: string;
  payload: string;
}
export const statusTopic = (o: Pick<ExposeOptions, 'baseTopic'>) => `${o.baseTopic}/status`;
export const configTopic = (o: ExposeOptions, e: Pick<ExposedEntity, 'kind' | 'key'>) =>
  `${o.discoveryPrefix}/${e.kind}/ll_${e.key}/config`;

/** The retained discovery config for one entity. */
export function discoveryConfig(
  memory: DeskMemory,
  e: ExposedEntity,
  o: ExposeOptions,
): Record<string, unknown> {
  const topic = `${o.baseTopic}/${e.key}`;
  const options = sensorOptions(memory, e);
  return {
    name: e.name,
    unique_id: `livinglayer_${o.installId}_${e.id}`,
    default_entity_id: exposedEntityId(e),
    state_topic: `${topic}/state`,
    json_attributes_topic: `${topic}/attributes`,
    availability: [{ topic: statusTopic(o) }, { topic: `${topic}/availability` }],
    availability_mode: 'all',
    ...(e.kind === 'binary_sensor' ? { payload_on: 'ON', payload_off: 'OFF' } : {}),
    ...(options ? { device_class: 'enum', options } : {}),
    ...(e.deviceClass && !options ? { device_class: e.deviceClass } : {}),
    ...(e.kind === 'sensor' && e.source.kind === 'any_inside'
      ? { state_class: 'measurement' }
      : {}),
    ...(e.icon ? { icon: e.icon } : {}),
    device: {
      identifiers: [`livinglayer_${o.installId}`],
      name: 'Living Layer',
      manufacturer: 'Living Layer',
      sw_version: o.version,
    },
    origin: { name: 'Living Layer', sw_version: o.version },
  };
}
/**
 * Every retained message the entities need, configs first, so a diff against
 * what was last sent publishes changes and clears what went away.
 */
export function exposeMessages(
  memory: DeskMemory,
  states: ExposedState[],
  o: ExposeOptions,
): ExposeMessage[] {
  const configs: ExposeMessage[] = [];
  const rest: ExposeMessage[] = [];
  for (const e of memory.exposed ?? []) {
    const s = states.find((x) => x.id === e.id);
    if (!s) continue;
    const topic = `${o.baseTopic}/${e.key}`;
    configs.push({
      topic: configTopic(o, e),
      payload: JSON.stringify(discoveryConfig(memory, e, o)),
    });
    rest.push({ topic: `${topic}/availability`, payload: s.available ? 'online' : 'offline' });
    if (s.state !== null) {
      rest.push({ topic: `${topic}/state`, payload: s.state });
      rest.push({ topic: `${topic}/attributes`, payload: JSON.stringify(s.attributes) });
    }
  }
  return [...configs, ...rest];
}
