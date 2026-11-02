import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  roomCalibrationSchema,
  zoneOnSurfaceSchema,
  type ZoneOnSurface,
  modeSchema,
  zoneRectSchema,
  surfacePinSchema,
  isoSurface,
  fixtureEntity,
  settleFixtures,
  followSurfaces,
  sightingSpot,
  DEMO_SURFACE,
  linkedFixtures,
  FIXTURE_MOVED,
  type Fixture,
  isoItemSchema,
  objectById,
  modelTarget,
  setModel,
  ruleGate,
  ruleObjects,
  ruleSighting,
  withoutThings,
  ruleInputSchema,
  exposedInputSchema,
  MAX_EXPOSED,
  MAX_OTHER_OBJECTS,
  MAX_RULES,
  MAX_FIXTURES,
  MAX_DISMISSED,
  placeSeen,
  type PlacementRule,
  isoSceneSchema,
  uniqueParts,
  draftModel,
  PHOTO_AS,
  MAX_PHOTO_THINGS,
  type PhotoThing,
  type SavedItem,
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
  type SurfacePin,
  sceneIllustrationSchema,
  textureRef,
} from '@livinglayer/domain';
import { EvidenceStore } from './store.js';
import { LabError, parseInput, safeError } from './errors.js';
import { keepLocked, rescore } from './item.js';
import type { PhotoDraft } from './photo.js';
import { noteControl } from './fixture.js';
import { refitToScene } from './room.js';

/** A zone drawn in the room must name a surface the room has. */
function checkOnSurface(memory: DeskMemory, onSurface: ZoneOnSurface | undefined) {
  if (onSurface && !isoSurface(onSurface.scene, onSurface.surfaceId, memory.scene))
    throw new LabError('zone_surface', 'That zone names a surface the room lacks.', 400);
}

/** What the watcher calls to have SAM's answer recorded and rules checked, as the routes do. */
export type DeskTracking = ReturnType<typeof deskRoutes>;

export function deskRoutes(
  app: FastifyInstance,
  store: EvidenceStore,
  /** Switch the main lamp (no entity) or a light or switch, on unless told off. */
  turnOn: (mode: Mode, entityId?: string, action?: 'on' | 'off') => Promise<LampResult>,
  /** The lights and switches rules may name. */
  entities: (mode: Mode) => string[] = () => [],
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
        noteControl(memory, decision.lamp);
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
   * Check the extra rules, all of them or only those counting one object.
   * Each rule keeps its own occupied/empty story, switches its entity on only
   * when the zone fills (and off when it empties, if asked), and can act at
   * most once per segmentation each way, like the main zone.
   */
  async function verifyRules(mode: Mode, objectId?: string) {
    const events: EvidenceRun<PlacementDecision>[] = [];
    const memory = store.memory(mode);
    for (const rule of memory.rules ?? []) {
      if (objectId && !ruleObjects(memory, rule).includes(objectId)) continue;
      const { inside, objectId: by, ...gate } = ruleGate(memory, rule);
      const o = by ? (objectById(memory, by)?.observation ?? null) : null;
      const decision: PlacementDecision = {
        ...gate,
        observationId: o?.id ?? null,
        objectId: by,
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
        rule.inside = inside;
      }
      // A zone with no entity only tells Home Assistant: nothing to switch, nothing to claim.
      const switching =
        rule.entityId === null
          ? null
          : decision.transition === 'entered'
            ? 'on'
            : decision.transition === 'left' && rule.offWhenEmpty
              ? 'off'
              : null;
      const claim = `${o?.segmentRunId}:${rule.id}${switching === 'off' ? ':left' : ''}`;
      if (switching && !store.claimPlacement(claim)) {
        decision.decision = 'blocked';
        decision.transition = undefined;
        decision.reason = `This segmentation already attempted "${rule.label}". Track the object in a new frame; no automatic retry.`;
      }
      const event = evidence('placement', mode, decision);
      const start = performance.now();
      if (switching && decision.transition) {
        decision.action = 'pending';
        event.status = 'unconfirmed';
      }
      store.save(event);
      rule.lastDecision = event;
      store.saveMemory(memory);
      if (decision.action === 'pending') {
        active.add(mode);
        try {
          decision.lamp = await turnOn(mode, rule.entityId!, switching!);
          decision.action = decision.lamp.stateConfirmed ? 'confirmed' : 'unconfirmed';
          event.status = decision.lamp.stateConfirmed ? 'completed' : 'unconfirmed';
          noteControl(memory, decision.lamp);
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
  async function trackMug(mode: Mode, segmentRunId: string) {
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
  }
  app.post('/api/desk/track', async (request) => {
    const { mode, segmentRunId } = parseInput(
      z.object({ mode: modeSchema, segmentRunId: z.string().uuid() }).strict(),
      request.body,
    );
    return trackMug(mode, segmentRunId);
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
   * It changes how the desk is drawn, not placement, which runs on the frame;
   * fixtures a scan placed stand again where the scan saw them, under the new pin.
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
    if (pin)
      for (const f of memory.fixtures ?? []) {
        const spot = f.scanned ? placeSeen(f, pin, memory.scene ?? null) : null;
        if (spot) Object.assign(f, spot);
      }
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
  async function trackObject(mode: Mode, objectId: string, segmentRunId: string) {
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
  }
  app.post('/api/desk/objects/track', async (request) => {
    const { mode, objectId, segmentRunId } = parseInput(
      z
        .object({ mode: modeSchema, objectId: z.string().uuid(), segmentRunId: z.string().uuid() })
        .strict(),
      request.body,
    );
    return trackObject(mode, objectId, segmentRunId);
  });
  /**
   * A new sighting of a fixture: remembered with its history, and its place
   * in the room (and its linked copies' places) moved to where it was seen,
   * when the pin fits their scene.
   */
  function sightFixture(
    memory: DeskMemory,
    fixture: Fixture,
    concept: string,
    observation: DeskObservation,
  ) {
    const before = fixture.track?.observation;
    const spot = sightingSpot(observation);
    const was = before && sightingSpot(before);
    const moved =
      was && Math.hypot(spot.foot.x - was.foot.x, spot.foot.y - was.foot.y) > FIXTURE_MOVED;
    for (const f of [fixture, ...linkedFixtures(memory.fixtures ?? [], fixture)]) {
      f.seen = spot;
      const pin = memory.surface ?? (memory.mode === 'demo' ? DEMO_SURFACE : null);
      const place = pin ? placeSeen(f, pin, memory.scene ?? null) : null;
      if (place) Object.assign(f, place);
      f.updatedAt = new Date().toISOString();
    }
    fixture.track = {
      concept,
      observation,
      history: before ? [before, ...(fixture.track?.history ?? [])].slice(0, HISTORY_LIMIT) : [],
      status: moved ? 'moved' : 'seen',
    };
    store.saveMemory(memory);
    store.save(evidence('observation', memory.mode, observation));
  }
  /** Confirm a fixture in a segmentation by hand, so the camera follows it from now on. */
  function anchorFixture(mode: Mode, fixtureId: string, segmentRunId: string, detectionId: string) {
    available(mode);
    const { run, segmentation } = latestSegmentation(mode, segmentRunId);
    const detection = segmentation.detections.find((d) => d.objectId === detectionId);
    if (!detection) throw new LabError('object_selection', 'Pick a mask from this segmentation.');
    const memory = store.memory(mode);
    const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
    if (!fixture)
      throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
    const observation = sightingOf(fixture.id, run, segmentation, detection, 'manual', null);
    delete fixture.track;
    sightFixture(memory, fixture, segmentation.concept, observation);
    return store.memory(mode);
  }
  /** Follow a tracked fixture into the newest segmentation of its concept, then check its rules. */
  async function trackFixture(mode: Mode, fixtureId: string, segmentRunId: string) {
    available(mode);
    const memory = store.memory(mode);
    const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
    if (!fixture?.track)
      throw new LabError('track_identity', 'Find this fixture in the camera first.', 409);
    const { run, segmentation } = latestSegmentation(mode, segmentRunId);
    if (!sameConcept(segmentation.concept, fixture.track.concept))
      throw new LabError(
        'track_concept',
        `Segment "${fixture.track.concept}" to track the ${fixture.label}.`,
        409,
      );
    if (!segmentation.detections.length)
      throw new LabError(
        'track_lost',
        `SAM found no ${fixture.track.concept} in this frame. Nothing changed.`,
        409,
      );
    const match = pickTracked(
      segmentation.detections,
      segmentation.frame,
      fixture.track.observation,
    )!;
    sightFixture(
      memory,
      fixture,
      fixture.track.concept,
      sightingOf(fixture.id, run, segmentation, match.detection, 'tracked', match.overlap),
    );
    const events = await verifyRules(mode, fixture.id);
    return { memory: store.memory(mode), events };
  }
  /** The watcher lost a fixture: it keeps its last place, drawn as missing. */
  function loseFixture(mode: Mode, fixtureId: string) {
    const memory = store.memory(mode);
    const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
    if (!fixture?.track || fixture.track.status === 'missing') return;
    fixture.track.status = 'missing';
    store.saveMemory(memory);
  }
  app.post('/api/fixtures/anchor', async (request) => {
    const { mode, id, segmentRunId, detectionId } = parseInput(
      z
        .object({
          mode: modeSchema,
          id: z.string().uuid(),
          segmentRunId: z.string().uuid(),
          detectionId: z.string().min(1).max(80),
        })
        .strict(),
      request.body,
    );
    return anchorFixture(mode, id, segmentRunId, detectionId);
  });
  app.post('/api/fixtures/track', async (request) => {
    const { mode, id, segmentRunId } = parseInput(
      z
        .object({ mode: modeSchema, id: z.string().uuid(), segmentRunId: z.string().uuid() })
        .strict(),
      request.body,
    );
    return trackFixture(mode, id, segmentRunId);
  });
  /** Stop following a fixture; it stays where it was last seen. */
  app.post('/api/fixtures/untrack', async (request) => {
    const { mode, id } = parseInput(
      z.object({ mode: modeSchema, id: z.string().uuid() }).strict(),
      request.body,
    );
    available(mode);
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
  app.post('/api/desk/objects/forget', async (request) => {
    const { mode, objectId } = parseInput(
      z.object({ mode: modeSchema, objectId: z.string().uuid() }).strict(),
      request.body,
    );
    available(mode);
    const memory = store.memory(mode);
    memory.others = (memory.others ?? []).filter((o) => o.id !== objectId);
    memory.rules = withoutThings(memory.rules, [objectId]);
    store.saveMemory(memory);
    return memory;
  });
  /**
   * Save an extra zone that counts some things, or any, and one light or
   * switch, or none. Like the main zone, it belongs to the image of the
   * newest sighting among the things it counts.
   */
  app.post('/api/desk/rules/save', async (request) => {
    const { mode, rule: input } = parseInput(
      z.object({ mode: modeSchema, rule: ruleInputSchema }).strict(),
      request.body,
    );
    available(mode);
    const memory = store.memory(mode);
    if (input.objects !== 'any' && input.objects.some((id) => !objectById(memory, id)?.observation))
      throw new LabError('rule_object', 'Confirm that object in a segmentation first.', 409);
    const o = ruleSighting(memory, input.objects);
    if (!o) throw new LabError('rule_object', 'Confirm something in a segmentation first.', 409);
    if (input.entityId !== null && !entities(mode).includes(input.entityId))
      throw new LabError('rule_light', 'Choose one of the configured lights or switches.', 400);
    if (input.fixtureId && input.objects !== 'any' && input.objects.includes(input.fixtureId))
      throw new LabError('rule_fixture', 'A fixture can’t switch itself on by moving.', 400);
    checkOnSurface(memory, input.onSurface);
    if (input.fixtureId) {
      const fixture = memory.fixtures?.find((f) => f.id === input.fixtureId);
      if (!fixture || fixtureEntity(fixture) !== input.entityId)
        throw new LabError('rule_fixture', 'That fixture does not switch this entity.', 400);
    }
    const rules = memory.rules ?? [];
    if (!input.id && rules.length >= MAX_RULES)
      throw new LabError('rule_limit', `Up to ${MAX_RULES} extra zones are allowed.`, 409);
    const rule: PlacementRule = {
      id: input.id ?? randomUUID(),
      label: input.label,
      objects: input.objects === 'any' ? 'any' : [...new Set(input.objects)],
      entityId: input.entityId,
      ...(input.fixtureId ? { fixtureId: input.fixtureId } : {}),
      ...(input.offWhenEmpty ? { offWhenEmpty: true } : {}),
      zone: {
        sourceKey: o.sourceKey,
        rect: input.rect,
        frame: o.frame,
        ...(input.onSurface ? { onSurface: input.onSurface } : {}),
      },
      // A new or moved zone starts a new inside/outside story.
      placement: null,
      inside: [],
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
    let memory = store.memory(mode);
    const before = memory.scene ?? null;
    memory.scene = scene as IsoScene | null;
    // A room made another size takes its camera with it: fitted again to the same marks.
    memory = refitToScene(memory, before);
    // What stands on a desk that was turned or moved goes with it, then settles into the scene.
    if (memory.fixtures)
      memory.fixtures = settleFixtures(
        followSurfaces(memory.fixtures, before, memory.scene ?? null),
        memory.scene ?? null,
      );
    if (
      memory.surface?.scene === 'custom' &&
      !isoSurface('custom', memory.surface.surfaceId, memory.scene)
    )
      memory.surface = null;
    store.saveMemory(memory);
    return memory;
  });
  /**
   * Save a reviewed photo draft in one go: the scene, the pin, and the
   * objects the person ticked, each remembered from its own mask with the
   * model fitted to it. The first ticked object becomes the main one (the
   * mug), so identity stays a person's choice, as it does for a mask.
   */
  /** A face texture of a scene drafted from a photo, before the room had a calibrated camera. */
  app.get('/api/scene/texture', async (request, reply) => {
    const { asset } = parseInput(z.object({ asset: textureRef }).strict(), request.query);
    const png = store.readAsset(asset);
    if (!png) throw new LabError('texture_missing', 'This texture is gone.', 404);
    return reply.type('image/png').header('cache-control', 'no-cache').send(png);
  });
  app.post('/api/scene/from-photo/save', async (request) => {
    const tiles = z.number().finite();
    const {
      mode,
      runId,
      scene,
      pin,
      track,
      as = {},
      fixtures = [],
    } = parseInput(
      z
        .object({
          mode: modeSchema,
          runId: z.string().uuid(),
          scene: isoSceneSchema,
          pin: surfacePinSchema.nullable(),
          track: z.array(z.string().min(1).max(24)).max(1 + MAX_OTHER_OBJECTS),
          /** What the person changed things to be drawn as, by thing id. */
          as: z.record(z.string().min(1).max(24), z.enum(PHOTO_AS)).optional(),
          /** Things no template draws and nobody tracks, where the review laid them out. */
          fixtures: z
            .array(
              z
                .object({
                  id: z.string().min(1).max(24),
                  at: z.object({ x: tiles, y: tiles, z: tiles }).strict(),
                  /** As it stands, turned. */
                  size: z.object({ w: tiles, d: tiles, h: tiles }).strict(),
                  turns: z.number().int().min(0).max(3).optional(),
                })
                .strict(),
            )
            .max(MAX_PHOTO_THINGS)
            .optional(),
        })
        .strict(),
      request.body,
    );
    available(mode);
    const draftRun = store.getRun(runId);
    if (
      !draftRun ||
      draftRun.kind !== 'photo' ||
      draftRun.mode !== mode ||
      draftRun.status !== 'completed'
    )
      throw new LabError('photo_draft', 'Draft a scene from a photo first.', 409);
    const draft = draftRun.output as PhotoDraft;
    const segment = store.getRun(draft.segmentRunId);
    if (!segment || store.latestSegment(mode) !== segment.id)
      throw new LabError(
        'photo_stale',
        'A newer segmentation came after this photo draft. Draft the photo again.',
        409,
      );
    const segmentation = segment.output as Segmentation;
    if (pin && (pin.scene !== 'custom' || !isoSurface('custom', pin.surfaceId, scene as IsoScene)))
      throw new LabError('surface_unknown', 'The pin must be on a surface of the drafted scene.');
    const picked = track.map((thingId) => {
      const detectionId = draft.detections[thingId];
      const detection = segmentation.detections.find((d) => d.objectId === detectionId);
      const thing = draft.inventory.things.find((t) => t.id === thingId);
      if (!detection || !thing)
        throw new LabError('photo_object', 'Pick objects that SAM outlined in this draft.');
      return { thing, detection };
    });
    let memory = store.memory(mode);
    if ((memory.others?.length ?? 0) + Math.max(0, picked.length - 1) > MAX_OTHER_OBJECTS)
      throw new LabError(
        'object_limit',
        `Up to ${MAX_OTHER_OBJECTS} more objects can be remembered. Forget one, or tick fewer.`,
        409,
      );
    // The room is drawn from its templates; nothing from the photo is pasted on.
    memory.scene = scene as IsoScene;
    // Through the camera it was laid out through: newer when the draft turned a hidden wall.
    if (memory.camera && draft.calibration.calibratedAt > memory.camera.calibratedAt)
      memory.camera = { ...memory.camera, ...draft.calibration };
    if (memory.fixtures) memory.fixtures = settleFixtures(memory.fixtures, memory.scene);
    memory.surface = pin as SurfacePin | null;
    memory.scenePhoto =
      mode === 'live' && store.readAsset(`${runId}/source.png`) ? `${runId}/source.png` : null;
    // A new photo is a new room: the old pictures of it no longer fit.
    memory.illustration = null;
    memory.deskIllustration = null;
    store.saveMemory(memory);
    const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const now = new Date().toISOString();
    // Chosen again with what the person changed it to, from the fixtures saved before this.
    const library = memory.fixtures ?? [];
    const chosen = (thing: PhotoThing) => draftModel(thing, as[thing.id] ?? thing.as, library);
    const saved = (thing: PhotoThing): SavedItem => {
      const c = chosen(thing);
      return {
        ...uniqueParts(c.item),
        label: thing.label,
        source: c.source === 'library' ? 'spark' : 'placeholder',
        segmentRunId: draft.segmentRunId,
        swatches: [{ hex: thing.color, share: 1 }],
        updatedAt: now,
        fit: null,
      };
    };
    const model = (thingId: string, previous: ReturnType<typeof modelTarget>) => {
      const thing = draft.inventory.things.find((t) => t.id === thingId);
      if (!thing) return null;
      const item = saved(thing);
      return { ...item, ...uniqueParts(keepLocked(item, previous?.item)) };
    };
    // What no template draws stays as a fixture, with its model and the crop Spark can model it from.
    const claimed = new Set<string>();
    const added: Fixture[] = [];
    for (const f of fixtures) {
      const thing = draft.inventory.things.find((t) => t.id === f.id);
      if (!thing || track.includes(f.id))
        throw new LabError(
          'photo_object',
          'Keep as fixtures only things from this draft that aren’t tracked.',
        );
      const c = { x: f.at.x + f.size.w / 2, y: f.at.y + f.size.d / 2 };
      const surface =
        f.at.z > 0.05
          ? memory.scene.surfaces
              .filter(
                (x) =>
                  Math.abs(x.z - f.at.z) < 0.1 &&
                  c.x >= x.rect.x &&
                  c.x <= x.rect.x + x.rect.w &&
                  c.y >= x.rect.y &&
                  c.y <= x.rect.y + x.rect.d,
              )
              .sort((a, b) => b.z - a.z)[0]
          : undefined;
      const where = { at: { x: f.at.x, y: f.at.y }, surfaceId: surface?.id ?? null };
      // The same thing already in this room moves here, and keeps its model, size and switch.
      const pick = chosen(thing);
      const same = library.find(
        (x) => x.id === pick.fixtureId && x.scene === 'custom' && !claimed.has(x.id),
      );
      if (same) {
        claimed.add(same.id);
        added.push({ ...same, ...where, updatedAt: now });
        continue;
      }
      const fit = (v: number) => Math.min(8, Math.max(0.1, v));
      // A fixture's size is before its turn.
      const turns = (f.turns ?? 0) as 0 | 1 | 2 | 3;
      const own = turns % 2 ? { w: f.size.d, d: f.size.w } : f.size;
      const crop = draft.crops[thing.id];
      added.push({
        id: randomUUID(),
        label: label(thing.label),
        scene: 'custom',
        ...where,
        turns,
        size: { w: fit(own.w), d: fit(own.d), h: fit(f.size.h) },
        model: saved(thing),
        reference: crop ? { runId, asset: crop } : null,
        control: { kind: 'none' },
        createdAt: now,
        updatedAt: now,
      });
    }
    if (added.length) {
      const moved = new Set(added.map((f) => f.id));
      const rest = (memory.fixtures ?? []).filter((f) => !moved.has(f.id));
      memory.fixtures = settleFixtures([...rest, ...added].slice(0, MAX_FIXTURES), memory.scene);
      store.saveMemory(memory);
    }
    const [main, ...rest] = picked;
    if (main) {
      const fresh = !memory.object;
      observe(memory, segment, segmentation, main.detection, 'manual', null);
      memory = store.memory(mode);
      if (fresh && memory.object) memory.object.label = label(main.thing.label);
      const item = model(main.thing.id, modelTarget(memory));
      if (item) setModel(memory, memory.object!.id, item);
    }
    for (const { thing, detection } of rest) {
      const id = randomUUID();
      const observation = sightingOf(id, segment, segmentation, detection, 'manual', null);
      memory.others = [
        ...(memory.others ?? []),
        {
          id,
          label: label(thing.label),
          concept: thing.label,
          createdAt: new Date().toISOString(),
          observation,
          history: [],
          item: model(thing.id, null),
        },
      ];
      store.save(evidence('observation', mode, observation));
    }
    store.saveMemory(memory);
    return store.memory(mode);
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
    const { mode, observationId, rect, onSurface } = parseInput(
      z
        .object({
          mode: modeSchema,
          observationId: z.string().uuid(),
          rect: zoneRectSchema,
          onSurface: zoneOnSurfaceSchema.optional(),
        })
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
    checkOnSurface(memory, onSurface);
    memory.zone = {
      id: randomUUID(),
      sourceKey: memory.observation.sourceKey,
      rect,
      frame: memory.observation.frame,
      ...(onSurface ? { onSurface } : {}),
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
      camera: store.memory(mode).camera ?? null,
      scene: store.memory(mode).scene ?? null,
      // The scene's pictures are part of the scene, so they stay with it.
      illustration: store.memory(mode).illustration ?? null,
      scenePhoto: store.memory(mode).scenePhoto ?? null,
      // What the person said isn't a fixture stays said.
      dismissed: store.memory(mode).dismissed ?? [],
      deskIllustration: store.memory(mode).deskIllustration ?? null,
      // Which camera is watched is a fact about the setup too.
      ...(store.memory(mode).watch ? { watch: store.memory(mode).watch } : {}),
      history: [],
      placement: null,
      // Extra objects and their rules go with the mug; the scene stays.
      others: [],
      rules: [],
      fixtures: store.memory(mode).fixtures ?? [],
      // Entities in Home Assistant describe the home; ones whose zone went show as unavailable.
      exposed: store.memory(mode).exposed ?? [],
    };
    store.saveMemory(memory);
    // Evidence and one-shot claims intentionally survive reset.
    return memory;
  });
  /**
   * Put the demo's memory back to the preset, as a fresh data folder has it:
   * no scene, pin, fixtures or saved models of its own. For probes against
   * the dev server (`bun run reset demo`); live memory is never touched.
   */
  app.post('/api/desk/demo/reset', async () => {
    const memory: DeskMemory = {
      mode: 'demo',
      object: null,
      observation: null,
      zone: null,
      lastDecision: null,
    };
    store.saveMemory(memory);
    return store.memory('demo');
  });
  /**
   * Put back a whole desk memory: an imported save, an undo or redo, or the
   * empty demo desk. The pin and the scene are checked like any other save;
   * the rest is the lab's own output coming back. Evidence is untouched.
   */
  app.post('/api/desk/restore', async (request) => {
    const { mode, memory } = parseInput(
      z
        .object({
          mode: modeSchema,
          memory: z
            .object({
              mode: modeSchema,
              object: z
                .object({ id: z.string().min(1), label: z.string(), createdAt: z.string() })
                .nullable(),
              surface: surfacePinSchema.nullable().optional(),
              camera: roomCalibrationSchema.nullable().optional(),
              scene: isoSceneSchema.nullable().optional(),
              scenePhoto: z
                .string()
                .regex(/^[a-z0-9-]{1,64}\/source\.png$/)
                .nullable()
                .optional(),
              illustration: sceneIllustrationSchema.nullable().optional(),
              deskIllustration: sceneIllustrationSchema.nullable().optional(),
              others: z
                .array(z.object({ id: z.string().min(1) }).loose())
                .max(MAX_OTHER_OBJECTS)
                .optional(),
              rules: z
                .array(z.object({ id: z.string().min(1) }).loose())
                .max(MAX_RULES)
                .optional(),
              fixtures: z
                .array(z.object({ id: z.string().min(1) }).loose())
                .max(MAX_FIXTURES)
                .optional(),
              dismissed: z.array(z.string().min(1).max(40)).max(MAX_DISMISSED).optional(),
              exposed: z
                .array(exposedInputSchema.required({ id: true }))
                .max(MAX_EXPOSED)
                .optional(),
            })
            .loose(),
        })
        .strict(),
      request.body,
    );
    if (memory.mode !== mode)
      throw new LabError('restore_mode', `This save is for ${memory.mode} mode, not ${mode}.`, 400);
    available(mode);
    const next = memory as unknown as DeskMemory;
    if (next.surface && !isoSurface(next.surface.scene, next.surface.surfaceId, next.scene))
      throw new LabError('restore_surface', 'The saved pin names a surface the scene lacks.', 400);
    store.saveMemory({
      ...next,
      zone: next.zone ?? null,
      lastDecision: next.lastDecision ?? null,
      observation: next.observation ?? null,
    });
    return store.memory(mode);
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
  return { trackMug, trackObject, trackFixture, loseFixture, verifyRules };
}
