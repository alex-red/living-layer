import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  runOutput,
  deskZoneOptionsBodySchema,
  deskCameraBodySchema,
  deskObjectsForgetBodySchema,
  deskObjectsSelectBodySchema,
  deskObjectsTrackBodySchema,
  deskRestoreBodySchema,
  deskRulesDeleteBodySchema,
  deskRulesOptionsBodySchema,
  deskRulesSaveBodySchema,
  deskSelectBodySchema,
  deskSurfaceBodySchema,
  deskTrackBodySchema,
  deskVerifyBodySchema,
  deskZoneBodySchema,
  modeOnlySchema,
  type ZoneOnSurface,
  isoSurface,
  fixtureEntities,
  sightingSpot,
  DEMO_SURFACE,
  linkedFixtures,
  FIXTURE_MOVED,
  movedFrom,
  type FixtureTrack,
  type Fixture,
  objectById,
  withSighting,
  MAIN_RULE,
  zoneApplies,
  followedThings,
  mugOf,
  otherThings,
  sightedThing,
  stockModel,
  type UnitBox,
  ruleGate,
  ruleObjects,
  ruleSighting,
  withoutThings,
  anchoredZone,
  placeAnchor,
  MAX_OTHER_OBJECTS,
  MAX_RULES,
  placeSeen,
  pinInOrder,
  calibrationOf,
  type PlacementRule,
  type ZoneStep,
  type DesktopNodeMessage,
  ruleActions,
  runSteps,
  stepEntities,
  stepThings,
  inTimeWindow,
  type ZoneActions,
  placementGate,
  pickTracked,
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
  type LightLook,
  zoneThingId,
} from '@livinglayer/domain';
import { EvidenceStore } from './store.js';
import { LabError, parseInput, safeError } from './errors.js';
import { noteControl } from './fixture/control.js';
import type { RouteDeps } from './route-deps.js';
import type { SwitchOptions, Switched } from './control.js';

/**
 * The main zone, when it no longer applies to the mug's sighting: the mug
 * was seen on another image. One set to count other things keeps.
 */
function dropMainZone(memory: DeskMemory) {
  const main = memory.rules?.find((r) => r.id === MAIN_RULE);
  const mug = mugOf(memory);
  if (main && mug && ruleObjects(memory, main).includes(mug.id) && !zoneApplies(memory).applies)
    memory.rules = memory.rules!.filter((r) => r.id !== MAIN_RULE);
}
/**
 * What a zone may be set off by: things remembered and seen, never the
 * thing it is or the fixture it switches; a motion zone by nothing.
 */
function checkTriggers(
  memory: DeskMemory,
  rule: Pick<PlacementRule, 'objects' | 'motion' | 'anchor' | 'fixtureId'>,
) {
  if (rule.motion && rule.objects !== 'any')
    throw new LabError('rule_object', 'A motion zone counts no things.', 400);
  if (rule.objects === 'any') return;
  if (rule.objects.some((id) => !objectById(memory, id)?.observation))
    throw new LabError('rule_object', 'Confirm that object in a segmentation first.', 409);
  if (rule.anchor && rule.objects.includes(rule.anchor.thingId))
    throw new LabError('rule_object', 'A thing can’t stand on itself.', 400);
  if (rule.fixtureId && rule.objects.includes(rule.fixtureId))
    throw new LabError('rule_fixture', 'A fixture can’t switch itself on by moving.', 400);
}
/** A zone drawn in the room must name a surface the room has. */
function checkOnSurface(memory: DeskMemory, onSurface: ZoneOnSurface | undefined) {
  if (onSurface && !isoSurface(onSurface.scene, onSurface.surfaceId, memory.scene))
    throw new LabError('zone_surface', 'That zone names a surface the room lacks.', 400);
}
/** A zone's steps may switch only configured entities, and ask only about things it counts. */
function checkActions(
  memory: DeskMemory,
  actions: ZoneActions,
  entities: string[],
  counts: PlacementRule['objects'],
) {
  const all = [...actions.onEnter, ...actions.onLeave];
  const unknown = stepEntities(all).find((e) => !entities.includes(e));
  if (unknown)
    throw new LabError(
      'rule_light',
      `${unknown} isn’t one of the configured lights or switches.`,
      400,
    );
  const things = stepThings(all);
  if (things.some((id) => !objectById(memory, id) || (counts !== 'any' && !counts.includes(id))))
    throw new LabError('rule_thing', 'A step asks about a thing this zone doesn’t count.', 400);
}

/** The desk's state and steps, shared by its routes, the scene and fixture routes that change a desk, and the watcher. */
export function createDesk(
  store: EvidenceStore,
  /** Switch the main lamp (no entity) or a light or switch, on unless told off. */
  turnOn: (
    mode: Mode,
    entityId?: string,
    action?: 'on' | 'off',
    look?: LightLook,
    options?: SwitchOptions,
  ) => Promise<Switched>,
  {
    sleep = (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      }),
    desktop = async () => {
      throw new LabError('node_unknown', 'No desktop nodes here.', 404);
    },
  }: {
    /** How a zone's `wait` step waits; ends early when the run is stopped. */
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    /** Sends a desktop node a zone step's banner or page (`DesktopNodes.send`). */
    desktop?: (mode: Mode, nodeId: string, message: DesktopNodeMessage) => Promise<unknown>;
  } = {},
) {
  const active = new Set<Mode>();
  /** Each zone's steps still running, by mode and rule, so a newer trigger stops them. */
  const runs = new Map<string, AbortController>();
  const LOCALLY = 'Seen where the watcher follows it, without a SAM call.';
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
    const segmentation = runOutput(run, 'segment')!;
    if (!isMugConcept(segmentation.concept) || !segmentation.sourceKey)
      throw new LabError('mug_selection', 'Segment the mug in a new frame first.');
    if (Date.now() - Date.parse(run.createdAt) > OBSERVATION_MAX_AGE_MS)
      throw new LabError('stale_observation', 'This segmentation is stale. Segment a new frame.');
    return { run, segmentation };
  }
  /**
   * Record where the mug is now, keeping the previous sighting in its
   * history: the mug is the thing of its type the camera places, made the
   * first time one is confirmed.
   */
  function observe(
    memory: DeskMemory,
    run: EvidenceRun,
    segmentation: Segmentation,
    detection: Detection,
    identity: DeskObservation['identity'],
    overlap: number | null,
  ) {
    let mug = mugOf(memory);
    const id = mug?.id ?? randomUUID();
    const observation = sightingOf(id, run, segmentation, detection, identity, overlap);
    if (!mug) {
      mug = sightedThing(memory, {
        id,
        label: 'My desk mug',
        concept: 'mug',
        observation,
        type: 'mug',
        model: stockModel('Mug'),
      });
      memory.fixtures = [...(memory.fixtures ?? []), mug];
    } else {
      const before = mug.track?.observation;
      mug.track = {
        concept: 'mug',
        observation,
        history: before ? [before, ...(mug.track?.history ?? [])].slice(0, HISTORY_LIMIT) : [],
        status: 'seen',
      };
      mug.updatedAt = new Date().toISOString();
    }
    // The main zone is meaningful only for the image it was drawn on, unless the
    // person has said the camera is fixed and the frame is the same size.
    dropMainZone(memory);
    memory.lastDecision = null;
    store.saveMemory(memory);
    store.save(evidence('observation', memory.mode, observation));
    return observation;
  }
  /**
   * Check the mug against the main zone, the rule `main`: its light turns on
   * when the mug enters and off when it leaves, unless the zone keeps it on.
   * Each segmentation can attempt each at most once. With no zone yet, a
   * blocked decision says what to do first.
   */
  async function verify(mode: Mode, memory: DeskMemory): Promise<EvidenceRun<PlacementDecision>> {
    const mug = mugOf(memory);
    const superseded = Boolean(
      mug?.track && store.latestSegment(mode) !== mug.track.observation.segmentRunId,
    );
    if (mug && !superseded && memory.rules?.some((r) => r.id === MAIN_RULE)) {
      // Whatever it counts: the mug by default, or the things it was set to.
      const [event] = await verifyRules(mode, undefined, undefined, MAIN_RULE);
      if (event) return event;
    }
    const o = mug?.track?.observation ?? null;
    const event = evidence('placement', mode, {
      ...(superseded
        ? {
            decision: 'blocked' as const,
            reason:
              'A newer segmentation superseded this observation. Confirm its mug mask before verifying.',
          }
        : placementGate(memory)),
      observationId: o?.id ?? null,
      objectId: mug?.id ?? null,
      segmentRunId: o?.segmentRunId ?? null,
      zoneId: null,
      action: 'none' as const,
    });
    store.save(event);
    store.updateMemory(mode, (latest) => void (latest.lastDecision = event));
    return event;
  }
  /**
   * Switch what a decision asks for, if anything, and record how it went:
   * once Home Assistant takes the action and, when its state is checked in
   * the background, again once it reports it, so the next check isn't held
   * up. `record` puts the decision back in desk memory, as it may have
   * changed meanwhile; a newer decision there is left as it is.
   */
  async function dispatch(
    mode: Mode,
    zone: string,
    decision: PlacementDecision,
    event: EvidenceRun<PlacementDecision>,
    start: number,
    act: () => Promise<Switched>,
    record: (memory: DeskMemory) => void,
  ) {
    let confirming: Promise<LampResult> | undefined;
    if (decision.action === 'pending') {
      active.add(mode);
      try {
        const { confirming: later, ...lamp } = await act();
        confirming = later;
        decision.lamp = lamp;
        decision.action = lamp.stateConfirmed ? 'confirmed' : 'unconfirmed';
        event.status = lamp.stateConfirmed ? 'completed' : 'unconfirmed';
      } catch (error) {
        const safe = safeError(error);
        decision.action = 'failed';
        decision.error = { code: safe.code, message: safe.message };
        event.status = 'failed';
      } finally {
        active.delete(mode);
      }
    }
    const save = () => {
      event.durationMs = Math.round(performance.now() - start);
      store.updateRun(event);
      store.updateMemory(mode, (latest) => {
        record(latest);
        if (decision.lamp) noteControl(latest, decision.lamp);
      });
    };
    save();
    if (!confirming) return logZone(mode, zone, decision);
    void confirming.then((lamp) => {
      decision.lamp = lamp;
      decision.action = lamp.stateConfirmed ? 'confirmed' : 'unconfirmed';
      event.status = lamp.stateConfirmed ? 'completed' : 'unconfirmed';
      save();
      logZone(mode, zone, decision);
    });
  }
  /**
   * Keep a zone filling or emptying as its occupied stat's change, so asking
   * about the room can say how long something was in it.
   */
  function noteZone(mode: Mode, ruleId: string, transition: PlacementDecision['transition']) {
    if (transition !== 'entered' && transition !== 'left') return;
    const value = transition === 'entered';
    const event = { thingId: zoneThingId(ruleId), key: 'occupied' as const, at: Date.now(), value };
    store.saveStats(mode, [{ ...event, source: 'camera', confidence: 1 }], []);
  }
  /**
   * A line in the server's log for each zone check that changes something: a
   * thing entering or leaving, or an entity switched (or failing to be).
   */
  function logZone(mode: Mode, zone: string, d: PlacementDecision) {
    if (d.transition !== 'entered' && d.transition !== 'left' && d.action === 'none') return;
    const what = d.transition ?? d.decision;
    const timing = d.lamp?.ms
      ? ` (switched in ${d.lamp.ms.switch} ms, confirmed ${d.lamp.ms.confirm} ms later)`
      : '';
    const entity = d.lamp
      ? ` · ${d.lamp.entityId} ${d.lamp.action ?? 'on'}: ${d.action}${timing}`
      : d.action !== 'none'
        ? ` · ${d.action}`
        : ' · no entity switched';
    const error = d.error ? ` (${d.error.message})` : '';
    console.info(`[zone ${mode}] ${new Date().toISOString()} ${zone}: ${what}${entity}${error}`);
  }

  /**
   * What an action is claimed against, so it is tried at most once: the
   * segmentation a sighting came from, or the watcher's own sighting.
   */
  const claimOf = (o: DeskObservation, local?: DeskObservation) =>
    o === local ? `local:${o.id}` : o.segmentRunId;
  /**
   * Judge one thing's zones where the watcher follows it now, and switch what
   * that changes: no SAM call. Its remembered sighting stays SAM's (the
   * watcher learns its look from that photo); a copy at the followed box, on
   * a frame of the same size, is what the zones judge. A new frame, so a zone
   * drawn on another one applies only to a fixed or calibrated camera.
   */
  async function placeLocally(mode: Mode, objectId: string, box: UnitBox) {
    available(mode);
    const memory = store.memory(mode);
    const last = objectById(memory, objectId)?.observation;
    if (!last) throw new LabError('track_identity', 'Confirm it in a segmentation first.', 409);
    const { width, height } = last.frame;
    const local: DeskObservation = {
      ...last,
      id: randomUUID(),
      observedAt: new Date().toISOString(),
      sourceKey: 'local',
      box: {
        x: Math.round(box.x * width),
        y: Math.round(box.y * height),
        width: Math.round(box.width * width),
        height: Math.round(box.height * height),
      },
      identity: 'tracked',
    };
    const rules = await verifyRules(mode, objectId, local);
    const event = rules.find((e) => e.output.ruleId === MAIN_RULE) ?? null;
    return {
      memory: store.memory(mode),
      event,
      rules: rules.filter((e) => e !== event),
    };
  }
  /**
   * Check the extra rules, all of them or only those counting one object or
   * that are it, a zone that is a thing moved first to where it is. Each rule keeps its own occupied/empty story, switches its entity on only
   * when the zone fills (and off when it empties, if asked), and can act at
   * most once per segmentation each way, like the main zone.
   */
  async function verifyRules(
    mode: Mode,
    objectId?: string,
    local?: DeskObservation,
    only?: string,
  ) {
    const events: EvidenceRun<PlacementDecision>[] = [];
    const ruleLabels = new Map(
      (store.memory(mode).rules ?? [])
        // Motion zones are judged by the watcher's frames (`motionZone`), not by things.
        .filter((r) => !r.motion && (!only || r.id === only))
        .map((r) => [r.id, r.label]),
    );
    // Each rule is judged and saved against the memory as it is then; none is held over an await.
    for (const ruleId of ruleLabels.keys()) {
      const step = store.updateMemory(mode, (memory) => {
        const was = memory.rules?.find((r) => r.id === ruleId);
        const moves = Boolean(objectId && was?.anchor?.thingId === objectId);
        if (!was || (objectId && !moves && !ruleObjects(memory, was).includes(objectId)))
          return null;
        const judged = local ? withSighting(memory, local.objectId, local) : memory;
        // A zone that is a thing goes where the thing is now, before anything is judged in it.
        const rule = placeAnchor(judged, was);
        if (rule !== was) memory.rules = memory.rules!.map((r) => (r.id === ruleId ? rule : r));
        const { inside, objectId: by, ...gate } = ruleGate(judged, rule);
        const o = by ? (objectById(judged, by)?.observation ?? null) : null;
        const decision: PlacementDecision = {
          ...gate,
          ...(local && o === local ? { reason: `${gate.reason} ${LOCALLY}` } : {}),
          observationId: o?.id ?? null,
          objectId: by,
          segmentRunId: o && o !== local ? o.segmentRunId : null,
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
        // The steps this change runs: entering's or emptying's; a zone with none only tells Home Assistant.
        const actions = ruleActions(rule);
        const steps =
          decision.transition === 'entered'
            ? actions.onEnter
            : decision.transition === 'left'
              ? actions.onLeave
              : [];
        const claim = `${o ? claimOf(o, local) : undefined}:${rule.id}${decision.transition === 'left' ? ':left' : ''}`;
        if (steps.length && !store.claimPlacement(claim)) {
          decision.decision = 'blocked';
          decision.transition = undefined;
          decision.reason = `This segmentation already attempted "${rule.label}". Track the object in a new frame; no automatic retry.`;
        }
        if (decision.transition === 'stayed_inside' && actions.onEnter.length)
          decision.reason = `Still inside since the last check, so nothing is switched. It switches again once the zone empties and fills. ${decision.reason}`;
        const event = evidence('placement', mode, decision);
        const running = steps.length > 0 && Boolean(decision.transition);
        if (running) {
          decision.action = 'pending';
          event.status = 'unconfirmed';
        }
        store.save(event);
        rule.lastDecision = event;
        memory.lastDecision = event;
        return { decision, event, steps: running ? steps : [] };
      });
      if (!step) continue;
      const { decision, event, steps } = step;
      noteZone(mode, ruleId, decision.transition);
      await runActions(mode, ruleId, ruleLabels.get(ruleId) ?? 'Zone', steps, decision, event, {
        background: Boolean(local),
      });
      events.push(event);
    }
    return events;
  }
  /**
   * Run what a zone's change asks for and record how it went. One switch is
   * switched as a zone always has (in the background when the watcher saw
   * it); more steps go to `runZoneSteps`.
   */
  async function runActions(
    mode: Mode,
    ruleId: string,
    label: string,
    steps: ZoneStep[],
    decision: PlacementDecision,
    event: EvidenceRun<PlacementDecision>,
    { background }: { background: boolean },
  ) {
    const record = (memory: DeskMemory) => {
      const rule = memory.rules?.find((r) => r.id === ruleId);
      if (rule && (!rule.lastDecision || rule.lastDecision.id === event.id))
        rule.lastDecision = event;
      if (!memory.lastDecision || memory.lastDecision.id === event.id) memory.lastDecision = event;
    };
    const only = steps.length === 1 && steps[0]!.kind === 'switch' ? steps[0]! : null;
    if (steps.length && !only)
      return runZoneSteps(mode, ruleId, label, steps, decision, event, record);
    if (steps.length) stopZoneSteps(mode, ruleId);
    await dispatch(
      mode,
      label,
      decision,
      event,
      performance.now(),
      // The main zone's old entity is empty: the main light.
      () => turnOn(mode, only!.entityId || undefined, only!.to, only!.look, { background }),
      record,
    );
  }
  /**
   * A motion zone started or stopped seeing motion, as the watcher found on
   * its frames: record it like a zone filling or emptying and run its steps.
   * Says whether there were steps, so the watcher lets their light settle.
   */
  async function motionZone(mode: Mode, ruleId: string, change: 'started' | 'stopped') {
    const step = store.updateMemory(mode, (memory) => {
      const rule = memory.rules?.find((r) => r.id === ruleId);
      if (!rule?.motion) return null;
      const moving = change === 'started';
      const decision: PlacementDecision = {
        decision: moving ? 'inside' : 'outside',
        transition: moving ? 'entered' : 'left',
        reason: moving
          ? `Motion in "${rule.label}".`
          : `No motion in "${rule.label}" for ${rule.motion.quietS} s.`,
        observationId: null,
        objectId: null,
        segmentRunId: null,
        zoneId: rule.id,
        ruleId: rule.id,
        action: 'none',
      };
      rule.placement = moving ? 'inside' : 'outside';
      const actions = ruleActions(rule);
      const steps = moving ? actions.onEnter : actions.onLeave;
      const event = evidence('placement', mode, decision);
      if (steps.length) {
        decision.action = 'pending';
        event.status = 'unconfirmed';
      }
      store.save(event);
      rule.lastDecision = event;
      return { decision, event, steps, label: rule.label };
    });
    if (!step) return false;
    noteZone(mode, ruleId, step.decision.transition);
    await runActions(mode, ruleId, step.label, step.steps, step.decision, step.event, {
      background: true,
    });
    return step.steps.length > 0;
  }
  function stopZoneSteps(mode: Mode, ruleId: string) {
    const key = `${mode}:${ruleId}`;
    runs.get(key)?.abort();
    runs.delete(key);
  }
  /**
   * Run a zone's steps, stopping any of its steps still running (a wait from
   * the last time it filled, say). Returns once the steps reach their first
   * wait or end, so a check doesn't hang on a wait; the rest runs on, and the
   * decision is saved again as it ends.
   */
  async function runZoneSteps(
    mode: Mode,
    ruleId: string,
    label: string,
    steps: ZoneStep[],
    decision: PlacementDecision,
    event: EvidenceRun<PlacementDecision>,
    record: (memory: DeskMemory) => void,
  ) {
    stopZoneSteps(mode, ruleId);
    const key = `${mode}:${ruleId}`;
    const controller = new AbortController();
    runs.set(key, controller);
    const start = performance.now();
    const log: string[] = [];
    decision.steps = log;
    const save = () => {
      event.durationMs = Math.round(performance.now() - start);
      store.updateRun(event);
      store.updateMemory(mode, record);
    };
    let reachedWait!: () => void;
    const paused = new Promise<void>((resolve) => (reachedWait = resolve));
    const done = runSteps(steps, {
      signal: controller.signal,
      log: (line) => log.push(line),
      switch: async (s) => {
        const { confirming: _, ...lamp } = await turnOn(
          mode,
          s.entityId || undefined,
          s.to,
          s.look,
        );
        decision.lamp = lamp;
        store.updateMemory(mode, (memory) => noteControl(memory, lamp));
        return lamp;
      },
      desktop: async (s) => {
        await desktop(mode, s.nodeId, s.message);
      },
      holds: (c) => {
        const rule = store.memory(mode).rules?.find((r) => r.id === ruleId);
        if (c.kind === 'occupied') return (rule?.placement === 'inside') === c.is;
        if (c.kind === 'inside') return Boolean(rule?.inside?.includes(c.thingId)) === c.is;
        return inTimeWindow(new Date(), c.from, c.to);
      },
      sleep: (ms) => {
        save();
        reachedWait();
        return sleep(ms, controller.signal);
      },
    }).then((outcome) => {
      if (runs.get(key) === controller) runs.delete(key);
      if (outcome.cancelled) log.push('Stopped: the zone changed again.');
      if (outcome.failed) {
        decision.action = 'failed';
        decision.error = outcome.failed;
        event.status = 'failed';
      } else {
        const confirmed = outcome.lamps.every((l) => l.stateConfirmed);
        decision.action = !outcome.lamps.length
          ? outcome.cancelled
            ? 'none'
            : 'confirmed'
          : confirmed
            ? 'confirmed'
            : 'unconfirmed';
        event.status = decision.action === 'unconfirmed' ? 'unconfirmed' : 'completed';
      }
      save();
      logZone(mode, label, decision);
    });
    await Promise.race([paused, done]);
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
    const segmentation = runOutput(run, 'segment')!;
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
      ...(detection.boxOnly ? { boxOnly: true as const } : {}),
    };
  }
  const sameConcept = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  /**
   * The last sightings of the other followed things of this concept, on
   * frames of this size: the detections are assigned to all of them at once,
   * so a thing never takes its look-alike's.
   */
  function lookAlikes(
    memory: DeskMemory,
    objectId: string,
    concept: string,
    frame: Segmentation['frame'],
  ) {
    const all = followedThings(memory).map((f) => ({
      concept: f.track.concept,
      o: f.track.observation,
    }));
    return all.flatMap(({ concept: c, o }) =>
      o &&
      o.objectId !== objectId &&
      (isMugConcept(concept) ? isMugConcept(c) : sameConcept(c, concept)) &&
      o.frame.width === frame.width &&
      o.frame.height === frame.height
        ? [o]
        : [],
    );
  }
  /** The detection that is this thing, or `track_lost` when its look-alikes account for all of them. */
  function pick(
    memory: DeskMemory,
    objectId: string,
    concept: string,
    segmentation: Segmentation,
    last: DeskObservation,
  ) {
    const match = pickTracked(
      segmentation.detections,
      segmentation.frame,
      last,
      lookAlikes(memory, objectId, concept, segmentation.frame),
    );
    if (!match)
      throw new LabError(
        'track_lost',
        `Every ${concept} SAM found is another one followed here. Nothing changed.`,
        409,
      );
    return match;
  }
  /**
   * One step of tracking: match the newest mug segmentation to the remembered
   * mug without asking, then verify it. Identity must have been confirmed by
   * hand once, and an ambiguous or empty frame changes nothing.
   */
  async function trackMug(mode: Mode, segmentRunId: string) {
    available(mode);
    const memory = store.memory(mode);
    const mug = mugOf(memory);
    if (!mug?.track)
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
    const match = pick(memory, mug.id, 'mug', segmentation, mug.track.observation);
    observe(memory, run, segmentation, match.detection, 'tracked', match.overlap);
    const all = await verifyRules(mode, mug.id);
    const event =
      all.find((e) => e.output.ruleId === MAIN_RULE) ?? (await verify(mode, store.memory(mode)));
    const rules = all.filter((e) => e !== event);
    return { memory: store.memory(mode), event, rules, margin: match.margin };
  }
  /** Follow another object into the newest segmentation of its own concept, then check its rules. */
  function trackObject(mode: Mode, objectId: string, segmentRunId: string) {
    const target = store.memory(mode).fixtures?.find((f) => f.id === objectId);
    if (target?.place !== 'sightings')
      throw new LabError('track_identity', 'Remember this object by hand first.', 409);
    return trackFixture(mode, objectId, segmentRunId);
  }
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
    standAt(memory, fixture, spot, Boolean(moved));
    fixture.track = {
      concept,
      observation,
      history: before ? [before, ...(fixture.track?.history ?? [])].slice(0, HISTORY_LIMIT) : [],
      status: moved ? 'moved' : 'seen',
    };
    store.saveMemory(memory);
    store.save(evidence('observation', memory.mode, observation));
  }
  /**
   * A fixture's place in the room (and its linked copies' places) moved to
   * where the camera sees it, when the pin fits their scene. A thing placed
   * by its sightings is drawn from them: nothing else to move. Once it has
   * `moved`, where a person put it in the whole room's view (`room`) goes
   * too, so that view shows it where the camera does.
   */
  function standAt(
    memory: DeskMemory,
    fixture: Fixture,
    spot: NonNullable<Fixture['seen']>,
    moved: boolean,
  ) {
    const placed = fixture.place === 'sightings' ? [] : [fixture];
    for (const f of [...placed, ...linkedFixtures(memory.fixtures ?? [], fixture)]) {
      f.seen = spot;
      if (moved) delete f.room;
      const pin = memory.surface ?? (memory.mode === 'demo' ? DEMO_SURFACE : null);
      const place = pin ? placeSeen(f, pin, memory.scene ?? null) : null;
      if (place) Object.assign(f, place);
      f.updatedAt = new Date().toISOString();
    }
  }
  /**
   * The watcher followed a thing somewhere new and it settled there, with no
   * SAM call: kept as where it is followed (`followed`), and a thing placed
   * in the room stands there, so the room draws it where it is. Its sighting
   * stays SAM's. Nothing when it hasn't moved from where it was last kept.
   */
  function followLocally(mode: Mode, objectId: string, box: UnitBox) {
    const inFrame = (track: FixtureTrack) => {
      const { width, height } = track.observation.frame;
      return {
        x: Math.round(box.x * width),
        y: Math.round(box.y * height),
        width: Math.round(box.width * width),
        height: Math.round(box.height * height),
      };
    };
    // Read first: a thing settling where it was kept saves nothing.
    const kept = store.memory(mode).fixtures?.find((f) => f.id === objectId)?.track;
    if (!kept || !movedFrom(kept, inFrame(kept))) return false;
    return store.updateMemory(mode, (memory) => {
      const fixture = memory.fixtures?.find((f) => f.id === objectId);
      const track = fixture?.track;
      if (!fixture || !track) return false;
      const at = inFrame(track);
      if (!movedFrom(track, at)) return false;
      track.followed = { box: at, observedAt: new Date().toISOString() };
      standAt(memory, fixture, sightingSpot({ box: at, frame: track.observation.frame }), true);
      return true;
    });
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
    const match = pick(
      memory,
      fixture.id,
      fixture.track.concept,
      segmentation,
      fixture.track.observation,
    );
    sightFixture(
      memory,
      fixture,
      fixture.track.concept,
      sightingOf(fixture.id, run, segmentation, match.detection, 'tracked', match.overlap),
    );
    const events = await verifyRules(mode, fixture.id);
    return { memory: store.memory(mode), events, margin: match.margin };
  }
  /** The watcher lost a fixture: it keeps its last place, drawn as missing. */
  function loseFixture(mode: Mode, fixtureId: string) {
    const memory = store.memory(mode);
    const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
    if (!fixture?.track || fixture.track.status === 'missing') return;
    fixture.track.status = 'missing';
    store.saveMemory(memory);
  }
  /** The watcher found a fixture it had lost, by itself: no longer drawn as missing. */
  function findFixture(mode: Mode, fixtureId: string) {
    const lost = (memory: DeskMemory) => {
      const track = memory.fixtures?.find((f) => f.id === fixtureId)?.track;
      return track?.status === 'missing' ? track : null;
    };
    if (!lost(store.memory(mode))) return;
    store.updateMemory(mode, (memory) => {
      const track = lost(memory);
      if (track) track.status = 'seen';
    });
  }
  /** The mug is this mask of the newest mug segmentation, by hand. */
  function selectMug(mode: Mode, segmentRunId: string, detectionId: string) {
    available(mode);
    const { run, segmentation } = latestMugSegmentation(mode, segmentRunId);
    const detection = segmentation.detections.find((d) => d.objectId === detectionId);
    if (run.status !== 'completed' || !detection)
      throw new LabError('mug_selection', 'Select a specific mug mask from a new segmentation.');
    const memory = store.memory(mode);
    const previous = mugOf(memory)?.track?.observation;
    observe(
      memory,
      run,
      segmentation,
      detection,
      'manual',
      previous ? (pickTracked([detection], segmentation.frame, previous)?.overlap ?? null) : null,
    );
    return memory;
  }
  /** Remember another object from the newest segmentation, by hand, like the mug. */
  async function rememberObject(
    mode: Mode,
    segmentRunId: string,
    detectionId: string,
    label: string,
  ) {
    available(mode);
    const { run, segmentation } = latestSegmentation(mode, segmentRunId);
    const detection = segmentation.detections.find((d) => d.objectId === detectionId);
    if (!detection) throw new LabError('object_selection', 'Pick a mask from this segmentation.');
    const memory = store.memory(mode);
    if (otherThings(memory).length >= MAX_OTHER_OBJECTS)
      throw new LabError(
        'object_limit',
        `Up to ${MAX_OTHER_OBJECTS} more objects can be remembered.`,
        409,
      );
    const taken = followedThings(memory).find(
      (f) =>
        f.track.observation.segmentRunId === run.id &&
        f.track.observation.detectionId === detectionId,
    );
    if (taken)
      throw new LabError('object_selection', `That mask is already the ${taken.label}.`, 409);
    const id = randomUUID();
    const observation = sightingOf(id, run, segmentation, detection, 'manual', null);
    memory.fixtures = [
      ...(memory.fixtures ?? []),
      sightedThing(memory, { id, label, concept: segmentation.concept, observation }),
    ];
    store.saveMemory(memory);
    store.save(evidence('observation', mode, observation));
    const events = await verifyRules(mode, id);
    return { memory: store.memory(mode), events };
  }
  return {
    /** Throws while a placement check is switching a light in this mode. */
    available,
    selectMug,
    rememberObject,
    evidence,
    observe,
    sightingOf,
    trackMug,
    trackObject,
    trackFixture,
    anchorFixture,
    loseFixture,
    findFixture,
    verifyRules,
    motionZone,
    /** Stop a zone's steps still running: it was changed or deleted. */
    stopZoneSteps,
    placeLocally,
    followLocally,
    latestMugSegmentation,
    latestSegmentation,
    verify,
  };
}

export type Desk = ReturnType<typeof createDesk>;
/** What the watcher calls to have SAM's answer recorded and rules checked, as the routes do. */
export type DeskTracking = Desk;

/** The routes of `/api/desk`. */
export async function deskRoutes(
  app: FastifyInstance,
  deps: Pick<RouteDeps, 'store' | 'desk' | 'entities'>,
) {
  const { store, desk, entities } = deps;
  const { available, evidence, trackMug, trackObject, verify, verifyRules } = desk;
  // The lab asks every few seconds whether a desk changed; an unchanged one answers 304.
  app.get('/:mode', async (request, reply) => {
    const { mode } = parseInput(modeOnlySchema, request.params);
    const tag = store.memoryTag();
    reply.header('ETag', tag).header('Cache-Control', 'no-store');
    if (request.headers['if-none-match'] === tag) return reply.code(304).send();
    return store.memory(mode);
  });
  app.post('/select', async (request) => {
    const { mode, segmentRunId, detectionId } = parseInput(deskSelectBodySchema, request.body);
    return desk.selectMug(mode, segmentRunId, detectionId);
  });
  app.post('/track', async (request) => {
    const { mode, segmentRunId } = parseInput(deskTrackBodySchema, request.body);
    return trackMug(mode, segmentRunId);
  });
  /**
   * How the main zone switches its light: whether it goes off when the mug
   * leaves (it does unless told not to), and how it looks when it comes on.
   */
  app.post('/zone/options', async (request) => {
    const { mode, offWhenEmpty, look } = parseInput(deskZoneOptionsBodySchema, request.body);
    available(mode);
    const memory = store.memory(mode);
    const main = memory.rules?.find((r) => r.id === MAIN_RULE);
    if (!main) throw new LabError('zone_missing', 'Draw and save the zone first.', 409);
    if (offWhenEmpty !== undefined) main.offWhenEmpty = offWhenEmpty;
    if (look) main.look = look;
    store.saveMemory(memory);
    return memory;
  });
  app.post('/camera', async (request) => {
    const { mode, fixed } = parseInput(deskCameraBodySchema, request.body);
    available(mode);
    const memory = store.memory(mode);
    memory.fixedCamera = fixed;
    // Turning it off drops a main zone that only applied by the fixed-camera assumption.
    dropMainZone(memory);
    memory.lastDecision = null;
    store.saveMemory(memory);
    return memory;
  });
  /**
   * Tie frames of one size to a surface of an isometric scene, or clear it.
   * It changes how the desk is drawn, not placement, which runs on the frame;
   * fixtures a scan placed stand again where the scan saw them, under the new pin.
   */
  app.post('/surface', async (request) => {
    const { mode, pin } = parseInput(deskSurfaceBodySchema, request.body);
    available(mode);
    const memory = store.memory(mode);
    if (pin && !isoSurface(pin.scene, pin.surfaceId, memory.scene))
      throw new LabError('surface_unknown', 'That surface is not part of the chosen scene.');
    // Clicked corners start at the back left as it looks on screen; the
    // calibrated camera knows which corner of the surface that really is.
    const calibration = calibrationOf(memory);
    const seen = pin && calibration && isoSurface(calibration.scene, pin.surfaceId, memory.scene);
    const ordered = pin && calibration && seen ? pinInOrder(pin, calibration.camera, seen) : pin;
    memory.surface = ordered;
    if (ordered)
      for (const f of memory.fixtures ?? []) {
        const spot = f.scanned ? placeSeen(f, ordered, memory.scene ?? null) : null;
        if (spot) Object.assign(f, spot);
      }
    store.saveMemory(memory);
    return memory;
  });
  /** Remember another object from the newest segmentation, by hand, like the mug. */
  app.post('/objects/select', async (request) => {
    const { mode, segmentRunId, detectionId, label } = parseInput(
      deskObjectsSelectBodySchema,
      request.body,
    );
    return desk.rememberObject(mode, segmentRunId, detectionId, label);
  });
  app.post('/objects/track', async (request) => {
    const { mode, objectId, segmentRunId } = parseInput(deskObjectsTrackBodySchema, request.body);
    return trackObject(mode, objectId, segmentRunId);
  });
  app.post('/objects/forget', async (request) => {
    const { mode, objectId } = parseInput(deskObjectsForgetBodySchema, request.body);
    available(mode);
    const memory = store.memory(mode);
    memory.fixtures = (memory.fixtures ?? []).filter((f) => f.id !== objectId);
    memory.rules = withoutThings(memory.rules, [objectId]);
    store.saveMemory(memory);
    return memory;
  });
  /**
   * Save an extra zone that counts some things, or any, and one light or
   * switch, or none. Like the main zone, it belongs to the image of the
   * newest sighting among the things it counts; a zone that is a thing is
   * wherever that thing is now.
   */
  app.post('/rules/save', async (request) => {
    const { mode, rule: input } = parseInput(deskRulesSaveBodySchema, request.body);
    available(mode);
    const memory = store.memory(mode);
    checkTriggers(memory, input);
    // A thing zone belongs to the image of the newest sighting it counts; a
    // motion zone to the calibrated camera's frames, whose pixels it watches.
    const o = input.motion ? null : ruleSighting(memory, input.objects);
    if (!input.motion && !o)
      throw new LabError('rule_object', 'Confirm something in a segmentation first.', 409);
    const frame = o?.frame ?? calibrationOf(memory)?.camera.frame;
    if (!frame)
      throw new LabError(
        'not_calibrated',
        'Calibrate the camera first: a motion zone is drawn on its frames.',
        409,
      );
    const anchor = input.anchor && memory.fixtures?.find((f) => f.id === input.anchor!.thingId);
    if (input.anchor && !anchor)
      throw new LabError('zone_anchor', 'That thing is gone. Refresh and try again.', 409);
    const anchored = input.anchor ? anchoredZone(memory, input.anchor) : null;
    if (input.anchor && !anchored)
      throw new LabError(
        'zone_anchor',
        anchor?.track
          ? `The ${anchor.label} can’t be placed yet: confirm it in the camera’s view.`
          : `The ${anchor?.label ?? 'thing'} isn’t on the surface zones are drawn on. Put it there, or pin its surface.`,
        409,
      );
    if (input.entityId !== null && !entities(mode).includes(input.entityId))
      throw new LabError('rule_light', 'Choose one of the configured lights or switches.', 400);
    checkOnSurface(memory, input.onSurface);
    // A motion zone has no things for a step to ask about.
    if (input.actions)
      checkActions(memory, input.actions, entities(mode), input.motion ? [] : input.objects);
    if (input.fixtureId) {
      const fixture = memory.fixtures?.find((f) => f.id === input.fixtureId);
      if (!fixture || !input.entityId || !fixtureEntities(fixture).includes(input.entityId))
        throw new LabError('rule_fixture', 'That fixture does not switch this entity.', 400);
    }
    const rules = memory.rules ?? [];
    if (!input.id && rules.filter((r) => r.id !== MAIN_RULE).length >= MAX_RULES)
      throw new LabError('rule_limit', `Up to ${MAX_RULES} extra zones are allowed.`, 409);
    const rule: PlacementRule = {
      id: input.id ?? randomUUID(),
      label: input.label,
      objects: input.objects === 'any' ? 'any' : [...new Set(input.objects)],
      ...(input.match ? { match: input.match } : {}),
      entityId: input.entityId,
      ...(input.fixtureId ? { fixtureId: input.fixtureId } : {}),
      ...(input.offWhenEmpty ? { offWhenEmpty: true } : {}),
      ...(input.look && input.entityId?.startsWith('light.') ? { look: input.look } : {}),
      ...(input.actions ? { actions: input.actions } : {}),
      ...(input.motion ? { motion: input.motion } : {}),
      ...(input.anchor
        ? {
            anchor: {
              ...input.anchor,
              ...(anchor?.track ? { seenAt: anchor.track.observation.observedAt } : {}),
            },
          }
        : {}),
      zone: anchored ?? {
        sourceKey: o?.sourceKey ?? 'camera',
        rect: input.rect!,
        frame,
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
    desk.stopZoneSteps(mode, rule.id);
    store.save(
      evidence('zone', mode, {
        ...rule.zone,
        id: rule.id,
        ruleId: rule.id,
        observationId: o?.id ?? null,
      }),
    );
    return memory;
  });
  /**
   * Rename a zone, change what sets it off or its steps, keeping where it is.
   * New triggers start a new inside/outside story, as a redrawn zone does;
   * steps given replace an older rule's entity; steps still running stop.
   * Null puts the main zone back to switching the main lamp.
   */
  app.post('/rules/options', async (request) => {
    const { mode, ruleId, label, actions, triggers } = parseInput(
      deskRulesOptionsBodySchema,
      request.body,
    );
    available(mode);
    const memory = store.memory(mode);
    const rule = memory.rules?.find((r) => r.id === ruleId);
    if (!rule) throw new LabError('zone_missing', 'That zone is gone. Refresh and try again.', 409);
    if (label) rule.label = label;
    if (triggers) {
      const objects = triggers.objects === 'any' ? 'any' : [...new Set(triggers.objects)];
      checkTriggers(memory, { ...rule, objects });
      // Steps that ask about a thing must still count it.
      const steps = actions ?? ruleActions(rule);
      const asked = stepThings([...steps.onEnter, ...steps.onLeave]);
      if (objects !== 'any' && asked.some((id) => !objects.includes(id)))
        throw new LabError(
          'rule_thing',
          'A step asks about a thing this zone wouldn’t count.',
          400,
        );
      rule.objects = objects;
      if (triggers.match) rule.match = triggers.match;
      else delete rule.match;
      rule.placement = null;
      rule.inside = [];
      rule.lastDecision = null;
    }
    if (actions) {
      checkActions(memory, actions, entities(mode), rule.motion ? [] : rule.objects);
      rule.actions = actions;
      // The main zone's empty entity stays, for what reads it as the main lamp's zone.
      if (rule.id !== MAIN_RULE) {
        rule.entityId = null;
        delete rule.fixtureId;
        delete rule.offWhenEmpty;
        delete rule.look;
      }
    } else if (actions === null) {
      if (rule.id !== MAIN_RULE)
        throw new LabError('zone_actions', 'Only the main zone switches a lamp of its own.', 400);
      delete rule.actions;
    }
    store.saveMemory(memory);
    if (actions !== undefined || triggers) desk.stopZoneSteps(mode, rule.id);
    return memory;
  });
  app.post('/rules/delete', async (request) => {
    const { mode, ruleId } = parseInput(deskRulesDeleteBodySchema, request.body);
    available(mode);
    const memory = store.memory(mode);
    memory.rules = (memory.rules ?? []).filter((r) => r.id !== ruleId);
    store.saveMemory(memory);
    desk.stopZoneSteps(mode, ruleId);
    return memory;
  });
  app.post('/rules/verify', async (request) => {
    const { mode } = parseInput(modeOnlySchema, request.body);
    available(mode);
    const events = await verifyRules(mode);
    return { memory: store.memory(mode), events };
  });
  /** Draw the main zone: the rule `main`, counting the mug and switching the main light. */
  app.post('/zone', async (request) => {
    const { mode, observationId, rect, onSurface } = parseInput(deskZoneBodySchema, request.body);
    available(mode);
    const memory = store.memory(mode);
    const mug = mugOf(memory);
    const o = mug?.track?.observation;
    if (!mug || !o || o.id !== observationId)
      throw new LabError(
        'observation_changed',
        'Confirm the current mug before saving its zone.',
        409,
      );
    checkOnSurface(memory, onSurface);
    // A redrawn zone keeps the name and steps it was given.
    const was = memory.rules?.find((r) => r.id === MAIN_RULE);
    const main: PlacementRule = {
      id: MAIN_RULE,
      label: was?.label ?? 'Main zone',
      objects: [mug.id],
      entityId: '',
      // Its light goes off as the mug leaves, unless the zone is told to keep it on.
      offWhenEmpty: true,
      ...(was?.actions ? { actions: was.actions } : {}),
      zone: { sourceKey: o.sourceKey, rect, frame: o.frame, ...(onSurface ? { onSurface } : {}) },
      // A new zone starts a new inside/outside story.
      placement: null,
      inside: [],
      lastDecision: null,
    };
    memory.rules = [main, ...(memory.rules ?? []).filter((r) => r.id !== MAIN_RULE)];
    memory.lastDecision = null;
    store.saveMemory(memory);
    store.save(evidence('zone', mode, { ...main.zone, id: MAIN_RULE, observationId }));
    return memory;
  });
  app.post('/reset', async (request) => {
    const { mode } = parseInput(modeOnlySchema, request.body);
    available(mode);
    const memory: DeskMemory = {
      mode,
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
      // The mug, other objects and the rules go; the scene and what was placed in it stay.
      rules: [],
      fixtures: (store.memory(mode).fixtures ?? []).filter((f) => f.place !== 'sightings'),
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
  app.post('/demo/reset', async () => {
    const memory: DeskMemory = { mode: 'demo', lastDecision: null };
    store.saveMemory(memory);
    return store.memory('demo');
  });
  /**
   * Put back a whole desk memory: an imported save, an undo or redo, or the
   * empty demo desk. The pin and the scene are checked like any other save;
   * the rest is the lab's own output coming back. Evidence is untouched.
   */
  app.post('/restore', async (request) => {
    const { mode, memory } = parseInput(deskRestoreBodySchema, request.body);
    if (memory.mode !== mode)
      throw new LabError('restore_mode', `This save is for ${memory.mode} mode, not ${mode}.`, 400);
    available(mode);
    const next = memory as unknown as DeskMemory;
    if (next.surface && !isoSurface(next.surface.scene, next.surface.surfaceId, next.scene))
      throw new LabError('restore_surface', 'The saved pin names a surface the scene lacks.', 400);
    store.saveMemory({ ...next, lastDecision: next.lastDecision ?? null });
    return store.memory(mode);
  });
  app.post('/verify', async (request) => {
    const { mode, observationId, zoneId } = parseInput(deskVerifyBodySchema, request.body);
    available(mode);
    const memory = store.memory(mode);
    const main = memory.rules?.find((r) => r.id === MAIN_RULE);
    if (mugOf(memory)?.track?.observation.id !== observationId || main?.id !== zoneId)
      throw new LabError(
        'desk_changed',
        'The selected observation or zone changed. Refresh and review it.',
        409,
      );
    return verify(mode, memory);
  });
}
