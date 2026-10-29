import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DEMO_REFERENCES,
  META_PRICES,
  MAX_FIXTURES,
  isoSceneKindSchema,
  promptBox,
  sparkCeiling,
  sizeInTiles,
  fixtureEntity,
  fixtureInputSchema,
  fixtureProblem,
  modeSchema,
  uniqueParts,
  type DeskMemory,
  type Detection,
  type Fixture,
  type FixtureClass,
  type FixtureDraft,
  type LampResult,
  type Mode,
  type Usage,
} from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import { demoFixtureClass, demoReference } from './demo.js';
import { maskedCrop, validateImage } from './images.js';
import { draftModel, rescore, type Runner } from './item.js';
import { SPARK_BUDGET, type MetaAdapter } from './meta.js';
import type { EvidenceStore } from './store.js';

/**
 * The most a live draft can cost: Spark names the thing, SAM outlines it,
 * SAM looks for up to two parts, and Spark checks one render.
 */
const fixtureDraftCeiling = () =>
  sparkCeiling(SPARK_BUDGET.fixtureClass, 1) +
  3 * META_PRICES.samPerImage +
  sparkCeiling(SPARK_BUDGET.itemCheck, 2);

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
          /** Demo: one of the bundled pictures. */
          reference: z.enum(DEMO_REFERENCES).optional(),
          /** Live: the person's photo of the thing. */
          imageDataUrl: z.string().max(7_000_000).optional(),
          /** What the person says it is; Spark is told, and it names the draft. */
          label: z.string().trim().min(1).max(40).optional(),
        })
        .strict(),
      request.body,
    );
    const { mode, scene } = input;
    const live = mode === 'live';
    if (live ? input.reference : input.imageDataUrl || !input.reference)
      throw new LabError(
        'demo_image',
        live
          ? 'Live mode drafts from your own photo, not the bundled pictures.'
          : 'Demo mode drafts only from the bundled pictures.',
      );
    const custom = store.memory(mode).scene;
    if (scene === 'custom' && !custom)
      throw new LabError(
        'fixture_place',
        'Save your own scene before drafting fixtures for it.',
        409,
      );
    // Refuse up front rather than stop halfway, with Spark's answer already paid for.
    if (live && !meta.canAfford(fixtureDraftCeiling()))
      throw new LabError(
        'spend_limit',
        `A fixture draft could cost up to $${fixtureDraftCeiling().toFixed(3)}, which would pass today's Meta spending limit. Raise the limit in Setup, or wait for the next UTC day.`,
        429,
      );
    const event = await run('fixture', mode, async (id) => {
      let usage: Usage | null = null;
      let model: string | undefined;
      let requestId: string | null = null;
      const assets: string[] = [];
      // 1. The photo, and what is in it: Spark live, the hand-written class in the demo.
      let png: Buffer;
      let cls: FixtureClass;
      let detection: Detection;
      if (live) {
        const image = await validateImage(input.imageDataUrl);
        png = image.bytes;
        const named = await meta.fixtureClass(image.dataUrl, input.label);
        cls = named.output;
        usage = named.usage;
        model = named.model;
        requestId = named.requestId;
        // 2. SAM outlines whatever is inside Spark's box.
        const frame = { width: image.width, height: image.height };
        const box = promptBox(cls, frame);
        if (!box)
          throw new LabError('fixture_none', `The ${cls.label} is too small in the photo.`, 422);
        const outlined = await meta.segmentBoxes(
          image.dataUrl,
          [{ id: 1, box }],
          frame.width,
          frame.height,
        );
        assets.push(store.asset(id, 'sam-output.txt', outlined.raw));
        const found = [...outlined.output.detections].sort(
          (a, b) => b.mask.foregroundPixels - a.mask.foregroundPixels,
        )[0];
        if (!found)
          throw new LabError(
            'fixture_none',
            `Couldn’t find the ${cls.label.toLowerCase()} in the photo. Try one thing, filling most of the frame.`,
            422,
          );
        detection = found;
      } else {
        cls = demoFixtureClass[input.reference!];
        ({ png, detection } = await demoReference(input.reference!));
      }
      const label = input.label ?? cls.label;
      const crop = await maskedCrop(png, detection);
      const referenceAsset = store.asset(id, 'reference.png', png);
      const cropAsset = store.asset(id, 'item-crop.png', crop.png);
      // 3. The same modelling as objects: part masks and Spark's check when live.
      const drafted = await draftModel(meta, store, id, {
        crop,
        cropUrl: `data:image/png;base64,${crop.png.toString('base64')}`,
        label,
        archetype: cls.archetype,
        material: cls.material,
        elevation: null,
        live,
      });
      if (drafted.usage)
        usage = usage
          ? {
              inputTokens: usage.inputTokens + drafted.usage.inputTokens,
              outputTokens: usage.outputTokens + drafted.usage.outputTokens,
              totalTokens: usage.totalTokens + drafted.usage.totalTokens,
            }
          : drafted.usage;
      const draft: FixtureDraft = {
        label,
        archetype: drafted.fitted.archetype,
        suggested: cls.control,
        description: cls.description,
        model: {
          ...uniqueParts(drafted.item),
          source: live ? 'spark' : 'demo',
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
            assists: [
              `${live ? 'Spark' : 'Demo'}: ${cls.archetype}, ${cls.material}. ${cls.description}`,
              ...drafted.assists,
            ],
          },
        },
        size: sizeInTiles(cls.sizeCm, scene, custom),
        reference: { runId: id, asset: referenceAsset },
      };
      return {
        output: draft,
        assets: [referenceAsset, cropAsset, ...assets, ...drafted.assets],
        usage,
        ...(model ? { model } : {}),
        requestId,
      };
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
