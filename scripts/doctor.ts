import { existsSync } from 'node:fs';
import { loadConfig } from '../apps/server/src/config.js';
import { APPEARANCE_MODEL, appearanceModelPath } from '../apps/server/src/appearance.js';
try {
  const config = loadConfig();
  console.log('LivingLayer readiness (no network requests)');
  console.log(`Bun ${Bun.version}; data directory: ${config.dataDir}`);
  console.log(
    `Meta key: ${config.modelApiKey ? 'present' : 'missing'}; live enabled: ${config.metaEnabled}`,
  );
  console.log(
    `Models: ${config.sparkModel}, ${config.samModel}; spending limit: $${config.spendLimitUsd}/UTC day (changeable in the lab)`,
  );
  console.log(
    `Home Assistant: ${config.haUrl && config.haToken && config.haEntity ? 'configured' : 'incomplete'}; live enabled: ${config.haEnabled}`,
  );
  console.log(
    `Watching a live camera: ffmpeg ${Bun.which('ffmpeg') ? 'found' : 'missing (brew install ffmpeg)'}; ${config.cameraStreams.filter((s) => s.startsWith('rtsp://')).length} RTSP camera(s) configured, more found over mDNS`,
  );
  console.log(
    `Finding lost things by appearance: ${APPEARANCE_MODEL.name} ${existsSync(appearanceModelPath(config.dataDir)) ? 'present' : 'missing (bun run fetch-model; without it lost things go straight to SAM)'}`,
  );
  console.log(
    'Demo workflow is available without credentials. Live connectivity and physical effect are not tested by doctor.',
  );
} catch {
  console.error(
    'Invalid configuration. Compare your local .env with .env.example; values were not printed.',
  );
  process.exitCode = 1;
}
