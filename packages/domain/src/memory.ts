import { z } from 'zod';
import type { IsoScene, IsoSceneKind, SurfacePin } from './iso.js';
import { pointSchema } from './iso.js';
import { ISO_PRESETS } from './iso-presets.js';
import type { SceneIllustration } from './illustration.js';
import { DEMO_CAMERA } from './demo-room.js';
import { CAMERA_EDGES_MAX, marksOf, roomCameraSchema, roomMarksSchema } from './room-camera.js';
import { cameraCropSchema } from './camera.js';
import type { SavedItem } from './iso-item.js';
import { fixtureModel, linkedFixtures, type Fixture } from './fixture.js';
import type { ExposedEntity } from './expose.js';
import type { Detection, EvidenceRun, LampResult, Mode, Segmentation } from './api.js';
import type { PlacementRule } from './rules.js';

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
    scene: z.enum(['office', 'desk', 'fridge', 'custom']),
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
    scene: z.enum(['office', 'desk', 'fridge', 'custom']),
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
}
export interface DeskMemory {
  mode: Mode;
  object: { id: string; label: string; createdAt: string } | null;
  observation: DeskObservation | null;
  /** `frame` is the size of the image the zone was drawn on; older zones lack it. */
  zone: {
    id: string;
    sourceKey: string;
    rect: ZoneRect;
    frame?: Segmentation['frame'];
    onSurface?: ZoneOnSurface;
  } | null;
  lastDecision: EvidenceRun<PlacementDecision> | null;
  /**
   * Opt-in: the camera hasn't moved, so a zone carries over to any new frame of
   * the same size. Off, a zone only applies to the exact image it was drawn on.
   */
  fixedCamera?: boolean;
  /** Earlier observations of the object, newest first. */
  history?: DeskObservation[];
  /** The last inside/outside verdict, so the lamp fires only on entering the zone. */
  placement?: 'inside' | 'outside' | null;
  /** Corners that tie frames of one size to a surface of an isometric scene. */
  surface?: SurfacePin | null;
  /** The room's one camera, calibrated against the room itself. */
  camera?: RoomCalibration | null;
  /** Further remembered objects, each followed like the mug. */
  others?: TrackedObject[];
  /** Further zones, each tied to one object and one light or switch. */
  rules?: PlacementRule[];
  /** The person's own isometric scene, built from templates or drafted by Spark. */
  scene?: IsoScene | null;
  /** The photo that scene was drafted from, as an evidence asset (live only). */
  scenePhoto?: string | null;
  /** A clean isometric picture of that scene's room, drawn from its photo. */
  illustration?: SceneIllustration | null;
  /** The room's desk close up, redrawn from a close camera frame in the room picture's style. */
  deskIllustration?: SceneIllustration | null;
  /** A detailed model of the remembered object, drafted from its mask and editable. */
  item?: SavedItem | null;
  /** Things placed in a room by hand: lamps, switches, a mouse. Reset keeps them. */
  fixtures?: Fixture[];
  /** Names the person said aren't fixtures, so scans skip them. */
  dismissed?: string[];
  /** Whether the server watches the camera, and which one; it resumes after a restart. */
  watch?: { on: boolean; camera: WatchCamera | null };
  /** Entities shown in Home Assistant over MQTT, each with what its state comes from. Reset keeps them. */
  exposed?: ExposedEntity[];
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
}
/** Another remembered object, beside the mug. Any concept SAM can segment. */
export interface TrackedObject {
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
    zone: memory.zone ? onSurface(memory.zone) : memory.zone,
    ...(memory.rules
      ? { rules: memory.rules.map((r) => ({ ...r, zone: onSurface(r.zone) })) }
      : {}),
    ...(memory.fixtures ? { fixtures: memory.fixtures.map(own) } : {}),
  };
}
/** The observation and name of the mug or another remembered object, by id. */
export function objectById(
  memory: DeskMemory,
  objectId: string,
): { label: string; concept: string; observation: DeskObservation | null } | null {
  if (memory.object?.id === objectId)
    return { label: memory.object.label, concept: 'mug', observation: memory.observation };
  const other = memory.others?.find((o) => o.id === objectId);
  if (other) return { label: other.label, concept: other.concept, observation: other.observation };
  // A fixture found in the camera's view is followed like an object.
  const fixture = memory.fixtures?.find((f) => f.id === objectId && f.track);
  return fixture?.track
    ? {
        label: fixture.label,
        concept: fixture.track.concept,
        observation: fixture.track.observation,
      }
    : null;
}
/** The mug (no id, or its id), another remembered object or a fixture, with its model. */
export function modelTarget(
  memory: DeskMemory,
  objectId?: string,
): {
  id: string;
  label: string;
  observation: DeskObservation | null;
  item: SavedItem | null;
  /** A fixture is never seen by the camera: its model comes from its reference photo. */
  fixture?: boolean;
} | null {
  if (!objectId || objectId === memory.object?.id)
    return memory.object
      ? {
          id: memory.object.id,
          label: memory.object.label,
          observation: memory.observation,
          item: memory.item ?? null,
        }
      : null;
  const other = memory.others?.find((o) => o.id === objectId);
  if (other)
    return {
      id: other.id,
      label: other.label,
      observation: other.observation,
      item: other.item ?? null,
    };
  const fixture = memory.fixtures?.find((f) => f.id === objectId);
  return fixture
    ? {
        id: fixture.id,
        label: fixture.label,
        observation: null,
        item: fixtureModel(fixture),
        fixture: true,
      }
    : null;
}
/** Store a model on the mug, another remembered object, or a fixture (which always keeps one). */
export function setModel(memory: DeskMemory, objectId: string, item: SavedItem | null): void {
  if (objectId === memory.object?.id) memory.item = item;
  else {
    const other = memory.others?.find((o) => o.id === objectId);
    if (other) other.item = item;
    const fixture = memory.fixtures?.find((f) => f.id === objectId);
    if (fixture && item) {
      const now = new Date().toISOString();
      const targets = [fixture, ...linkedFixtures(memory.fixtures ?? [], fixture)];
      for (const f of targets) {
        if (fixture.state) {
          f.states = {
            ...f.states,
            [fixture.state]: { ...(f.states?.[fixture.state] ?? {}), model: item },
          };
        } else {
          f.model = item;
        }
        f.updatedAt = now;
      }
    }
  }
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
  if (
    next.mode === 'demo' &&
    (old(next.observation?.sourceKey) ||
      old(next.zone?.sourceKey) ||
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
      fixtures: (next.fixtures ?? []).filter((f) => f.scene !== 'custom'),
    };
  if (next.illustration && !next.illustration.drawnFrom) next = { ...next, illustration: null };
  return next;
}
