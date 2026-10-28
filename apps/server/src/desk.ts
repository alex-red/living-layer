import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  modeSchema,
  zoneRectSchema,
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
} from '@livinglayer/domain';
import { EvidenceStore } from './store.js';
import { LabError, parseInput, safeError } from './errors.js';

export function deskRoutes(
  app: FastifyInstance,
  store: EvidenceStore,
  turnOn: (mode: Mode) => Promise<LampResult>,
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
    return { memory: store.memory(mode), event };
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
      history: [],
      placement: null,
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
