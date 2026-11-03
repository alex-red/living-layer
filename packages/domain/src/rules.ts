import { assignTracks } from './assign.js';
import { z } from 'zod';
import {
  lightLookSchema,
  type Detection,
  type EvidenceRun,
  type LightLook,
  type Segmentation,
} from './api.js';
import { entityIdSchema } from './fixture.js';
import { isoSurface, projectBox, surfaceMap } from './iso.js';
import {
  calibrationOf,
  objectById,
  zoneOnSurfaceSchema,
  zoneRectSchema,
  type DeskMemory,
  type DeskObservation,
  type RoomCalibration,
  type PlacementDecision,
  type ZoneOnSurface,
  type ZoneRect,
} from './memory.js';

export const OBSERVATION_MAX_AGE_MS = 5 * 60 * 1000;
export const MOVED_CAMERA =
  'The camera has moved since it was calibrated, so zones no longer line up. Calibrate it again, or keep the calibration if it still fits and redraw the zones.';
/**
 * Desk memory with its camera no longer taken to have moved, compared from
 * now on with `reference`, and checks blocked only by the move dropped.
 */
export function cameraKept(memory: DeskMemory, reference: string): DeskMemory {
  const { moved: _, ...camera } = memory.camera!;
  const stale = (d: DeskMemory['lastDecision'] | undefined) =>
    d?.output.reason === MOVED_CAMERA ? null : (d ?? null);
  return {
    ...memory,
    camera: { ...camera, reference },
    lastDecision: stale(memory.lastDecision),
    rules: memory.rules?.map((r) => ({ ...r, lastDecision: stale(r.lastDecision) })),
  };
}
/** True when the box's bottom centre, where it touches down nearest the camera, is in the zone. */
export function footInZone(
  b: Detection['box'],
  frame: Segmentation['frame'],
  zone: ZoneRect,
): boolean {
  const x = (b.x + b.width / 2) / frame.width;
  const y = (b.y + b.height) / frame.height;
  return x >= zone.x && x <= zone.x + zone.width && y >= zone.y && y <= zone.y + zone.height;
}
const within = (v: number, a: number, b: number) => v >= Math.min(a, b) && v <= Math.max(a, b);
/**
 * Whether a sighting stands in a zone: where it stands, not its whole box, so
 * a mug taller than the zone counts. A zone drawn in the room is judged there,
 * by the middle of the thing's base on the pinned surface (`projectBox`);
 * any other zone by the box's bottom centre in the frame.
 */
function standsInZone(
  memory: Pick<DeskMemory, 'surface' | 'scene'>,
  o: Pick<DeskObservation, 'box' | 'frame'>,
  zone: { rect: ZoneRect; onSurface?: ZoneOnSurface },
): boolean {
  const drawn = zone.onSurface;
  const pin = memory.surface;
  const surface =
    drawn && pin?.scene === drawn.scene && pin.surfaceId === drawn.surfaceId
      ? isoSurface(pin.scene, pin.surfaceId, memory.scene)
      : undefined;
  const map = surface && pin ? surfaceMap(pin, o.frame) : null;
  if (drawn && surface && map) {
    const { foot } = projectBox(o.box, surface, map.toSurface);
    return within(foot.x, drawn.a.x, drawn.b.x) && within(foot.y, drawn.a.y, drawn.b.y);
  }
  return footInZone(o.box, o.frame, zone.rect);
}
export const HISTORY_LIMIT = 12;
const normalize = (b: Detection['box'], f: Segmentation['frame']) => ({
  x: b.x / f.width,
  y: b.y / f.height,
  width: b.width / f.width,
  height: b.height / f.height,
});
/** Intersection over union of two boxes, each measured against its own frame. */
function boxOverlap(
  a: Detection['box'],
  aFrame: Segmentation['frame'],
  b: Detection['box'],
  bFrame: Segmentation['frame'],
): number {
  const p = normalize(a, aFrame);
  const q = normalize(b, bFrame);
  const w = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x);
  const h = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y);
  const inter = Math.max(0, w) * Math.max(0, h);
  const union = p.width * p.height + q.width * q.height - inter;
  return union > 0 ? inter / union : 0;
}
/**
 * Pick which detection is the remembered object: the one overlapping its last
 * box most, or the nearest when none overlap. With no previous box, only a
 * lone detection is safe to take; several mean a person has to choose.
 *
 * `others` are the look-alikes followed beside it (things of the same
 * concept, by their last boxes): every detection is then assigned to all of
 * them at once (`assignTracks`), so it never takes a neighbour's, and it gets
 * null when the others account for every detection. `margin` is how much
 * better that assignment is than the best other; under `MULTI.minMargin` it
 * is a guess between look-alikes.
 */
export function pickTracked(
  detections: Detection[],
  frame: Segmentation['frame'],
  previous?: { box: Detection['box']; frame: Segmentation['frame'] },
  others: { box: Detection['box']; frame: Segmentation['frame'] }[] = [],
): { detection: Detection; overlap: number | null; margin: number } | null {
  if (!detections.length) return null;
  if (!previous)
    return detections.length === 1
      ? { detection: detections[0]!, overlap: null, margin: Infinity }
      : null;
  const fit = (last: { box: Detection['box']; frame: Segmentation['frame'] }, d: Detection) => {
    const l = normalize(last.box, last.frame);
    const n = normalize(d.box, frame);
    const distance = Math.hypot(
      n.x + n.width / 2 - (l.x + l.width / 2),
      n.y + n.height / 2 - (l.y + l.height / 2),
    );
    return { overlap: boxOverlap(d.box, frame, last.box, last.frame), distance };
  };
  if (!others.length) {
    const scored = detections.map((d) => ({ d, ...fit(previous, d) }));
    scored.sort((a, b) => b.overlap - a.overlap || a.distance - b.distance);
    return { detection: scored[0]!.d, overlap: scored[0]!.overlap, margin: Infinity };
  }
  const cost = [previous, ...others].map((last) =>
    detections.map((d) => {
      const f = fit(last, d);
      return 1 - f.overlap + f.distance;
    }),
  );
  // SAM's answer is taken whenever there is one to take: going without costs more than any pair.
  const { pick, margins } = assignTracks(cost, 10);
  const j = pick[0];
  if (j === null || j === undefined) return null;
  return {
    detection: detections[j]!,
    overlap: fit(previous, detections[j]!).overlap,
    margin: margins[0] ?? 0,
  };
}
/** Whether the saved zone applies to the current observation, and whether only by assumption. */
export function zoneApplies(memory: DeskMemory): { applies: boolean; carried: boolean } {
  return zoneAppliesTo(memory.observation, memory.zone, memory.fixedCamera, calibrationOf(memory));
}
/**
 * Whether a zone applies to an observation: one drawn in the room applies to
 * every frame of its calibrated camera; otherwise the same image, or any frame
 * of its size by the fixed-camera assumption.
 */
function zoneAppliesTo(
  o: DeskObservation | null | undefined,
  z:
    | { sourceKey: string; frame?: Segmentation['frame']; onSurface?: ZoneOnSurface }
    | null
    | undefined,
  fixedCamera = false,
  calibration: RoomCalibration | null = null,
): { applies: boolean; carried: boolean } {
  if (!o || !z) return { applies: false, carried: false };
  const frame = calibration?.camera.frame;
  if (
    z.onSurface &&
    frame?.width === o.frame.width &&
    frame?.height === o.frame.height &&
    z.frame?.width === frame.width &&
    z.frame?.height === frame.height
  )
    return { applies: true, carried: false };
  if (z.sourceKey === o.sourceKey) return { applies: true, carried: false };
  const sameSize = z.frame?.width === o.frame.width && z.frame?.height === o.frame.height;
  return fixedCamera && sameSize
    ? { applies: true, carried: true }
    : { applies: false, carried: false };
}

/**
 * A zone beyond the main one. It counts some things (any the camera follows,
 * or the ones named) and is occupied while any of them is fully inside. When
 * it becomes occupied it switches `entityId` on, and with `offWhenEmpty` off
 * again when the last one leaves. With no entity it switches nothing, and
 * only tells Home Assistant.
 */
export interface PlacementRule {
  id: string;
  label: string;
  /** What the zone counts: any thing the camera follows, or these by id. */
  objects: 'any' | string[];
  /** A light or a switch, or null for a zone that only tells Home Assistant. */
  entityId: string | null;
  /** The fixture the entity was picked as, when it was picked as one. */
  fixtureId?: string;
  /** Switch the entity off when the zone empties. */
  offWhenEmpty?: boolean;
  /** What a light does when the zone turns it on; unset keeps the bulb's own. */
  look?: LightLook;
  zone: {
    sourceKey: string;
    rect: ZoneRect;
    frame: Segmentation['frame'];
    onSurface?: ZoneOnSurface;
  };
  /** The zone's state: `inside` while any thing it counts is in it. */
  placement?: 'inside' | 'outside' | null;
  /** The things it counts last seen fully inside. */
  inside?: string[];
  lastDecision?: EvidenceRun<PlacementDecision> | null;
}
export const MAX_OTHER_OBJECTS = 4;
export const MAX_RULES = 8;
/** Virtual lights in demo mode. The first stands for the main desk lamp. */
export const DEMO_LIGHTS = ['light.demo_desk', 'light.demo_shelf', 'light.demo_fridge'];
/** Virtual switches in demo mode, for fixtures like a fan or a monitor. */
export const DEMO_SWITCHES = ['switch.demo_fan', 'switch.demo_monitor'];
export const ruleInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    label: z.string().trim().min(1).max(40),
    objects: z.union([z.literal('any'), z.array(z.string().uuid()).min(1).max(16)]),
    entityId: entityIdSchema.nullable(),
    fixtureId: z.string().uuid().optional(),
    offWhenEmpty: z.boolean().optional(),
    look: lightLookSchema.optional(),
    rect: zoneRectSchema,
    onSurface: zoneOnSurfaceSchema.optional(),
  })
  .strict()
  .refine((r) => r.entityId || !r.fixtureId, { message: 'A fixture needs its entity.' })
  .refine((r) => r.entityId || !r.offWhenEmpty, {
    message: 'Nothing to switch off.',
  }) satisfies z.ZodType<
  Pick<PlacementRule, 'label' | 'objects' | 'entityId' | 'fixtureId' | 'offWhenEmpty' | 'look'> & {
    id?: string;
    rect: ZoneRect;
    onSurface?: ZoneOnSurface;
  }
>;
/** Everything the camera follows: the mug, other objects and tracked fixtures. */
function followedIds(memory: DeskMemory): string[] {
  return [
    ...(memory.object && memory.observation ? [memory.object.id] : []),
    ...(memory.others ?? []).filter((o) => o.observation).map((o) => o.id),
    ...(memory.fixtures ?? []).filter((f) => f.track).map((f) => f.id),
  ];
}
/**
 * The things a rule counts that are still remembered. A fixture never counts
 * toward the entity it switches: it can't switch itself on by moving.
 */
export function ruleObjects(memory: DeskMemory, rule: PlacementRule): string[] {
  const ids =
    rule.objects === 'any'
      ? followedIds(memory)
      : rule.objects.filter((id) => objectById(memory, id));
  return ids.filter((id) => id !== rule.fixtureId);
}
/**
 * Rules once things are forgotten: each stops counting them, and one left
 * counting nothing goes, since it can't be checked any more.
 */
export function withoutThings(rules: PlacementRule[] | undefined, gone: string[]): PlacementRule[] {
  return (rules ?? []).flatMap((r) => {
    if (r.objects === 'any')
      return [{ ...r, inside: r.inside?.filter((id) => !gone.includes(id)) }];
    const objects = r.objects.filter((id) => !gone.includes(id));
    if (!objects.length) return [];
    return objects.length === r.objects.length
      ? [r]
      : [{ ...r, objects, inside: r.inside?.filter((id) => objects.includes(id)) }];
  });
}
/** What a rule counts, in words: "anything", "the mug", "the mug or the book". */
export function ruleWho(memory: DeskMemory, rule: Pick<PlacementRule, 'objects'>): string {
  if (rule.objects === 'any') return 'anything';
  const names = rule.objects.map(
    (id) => `the ${objectById(memory, id)?.label ?? 'forgotten thing'}`,
  );
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]!;
}
/**
 * The sighting a rule's zone is drawn on: the newest among the things it
 * counts, all seen by the one camera.
 */
export function ruleSighting(
  memory: DeskMemory,
  objects: PlacementRule['objects'],
): DeskObservation | null {
  const ids = objects === 'any' ? followedIds(memory) : objects;
  return (
    ids
      .map((id) => objectById(memory, id)?.observation)
      .filter((o): o is DeskObservation => Boolean(o))
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0] ?? null
  );
}
/** One counted thing against a rule's zone: the same checks as the main zone. */
function thingGate(
  memory: DeskMemory,
  rule: PlacementRule,
  objectId: string,
  now: number,
): Pick<PlacementDecision, 'decision' | 'reason' | 'assumedFixedCamera'> {
  const target = objectById(memory, objectId);
  const o = target?.observation;
  if (!target || !o)
    return {
      decision: 'blocked',
      reason: `Confirm the ${target?.label ?? 'object'} in a segmentation first.`,
    };
  const age = now - Date.parse(o.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > OBSERVATION_MAX_AGE_MS)
    return {
      decision: 'blocked',
      reason: `The last sighting of the ${target.label} is stale. Track it in a new frame.`,
    };
  const zone = zoneAppliesTo(o, rule.zone, memory.fixedCamera, calibrationOf(memory));
  if (!zone.applies)
    return {
      decision: 'blocked',
      reason: memory.fixedCamera
        ? `The zone "${rule.label}" was drawn on a frame of another size.`
        : `The zone "${rule.label}" was drawn on another image. Mark the camera as fixed to carry it over.`,
    };
  const assumption = zone.carried ? ' (zone carried over: camera assumed fixed)' : '';
  return standsInZone(memory, o, rule.zone)
    ? {
        decision: 'inside',
        reason: `The ${target.label} stands in "${rule.label}"${assumption}.`,
        assumedFixedCamera: zone.carried,
      }
    : {
        decision: 'outside',
        reason: `The ${target.label} stands outside "${rule.label}"${assumption}.`,
        assumedFixedCamera: zone.carried,
      };
}
/**
 * The state of an extra zone: occupied while any thing it counts is fully
 * inside. Each thing is checked like the main zone's mug; one with no fresh
 * verdict (stale, or drawn on another image) keeps its last place, so it
 * neither empties the zone nor fills it. Blocked only when no thing it counts
 * has a verdict.
 */
export function ruleGate(
  memory: DeskMemory,
  rule: PlacementRule,
  now = Date.now(),
): Pick<PlacementDecision, 'decision' | 'reason' | 'assumedFixedCamera'> & {
  /** The things now inside. */
  inside: string[];
  /** The thing that moved the zone: the one that entered or left, else one decided. */
  objectId: string | null;
} {
  const ids = ruleObjects(memory, rule);
  const before = (rule.inside ?? []).filter((id) => ids.includes(id));
  if (!ids.length)
    return {
      decision: 'blocked',
      reason:
        rule.objects === 'any'
          ? 'Confirm something in a segmentation first.'
          : `Confirm ${ruleWho(memory, rule)} in a segmentation first.`,
      inside: before,
      objectId: null,
    };
  if (calibrationOf(memory)?.moved)
    return { decision: 'blocked', reason: MOVED_CAMERA, inside: before, objectId: null };
  const gates = ids.map((id) => ({ id, ...thingGate(memory, rule, id, now) }));
  const decided = gates.filter((g) => g.decision !== 'blocked');
  if (!decided.length) return { ...gates[0]!, inside: before, objectId: null };
  const inside = gates
    .filter((g) => g.decision === 'inside' || (g.decision === 'blocked' && before.includes(g.id)))
    .map((g) => g.id);
  const objectId =
    inside.find((id) => !before.includes(id)) ??
    before.find((id) => !inside.includes(id)) ??
    (decided.find((g) => g.decision === 'inside') ?? decided[0]!).id;
  const assumedFixedCamera = decided.some((g) => g.assumedFixedCamera);
  // One thing reads as before; several are summed up.
  if (ids.length === 1) return { ...gates[0]!, inside, objectId };
  const assumption = assumedFixedCamera ? ' (zone carried over: camera assumed fixed)' : '';
  const names = inside.map((id) => objectById(memory, id)?.label ?? 'thing');
  return {
    decision: inside.length ? 'inside' : 'outside',
    reason: inside.length
      ? `${names.length > 1 ? `${names.length} things are` : `The ${names[0]} box is`} fully inside "${rule.label}" (${names.join(', ')})${assumption}.`
      : `Nothing it counts is fully inside "${rule.label}"${assumption}.`,
    assumedFixedCamera,
    inside,
    objectId,
  };
}
export function placementGate(
  memory: DeskMemory,
  now = Date.now(),
): Pick<PlacementDecision, 'decision' | 'reason' | 'assumedFixedCamera'> {
  const o = memory.observation;
  const z = memory.zone;
  if (!o || !memory.object || o.objectId !== memory.object.id)
    return { decision: 'blocked', reason: 'Select and manually confirm a mug mask first.' };
  const age = now - Date.parse(o.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > OBSERVATION_MAX_AGE_MS)
    return {
      decision: 'blocked',
      reason: 'Observation is stale. Segment a new frame and confirm the mug.',
    };
  if (calibrationOf(memory)?.moved) return { decision: 'blocked', reason: MOVED_CAMERA };
  const zone = zoneApplies(memory);
  if (!z || !zone.applies)
    return {
      decision: 'blocked',
      reason: memory.fixedCamera
        ? 'Draw and save a zone on a frame of this size.'
        : 'Draw and save a zone on this observation image, or mark the camera as fixed.',
    };
  const who = o.identity === 'tracked' ? 'tracked' : 'manually confirmed';
  const assumption = zone.carried ? ' (zone carried over: camera assumed fixed)' : '';
  return standsInZone(memory, o, z)
    ? {
        decision: 'inside',
        reason: `The ${who} mug stands in the saved zone${assumption}.`,
        assumedFixedCamera: zone.carried,
      }
    : {
        decision: 'outside',
        reason: `The mug stands outside the zone${assumption}. No lamp action.`,
        assumedFixedCamera: zone.carried,
      };
}
