import { loadConfig } from '../apps/server/src/config.js';
try {
  const config = loadConfig();
  console.log('LivingLayer readiness (no network requests)');
  console.log(`Bun ${Bun.version}; data directory: ${config.dataDir}`);
  console.log(
    `Meta key: ${config.modelApiKey ? 'present' : 'missing'}; live enabled: ${config.metaEnabled}`,
  );
  console.log(
    `Models: ${config.sparkModel}, ${config.samModel}; request allowance: ${config.maxRequests}/UTC day`,
  );
  console.log(
    `Home Assistant: ${config.haUrl && config.haToken && config.haEntity ? 'configured' : 'incomplete'}; live enabled: ${config.haEnabled}`,
  );
  console.log(
    'Fixture workflow is available without credentials. Live connectivity and physical effect are not tested by doctor.',
  );
} catch {
  console.error(
    'Invalid configuration. Compare your local .env with .env.example; values were not printed.',
  );
  process.exitCode = 1;
}
