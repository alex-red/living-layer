import { z } from 'zod';
import type { IsoScene, IsoSceneKind, SurfacePin } from './iso.js';
import { pointSchema, surfacePinSchema } from './iso.js';
import { ISO_PRESETS } from './iso-presets.js';
import type { SceneIllustration } from './illustration.js';
import { DEMO_CAMERA } from './demo-room.js';
import { CAMERA_EDGES_MAX, marksOf, roomCameraSchema, roomMarksSchema } from './room-camera.js';
import { cameraCropSchema } from './camera.js';
import { upgradeItem, type SavedItem } from './iso-item.js';
import {
  fixtureModel,
  isStockModel,
  linkedFixtures,
  stockModel,
  type Fixture,
  type FixtureTrack,
} from './fixture.js';
import type { ExposedEntity } from './expose.js';
import {
  modeSchema,
  type Detection,
  type EvidenceRun,
  type LampResult,
  type LightLook,
  type Mode,
  type Segmentation,
} from './api.js';
import type { PlacementRule } from './rules.js';
import { thingStatSchema, type ThingStat } from './stats.js';

// Source-normalized rectangles; the entire detection box must fit inside the zone.
export const zoneRectSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().min(0.01).max(1),
    height: z.number().finite().min(0.01).max(1),
  })
  .strict()
  .refine((r) => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001);
export type ZoneRect = z.infer<typeof zoneRectSchema>;
/**
 * Where a zone was drawn in the room: two opposite corners on a surface, in
 * its own unit square. With a calibrated camera the zone is the room's, not
 * one image's, so it applies to every frame that camera sends.
 */
export const zoneOnSurfaceSchema = z
  .object({
    scene: z.enum(['office', 'desk', 'fridge', 'home', 'custom']),
    surfaceId: z.string().min(1).max(48),
    a: pointSchema,
    b: pointSchema,
  })
  .strict();
export type ZoneOnSurface = z.infer<typeof zoneOnSurfaceSchema>;
/**
 * The room's camera once calibrated: where it is and how it sees, the marks
 * it was fitted to, and whether it has since been seen to move.
 */
export const roomCalibrationSchema = z
  .object({
    camera: roomCameraSchema,
    marks: roomMarksSchema,
    scene: z.enum(['office', 'desk', 'fridge', 'home', 'custom']),
    /** Root mean square distance of the marks from the fitted camera's floor lines, in pixels. */
    error: z.number().min(0),
    calibratedAt: z.string(),
    /** Edges of the frame it was calibrated on, to tell whether the camera moved since. */
    reference: z.string().max(CAMERA_EDGES_MAX).optional(),
    moved: z.boolean().optional(),
    /** The camera's zoomed view it was calibrated through; none for the whole frame. */
    crop: cameraCropSchema.nullable().optional(),
  })
  .strict();
export type RoomCalibration = z.infer<typeof roomCalibrationSchema>;
/** The demo camera, calibrated: the office's corner camera, as a person would have set it. */
export const DEMO_CALIBRATION: RoomCalibration = {
  camera: DEMO_CAMERA,
  marks: marksOf(DEMO_CAMERA),
  scene: 'office',
  error: 0,
  calibratedAt: '2026-10-30T00:00:00.000Z',
};
/** The room camera that applies: the calibrated one, or the demo's. */
export const calibrationOf = (memory: Pick<DeskMemory, 'mode' | 'camera'>) =>
  memory.camera ?? (memory.mode === 'demo' ? DEMO_CALIBRATION : null);
export interface DeskObservation {
  id: string;
  objectId: string;
  segmentRunId: string;
  detectionId: string;
  observedAt: string;
  sourceKey: string;
  frame: Segmentation['frame'];
  box: Detection['box'];
  /** `manual`: a person picked the mask. `tracked`: matched to the previous observation. */
  identity: 'manual' | 'tracked';
  /** Overlap (IoU) with the previous observation's box, when there was one. */
  overlap?: number | null;
  /** Its mask was the whole shape drawn round it (`Detection.boxOnly`), not an outline. */
  boxOnly?: true;
}
/**
 * The main zone as it was kept before it became the rule `main`: `frame` is
 * the size of the image it was drawn on; older zones lack it.
 */
interface OldZone {
  id: string;
  sourceKey: string;
  rect: ZoneRect;
  frame?: Segmentation['frame'];
  onSurface?: ZoneOnSurface;
  /** False keeps the light on when the mug leaves; unset turned it off. */
  offWhenEmpty?: boolean;
  look?: LightLook;
}
/**
 * Desk memory as kept before every thing was a fixture: the mug in fields of
 * its own, other objects in `others`, the main zone apart from the rules.
 * `upgradeMemory` turns it into today's.
 */
interface OldMemory {
  object?: { id: string; label: string; createdAt: string } | null;
  observation?: DeskObservation | null;
  zone?: OldZone | null;
  history?: DeskObservation[];
  placement?: 'inside' | 'outside' | null;
  others?: TrackedObject[];
  item?: SavedItem | null;
}
export interface DeskMemory {
  mode: Mode;
  /** The newest decision of any rule, for the activity line. */
  lastDecision: EvidenceRun<PlacementDecision> | null;
  /**
   * Opt-in: the camera hasn't moved, so a zone carries over to any new frame of
   * the same size. Off, a zone only applies to the exact image it was drawn on.
   */
  fixedCamera?: boolean;
  /** Corners that tie frames of one size to a surface of an isometric scene. */
  surface?: SurfacePin | null;
  /** The room's one camera, calibrated against the room itself. */
  camera?: RoomCalibration | null;
  /** Zones, the main one (`main`) among them, each counting things and switching one light or switch. */
  rules?: PlacementRule[];
  /** The person's own isometric scene, built from templates or drafted by Spark. */
  scene?: IsoScene | null;
  /** The photo that scene was drafted from, as an evidence asset (live only). */
  scenePhoto?: string | null;
  /** A clean isometric picture of that scene's room, drawn from its photo. */
  illustration?: SceneIllustration | null;
  /** The room's desk close up, redrawn from a close camera frame in the room picture's style. */
  deskIllustration?: SceneIllustration | null;
  /**
   * Every thing: placed by hand or a scan (a lamp, a switch, a mouse), or by
   * where the camera saw it (`place: 'sightings'`: the mug, other objects).
   * Reset keeps the hand-placed ones.
   */
  fixtures?: Fixture[];
  /** Names the person said aren't fixtures, so scans skip them. */
  dismissed?: string[];
  /** Whether the server watches the camera, and which one; it resumes after a restart. */
  watch?: { on: boolean; camera: WatchCamera | null };
  /** Entities shown in Home Assistant over MQTT, each with what its state comes from. Reset keeps them. */
  exposed?: ExposedEntity[];
  /** The stats switched on for each thing, by its id; their history is in the store. Reset keeps them. */
  thingStats?: Record<string, ThingStat[]>;
  /** When the demo's household was first brought into its Home room: once, so deleting them sticks. */
  householdAt?: string;
  /** When the demo's fridge was first stocked: once, so deleting its food sticks. */
  fridgeAt?: string;
}
/** A camera the server reads frames from: an RTSP stream, never a tab's. */
export interface WatchCamera {
  id: string;
  name: string;
  url: string;
}
export interface PlacementDecision {
  observationId: string | null;
  objectId: string | null;
  segmentRunId: string | null;
  zoneId: string | null;
  decision: 'inside' | 'outside' | 'blocked';
  reason: string;
  action: 'none' | 'pending' | 'confirmed' | 'unconfirmed' | 'failed';
  /** How this verdict compares with the previous one. Absent when blocked. */
  transition?: 'entered' | 'stayed_inside' | 'left' | 'stayed_outside';
  /** The zone was drawn on another frame and applied because the camera is marked fixed. */
  assumedFixedCamera?: boolean;
  lamp?: LampResult;
  error?: { code: string; message: string };
  /** Set when an extra placement rule, not the main zone, made this decision. */
  ruleId?: string;
  /** What the zone's steps did, a line each, when it ran more than one switch. */
  steps?: string[];
}
/** Another remembered object, beside the mug. Any concept SAM can segment. */
interface TrackedObject {
  id: string;
  label: string;
  /** The SAM concept it was confirmed from; tracking only follows the same one. */
  concept: string;
  createdAt: string;
  observation: DeskObservation | null;
  history?: DeskObservation[];
  item?: SavedItem | null;
}
/**
 * The room a preset was, adopted as the person's own scene: a copy of the
 * preset as `memory.scene`, and everything that named the preset (its
 * calibration, the pin, zones drawn on its surfaces, fixtures standing in
 * it) naming `custom` instead. Surface ids stay the same, so nothing moves.
 * For changing a preset room the way a person's own can be changed.
 */
export function adoptPreset(memory: DeskMemory, kind: IsoSceneKind): DeskMemory {
  const preset = ISO_PRESETS[kind];
  const own = <T extends { scene: string }>(x: T): T =>
    x.scene === kind ? { ...x, scene: 'custom' } : x;
  const onSurface = <T extends { onSurface?: ZoneOnSurface }>(x: T): T =>
    x.onSurface ? { ...x, onSurface: own(x.onSurface) } : x;
  const calibration = calibrationOf(memory);
  return {
    ...memory,
    scene: { ...preset, kind: 'custom' },
    ...(calibration ? { camera: own(calibration) } : {}),
    surface: memory.surface ? own(memory.surface) : memory.surface,
    ...(memory.rules
      ? { rules: memory.rules.map((r) => ({ ...r, zone: onSurface(r.zone) })) }
      : {}),
    ...(memory.fixtures ? { fixtures: memory.fixtures.map(own) } : {}),
  };
}
/** The rule of the main zone: it counts the mug and switches the main light. */
export const MAIN_RULE = 'main';
/** The mug: the first thing of its type placed by where it was seen. */
export function mugOf(memory: DeskMemory | null | undefined): Fixture | null {
  return memory?.fixtures?.find((f) => f.place === 'sightings' && f.type === 'mug') ?? null;
}
/*
 * What the desk used to keep in fields of its own, read off things and rules:
 * the mug's sighting, history and model, the main zone and its verdict, and
 * the other objects. For the readers that still think in those terms.
 */
/** The mug's last sighting. */
export const mugSighting = (m: DeskMemory | null | undefined): DeskObservation | null =>
  mugOf(m)?.track?.observation ?? null;
/** The mug's earlier sightings, newest first. */
export const mugHistory = (m: DeskMemory | null | undefined): DeskObservation[] =>
  mugOf(m)?.track?.history ?? [];
/** The mug's own model, or null while it has only the stock one. */
export function mugModel(m: DeskMemory | null | undefined): SavedItem | null {
  const mug = mugOf(m);
  return mug ? ownModel(mug) : null;
}
/** The main zone as it was kept: its id, where it was drawn, and how it switches its light. */
export function mainZone(m: DeskMemory | null | undefined) {
  const r = m?.rules?.find((x) => x.id === MAIN_RULE);
  return r
    ? {
        id: r.id,
        ...r.zone,
        ...(r.offWhenEmpty !== undefined ? { offWhenEmpty: r.offWhenEmpty } : {}),
        ...(r.look ? { look: r.look } : {}),
        ...(r.actions ? { actions: r.actions } : {}),
        label: r.label,
      }
    : null;
}
/** The main zone's last verdict. */
export const mainPlacement = (m: DeskMemory | null | undefined) =>
  m?.rules?.find((x) => x.id === MAIN_RULE)?.placement ?? null;
/** The other objects, as they were kept beside the mug. */
export function otherObjects(m: DeskMemory | null | undefined) {
  if (!m) return [];
  return otherThings(m).map((f) => ({
    id: f.id,
    label: f.label,
    concept: f.track?.concept ?? '',
    createdAt: f.createdAt,
    observation: f.track?.observation ?? null,
    history: f.track?.history ?? [],
    item: ownModel(f),
  }));
}
/** The things the camera follows: each one with a sighting. */
export function followedThings(memory: DeskMemory): (Fixture & { track: FixtureTrack })[] {
  return (memory.fixtures ?? []).filter((f): f is Fixture & { track: FixtureTrack } =>
    Boolean(f.track),
  );
}
/** Fixtures placed by hand or a scan, without the things the camera places by their sightings. */
export const placedFixtures = (
  memory: Pick<DeskMemory, 'fixtures'> | null | undefined,
): Fixture[] => (memory?.fixtures ?? []).filter((f) => f.place !== 'sightings');
/** Things placed by their sightings, other than the mug: what used to be "other objects". */
export function otherThings(memory: DeskMemory): Fixture[] {
  const mug = mugOf(memory);
  return (memory.fixtures ?? []).filter((f) => f.place === 'sightings' && f !== mug);
}
/** A thing's model as drafted for it, or null while it is only its stock one. */
const ownModel = (f: Fixture): SavedItem | null =>
  f.place === 'sightings' && isStockModel(f.model) ? null : fixtureModel(f);
/**
 * Desk memory as it would be with one thing seen somewhere else. A copy,
 * for judging zones at a box that isn't a remembered sighting (the
 * watcher's own following).
 */
export function withSighting(
  memory: DeskMemory,
  objectId: string,
  observation: DeskObservation,
): DeskMemory {
  return {
    ...memory,
    fixtures: memory.fixtures?.map((f) =>
      f.id === objectId && f.track ? { ...f, track: { ...f.track, observation } } : f,
    ),
  };
}
/** The observation and name of a followed thing, by id. */
export function objectById(
  memory: DeskMemory,
  objectId: string,
): { label: string; concept: string; observation: DeskObservation | null } | null {
  const thing = memory.fixtures?.find((f) => f.id === objectId && f.track);
  return thing?.track
    ? { label: thing.label, concept: thing.track.concept, observation: thing.track.observation }
    : null;
}
/** The mug (no id, or its id) or another thing, with its model. */
export function modelTarget(
  memory: DeskMemory,
  objectId?: string,
): {
  id: string;
  label: string;
  observation: DeskObservation | null;
  item: SavedItem | null;
  /** Placed by hand: its model comes from its reference photo, not a sighting. */
  fixture?: boolean;
} | null {
  const thing = objectId ? memory.fixtures?.find((f) => f.id === objectId) : mugOf(memory);
  if (!thing) return null;
  return thing.place === 'sightings'
    ? {
        id: thing.id,
        label: thing.label,
        observation: thing.track?.observation ?? null,
        item: ownModel(thing),
      }
    : {
        id: thing.id,
        label: thing.label,
        observation: null,
        item: fixtureModel(thing),
        fixture: true,
      };
}
/** Store a thing's model; null puts a followed thing back on its stock model. */
export function setModel(memory: DeskMemory, objectId: string, item: SavedItem | null): void {
  const fixture = memory.fixtures?.find((f) => f.id === objectId);
  if (!fixture) return;
  const now = new Date().toISOString();
  if (fixture.place === 'sightings') {
    fixture.model = item ?? stockModel(fixture.label);
    fixture.updatedAt = now;
    return;
  }
  if (!item) return;
  for (const f of [fixture, ...linkedFixtures(memory.fixtures ?? [], fixture)]) {
    if (fixture.state)
      f.states = {
        ...f.states,
        [fixture.state]: { ...(f.states?.[fixture.state] ?? {}), model: item },
      };
    else f.model = item;
    f.updatedAt = now;
  }
}
/**
 * A thing placed by its sightings, as the mug and other objects are: drawn
 * where the camera saw it, so its own place is only nominal (the pin's
 * scene, its corner, a mug's size).
 */
export function sightedThing(
  memory: Pick<DeskMemory, 'surface' | 'scene'>,
  thing: {
    id: string;
    label: string;
    concept: string;
    observation: DeskObservation;
    history?: DeskObservation[];
    model?: SavedItem | null;
    type?: Fixture['type'];
    createdAt?: string;
  },
): Fixture {
  const now = new Date().toISOString();
  return {
    id: thing.id,
    label: thing.label.slice(0, 40),
    scene: memory.surface?.scene ?? (memory.scene ? 'custom' : 'office'),
    surfaceId: null,
    at: { x: 0, y: 0 },
    turns: 0,
    size: { w: 0.4, d: 0.4, h: 0.4 },
    model: thing.model ?? stockModel(thing.label),
    reference: null,
    control: { kind: 'none' },
    ...(thing.type ? { type: thing.type } : {}),
    place: 'sightings',
    track: {
      concept: thing.concept,
      observation: thing.observation,
      history: thing.history ?? [],
      status: 'seen',
    },
    createdAt: thing.createdAt ?? now,
    updatedAt: now,
  };
}
/**
 * Memory kept before every thing was a fixture, as it is now: the mug and
 * each other object become things placed by their sightings (keeping their
 * ids, so rules, stats and Home Assistant's sources still name them), and
 * the main zone the rule `main`, on the main light (`entityId: ''`), with its
 * verdict and decision. The old fields go. A thing never seen is dropped:
 * there was nothing to follow.
 */
function oneList(memory: DeskMemory & OldMemory): DeskMemory {
  const { object, observation, zone, history, placement, others, item, ...rest } = memory;
  if (
    object === undefined &&
    observation === undefined &&
    zone === undefined &&
    history === undefined &&
    placement === undefined &&
    others === undefined &&
    item === undefined
  )
    return memory;
  const things: Fixture[] = [];
  if (object && observation)
    things.push(
      sightedThing(rest, {
        id: object.id,
        label: object.label,
        concept: 'mug',
        observation,
        ...(history ? { history } : {}),
        model: item ?? stockModel('Mug'),
        type: 'mug',
        createdAt: object.createdAt,
      }),
    );
  for (const o of others ?? [])
    if (o.observation)
      things.push(
        sightedThing(rest, {
          id: o.id,
          label: o.label,
          concept: o.concept,
          observation: o.observation,
          ...(o.history ? { history: o.history } : {}),
          ...(o.item ? { model: o.item } : {}),
          createdAt: o.createdAt,
        }),
      );
  const main: PlacementRule[] =
    zone && object && observation
      ? [
          {
            id: MAIN_RULE,
            label: 'Main zone',
            objects: [object.id],
            entityId: '',
            // The main zone turned its light off as the mug left unless told not to.
            ...(zone.offWhenEmpty !== false ? { offWhenEmpty: true } : {}),
            ...(zone.look ? { look: zone.look } : {}),
            zone: {
              sourceKey: zone.sourceKey,
              rect: zone.rect,
              frame: zone.frame ?? observation.frame,
              ...(zone.onSurface ? { onSurface: zone.onSurface } : {}),
            },
            placement: placement ?? null,
            inside: placement === 'inside' ? [object.id] : [],
            lastDecision: rest.lastDecision,
          },
        ]
      : [];
  return {
    ...rest,
    fixtures: [...(rest.fixtures ?? []), ...things],
    rules: [...main, ...(rest.rules ?? []).filter((r) => r.id !== MAIN_RULE)],
  };
}
/** The demo's frames before it was a camera in the office: an illustrated desk, close up. */
const OLD_DEMO_ID = 'illustrated-desk-v1';
/**
 * Desk memory as saved by an earlier version. Rules named only a light
 * (`lightId`) before they could target switches and fixtures. And demo memory
 * from the illustrated desk: its sightings, zones, pin and drafted room were
 * drawn on a picture the demo no longer shows, of the same size, so a zone
 * carried by the fixed camera would land somewhere else entirely. They are
 * dropped; fixtures in the preset rooms, entities and settings stay. A room
 * picture drawn before the corner camera was tied to a desk top found on it,
 * not to a camera frame, so nothing places on it any more: it is dropped too.
 */
export function upgradeMemory(memory: DeskMemory): DeskMemory {
  let next = memory;
  if (next.rules?.some((r) => r.entityId === undefined))
    next = {
      ...next,
      rules: next.rules.map((rule) => {
        if (rule.entityId !== undefined) return rule;
        const { lightId, ...rest } = rule as PlacementRule & { lightId?: string };
        return { ...rest, entityId: lightId ?? '' };
      }),
    };
  // Rules named one object before they could count several, or any.
  const single = (r: PlacementRule) =>
    r.objects === undefined && typeof (r as { objectId?: unknown }).objectId === 'string';
  if (next.rules?.some(single))
    next = {
      ...next,
      rules: next.rules.map((rule) => {
        if (!single(rule)) return rule;
        const { objectId, ...rest } = rule as PlacementRule & { objectId: string };
        return {
          ...rest,
          objects: [objectId],
          inside: rule.placement === 'inside' ? [objectId] : [],
        };
      }),
    };
  const old = (key?: string) => key?.startsWith(OLD_DEMO_ID) ?? false;
  const was = next as DeskMemory & OldMemory;
  if (
    next.mode === 'demo' &&
    (old(was.observation?.sourceKey) ||
      old(was.zone?.sourceKey) ||
      next.rules?.some((r) => old(r.zone?.sourceKey)))
  )
    next = {
      ...next,
      object: null,
      observation: null,
      zone: null,
      lastDecision: null,
      history: [],
      placement: null,
      others: [],
      rules: [],
      item: null,
      surface: null,
      scene: null,
      scenePhoto: null,
      illustration: null,
      deskIllustration: null,
      fixtures: (next.fixtures ?? []).filter((f) => f.scene !== 'custom' && !f.track),
    } as DeskMemory & OldMemory;
  if (next.illustration && !next.illustration.drawnFrom) next = { ...next, illustration: null };
  return upgradeItems(oneList(next as DeskMemory & OldMemory));
}
/**
 * Models saved with the first part shapes (cylinder, cone, box, handle, lid)
 * get the modern ones. They sit on the remembered object, other objects and
 * fixtures (a fixture's states and its earlier drafts too). Parts are named by
 * id everywhere else (lights, the editor's selection), so a lid splitting in
 * two moves no reference; the same object comes back when nothing is old.
 */
function upgradeItems(memory: DeskMemory): DeskMemory {
  const modelOf = <K extends string, T extends Partial<Record<K, SavedItem | null>>>(
    o: T,
    key: K,
  ): T => {
    const was = o[key];
    const now = was ? upgradeItem(was) : was;
    return now === was ? o : { ...o, [key]: now };
  };
  const each = <T>(list: T[] | undefined, up: (x: T) => T): T[] | undefined => {
    const out = list?.map(up);
    return out && list && out.some((x, i) => x !== list[i]) ? out : list;
  };
  const fixtures = each(memory.fixtures, (f) => {
    const model = modelOf(f, 'model');
    const drafts = each(model.drafts, (d) => modelOf(d, 'model'));
    const entries = Object.entries(model.states ?? {}).map(
      ([k, v]) => [k, modelOf(v, 'model')] as const,
    );
    const states = entries.some(([k, v]) => v !== model.states![k])
      ? Object.fromEntries(entries)
      : model.states;
    return drafts === model.drafts && states === model.states
      ? model
      : { ...model, ...(drafts ? { drafts } : {}), ...(states ? { states } : {}) };
  });
  return fixtures === memory.fixtures ? memory : { ...memory, ...(fixtures ? { fixtures } : {}) };
}

/** Any object, typed as `T`: the nested parts have their own schemas elsewhere, or none yet. */
const shaped = <T>() =>
  z.custom<T>((v) => typeof v === 'object' && v !== null && !Array.isArray(v));
const listOf = <T>() => z.custom<T[]>((v) => Array.isArray(v));

/**
 * Desk memory as saved: earlier versions are upgraded first (`upgradeMemory`),
 * then the top level is checked. Nested parts are checked only for their kind
 * (object or list), as the fields of `DeskMemory` have no schemas of their own
 * yet; unknown keys are kept.
 */
export const deskMemorySchema = z.preprocess(
  (raw) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    // A malformed list is left for the check below to refuse, not for the upgrade to throw on.
    const { rules } = raw as { rules?: unknown };
    return rules === undefined || Array.isArray(rules) ? upgradeMemory(raw as DeskMemory) : raw;
  },
  z.looseObject({
    mode: modeSchema,
    lastDecision: shaped<NonNullable<DeskMemory['lastDecision']>>().nullable(),
    fixedCamera: z.boolean().optional(),
    surface: surfacePinSchema.nullable().optional(),
    camera: roomCalibrationSchema.nullable().optional(),
    rules: listOf<PlacementRule>().optional(),
    scene: shaped<IsoScene>().nullable().optional(),
    scenePhoto: z.string().nullable().optional(),
    illustration: shaped<SceneIllustration>().nullable().optional(),
    deskIllustration: shaped<SceneIllustration>().nullable().optional(),
    fixtures: listOf<Fixture>().optional(),
    dismissed: z.array(z.string()).optional(),
    watch: shaped<NonNullable<DeskMemory['watch']>>().optional(),
    exposed: listOf<ExposedEntity>().optional(),
    thingStats: z.record(z.string(), z.array(thingStatSchema)).optional(),
    householdAt: z.string().optional(),
    fridgeAt: z.string().optional(),
  }),
) satisfies z.ZodType<DeskMemory, unknown>;
