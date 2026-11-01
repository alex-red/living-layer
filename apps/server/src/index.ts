import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { CameraRelay } from './relay.js';

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
// with it. Reloading keeps the process, so one already orphaned starts under PID 1. Only under
// --watch: a server run by a service manager has PID 1 for a parent by design.
if (process.execArgv.some((a) => a === '--watch' || a === '--hot')) {
  const parent = process.ppid;
  if (parent === 1) void shutdown();
  setInterval(() => {
    if (process.ppid !== parent) void shutdown();
  }, 2000).unref();
}

try {
  const config = loadConfig();
  const { binary, port } = config.cameraRelay;
  app = await buildApp(config, { relay: CameraRelay.find(config.dataDir, binary, port) });
  // A server that is ending (a reload, a restart) can hold the port a moment longer: wait for it.
  for (let tries = 1; ; tries++)
    try {
      await app.listen({ host: '127.0.0.1', port: config.port });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EADDRINUSE' || tries >= 20) throw error;
      await Bun.sleep(500);
    }
  console.log(`LivingLayer desk lab: http://127.0.0.1:${config.port}`);
} catch {
  // A server that can't listen (another holds the port) stops its watchers too.
  await app?.close().catch(() => {});
  console.error(
    'LivingLayer could not start. Check .env against .env.example, the port, and the local data directory. Configuration values were not logged.',
  );
  process.exitCode = 1;
}
