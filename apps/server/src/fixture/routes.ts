import type { FastifyInstance } from 'fastify';
import {
  fixturesAnchorBodySchema,
  fixturesChooseBodySchema,
  fixturesControlBodySchema,
  fixturesDeleteBodySchema,
  fixturesDraftBodySchema,
  fixturesEditBodySchema,
  fixturesFindBodySchema,
  fixturesPhotoBodySchema,
  fixturesPromoteBodySchema,
  fixturesReferenceQuerySchema,
  fixturesRefine3dBodySchema,
  fixturesReleaseBodySchema,
  fixturesSaveBodySchema,
  fixturesScanBodySchema,
  fixturesSculptBodySchema,
  fixturesSculptReapplyBodySchema,
  fixturesStateBodySchema,
  fixturesUndismissBodySchema,
  isDismissed,
  MAX_DISMISSED,
  modeIdSchema,
  withoutThings,
} from '@livinglayer/domain';
import { LabError, parseInput } from '../errors.js';
import type { RouteDeps } from '../route-deps.js';
import { controlFixture } from './control.js';
import { draftFixture, refitFixture } from './draft.js';
import { editFixture } from './edit.js';
import { findFixture } from './find.js';
import { promoteFixture } from './promote.js';
import { refineFixture } from './refine.js';
import { chooseDraft, saveFixture, setFixtureState } from './save.js';
import { scanFixtures } from './scan.js';
import { reapplySculpt, sculptFixture } from './sculpt.js';

/**
 * Fixtures: things placed in a room by hand, never tracked. Saving checks
 * where one stands and what it switches; controlling one is an explicit
 * action recorded like the lamp test.
 */
export async function fixtureRoutes(
  app: FastifyInstance,
  deps: Pick<
    RouteDeps,
    'store' | 'meta' | 'run' | 'jobs' | 'control' | 'entities' | 'productsDir' | 'sam3d' | 'desk'
  >,
) {
  const { store, desk } = deps;
  app.post('/anchor', async (request) => {
    const { mode, id, segmentRunId, detectionId } = parseInput(
      fixturesAnchorBodySchema,
      request.body,
    );
    return desk.anchorFixture(mode, id, segmentRunId, detectionId);
  });
  /** Stop following a fixture; it stays where it was last seen. */
  app.post('/untrack', async (request) => {
    const { mode, id } = parseInput(modeIdSchema, request.body);
    desk.available(mode);
    const memory = store.memory(mode);
    const fixture = memory.fixtures?.find((f) => f.id === id);
    if (!fixture)
      throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
    delete fixture.track;
    // Rules that counted only it can't be checked any more.
    memory.rules = withoutThings(memory.rules, [id]);
    store.saveMemory(memory);
    return memory;
  });
  app.post('/draft', async (request) =>
    draftFixture(deps, parseInput(fixturesDraftBodySchema, request.body)),
  );
  app.post('/scan', async (request) =>
    scanFixtures(deps, parseInput(fixturesScanBodySchema, request.body)),
  );
  app.post('/sculpt', async (request) =>
    sculptFixture(deps, parseInput(fixturesSculptBodySchema, request.body)),
  );
  app.post('/edit', async (request) =>
    editFixture(deps, parseInput(fixturesEditBodySchema, request.body)),
  );
  app.post('/sculpt/reapply', async (request) =>
    reapplySculpt(deps, parseInput(fixturesSculptReapplyBodySchema, request.body)),
  );
  app.post('/photo', async (request) =>
    refitFixture(deps, parseInput(fixturesPhotoBodySchema, request.body)),
  );
  app.post('/refine3d', async (request) =>
    refineFixture(deps, parseInput(fixturesRefine3dBodySchema, request.body)),
  );
  app.post('/choose', async (request) =>
    chooseDraft(store, parseInput(fixturesChooseBodySchema, request.body)),
  );
  app.post('/save', async (request) =>
    saveFixture(deps, parseInput(fixturesSaveBodySchema, request.body)),
  );
  /** Make a thing drawn with the room a thing of its own, pictured by the room draft's crop of it. */
  app.post('/promote', async (request) =>
    promoteFixture(deps, parseInput(fixturesPromoteBodySchema, request.body)),
  );
  /** The reference photo a fixture was drafted from, for review and the inspector. */
  app.get('/reference', async (request, reply) => {
    const { runId } = parseInput(fixturesReferenceQuerySchema, request.query);
    const drafted = store.getRun(runId);
    const png = drafted?.kind === 'fixture' ? store.readAsset(`${runId}/reference.png`) : null;
    if (!png) throw new LabError('fixture_reference', 'That draft has no reference photo.', 404);
    return reply.type('image/png').header('cache-control', 'private, max-age=3600').send(png);
  });
  /** Rules that switched the fixture keep its entity and lose the link to it. */
  /**
   * Delete a fixture. `dismiss` also remembers its name as not a fixture, so
   * scans skip it: something Spark keeps finding that shouldn't be one.
   */
  app.post('/find', async (request) =>
    findFixture(deps, parseInput(fixturesFindBodySchema, request.body)),
  );
  /** Delete one fixture, or several at once (`fixtureIds`), in one save. */
  app.post('/delete', async (request) => {
    const { mode, fixtureId, fixtureIds, dismiss } = parseInput(
      fixturesDeleteBodySchema,
      request.body,
    );
    const ids = new Set(fixtureIds ?? [fixtureId!]);
    const memory = store.memory(mode);
    for (const gone of (memory.fixtures ?? []).filter((f) => ids.has(f.id)))
      if (dismiss && !isDismissed(gone.label, memory.dismissed ?? []))
        memory.dismissed = [...(memory.dismissed ?? []), gone.label].slice(-MAX_DISMISSED);
    memory.fixtures = (memory.fixtures ?? []).filter((f) => !ids.has(f.id));
    // Rules they decided go with them; rules that switched one keep their entity.
    memory.rules = withoutThings(memory.rules, [...ids]).map((r) => {
      if (!r.fixtureId || !ids.has(r.fixtureId)) return r;
      const { fixtureId: _gone, ...rest } = r;
      return rest;
    });
    store.saveMemory(memory);
    return memory;
  });
  /** Hand every fixture of a scene back to scans, to place and refit on the next one. */
  app.post('/release', async (request) => {
    const { mode, scene } = parseInput(fixturesReleaseBodySchema, request.body);
    const memory = store.memory(mode);
    for (const f of memory.fixtures ?? []) if (f.scene === scene) f.scanned = true;
    store.saveMemory(memory);
    return memory;
  });
  /** Let scans find a dismissed name again. */
  app.post('/undismiss', async (request) => {
    const { mode, label } = parseInput(fixturesUndismissBodySchema, request.body);
    const memory = store.memory(mode);
    memory.dismissed = (memory.dismissed ?? []).filter((d) => d !== label);
    store.saveMemory(memory);
    return memory;
  });
  app.post('/state', async (request) =>
    setFixtureState(store, parseInput(fixturesStateBodySchema, request.body)),
  );
  app.post('/control', async (request) =>
    controlFixture(deps, parseInput(fixturesControlBodySchema, request.body)),
  );
}
