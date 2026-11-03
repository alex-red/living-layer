import { afterEach, mock, type Mock } from 'bun:test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeskMemory, Mode } from '@livinglayer/domain';
import { buildApp } from '../../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../../apps/server/src/config.js';

type BuildOptions = NonNullable<Parameters<typeof buildApp>[1]>;

export interface TestAppOptions extends BuildOptions {
  /** `.env` values; `DATA_DIR` is the test's own folder unless this names one. */
  env?: Record<string, string>;
  /** Names the folder, so a failing run is easy to find while it lasts. */
  name?: string;
  /** A data folder to start from, copied: the store as an earlier test left it. */
  from?: string;
  /**
   * Whether tracking may call SAM and Spark (the demo's stand-ins, offline).
   * On unless a test says otherwise, so the flows built on SAM's answers keep
   * their tests; the lab itself starts with it off.
   */
  trackingAi?: boolean;
}

const dirs: string[] = [];
const apps: { close: () => Promise<unknown> }[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A data folder removed after the test, for the tests that build more than the one app. */
export function tempDir(name = 'test') {
  const dir = mkdtempSync(join(tmpdir(), `livinglayer-${name}-`));
  dirs.push(dir);
  return dir;
}

/**
 * The lab server on a fresh data folder, with a mocked fetcher unless one is
 * passed, and no web files served. The folder and the app go when the test ends.
 * `post` sends a demo-mode body to `/api/<path>` unless it names another mode.
 */
export async function testApp({
  env = {},
  name,
  from,
  fetcher,
  trackingAi = true,
  ...options
}: TestAppOptions = {}) {
  const dataDir = env.DATA_DIR ?? tempDir(name);
  if (from) cpSync(from, dataDir, { recursive: true });
  const config = parseConfig({ ...env, DATA_DIR: dataDir });
  const sent = (fetcher ?? mock<Fetcher>()) as Mock<Fetcher>;
  const app = await buildApp(config, { serveWeb: false, ...options, fetcher: sent });
  apps.push(app);
  if (trackingAi)
    await app.inject({ method: 'POST', url: '/api/settings/tracking-ai', payload: { on: true } });
  const post = (path: string, body: object = {}) =>
    app.inject({ method: 'POST', url: `/api/${path}`, payload: { mode: 'demo', ...body } });
  const get = (path: string) => app.inject({ method: 'GET', url: `/api/${path}` });
  const memory = async (mode: Mode = 'demo') => (await get(`desk/${mode}`)).json<DeskMemory>();
  return { app, post, get, memory, dataDir, config, fetcher: sent };
}
