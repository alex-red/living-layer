import type { DeskMemory } from '@livinglayer/domain';
import type { StaticSeed } from '../../apps/web/src/static-demo/backend.js';

interface Injects {
  inject: (o: {
    method: 'GET' | 'POST';
    url: string;
    payload?: object;
  }) => PromiseLike<{ statusCode: number; json: () => unknown }>;
}

/** What the page reads once and the static demo answers as saved: lists that stay empty without a server. */
const GETS = [
  'status',
  'runs',
  'saves',
  'streams',
  'cameras',
  'remote',
  'ha/entities',
  'busy',
  'coach/demo',
  'expose/demo',
  'expose/live',
  'watch/demo',
  'watch/live',
  'desk/live',
];

/**
 * The static demo's seed: a fresh demo (its household, fridge and litter room
 * brought in as a reset does) as the lab server answers it, for the page to
 * start from (`staticBackend`). Each thing's week of stats goes in too.
 */
export async function captureSeed(app: Injects, at = Date.now()): Promise<StaticSeed> {
  const reset = await app.inject({ method: 'POST', url: '/api/desk/demo/reset' });
  if (reset.statusCode !== 200) throw new Error(`The demo reset answered ${reset.statusCode}.`);
  const demo = reset.json() as DeskMemory;
  const seed: StaticSeed = { at, get: { 'desk/demo': demo }, post: {} };
  const paths = [...GETS, ...(demo.fixtures ?? []).map((f) => `things/demo/${f.id}/stats?days=7`)];
  for (const path of paths) {
    const response = await app.inject({ method: 'GET', url: `/api/${path}` });
    if (response.statusCode === 200) seed.get[path] = response.json();
  }
  // The demo's virtual desktop only: live's list is what this machine's network has on it.
  const nodes = await app.inject({
    method: 'POST',
    url: '/api/nodes/list',
    payload: { mode: 'demo' },
  });
  if (nodes.statusCode === 200) seed.post['nodes/list:demo'] = nodes.json();
  return seed;
}
