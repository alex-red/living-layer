import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  modeSchema,
  zoneRectSchema,
  placementGate,
  OBSERVATION_MAX_AGE_MS,
  type DeskMemory,
  type Mode,
  type Segmentation,
  type EvidenceRun,
  type PlacementDecision,
  type LampResult,
} from '@livinglayer/domain';
import { EvidenceStore } from './store.js';
import { LabError, safeError } from './errors.js';

export function deskRoutes(
  app: FastifyInstance,
  store: EvidenceStore,
  turnOn: (mode: Mode) => Promise<LampResult>,
) {
  const active = new Set<Mode>();
  function input<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new LabError('invalid_input', 'Request fields do not match this operation.');
    return parsed.data;
  }
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
  app.get('/api/desk/:mode', async (request) => {
    const { mode } = input(z.object({ mode: modeSchema }), request.params);
    return store.memory(mode);
  });
  app.post('/api/desk/select', async (request) => {
    const { mode, segmentRunId, detectionId } = input(
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
    const run = store.getRun(segmentRunId);
    if (
      !run ||
      run.kind !== 'segment' ||
      run.mode !== mode ||
      run.status !== 'completed' ||
      store.latestSegment(mode) !== segmentRunId
    )
      throw new LabError('observation_source', 'Choose a completed segmentation from this mode.');
    const segmentation = run.output as Segmentation;
    const detection = segmentation.detections.find((d) => d.objectId === detectionId);
    if (
      !/^(mug|cream mug|cup)$/i.test(segmentation.concept) ||
      !detection ||
      !segmentation.sourceKey
    )
      throw new LabError('mug_selection', 'Select a specific mug mask from a new segmentation.');
    if (Date.now() - Date.parse(run.createdAt) > OBSERVATION_MAX_AGE_MS)
      throw new LabError('stale_observation', 'This segmentation is stale. Segment a new frame.');
    const memory = store.memory(mode);
    memory.object ??= {
      id: randomUUID(),
      label: 'My desk mug',
      createdAt: new Date().toISOString(),
    };
    memory.observation = {
      id: randomUUID(),
      objectId: memory.object.id,
      segmentRunId,
      detectionId,
      observedAt: run.createdAt,
      sourceKey: segmentation.sourceKey,
      frame: segmentation.frame,
      box: detection.box,
      identity: 'manual',
    };
    // A zone is meaningful only for the exact prepared image on which it was drawn.
    if (memory.zone?.sourceKey !== segmentation.sourceKey) memory.zone = null;
    memory.lastDecision = null;
    store.saveMemory(memory);
    store.save(evidence('observation', mode, memory.observation));
    return memory;
  });
  app.post('/api/desk/zone', async (request) => {
    const { mode, observationId, rect } = input(
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
    memory.zone = { id: randomUUID(), sourceKey: memory.observation.sourceKey, rect };
    memory.lastDecision = null;
    store.saveMemory(memory);
    store.save(evidence('zone', mode, { ...memory.zone, observationId }));
    return memory;
  });
  app.post('/api/desk/reset', async (request) => {
    const { mode } = input(z.object({ mode: modeSchema }).strict(), request.body);
    available(mode);
    const memory: DeskMemory = {
      mode,
      object: null,
      observation: null,
      zone: null,
      lastDecision: null,
    };
    store.saveMemory(memory);
    // Evidence and one-shot claims intentionally survive reset.
    return memory;
  });
  app.post('/api/desk/verify', async (request) => {
    const { mode, observationId, zoneId } = input(
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
    const o = memory.observation;
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
    if (decision.decision === 'inside' && !store.claimPlacement(o.segmentRunId)) {
      decision.decision = 'blocked';
      decision.reason =
        'This segmentation already attempted an action. Capture and segment a new frame; no automatic retry.';
    }
    const event = evidence('placement', mode, decision);
    const start = performance.now();
    if (decision.decision === 'inside') {
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
  });
}
