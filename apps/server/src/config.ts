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
  /** HTTPS port the phone opens to act as a remote camera; only listens once a phone is paired. */
  REMOTE_CAMERA_PORT: z.coerce.number().int().min(1024).max(65535).default(43432),
  /** Address the pairing QR code points at, when the detected LAN address is wrong. */
  REMOTE_CAMERA_HOST: z.string().default(''),
  /** PEM files for the phone page, e.g. from mkcert. Unset, a self-signed pair is made in DATA_DIR. */
  REMOTE_CAMERA_CERT: z.string().default(''),
  REMOTE_CAMERA_KEY: z.string().default(''),
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
  haUrl: string;
  haToken: string;
  haEntity: string;
  /** Every light a rule may switch: the main one first, then the extras. */
  haLights: string[];
  /** Every switch a fixture or rule may turn on and off. */
  haSwitches: string[];
  haEnabled: boolean;
  cameraStreams: string[];
  remoteCamera: { port: number; host: string; cert: string; key: string };
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
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('CAMERA_STREAMS must list HTTP(S) WHEP URLs without credentials.');
  }
  if (value.REMOTE_CAMERA_HOST && !/^[\w.-]+$/.test(value.REMOTE_CAMERA_HOST))
    throw new Error('REMOTE_CAMERA_HOST must be a bare host name or IP address.');
  if (Boolean(value.REMOTE_CAMERA_CERT) !== Boolean(value.REMOTE_CAMERA_KEY))
    throw new Error('Set both REMOTE_CAMERA_CERT and REMOTE_CAMERA_KEY, or neither.');
  if (value.REMOTE_CAMERA_PORT === value.PORT)
    throw new Error('REMOTE_CAMERA_PORT must differ from PORT.');
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
    haUrl: value.HA_URL.replace(/\/$/, ''),
    haToken: value.HA_TOKEN,
    haEntity: value.HA_ENTITY_ID,
    haLights: [...new Set([value.HA_ENTITY_ID, ...extras].filter(Boolean))],
    haSwitches: [...new Set(switches)],
    haEnabled: value.HA_LIVE_ENABLED,
    cameraStreams,
    remoteCamera: {
      port: value.REMOTE_CAMERA_PORT,
      host: value.REMOTE_CAMERA_HOST,
      cert: value.REMOTE_CAMERA_CERT && resolve(cwd, value.REMOTE_CAMERA_CERT),
      key: value.REMOTE_CAMERA_KEY && resolve(cwd, value.REMOTE_CAMERA_KEY),
    },
  };
}

/** Bun loads `.env` from the working directory, so run entry points from the project root. */
export function loadConfig(): Config {
  return parseConfig(process.env, PROJECT_ROOT);
}
