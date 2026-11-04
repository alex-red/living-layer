import { describe, expect, it } from 'bun:test';
import { testApp } from './lib/app.js';

/** Every route the lab server answers, by path and method (HEAD omitted). */
const ROUTES = [
  '/api/assist [POST]',
  '/api/assist/save [POST]',
  '/api/busy [GET]',
  '/api/cameras [GET]',
  '/api/cameras/:id/snapshot [GET]',
  '/api/cameras/:id/stream [GET]',
  '/api/cameras/:id/whep [POST]',
  '/api/cameras/:id/whep/:session [DELETE]',
  '/api/cameras/delete [POST]',
  '/api/cameras/save [POST]',
  '/api/coach/:mode [GET]',
  '/api/coach/check [POST]',
  '/api/coach/switch [POST]',
  '/api/desk/:mode [GET]',
  '/api/desk/auto-pin [POST]',
  '/api/desk/camera [POST]',
  '/api/desk/demo/reset [POST]',
  '/api/desk/objects/forget [POST]',
  '/api/desk/objects/select [POST]',
  '/api/desk/objects/track [POST]',
  '/api/desk/reset [POST]',
  '/api/desk/restore [POST]',
  '/api/desk/rules/delete [POST]',
  '/api/desk/rules/options [POST]',
  '/api/desk/rules/save [POST]',
  '/api/desk/rules/verify [POST]',
  '/api/desk/select [POST]',
  '/api/desk/surface [POST]',
  '/api/desk/track [POST]',
  '/api/desk/verify [POST]',
  '/api/desk/zone [POST]',
  '/api/desk/zone/options [POST]',
  '/api/discover [POST]',
  '/api/evidence [GET]',
  '/api/expose/:mode [GET]',
  '/api/expose/delete [POST]',
  '/api/expose/learn-empty [POST]',
  '/api/expose/save [POST]',
  '/api/fixtures/anchor [POST]',
  '/api/fixtures/choose [POST]',
  '/api/fixtures/control [POST]',
  '/api/fixtures/delete [POST]',
  '/api/fixtures/draft [POST]',
  '/api/fixtures/edit [POST]',
  '/api/fixtures/find [POST]',
  '/api/fixtures/layer [POST]',
  '/api/fixtures/photo [POST]',
  '/api/fixtures/promote [POST]',
  '/api/fixtures/reference [GET]',
  '/api/fixtures/refine3d [POST]',
  '/api/fixtures/release [POST]',
  '/api/fixtures/save [POST]',
  '/api/fixtures/scan [POST]',
  '/api/fixtures/sculpt [POST]',
  '/api/fixtures/sculpt/reapply [POST]',
  '/api/fixtures/state [POST]',
  '/api/fixtures/undismiss [POST]',
  '/api/fixtures/untrack [POST]',
  '/api/ha/chosen [POST]',
  '/api/ha/entities [GET]',
  '/api/ha/login [POST]',
  '/api/ha/logout [POST]',
  '/api/item/crop [GET]',
  '/api/item/draft [POST]',
  '/api/item/refit [POST]',
  '/api/item/save [POST]',
  '/api/jobs [GET]',
  '/api/jobs/:id [GET]',
  '/api/jobs/:id/events [GET]',
  '/api/jobs/:id/stop [POST]',
  '/api/lamp [POST]',
  '/api/nodes/adopt [POST]',
  '/api/nodes/command [POST]',
  '/api/nodes/forget [POST]',
  '/api/nodes/link [POST]',
  '/api/nodes/list [POST]',
  '/api/remote [GET, DELETE]',
  '/api/remote/:token/whep [POST, DELETE]',
  '/api/remote/events [GET]',
  '/api/remote/pair [POST]',
  '/api/room/calibrate [POST]',
  '/api/room/floor [POST]',
  '/api/room/forget [POST]',
  '/api/room/keep [POST]',
  '/api/runs [GET]',
  '/api/saves [GET]',
  '/api/saves/delete [POST]',
  '/api/saves/rename [POST]',
  '/api/saves/save [POST]',
  '/api/scene/classify [POST]',
  '/api/scene/draft [POST]',
  '/api/scene/fit [POST]',
  '/api/scene/from-photo [POST]',
  '/api/scene/from-photo/save [POST]',
  '/api/scene/illustrate [POST]',
  '/api/scene/illustration [GET]',
  '/api/scene/photo [GET]',
  '/api/scene/save [POST]',
  '/api/scene/separate [POST]',
  '/api/scene/separate/undo [POST]',
  '/api/scene/setup [POST]',
  '/api/scene/texture [GET]',
  '/api/segment [POST]',
  '/api/select/resolve [POST]',
  '/api/settings/spend-limit [POST]',
  '/api/settings/tracking-ai [POST]',
  '/api/status [GET]',
  '/api/streams [GET]',
  '/api/streams/crop [POST]',
  '/api/streams/stats [POST]',
  '/api/text [POST]',
  '/api/things/:mode/:id/stats [GET]',
  '/api/things/ask [POST]',
  '/api/things/learn [POST]',
  '/api/things/stats [POST]',
  '/api/things/used [POST]',
  '/api/watch [POST]',
  '/api/watch/:mode [GET]',
  '/api/watch/:mode/events [GET]',
  '/api/watch/demo [POST]',
];

/** Flatten Fastify's route tree into `path [METHODS]` lines. */
function listed(tree: string): string[] {
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of tree.split('\n').filter(Boolean)) {
    const m = /^((?:│   |    )*)(?:├── |└── )(.*?) \(([^)]*)\)$/.exec(line);
    if (!m) throw new Error(`Unreadable route line: ${line}`);
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack[depth] = m[2]!;
    out.push(`${stack.join('')} [${m[3]!.replace(', HEAD', '')}]`);
  }
  return out.sort();
}

describe('routes', () => {
  it('are the ones the web and the phone page call', async () => {
    const { app } = await testApp({ name: 'routes' });
    await app.ready();
    expect(listed(app.printRoutes({ commonPrefix: false }))).toEqual(ROUTES);
  });
});
