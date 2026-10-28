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
  META_MAX_REQUESTS_PER_DAY: z.coerce.number().int().min(1).max(1000).default(20),
  META_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  HA_URL: z.string().default(''),
  HA_TOKEN: z.string().default(''),
  HA_ENTITY_ID: z.string().default(''),
  HA_LIVE_ENABLED: flag,
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
  maxRequests: number;
  timeoutMs: number;
  haUrl: string;
  haToken: string;
  haEntity: string;
  haEnabled: boolean;
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
  return {
    port: value.PORT,
    dataDir: resolve(cwd, value.DATA_DIR),
    modelApiKey: value.MODEL_API_KEY,
    sparkModel: value.META_SPARK_MODEL,
    samModel: value.META_SAM_MODEL,
    metaEnabled: value.META_LIVE_ENABLED,
    maxRequests: value.META_MAX_REQUESTS_PER_DAY,
    timeoutMs: value.META_TIMEOUT_MS,
    haUrl: value.HA_URL.replace(/\/$/, ''),
    haToken: value.HA_TOKEN,
    haEntity: value.HA_ENTITY_ID,
    haEnabled: value.HA_LIVE_ENABLED,
  };
}

/** Bun loads `.env` from the working directory, so run entry points from the project root. */
export function loadConfig(): Config {
  return parseConfig(process.env, PROJECT_ROOT);
}
