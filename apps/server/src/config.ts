import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
const schema = z.object({
  PORT: z.coerce.number().int().min(1024).max(65535).default(4310),
  DATA_DIR: z.string().default('.data'),
  MODEL_API_KEY: z.string().default(''),
  META_SPARK_MODEL: z
    .string()
    .regex(/^muse-spark-[\w.-]+$/)
    .default('muse-spark-1.3'),
  META_SAM_MODEL: z.literal('sam-3.1').default('sam-3.1'),
  META_LIVE_ENABLED: flag,
  /** The most today's live Meta calls may cost (UTC day); changeable in the lab. */
  META_DAILY_SPEND_LIMIT_USD: z.coerce.number().positive().max(1000).default(10),
  META_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  HA_URL: z.string().default(''),
  HA_TOKEN: z.string().default(''),
  HA_ENTITY_ID: z.string().default(''),
  /** More lights that placement rules may switch, comma-separated. */
  HA_EXTRA_ENTITY_IDS: z.string().default(''),
  HA_LIVE_ENABLED: flag,
  /** Network camera WHEP URLs, comma-separated, for networks where mDNS discovery is blocked. */
  CAMERA_STREAMS: z.string().default(''),
});

/** The part of `fetch` the adapters use, so tests can pass a plain mock. */
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface Config {
  port: number;
  dataDir: string;
  modelApiKey: string;
  sparkModel: string;
  samModel: string;
  metaEnabled: boolean;
  spendLimitUsd: number;
  timeoutMs: number;
  haUrl: string;
  haToken: string;
  haEntity: string;
  /** Every light a rule may switch: the main one first, then the extras. */
  haLights: string[];
  haEnabled: boolean;
  cameraStreams: string[];
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
  const cameraStreams = value.CAMERA_STREAMS.split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  for (const stream of cameraStreams) {
    const url = URL.parse(stream);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('CAMERA_STREAMS must list HTTP(S) WHEP URLs without credentials.');
  }
  return {
    port: value.PORT,
    dataDir: resolve(cwd, value.DATA_DIR),
    modelApiKey: value.MODEL_API_KEY,
    sparkModel: value.META_SPARK_MODEL,
    samModel: value.META_SAM_MODEL,
    metaEnabled: value.META_LIVE_ENABLED,
    spendLimitUsd: value.META_DAILY_SPEND_LIMIT_USD,
    timeoutMs: value.META_TIMEOUT_MS,
    haUrl: value.HA_URL.replace(/\/$/, ''),
    haToken: value.HA_TOKEN,
    haEntity: value.HA_ENTITY_ID,
    haLights: [...new Set([value.HA_ENTITY_ID, ...extras].filter(Boolean))],
    haEnabled: value.HA_LIVE_ENABLED,
    cameraStreams,
  };
}

/** Bun loads `.env` from the working directory, so run entry points from the project root. */
export function loadConfig(): Config {
  return parseConfig(process.env, PROJECT_ROOT);
}
