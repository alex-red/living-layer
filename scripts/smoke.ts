import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { loadConfig } from '../apps/server/src/config.js';
import { buildApp } from '../apps/server/src/app.js';

const config = loadConfig();
const live = process.argv.includes('--live');
const mode = live ? 'live' : 'fixture';
const imageIndex = process.argv.indexOf('--image');
let imageDataUrl: string | undefined;
if (live) {
  const path = process.argv[imageIndex + 1];
  if (imageIndex < 0 || !path || !/\.(png|jpe?g)$/i.test(path))
    throw new Error('Live smoke requires --image /path/to/desk.png (or .jpg).');
  if (!config.modelApiKey || !config.metaEnabled)
    throw new Error('Live Meta access is not enabled. Run npm run doctor and see the README.');
  const bytes = readFileSync(resolve(path));
  imageDataUrl = `data:image/${extname(path).toLowerCase() === '.png' ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
}
const app = await buildApp(config, { serveWeb: false });
try {
  const probes = [
    { path: 'text' },
    { path: 'discover' },
    { path: 'segment', concept: 'mug' },
    ...(!live
      ? [{ path: 'segment', concept: 'unicorn' }, { path: 'lamp' }]
      : process.argv.includes('--lamp')
        ? [{ path: 'lamp' }]
        : []),
  ];
  for (const probe of probes) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/${probe.path}`,
      payload: {
        mode,
        ...(['discover', 'segment'].includes(probe.path) && imageDataUrl ? { imageDataUrl } : {}),
        ...('concept' in probe ? { concept: probe.concept } : {}),
      },
    });
    const result = response.json();
    if (response.statusCode !== 200)
      throw new Error(`${probe.path}: ${result.error?.message ?? 'failed'}`);
    console.log(`${mode} ${probe.path}: ${result.status} (${result.durationMs} ms) · ${result.id}`);
  }
  const evidence = await app.inject('/api/evidence');
  mkdirSync(resolve(config.dataDir, 'exports'), { recursive: true });
  const path = resolve(config.dataDir, 'exports', `${mode}-smoke.json`);
  writeFileSync(path, evidence.body, { mode: 0o600 });
  console.log(
    `Evidence saved: ${path}\n${live ? 'Observe the physical lamp separately if requested.' : 'Synthetic fixture only; live proof remains pending.'}`,
  );
} finally {
  await app.close();
}
