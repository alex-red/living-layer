import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
const schema = z.object({
  PORT: z.coerce.number().int().min(1024).max(65535).default(43431),
  DATA_DIR: z.string().default('.data'),
  MODEL_API_KEY: z.string().default(''),
  META_SPARK_MODEL: z
    .string()
    .regex(/^muse-spark-[\w.-]+$/)
    .default('muse-spark-1.3'),
  META_SAM_MODEL: z.literal('sam-3.1').default('sam-3.1'),
  META_IMAGE_MODEL: z.literal('muse-image-1.0').default('muse-image-1.0'),
  META_LIVE_ENABLED: flag,
  /** The most today's live Meta calls may cost (UTC day); changeable in the lab. */
  META_DAILY_SPEND_LIMIT_USD: z.coerce.number().positive().max(1000).default(10),
  META_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  /**
   * SAM 3D Objects, for refining a fixture's shape (experimental): on this
   * machine through mlx-spatial (its weights folder and its command), else
   * fal.ai's host with FAL_KEY. Off unless SAM3D_ENABLED is true, whatever is set.
   */
  SAM3D_ENABLED: flag,
  SAM3D_MLX_WEIGHTS: z.string().default(''),
  SAM3D_MLX_BIN: z.string().default('mlx-spatial-sam3d'),
  FAL_KEY: z.string().default(''),
  HA_URL: z.string().default(''),
  HA_TOKEN: z.string().default(''),
  HA_ENTITY_ID: z.string().default(''),
  /** More lights that placement rules may switch, comma-separated. */
  HA_EXTRA_ENTITY_IDS: z.string().default(''),
  /** Switches that fixtures and rules may turn on and off, comma-separated. */
  HA_SWITCH_ENTITY_IDS: z.string().default(''),
  HA_LIVE_ENABLED: flag,
  /** Network camera WHEP URLs, comma-separated, for networks where mDNS discovery is blocked. */
  CAMERA_STREAMS: z.string().default(''),
  /** mediamtx, which relays saved RTSP cameras to the tab as WebRTC; `off` for the MJPEG preview. */
  CAMERA_RELAY: z.string().default('mediamtx'),
  /** The relay's WHEP port, loopback only; RTSP and WebRTC media (UDP) take the next two. */
  CAMERA_RELAY_PORT: z.coerce.number().int().min(1024).max(65533).default(43433),
  /** HTTPS port the phone opens to act as a remote camera; only listens once a phone is paired. */
  REMOTE_CAMERA_PORT: z.coerce.number().int().min(1024).max(65535).default(43432),
  /** Address the pairing QR code points at, when the detected LAN address is wrong. */
  REMOTE_CAMERA_HOST: z.string().default(''),
  /** PEM files for the phone page, e.g. from mkcert. Unset, a self-signed pair is made in DATA_DIR. */
  REMOTE_CAMERA_CERT: z.string().default(''),
  REMOTE_CAMERA_KEY: z.string().default(''),
  /** The MQTT broker entities are published to for Home Assistant: mqtt:// or mqtts://. */
  MQTT_URL: z.string().default(''),
  MQTT_USERNAME: z.string().default(''),
  MQTT_PASSWORD: z.string().default(''),
  /** Home Assistant's discovery prefix, `homeassistant` unless changed there. */
  MQTT_DISCOVERY_PREFIX: z
    .string()
    .regex(/^[\w-]+(\/[\w-]+)*$/)
    .default('homeassistant'),
  /** The topic every state is published under. */
  MQTT_BASE_TOPIC: z
    .string()
    .regex(/^[\w-]+(\/[\w-]+)*$/)
    .default('livinglayer'),
  MQTT_LIVE_ENABLED: flag,
  /** Lights and switches switched over MQTT: `light.desk=zigbee2mqtt/Desk lamp`, comma-separated. */
  MQTT_DEVICES: z.string().default(''),
});

/** The part of `fetch` the adapters use, so tests can pass a plain mock. */
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface Config {
  port: number;
  dataDir: string;
  modelApiKey: string;
  sparkModel: string;
  samModel: string;
  imageModel: string;
  metaEnabled: boolean;
  spendLimitUsd: number;
  timeoutMs: number;
  /** Where SAM 3D runs, when it can: this machine, fal.ai, or nowhere. */
  sam3d: { kind: 'local'; weights: string; bin: string } | { kind: 'fal'; key: string } | null;
  haUrl: string;
  haToken: string;
  haEntity: string;
  /** Every light a rule may switch: the main one first, then the extras. */
  haLights: string[];
  /** Every switch a fixture or rule may turn on and off. */
  haSwitches: string[];
  haEnabled: boolean;
  cameraStreams: string[];
  cameraRelay: { binary: string; port: number };
  remoteCamera: { port: number; host: string; cert: string; key: string };
  mqtt: {
    url: string;
    username: string;
    password: string;
    discoveryPrefix: string;
    baseTopic: string;
    enabled: boolean;
    /** Lights and switches switched over MQTT, each by the topic it reports its state on. */
    devices: { entityId: string; topic: string }[];
  };
}

export function parseConfig(env: NodeJS.ProcessEnv, cwd = process.cwd()): Config {
  const value = schema.parse(env);
  if (value.META_SPARK_MODEL.includes('contributor')) {
    throw new Error('This home-camera workbench requires a Standard-mode Spark model.');
  }
  if (value.HA_URL) {
    const url = new URL(value.HA_URL);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '')
    ) {
      throw new Error(
        'HA_URL must be an HTTP(S) instance origin without credentials, path, query, or fragment.',
      );
    }
  }
  if (value.HA_ENTITY_ID && !/^light\.[a-z0-9_]+$/.test(value.HA_ENTITY_ID)) {
    throw new Error('HA_ENTITY_ID must identify one light entity.');
  }
  const extras = value.HA_EXTRA_ENTITY_IDS.split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (extras.some((e) => !/^light\.[a-z0-9_]+$/.test(e)))
    throw new Error('HA_EXTRA_ENTITY_IDS must list light entities, separated by commas.');
  if (extras.length && !value.HA_ENTITY_ID)
    throw new Error('Set HA_ENTITY_ID, the main light, before listing extra lights.');
  const switches = value.HA_SWITCH_ENTITY_IDS.split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (switches.some((e) => !/^switch\.[a-z0-9_]+$/.test(e)))
    throw new Error('HA_SWITCH_ENTITY_IDS must list switch entities, separated by commas.');
  const cameraStreams = value.CAMERA_STREAMS.split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  for (const stream of cameraStreams) {
    const url = URL.parse(stream);
    if (
      !url ||
      !['http:', 'https:', 'rtsp:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('CAMERA_STREAMS must list HTTP(S) WHEP or RTSP URLs without credentials.');
  }
  if (value.REMOTE_CAMERA_HOST && !/^[\w.-]+$/.test(value.REMOTE_CAMERA_HOST))
    throw new Error('REMOTE_CAMERA_HOST must be a bare host name or IP address.');
  if (Boolean(value.REMOTE_CAMERA_CERT) !== Boolean(value.REMOTE_CAMERA_KEY))
    throw new Error('Set both REMOTE_CAMERA_CERT and REMOTE_CAMERA_KEY, or neither.');
  if (value.MQTT_URL) {
    const url = URL.parse(value.MQTT_URL);
    if (
      !url ||
      !['mqtt:', 'mqtts:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.pathname && url.pathname !== '/') ||
      url.search ||
      url.hash
    )
      throw new Error(
        'MQTT_URL must be mqtt://host:port or mqtts://host:port, with credentials in MQTT_USERNAME and MQTT_PASSWORD.',
      );
  }
  const devices = value.MQTT_DEVICES.split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const at = e.indexOf('=');
      return { entityId: e.slice(0, at).trim(), topic: e.slice(at + 1).trim() };
    });
  for (const d of devices)
    if (
      !/^(light|switch)\.[a-z0-9_]+$/.test(d.entityId) ||
      !d.topic ||
      /[+#]|^\/|\/$/.test(d.topic)
    )
      throw new Error(
        'MQTT_DEVICES must list light.* or switch.* entities with their MQTT topics, e.g. light.desk=zigbee2mqtt/Desk lamp.',
      );
  const known = new Set([value.HA_ENTITY_ID, ...extras, ...switches]);
  if (
    devices.some((d) => known.has(d.entityId)) ||
    new Set(devices.map((d) => d.entityId)).size !== devices.length
  )
    throw new Error(
      'Each entity in MQTT_DEVICES must be listed once, and not among the HA_* entities.',
    );
  if (value.REMOTE_CAMERA_PORT === value.PORT)
    throw new Error('REMOTE_CAMERA_PORT must differ from PORT.');
  const relayPorts = [0, 1, 2].map((k) => value.CAMERA_RELAY_PORT + k);
  if (relayPorts.some((p) => p === value.PORT || p === value.REMOTE_CAMERA_PORT))
    throw new Error('CAMERA_RELAY_PORT and the two ports after it must differ from the others.');
  return {
    port: value.PORT,
    dataDir: resolve(cwd, value.DATA_DIR),
    modelApiKey: value.MODEL_API_KEY,
    sparkModel: value.META_SPARK_MODEL,
    samModel: value.META_SAM_MODEL,
    imageModel: value.META_IMAGE_MODEL,
    metaEnabled: value.META_LIVE_ENABLED,
    spendLimitUsd: value.META_DAILY_SPEND_LIMIT_USD,
    timeoutMs: value.META_TIMEOUT_MS,
    sam3d: !value.SAM3D_ENABLED
      ? null
      : value.SAM3D_MLX_WEIGHTS
        ? { kind: 'local', weights: value.SAM3D_MLX_WEIGHTS, bin: value.SAM3D_MLX_BIN }
        : value.FAL_KEY
          ? { kind: 'fal', key: value.FAL_KEY }
          : null,
    haUrl: value.HA_URL.replace(/\/$/, ''),
    haToken: value.HA_TOKEN,
    haEntity: value.HA_ENTITY_ID,
    haLights: [...new Set([value.HA_ENTITY_ID, ...extras].filter(Boolean))],
    haSwitches: [...new Set(switches)],
    haEnabled: value.HA_LIVE_ENABLED,
    cameraStreams,
    cameraRelay: { binary: value.CAMERA_RELAY, port: value.CAMERA_RELAY_PORT },
    remoteCamera: {
      port: value.REMOTE_CAMERA_PORT,
      host: value.REMOTE_CAMERA_HOST,
      cert: value.REMOTE_CAMERA_CERT && resolve(cwd, value.REMOTE_CAMERA_CERT),
      key: value.REMOTE_CAMERA_KEY && resolve(cwd, value.REMOTE_CAMERA_KEY),
    },
    mqtt: {
      url: value.MQTT_URL,
      username: value.MQTT_USERNAME,
      password: value.MQTT_PASSWORD,
      discoveryPrefix: value.MQTT_DISCOVERY_PREFIX,
      baseTopic: value.MQTT_BASE_TOPIC,
      enabled: value.MQTT_LIVE_ENABLED,
      devices,
    },
  };
}

/** Bun loads `.env` from the working directory, so run entry points from the project root. */
export function loadConfig(): Config {
  return parseConfig(process.env, PROJECT_ROOT);
}
