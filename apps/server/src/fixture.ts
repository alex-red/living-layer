import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DEMO_REFERENCES,
  MAX_FIXTURES,
  isoSceneKindSchema,
  sizeInTiles,
  fixtureEntity,
  fixtureInputSchema,
  fixtureProblem,
  modeSchema,
  uniqueParts,
  type DeskMemory,
  type Fixture,
  type FixtureDraft,
  type LampResult,
  type Mode,
} from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import { demoFixtureClass, demoReference } from './demo.js';
import { maskedCrop } from './images.js';
import { draftModel, rescore, type Runner } from './item.js';
import type { MetaAdapter } from './meta.js';
import type { EvidenceStore } from './store.js';

/** Switch one light or switch, through Home Assistant or the demo's virtual adapter. */
export type Control = (mode: Mode, entityId: string, action: 'on' | 'off') => Promise<LampResult>;

/** What a confirmed action says about every fixture on that entity; unconfirmed says nothing. */
export function noteControl(memory: DeskMemory, result: LampResult): void {
  for (const f of memory.fixtures ?? [])
    if (fixtureEntity(f) === result.entityId)
      f.state = result.stateConfirmed ? (result.action ?? 'on') : null;
}

/**
 * Fixtures: things placed in a room by hand, never tracked. Saving checks
 * where one stands and what it switches; controlling one is an explicit
 * action recorded like the lamp test.
 */
export function fixtureRoutes(
  app: FastifyInstance,
  {
    store,
    meta,
    run,
    control,
    entities,
  }: {
    store: EvidenceStore;
    meta: MetaAdapter;
    run: Runner;
    control: Control;
    entities: (mode: Mode) => string[];
  },
) {
  /**
   * Draft a fixture from a reference photo: one thing, filling most of the
   * frame. Its mask is cut out and modelled by the same fitter as objects,
   * and sized for the scene it is meant for. Nothing is saved; the draft
   * comes back for the person to name, choose a control for, and place.
   * Demo mode drafts from the bundled illustrations only.
   */
  app.post('/api/fixtures/draft', async (request) => {
    const input = parseInput(
      z
        .object({
          mode: modeSchema,
          scene: z.union([isoSceneKindSchema, z.literal('custom')]),
          reference: z.enum(DEMO_REFERENCES).optional(),
          label: z.string().trim().min(1).max(40).optional(),
        })
        .strict(),
      request.body,
    );
    const { mode, scene } = input;
    if (mode !== 'demo')
      throw new LabError(
        'fixture_live',
        'Drafting a fixture from your own photo isn’t built yet. Use demo mode.',
        501,
      );
    if (!input.reference)
      throw new LabError('demo_image', 'Demo mode drafts only from the bundled pictures.');
    const reference = input.reference;
    const custom = store.memory(mode).scene;
    if (scene === 'custom' && !custom)
      throw new LabError(
        'fixture_place',
        'Save your own scene before drafting fixtures for it.',
        409,
      );
    const event = await run('fixture', mode, async (id) => {
      const cls = demoFixtureClass[reference];
      const { png, detection } = await demoReference(reference);
      const label = input.label ?? cls.label;
      const crop = await maskedCrop(png, detection);
      const referenceAsset = store.asset(id, 'reference.png', png);
      const cropAsset = store.asset(id, 'item-crop.png', crop.png);
      const drafted = await draftModel(meta, store, id, {
        crop,
        cropUrl: `data:image/png;base64,${crop.png.toString('base64')}`,
        label,
        archetype: cls.archetype,
        material: cls.material,
        elevation: null,
        live: false,
      });
      const draft: FixtureDraft = {
        label,
        archetype: drafted.fitted.archetype,
        suggested: cls.control,
        description: cls.description,
        model: {
          ...uniqueParts(drafted.item),
          source: 'demo',
          segmentRunId: null,
          swatches: drafted.fitted.swatches,
          updatedAt: new Date().toISOString(),
          fit: {
            archetype: drafted.fitted.archetype,
            params: drafted.params,
            iou: drafted.score.iou,
            deltaE: drafted.score.deltaE,
            elevation: drafted.fitted.elevation,
            views: 1,
            crop: cropAsset,
            assists: [`Demo: ${cls.description}`, ...drafted.assists],
          },
        },
        size: sizeInTiles(cls.sizeCm, scene, custom),
        reference: { runId: id, asset: referenceAsset },
      };
      return { output: draft, assets: [referenceAsset, cropAsset, ...drafted.assets] };
    });
    return { run: event, draft: event.output as FixtureDraft };
  });
  app.post('/api/fixtures/save', async (request) => {
    const { mode, fixture: input } = parseInput(
      z.object({ mode: modeSchema, fixture: fixtureInputSchema }).strict(),
      request.body,
    );
    const memory = store.memory(mode);
    const fixtures = memory.fixtures ?? [];
    const previous = input.id ? fixtures.find((f) => f.id === input.id) : undefined;
    if (input.id && !previous)
      throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
    if (!previous && fixtures.length >= MAX_FIXTURES)
      throw new LabError('fixture_limit', `Up to ${MAX_FIXTURES} fixtures are allowed.`, 409);
    const problem = fixtureProblem(input, memory.scene);
    if (problem) throw new LabError('fixture_place', problem, 400);
    const entity = fixtureEntity(input);
    if (entity && !entities(mode).includes(entity))
      throw new LabError('fixture_entity', 'Choose one of the configured lights or switches.', 400);
    const referenceRun = input.reference ? store.getRun(input.reference.runId) : undefined;
    if (
      input.reference &&
      (!referenceRun || !input.reference.asset.startsWith(`${input.reference.runId}/`))
    )
      throw new LabError(
        'fixture_reference',
        'The reference photo is not one of the lab’s runs.',
        400,
      );
    const now = new Date().toISOString();
    const { id: _id, model, ...rest } = input;
    // What the model was drafted as: the fixture before, or the draft it came from.
    const base =
      previous?.model ??
      (referenceRun?.kind === 'fixture' && referenceRun.status === 'completed'
        ? (referenceRun.output as FixtureDraft).model
        : undefined);
    const fixture: Fixture = {
      ...rest,
      id: previous?.id ?? randomUUID(),
      model: {
        ...uniqueParts(model),
        source: base?.source ?? (mode === 'demo' ? 'demo' : 'sampled'),
        segmentRunId: base?.segmentRunId ?? null,
        swatches: base?.swatches ?? [],
        updatedAt: now,
        // An edit keeps its fit record, scored again against the same crop.
        fit: await rescore(store, model, base?.fit),
      },
      // A new entity starts with no known state.
      state: previous && fixtureEntity(previous) === entity ? (previous.state ?? null) : null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    memory.fixtures = previous
      ? fixtures.map((f) => (f.id === previous.id ? fixture : f))
      : [...fixtures, fixture];
    store.saveMemory(memory);
    return memory;
  });
  /** The reference photo a fixture was drafted from, for review and the inspector. */
  app.get('/api/fixtures/reference', async (request, reply) => {
    const { runId } = parseInput(z.object({ runId: z.string().uuid() }).strict(), request.query);
    const drafted = store.getRun(runId);
    const png = drafted?.kind === 'fixture' ? store.readAsset(`${runId}/reference.png`) : null;
    if (!png) throw new LabError('fixture_reference', 'That draft has no reference photo.', 404);
    return reply.type('image/png').header('cache-control', 'private, max-age=3600').send(png);
  });
  /** Rules that switched the fixture keep its entity and lose the link to it. */
  app.post('/api/fixtures/delete', async (request) => {
    const { mode, fixtureId } = parseInput(
      z.object({ mode: modeSchema, fixtureId: z.string().uuid() }).strict(),
      request.body,
    );
    const memory = store.memory(mode);
    memory.fixtures = (memory.fixtures ?? []).filter((f) => f.id !== fixtureId);
    memory.rules = (memory.rules ?? []).map((r) => {
      if (r.fixtureId !== fixtureId) return r;
      const { fixtureId: _gone, ...rest } = r;
      return rest;
    });
    store.saveMemory(memory);
    return memory;
  });
  app.post('/api/fixtures/control', async (request) => {
    const { mode, fixtureId, action } = parseInput(
      z
        .object({ mode: modeSchema, fixtureId: z.string().uuid(), action: z.enum(['on', 'off']) })
        .strict(),
      request.body,
    );
    const fixture = store.memory(mode).fixtures?.find((f) => f.id === fixtureId);
    if (!fixture)
      throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
    const entity = fixtureEntity(fixture);
    if (!entity)
      throw new LabError('fixture_control', `The ${fixture.label} has nothing to switch.`, 400);
    const event = await run('lamp', mode, async () => ({
      output: await control(mode, entity, action),
    }));
    // Read again: the action took a while, and the memory may have changed meanwhile.
    const memory = store.memory(mode);
    noteControl(memory, event.output as LampResult);
    store.saveMemory(memory);
    return { memory, event };
  });
}
