import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { CameraRelay } from './relay.js';

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  const config = loadConfig();
  const { binary, port } = config.cameraRelay;
  app = await buildApp(config, { relay: CameraRelay.find(config.dataDir, binary, port) });
  await app.listen({ host: '127.0.0.1', port: config.port });
  console.log(`LivingLayer desk lab: http://127.0.0.1:${config.port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void app?.close();
    });
} catch {
  // A server that can't listen (another holds the port) stops its watchers too.
  await app?.close().catch(() => {});
  console.error(
    'LivingLayer could not start. Check .env against .env.example, the port, and the local data directory. Configuration values were not logged.',
  );
  process.exitCode = 1;
}
