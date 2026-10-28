import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  modeSchema,
  zoneRectSchema,
  surfacePinSchema,
  isoSurface,
  isoItemSchema,
  objectById,
  modelTarget,
  setModel,
  ruleGate,
  ruleInputSchema,
  MAX_OTHER_OBJECTS,
  MAX_RULES,
  type PlacementRule,
  isoSceneSchema,
  uniqueParts,
  placementGate,
  pickTracked,
  zoneApplies,
  isMugConcept,
  HISTORY_LIMIT,
  OBSERVATION_MAX_AGE_MS,
  type DeskMemory,
  type DeskObservation,
  type Detection,
  type Mode,
  type Segmentation,
  type EvidenceRun,
  type PlacementDecision,
  type LampResult,
  type IsoScene,
} from '@livinglayer/domain';
import { EvidenceStore } from './store.js';
import { LabError, parseInput, safeError } from './errors.js';
import { rescore } from './item.js';

export function deskRoutes(
  app: FastifyInstance,
  store: EvidenceStore,
  turnOn: (mode: Mode, entityId?: string) => Promise<LampResult>,
  lights: (mode: Mode) => string[] = () => [],
) {
  const active = new Set<Mode>();
  function available(mode: Mode) {
    if (active.has(mode))
      throw new LabError('placement_busy', 'A placement check is already running.', 409);
  }
  function evidence<T>(
    kind: 'observation' | 'zone' | 'placement',
    mode: Mode,
    output: T,
  ): EvidenceRun<T> {
    return {
      id: randomUUID(),
      kind,
      mode,
      output,
      createdAt: new Date().toISOString(),
      durationMs: 0,
      status: 'completed',
      model: null,
      requestId: null,
      usage: null,
      promptVersion: `${kind}-v1`,
      assets: [],
    };
  }
  /** The newest completed mug segmentation in this mode, still fresh enough to observe. */
  function latestMugSegmentation(mode: Mode, segmentRunId: string) {
    const run = store.getRun(segmentRunId);
    if (
      !run ||
      run.kind !== 'segment' ||
      run.mode !== mode ||
      !['completed', 'no_match'].includes(run.status) ||
      store.latestSegment(mode) !== segmentRunId
    )
      throw new LabError('observation_source', 'Choose a completed segmentation from this mode.');
    const segmentation = run.output as Segmentation;
    if (!isMugConcept(segmentation.concept) || !segmentation.sourceKey)
      throw new LabError('mug_selection', 'Segment the mug in a new frame first.');
    if (Date.now() - Date.parse(run.createdAt) > OBSERVATION_MAX_AGE_MS)
      throw new LabError('stale_observation', 'This segmentation is stale. Segment a new frame.');
    return { run, segmentation };
  }
  /** Record where the object is now, keeping the previous sighting in its history. */
  function observe(
    memory: DeskMemory,
    run: EvidenceRun,
    segmentation: Segmentation,
    detection: Detection,
    identity: DeskObservation['identity'],
    overlap: number | null,
  ) {
    memory.object ??= {
      id: randomUUID(),
      label: 'My desk mug',
      createdAt: new Date().toISOString(),
    };
    if (memory.observation)
      memory.history = [memory.observation, ...(memory.history ?? [])].slice(0, HISTORY_LIMIT);
    memory.observation = {
      id: randomUUID(),
      objectId: memory.object.id,
      segmentRunId: run.id,
      detectionId: detection.objectId,
      observedAt: run.createdAt,
      sourceKey: segmentation.sourceKey!,
      frame: segmentation.frame,
      box: detection.box,
      identity,
      overlap,
    };
    // A zone is meaningful only for the image it was drawn on, unless the
    // person has said the camera is fixed and the frame is the same size.
    if (!zoneApplies(memory).applies) memory.zone = null;
    memory.lastDecision = null;
    store.saveMemory(memory);
    store.save(evidence('observation', memory.mode, memory.observation));
  }
  /**
   * Check the current observation against the zone. The lamp fires only when
   * the mug enters: inside now, and not inside at the last check. Each
   * segmentation can still attempt the lamp at most once.
   */
  async function verify(mode: Mode, memory: DeskMemory): Promise<EvidenceRun<PlacementDecision>> {
    const o = memory.observation!;
    const zoneId = memory.zone?.id ?? null;
    const gate =
      store.latestSegment(mode) !== o.segmentRunId
        ? {
            decision: 'blocked' as const,
            reason:
              'A newer segmentation superseded this observation. Confirm its mug mask before verifying.',
          }
        : placementGate(memory);
    const decision: PlacementDecision = {
      ...gate,
      observationId: o.id,
      objectId: o.objectId,
      segmentRunId: o.segmentRunId,
      zoneId,
      action: 'none',
    };
    if (decision.decision !== 'blocked') {
      const wasInside = memory.placement === 'inside';
      decision.transition =
        decision.decision === 'inside'
          ? wasInside
            ? 'stayed_inside'
            : 'entered'
          : wasInside
            ? 'left'
            : 'stayed_outside';
      memory.placement = decision.decision;
    }
    if (decision.transition === 'stayed_inside')
      decision.reason = `Still inside since the last check, so no lamp action. It fires again once the mug leaves and comes back. ${decision.reason}`;
    const fire = decision.transition === 'entered';
    if (fire && !store.claimPlacement(o.segmentRunId)) {
      decision.decision = 'blocked';
      decision.transition = undefined;
      decision.reason =
        'This segmentation already attempted an action. Capture and segment a new frame; no automatic retry.';
    }
    const event = evidence('placement', mode, decision);
    const start = performance.now();
    if (decision.decision === 'inside' && fire) {
      decision.action = 'pending';
      event.status = 'unconfirmed';
    }
    // Persist intent before dispatch: an interrupted request remains uncertain, never retried.
    store.save(event);
    memory.lastDecision = event;
    store.saveMemory(memory);
    if (decision.action === 'pending') {
      active.add(mode);
      try {
        decision.lamp = await turnOn(mode);
        decision.action = decision.lamp.stateConfirmed ? 'confirmed' : 'unconfirmed';
        event.status = decision.lamp.stateConfirmed ? 'completed' : 'unconfirmed';
      } catch (error) {
        const safe = safeError(error);
        decision.action = 'failed';
        decision.error = { code: safe.code, message: safe.message };
        event.status = 'failed';
      } finally {
        active.delete(mode);
      }
    }
    event.durationMs = Math.round(performance.now() - start);
    store.updateRun(event);
    memory.lastDecision = event;
    store.saveMemory(memory);
    return event;
  }

  /**
   * Check the extra rules, all of them or only those for one object. Each
   * rule keeps its own inside/outside story, fires its light only on
   * entering, and can act at most once per segmentation, like the main zone.
   */
  async function verifyRules(mode: Mode, objectId?: string) {
    const events: EvidenceRun<PlacementDecision>[] = [];
    const memory = store.memory(mode);
    for (const rule of memory.rules ?? []) {
      if (objectId && rule.objectId !== objectId) continue;
      const o = objectById(memory, rule.objectId)?.observation ?? null;
      const decision: PlacementDecision = {
        ...ruleGate(memory, rule),
        observationId: o?.id ?? null,
        objectId: rule.objectId,
        segmentRunId: o?.segmentRunId ?? null,
        zoneId: rule.id,
        ruleId: rule.id,
        action: 'none',
      };
      if (decision.decision !== 'blocked') {
        const wasInside = rule.placement === 'inside';
        decision.transition =
          decision.decision === 'inside'
            ? wasInside
              ? 'stayed_inside'
              : 'entered'
            : wasInside
              ? 'left'
              : 'stayed_outside';
        rule.placement = decision.decision;
      }
      if (
        decision.transition === 'entered' &&
        !store.claimPlacement(`${o!.segmentRunId}:${rule.id}`)
      ) {
        decision.decision = 'blocked';
        decision.transition = undefined;
        decision.reason = `This segmentation already attempted "${rule.label}". Track the object in a new frame; no automatic retry.`;
      }
      const event = evidence('placement', mode, decision);
      const start = performance.now();
      if (decision.transition === 'entered') {
        decision.action = 'pending';
        event.status = 'unconfirmed';
      }
      store.save(event);
      rule.lastDecision = event;
      store.saveMemory(memory);
      if (decision.action === 'pending') {
        active.add(mode);
        try {
          decision.lamp = await turnOn(mode, rule.lightId);
          decision.action = decision.lamp.stateConfirmed ? 'confirmed' : 'unconfirmed';
          event.status = decision.lamp.stateConfirmed ? 'completed' : 'unconfirmed';
        } catch (error) {
          const safe = safeError(error);
          decision.action = 'failed';
          decision.error = { code: safe.code, message: safe.message };
          event.status = 'failed';
        } finally {
          active.delete(mode);
        }
      }
      event.durationMs = Math.round(performance.now() - start);
      store.updateRun(event);
      rule.lastDecision = event;
      store.saveMemory(memory);
      events.push(event);
    }
    return events;
  }
  /** A completed segmentation of any concept from this mode, the newest and still fresh. */
  function latestSegmentation(mode: Mode, segmentRunId: string) {
    const run = store.getRun(segmentRunId);
    if (
      !run ||
      run.kind !== 'segment' ||
      run.mode !== mode ||
      run.status !== 'completed' ||
      store.latestSegment(mode) !== segmentRunId
    )
      throw new LabError('observation_source', 'Choose the newest segmentation from this mode.');
    const segmentation = run.output as Segmentation;
    if (!segmentation.sourceKey || Date.now() - Date.parse(run.createdAt) > OBSERVATION_MAX_AGE_MS)
      throw new LabError('stale_observation', 'This segmentation is stale. Segment a new frame.');
    return { run, segmentation };
  }
  function sightingOf(
    objectId: string,
    run: EvidenceRun,
    segmentation: Segmentation,
    detection: Detection,
    identity: DeskObservation['identity'],
    overlap: number | null,
  ): DeskObservation {
    return {
      id: randomUUID(),
      objectId,
      segmentRunId: run.id,
      detectionId: detection.objectId,
      observedAt: run.createdAt,
      sourceKey: segmentation.sourceKey!,
      frame: segmentation.frame,
      box: detection.box,
      identity,
      overlap,
    };
  }
  const sameConcept = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  app.get('/api/desk/:mode', async (request) => {
    const { mode } = parseInput(z.object({ mode: modeSchema }), request.params);
    return store.memory(mode);
  });
  app.post('/api/desk/select', async (request) => {
    const { mode, segmentRunId, detectionId } = parseInput(
      z
        .object({
          mode: modeSchema,
          segmentRunId: z.string().uuid(),
          detectionId: z.string().min(1).max(80),
        })
        .strict(),
      request.body,
    );
    available(mode);
    const { run, segmentation } = latestMugSegmentation(mode, segmentRunId);
    const detection = segmentation.detections.find((d) => d.objectId === detectionId);
    if (run.status !== 'completed' || !detection)
      throw new LabError('mug_selection', 'Select a specific mug mask from a new segmentation.');
    const memory = store.memory(mode);
    const previous = memory.observation;
    observe(
      memory,
      run,
      segmentation,
      detection,
      'manual',
      previous ? (pickTracked([detection], segmentation.frame, previous)?.overlap ?? null) : null,
    );
    return memory;
  });
  /**
   * One step of tracking: match the newest mug segmentation to the remembered
   * mug without asking, then verify it. Identity must have been confirmed by
   * hand once, and an ambiguous or empty frame changes nothing.
   */
  app.post('/api/desk/track', async (request) => {
    const { mode, segmentRunId } = parseInput(
      z.object({ mode: modeSchema, segmentRunId: z.string().uuid() }).strict(),
      request.body,
    );
    available(mode);
    const memory = store.memory(mode);
    if (!memory.object || !memory.observation)
      throw new LabError(
        'track_identity',
        'Confirm the mug by hand once, then tracking can follow it.',
        409,
      );
    const { run, segmentation } = latestMugSegmentation(mode, segmentRunId);
    if (!segmentation.detections.length)
      throw new LabError(
        'track_lost',
        'SAM found no mug in this frame. Nothing changed; the last sighting stands.',
        409,
      );
    const match = pickTracked(segmentation.detections, segmentation.frame, memory.observation)!;
    observe(memory, run, segmentation, match.detection, 'tracked', match.overlap);
    const event = await verify(mode, memory);
    const rules = await verifyRules(mode, memory.object.id);
    return { memory: store.memory(mode), event, rules };
  });
  app.post('/api/desk/camera', async (request) => {
    const { mode, fixed } = parseInput(
      z.object({ mode: modeSchema, fixed: z.boolean() }).strict(),
      request.body,
    );
    available(mode);
    const memory = store.memory(mode);
    memory.fixedCamera = fixed;
    // Turning it off drops a zone that only applied by the fixed-camera assumption.
    if (memory.zone && !zoneApplies(memory).applies) memory.zone = null;
    memory.lastDecision = null;
    store.saveMemory(memory);
    return memory;
  });
  /**
   * Tie frames of one size to a surface of an isometric scene, or clear it.
   * It only changes how the desk is drawn; placement still runs on the frame.
   */
  app.post('/api/desk/surface', async (request) => {
    const { mode, pin } = parseInput(
      z.object({ mode: modeSchema, pin: surfacePinSchema.nullable() }).strict(),
      request.body,
    );
    available(mode);
    const memory = store.memory(mode);
    if (pin && !isoSurface(pin.scene, pin.surfaceId, memory.scene))
      throw new LabError('surface_unknown', 'That surface is not part of the chosen scene.');
    memory.surface = pin;
    store.saveMemory(memory);
    return memory;
  });
  /** Remember another object from the newest segmentation, by hand, like the mug. */
  app.post('/api/desk/objects/select', async (request) => {
    const { mode, segmentRunId, detectionId, label } = parseInput(
      z
        .object({
          mode: modeSchema,
          segmentRunId: z.string().uuid(),
          detectionId: z.string().min(1).max(80),
          label: z.string().trim().min(1).max(40),
        })
        .strict(),
      request.body,
    );
    available(mode);
    const { run, segmentation } = latestSegmentation(mode, segmentRunId);
    const detection = segmentation.detections.find((d) => d.objectId === detectionId);
    if (!detection) throw new LabError('object_selection', 'Pick a mask from this segmentation.');
    const memory = store.memory(mode);
    const others = memory.others ?? [];
    if (others.length >= MAX_OTHER_OBJECTS)
      throw new LabError(
        'object_limit',
        `Up to ${MAX_OTHER_OBJECTS} more objects can be remembered.`,
        409,
      );
    if (
      memory.observation?.segmentRunId === run.id &&
      memory.observation.detectionId === detectionId
    )
      throw new LabError('object_selection', 'That mask is already the remembered mug.', 409);
    const id = randomUUID();
    const observation = sightingOf(id, run, segmentation, detection, 'manual', null);
    memory.others = [
      ...others,
      {
        id,
        label,
        concept: segmentation.concept,
        createdAt: new Date().toISOString(),
        observation,
        history: [],
      },
    ];
    store.saveMemory(memory);
    store.save(evidence('observation', mode, observation));
    const events = await verifyRules(mode, id);
    return { memory: store.memory(mode), events };
  });
  /** Follow another object into the newest segmentation of its own concept, then check its rules. */
  app.post('/api/desk/objects/track', async (request) => {
    const { mode, objectId, segmentRunId } = parseInput(
      z
        .object({ mode: modeSchema, objectId: z.string().uuid(), segmentRunId: z.string().uuid() })
        .strict(),
      request.body,
    );
    available(mode);
    const memory = store.memory(mode);
    const target = memory.others?.find((o) => o.id === objectId);
    if (!target?.observation)
      throw new LabError('track_identity', 'Remember this object by hand first.', 409);
    const { run, segmentation } = latestSegmentation(mode, segmentRunId);
    if (!sameConcept(segmentation.concept, target.concept))
      throw new LabError(
        'track_concept',
        `Segment "${target.concept}" to track the ${target.label}.`,
        409,
      );
    if (!segmentation.detections.length)
      throw new LabError(
        'track_lost',
        `SAM found no ${target.concept} in this frame. Nothing changed.`,
        409,
      );
    const match = pickTracked(segmentation.detections, segmentation.frame, target.observation)!;
    target.history = [target.observation, ...(target.history ?? [])].slice(0, HISTORY_LIMIT);
    target.observation = sightingOf(
      target.id,
      run,
      segmentation,
      match.detection,
      'tracked',
      match.overlap,
    );
    store.saveMemory(memory);
    store.save(evidence('observation', mode, target.observation));
    const events = await verifyRules(mode, target.id);
    return { memory: store.memory(mode), events };
  });
  app.post('/api/desk/objects/forget', async (request) => {
    const { mode, objectId } = parseInput(
      z.object({ mode: modeSchema, objectId: z.string().uuid() }).strict(),
      request.body,
    );
    available(mode);
    const memory = store.memory(mode);
    memory.others = (memory.others ?? []).filter((o) => o.id !== objectId);
    memory.rules = (memory.rules ?? []).filter((r) => r.objectId !== objectId);
    store.saveMemory(memory);
    return memory;
  });
  /**
   * Save an extra zone for one object and one light. Like the main zone, it
   * belongs to the image of the object's current sighting.
   */
  app.post('/api/desk/rules/save', async (request) => {
    const { mode, rule: input } = parseInput(
      z.object({ mode: modeSchema, rule: ruleInputSchema }).strict(),
      request.body,
    );
    available(mode);
    const memory = store.memory(mode);
    const o = objectById(memory, input.objectId)?.observation;
    if (!o) throw new LabError('rule_object', 'Confirm that object in a segmentation first.', 409);
    if (!lights(mode).includes(input.lightId))
      throw new LabError('rule_light', 'Choose one of the configured lights.', 400);
    const rules = memory.rules ?? [];
    if (!input.id && rules.length >= MAX_RULES)
      throw new LabError('rule_limit', `Up to ${MAX_RULES} extra zones are allowed.`, 409);
    const rule: PlacementRule = {
      id: input.id ?? randomUUID(),
      label: input.label,
      objectId: input.objectId,
      lightId: input.lightId,
      zone: { sourceKey: o.sourceKey, rect: input.rect, frame: o.frame },
      // A new or moved zone starts a new inside/outside story.
      placement: null,
      lastDecision: null,
    };
    memory.rules =
      input.id && rules.some((r) => r.id === input.id)
        ? rules.map((r) => (r.id === input.id ? rule : r))
        : [...rules, rule];
    store.saveMemory(memory);
    store.save(
      evidence('zone', mode, { ...rule.zone, id: rule.id, ruleId: rule.id, observationId: o.id }),
    );
    return memory;
  });
  app.post('/api/desk/rules/delete', async (request) => {
    const { mode, ruleId } = parseInput(
      z.object({ mode: modeSchema, ruleId: z.string().uuid() }).strict(),
      request.body,
    );
    available(mode);
    const memory = store.memory(mode);
    memory.rules = (memory.rules ?? []).filter((r) => r.id !== ruleId);
    store.saveMemory(memory);
    return memory;
  });
  app.post('/api/desk/rules/verify', async (request) => {
    const { mode } = parseInput(z.object({ mode: modeSchema }).strict(), request.body);
    available(mode);
    const events = await verifyRules(mode);
    return { memory: store.memory(mode), events };
  });
  /**
   * Save the person's own scene, or drop it. A pin on a surface the new
   * scene no longer has is cleared, since it would point at nothing.
   */
  app.post('/api/scene/save', async (request) => {
    const { mode, scene } = parseInput(
      z.object({ mode: modeSchema, scene: isoSceneSchema.nullable() }).strict(),
      request.body,
    );
    available(mode);
    const memory = store.memory(mode);
    memory.scene = scene as IsoScene | null;
    if (
      memory.surface?.scene === 'custom' &&
      !isoSurface('custom', memory.surface.surfaceId, memory.scene)
    )
      memory.surface = null;
    store.saveMemory(memory);
    return memory;
  });
  /** Save an edited model of the remembered object, or remove it. */
  app.post('/api/item/save', async (request) => {
    const { mode, item, objectId } = parseInput(
      z
        .object({
          mode: modeSchema,
          item: isoItemSchema.nullable(),
          objectId: z.string().uuid().optional(),
        })
        .strict(),
      request.body,
    );
    const memory = store.memory(mode);
    const target = modelTarget(memory, objectId);
    if (!target)
      throw new LabError('item_identity', 'Confirm the object by hand first, then model it.', 409);
    setModel(
      memory,
      target.id,
      item && {
        ...uniqueParts(item),
        source: target.item?.source ?? 'sampled',
        segmentRunId: target.item?.segmentRunId ?? null,
        swatches: target.item?.swatches ?? [],
        updatedAt: new Date().toISOString(),
        // An edit keeps its fit record, scored again against the same crop.
        fit: await rescore(store, item, target.item?.fit),
      },
    );
    store.saveMemory(memory);
    return memory;
  });
  app.post('/api/desk/zone', async (request) => {
    const { mode, observationId, rect } = parseInput(
      z
        .object({ mode: modeSchema, observationId: z.string().uuid(), rect: zoneRectSchema })
        .strict(),
      request.body,
    );
    available(mode);
    const memory = store.memory(mode);
    if (!memory.observation || memory.observation.id !== observationId)
      throw new LabError(
        'observation_changed',
        'Confirm the current mug before saving its zone.',
        409,
      );
    memory.zone = {
      id: randomUUID(),
      sourceKey: memory.observation.sourceKey,
      rect,
      frame: memory.observation.frame,
    };
    // A new zone starts a new inside/outside story.
    memory.placement = null;
    memory.lastDecision = null;
    store.saveMemory(memory);
    store.save(evidence('zone', mode, { ...memory.zone, observationId }));
    return memory;
  });
  app.post('/api/desk/reset', async (request) => {
    const { mode } = parseInput(z.object({ mode: modeSchema }).strict(), request.body);
    available(mode);
    const memory: DeskMemory = {
      mode,
      object: null,
      observation: null,
      zone: null,
      lastDecision: null,
      // Whether the camera moves is a fact about the setup, not about the mug.
      fixedCamera: store.memory(mode).fixedCamera ?? false,
      surface: store.memory(mode).surface ?? null,
      scene: store.memory(mode).scene ?? null,
      history: [],
      placement: null,
      // Extra objects and their rules go with the mug; the scene stays.
      others: [],
      rules: [],
    };
    store.saveMemory(memory);
    // Evidence and one-shot claims intentionally survive reset.
    return memory;
  });
  app.post('/api/desk/verify', async (request) => {
    const { mode, observationId, zoneId } = parseInput(
      z
        .object({ mode: modeSchema, observationId: z.string().uuid(), zoneId: z.string().uuid() })
        .strict(),
      request.body,
    );
    available(mode);
    const memory = store.memory(mode);
    if (memory.observation?.id !== observationId || memory.zone?.id !== zoneId)
      throw new LabError(
        'desk_changed',
        'The selected observation or zone changed. Refresh and review it.',
        409,
      );
    return verify(mode, memory);
  });
}
