import { loadConfig } from './config.js';
import { buildApp } from './app.js';

try {
  const config = loadConfig();
  const app = await buildApp(config);
  await app.listen({ host: '127.0.0.1', port: config.port });
  console.log(`LivingLayer desk lab: http://127.0.0.1:${config.port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void app.close();
    });
} catch {
  console.error(
    'LivingLayer could not start. Check .env against .env.example, the port, and the local data directory. Configuration values were not logged.',
  );
  process.exitCode = 1;
}
