import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { CameraRelay } from './relay.js';
import { lanAddress } from './remote.js';
import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import type { Config } from './config.js';
import type { RelayReader } from './relay.js';

/**
 * The GPU tracker as a reader of the camera relay, when one is configured:
 * it reads the relayed camera from this machine instead of the camera. Only
 * from its own addresses, when its host resolves.
 */
async function gpuReader(config: Config): Promise<RelayReader | undefined> {
  if (!config.gpuTracker) return undefined;
  const ips = await lookup(new URL(config.gpuTracker.url).hostname, { all: true })
    .then((found) => found.map((a) => a.address))
    .catch(() => []);
  // This machine's address on the way there: with several networks, the one it reaches us by.
  const host = (ips[0] && (await addressToward(ips[0]))) || lanAddress();
  return host ? { host, pass: config.gpuTracker.token, ips } : undefined;
}
/** The local address the system would send from to `ip`; a UDP socket's connect sends nothing. */
function addressToward(ip: string): Promise<string | null> {
  return new Promise((done) => {
    const socket = createSocket(ip.includes(':') ? 'udp6' : 'udp4');
    socket.on('error', () => (socket.close(), done(null)));
    socket.connect(9, ip, () => {
      const { address } = socket.address();
      socket.close();
      done(address);
    });
  });
}

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
/**
 * Closes the app, which stops the watchers, ffmpeg and the relay, then ends
 * the process. Under `bun --watch` a closed app doesn't end it: the process
 * waits for the next change and starts the server again, with nobody left to
 * stop it.
 */
async function shutdown() {
  setTimeout(() => process.exit(0), 5000).unref();
  await app?.close().catch(() => {});
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.once(signal, () => void shutdown());
// In dev, `bun run dev` can go without telling its children (a closed terminal, a kill -9): go
// with it. Reloading keeps the process, so one already orphaned starts under PID 1. Only in dev
// (`scripts/dev.ts` sets LIVING_LAYER_DEV, or --watch): a server run by a service manager has PID 1
// for a parent by design.
if (
  process.env.LIVING_LAYER_DEV === '1' ||
  process.execArgv.some((a) => a === '--watch' || a === '--hot')
) {
  const parent = process.ppid;
  if (parent === 1) void shutdown();
  setInterval(() => {
    if (process.ppid !== parent) void shutdown();
  }, 2000).unref();
}

try {
  const config = loadConfig();
  const { binary, port } = config.cameraRelay;
  app = await buildApp(config, {
    relay: CameraRelay.find(config.dataDir, binary, port, undefined, await gpuReader(config)),
  });
  // A server that is ending (a reload, a restart) can hold the port a moment longer: wait for it.
  for (let tries = 1; ; tries++)
    try {
      await app.listen({ host: '127.0.0.1', port: config.port });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EADDRINUSE' || tries >= 20) throw error;
      await Bun.sleep(500);
    }
  // Under `bun run dev` the lab is Vite's page; this one serves the last build, so it names itself the API.
  console.log(
    process.env.LIVING_LAYER_DEV
      ? `API server: http://127.0.0.1:${config.port}/api (open the lab at the dev page, not here)`
      : `Living Layer: http://127.0.0.1:${config.port}`,
  );
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  // A server that can't listen (another holds the port) stops its watchers too.
  await app?.close().catch(() => {});
  console.error(
    'Living Layer could not start. Check .env against .env.example, the port, and the local data directory. Configuration values were not logged.',
  );
  process.exitCode = 1;
}
