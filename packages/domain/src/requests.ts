import { z } from 'zod';
import { demoPositionSchema, lightLookSchema, modeSchema, segmentRequestSchema } from './api.js';
import { cameraCropSchema } from './camera.js';
import { desktopNodeCommandSchema, desktopNodeIdSchema } from './desktop-node.js';
import { MAX_EXPOSED, exposedInputSchema } from './expose.js';
import {
  DEMO_REFERENCES,
  MAX_DRAFTS,
  MAX_FIXTURES,
  entityIdSchema,
  fixtureInputSchema,
  fixtureStateInputSchema,
  fixtureStateNameSchema,
  STATE_FOLLOWS,
} from './fixture.js';
import { MAX_DISMISSED } from './fixture-scan.js';
import { ILLUSTRATION_NOTE_MAX, pictureLayerRef, sceneIllustrationSchema } from './illustration.js';
import {
  isoSceneKindSchema,
  isoSceneSchema,
  layerSchema,
  surfacePinSchema,
  textureRef,
} from './iso.js';
import { isoItemSchema } from './iso-item.js';
import { MAIN_RULE, roomCalibrationSchema, zoneOnSurfaceSchema, zoneRectSchema } from './memory.js';
import { MAX_PHOTO_THINGS, PHOTO_AS } from './photo-scene.js';
import { roomMarksSchema } from './room-camera.js';
import { STAT_KEYS, STAT_LOOKS, STATS, thingStatSchema } from './stats.js';
import { MAX_OTHER_OBJECTS, MAX_RULES, ruleInputSchema, zoneTriggersSchema } from './rules.js';
import { selectionShapeSchema } from './selection.js';
import { zoneActionsSchema } from './zone-actions.js';

/**
 * What each route reads from its request, hoisted so the web can share the
 * types. `XSchema` is checked by the server; `X` is what a client may send.
 */

const tiles = z.number().finite();

/** A room's size in centimetres, as a person measures it. */
const roomCm = z
  .object({ w: z.number().min(60).max(480), d: z.number().min(60).max(480) })
  .strict();

/** The most lights and switches the person may choose to show. */
export const MAX_CHOSEN = 24;

/** A stored source photo among a run's assets, by its asset name. */
export const SOURCE_ASSET = /^[a-z0-9-]{1,64}\/source\.(webp|png)$/;

/** A remote-camera link's token. */
export const remoteTokenParamsSchema = z.object({ token: z.string().regex(/^[\w-]{32}$/) });
export type RemoteTokenParams = z.input<typeof remoteTokenParamsSchema>;

/** POST /api/settings/spend-limit */
export const settingsSpendLimitBodySchema = z
  .object({ usd: z.number().positive().max(1000).nullable() })
  .strict();
export type SettingsSpendLimitBody = z.input<typeof settingsSpendLimitBodySchema>;

/** POST /api/settings/tracking-ai: whether tracking may call SAM or Spark. */
export const settingsTrackingAiBodySchema = z.object({ on: z.boolean() }).strict();
export type SettingsTrackingAiBody = z.input<typeof settingsTrackingAiBodySchema>;

/**
 * A named save as the server keeps it, beside each browser's own copy: the
 * whole save file the lab exports. Its desks are checked when one is loaded
 * (`desk/restore`), so here they are only objects.
 */
export const SAVE_NAME_MAX = 60;
const saveIdSchema = z.string().regex(/^[\w-]{1,64}$/);
const saveNameSchema = z.string().trim().min(1).max(SAVE_NAME_MAX);
export const sessionSaveSchema = z
  .object({
    app: z.literal('livinglayer'),
    version: z.literal(1),
    savedAt: z.string().max(40),
    name: z.string().max(SAVE_NAME_MAX).optional(),
    prefs: z.record(z.string(), z.unknown()),
    desks: z.object({ demo: z.unknown().optional(), live: z.unknown().optional() }).strict(),
  })
  .strict();
export type StoredSession = z.output<typeof sessionSaveSchema>;
export interface StoredSave {
  id: string;
  name: string;
  save: StoredSession;
}

/** POST /api/saves/save: keep a save under its name; a name another save has updates that one. */
export const savesSaveBodySchema = z
  .object({ id: saveIdSchema, name: saveNameSchema, save: sessionSaveSchema })
  .strict();
export type SavesSaveBody = z.input<typeof savesSaveBodySchema>;

/** POST /api/saves/rename */
export const savesRenameBodySchema = z.object({ id: saveIdSchema, name: saveNameSchema }).strict();
export type SavesRenameBody = z.input<typeof savesRenameBodySchema>;

/** POST /api/saves/delete */
export const savesDeleteBodySchema = z.object({ id: saveIdSchema }).strict();
export type SavesDeleteBody = z.input<typeof savesDeleteBodySchema>;

/**
 * POST /api/segment. With `shape`, the thing inside it is outlined on the
 * server with no model call (`outlineIn`); without, SAM outlines every match
 * of `concept`, which tracking allows only once AI is turned on for it.
 */
export const segmentBodySchema = segmentRequestSchema
  .extend({
    shape: selectionShapeSchema.optional(),
    /** With a shape: SAM outlines what is inside it (its box as the prompt, billed), not this machine. */
    sam: z.boolean().optional(),
  })
  .strict();
export type SegmentBody = z.input<typeof segmentBodySchema>;

/** GET /api/desk/:mode, GET /api/expose/:mode, GET /api/expose/:mode/events, GET /api/scene/photo, GET /api/watch/:mode, GET /api/watch/:mode/events, POST /api/desk/reset, POST /api/desk/rules/verify, POST /api/room/forget, POST /api/scene/separate/undo, POST /api/text */
export const modeOnlySchema = z.object({ mode: modeSchema }).strict();
export type ModeOnly = z.input<typeof modeOnlySchema>;

/** POST /api/lamp */
export const lampBodySchema = z
  .object({
    mode: modeSchema,
    entityId: entityIdSchema.optional(),
    action: z.enum(['on', 'off']).default('on'),
  })
  .strict();
export type LampBody = z.input<typeof lampBodySchema>;

/** POST /api/assist */
export const assistBodySchema = z
  .object({
    mode: modeSchema,
    prompt: z.string().trim().min(1).max(400),
    /** The selection; a follow-up may leave it out to keep the last one. */
    shape: selectionShapeSchema.optional(),
    /** Live: the frame the selection was drawn on, from the camera it was drawn over. */
    imageDataUrl: z.string().max(7_000_000).optional(),
    /** The assist run this request follows. */
    previous: z.uuid().optional(),
    jobId: z.uuid().optional(),
  })
  .strict();
export type AssistBody = z.input<typeof assistBodySchema>;

/** POST /api/assist/save */
export const assistSaveBodySchema = z.object({ mode: modeSchema, runId: z.uuid() }).strict();
export type AssistSaveBody = z.input<typeof assistSaveBodySchema>;

/** POST /api/cameras/delete */
export const camerasDeleteBodySchema = z.object({ id: z.string().min(1).max(40) }).strict();
export type CamerasDeleteBody = z.input<typeof camerasDeleteBodySchema>;

/** POST /api/streams/crop */
export const streamsCropBodySchema = z
  .object({
    streamId: z.string().min(1).max(200),
    crop: cameraCropSchema.nullable(),
  })
  .strict();
export type StreamsCropBody = z.input<typeof streamsCropBodySchema>;

/** GET /api/cameras/:id/snapshot, GET /api/cameras/:id/stream */
export const cameraIdOnlySchema = z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict();
export type CameraIdOnly = z.input<typeof cameraIdOnlySchema>;

/** POST /api/expose/save */
export const exposeSaveBodySchema = z
  .object({ mode: modeSchema, entity: exposedInputSchema })
  .strict();
export type ExposeSaveBody = z.input<typeof exposeSaveBodySchema>;

/** POST /api/expose/learn-empty */
export const exposeLearnEmptyBodySchema = z
  .object({ mode: modeSchema, zoneId: z.string().min(1).max(64) })
  .strict();
export type ExposeLearnEmptyBody = z.input<typeof exposeLearnEmptyBodySchema>;

/** POST /api/things/stats: the stats switched on for one thing, in the order shown. */
export const thingsStatsBodySchema = z
  .object({
    mode: modeSchema,
    id: z.string().min(1).max(64),
    stats: z
      .array(thingStatSchema)
      .max(STATS.max)
      .refine((s) => new Set(s.map((x) => x.key)).size === s.length, {
        message: 'A stat is switched on once.',
      }),
  })
  .strict();
export type ThingsStatsBody = z.input<typeof thingsStatsBodySchema>;

/** POST /api/things/ask: a question about the room's history. */
export const thingsAskBodySchema = z
  .object({
    mode: modeSchema,
    question: z.string().trim().min(1).max(300),
    /** Ask as of this time, ms: the demo's replay minute. Now when absent. */
    at: z
      .number()
      .int()
      .positive()
      .refine((at) => at <= Date.now() + 86_400_000, { message: 'That time is still to come.' })
      .optional(),
  })
  .strict();
export type ThingsAskBody = z.input<typeof thingsAskBodySchema>;

/** POST /api/coach/check: the room coach looks now, as of `at` in the demo. */
export const coachCheckBodySchema = z
  .object({
    mode: modeSchema,
    /** Look as of this time, ms: the demo's replay minute. Now when absent. */
    at: z
      .number()
      .int()
      .positive()
      .refine((at) => at <= Date.now() + 86_400_000, { message: 'That time is still to come.' })
      .optional(),
  })
  .strict();
export type CoachCheckBody = z.input<typeof coachCheckBodySchema>;

/** POST /api/coach/switch: whether the live room coach looks every few minutes. */
export const coachSwitchBodySchema = z
  .object({ mode: z.literal('live').default('live'), on: z.boolean() })
  .strict();
export type CoachSwitchBody = z.input<typeof coachSwitchBodySchema>;

/** GET /api/coach/:mode */
export const coachQuerySchema = z.object({ mode: modeSchema }).strict();

/** POST /api/things/learn: the person says how the thing looks now. */
export const thingsLearnBodySchema = z
  .object({
    mode: modeSchema,
    id: z.string().min(1).max(64),
    key: z.enum(STAT_KEYS),
    look: z.enum(STAT_LOOKS),
  })
  .strict();
export type ThingsLearnBody = z.input<typeof thingsLearnBodySchema>;

/** POST /api/things/used: the person says when a thing was last used (its Last used stat). */
export const thingsUsedBodySchema = z
  .object({
    mode: modeSchema,
    id: z.string().min(1).max(64),
    /** When, ms; not in the future (a minute's leeway for clocks). */
    at: z
      .number()
      .int()
      .positive()
      .refine((at) => at <= Date.now() + 60_000, { message: 'That time is still to come.' }),
  })
  .strict();
export type ThingsUsedBody = z.input<typeof thingsUsedBodySchema>;

/** GET /api/things/:mode/:id/stats?days=7 */
export const thingStatsQuerySchema = z
  .object({
    mode: modeSchema,
    id: z.string().min(1).max(64),
    days: z.coerce.number().int().min(1).max(90).default(7),
  })
  .strict();

/** POST /api/expose/delete, POST /api/fixtures/untrack */
export const modeIdSchema = z.object({ mode: modeSchema, id: z.string().uuid() }).strict();
export type ModeId = z.input<typeof modeIdSchema>;

/** POST /api/fixtures/draft */
export const fixturesDraftBodySchema = z
  .object({
    mode: modeSchema,
    scene: z.union([isoSceneKindSchema, z.literal('custom')]),
    /** Demo: one of the bundled pictures. */
    reference: z.enum(DEMO_REFERENCES).optional(),
    /** Live: the person's photo of the thing, or the desk photo a box is drawn on. */
    imageDataUrl: z.string().max(7_000_000).optional(),
    /**
     * A box drawn around the thing on a desk photo, in thousandths: the
     * live photo sent with it, or the demo camera's frame in the demo.
     */
    box: z
      .object({
        x1: z.number().int().min(0).max(1000),
        y1: z.number().int().min(0).max(1000),
        x2: z.number().int().min(0).max(1000),
        y2: z.number().int().min(0).max(1000),
      })
      .strict()
      .refine((b) => b.x2 > b.x1 && b.y2 > b.y1, { message: 'The box must have an area.' })
      .optional(),
    /** What the person says it is; Spark is told, and it names the draft. */
    label: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
export type FixturesDraftBody = z.input<typeof fixturesDraftBodySchema>;

/** POST /api/fixtures/scan */
export const fixturesScanBodySchema = z
  .object({
    mode: modeSchema,
    imageDataUrl: z.string().max(7_000_000).optional(),
    /** The scene to map into; the pin's own when left out. */
    scene: z.union([isoSceneKindSchema, z.literal('custom')]).optional(),
    /** Move fixtures placed by hand too, and the layout's things, to where the scan finds them. */
    replace: z.boolean().optional(),
    /** Add what the room doesn't have yet; false only looks for what it has. */
    addNew: z.boolean().optional(),
    /**
     * Follow each fixture and thing that moves from SAM's outline in the scan,
     * with no further call: a mug as the desk's mug, anything else as an object.
     */
    follow: z.boolean().optional(),
    /** The page's id for following the steps as they go. */
    jobId: z.string().uuid().optional(),
  })
  .strict();
export type FixturesScanBody = z.input<typeof fixturesScanBodySchema>;

/** POST /api/fixtures/sculpt */
export const fixturesSculptBodySchema = z
  .object({
    mode: modeSchema,
    fixtureId: z.string().uuid(),
    /** The page's id for following the steps as they go. */
    jobId: z.string().uuid().optional(),
    /** What the person says it is or wants of it: "it's a Dyson bladeless fan". */
    note: z.string().trim().min(1).max(300).optional(),
    /** A close photo of it, modelled from instead of the room camera's crop. */
    imageDataUrl: z.string().max(7_000_000).optional(),
  })
  .strict();
export type FixturesSculptBody = z.input<typeof fixturesSculptBodySchema>;

/** POST /api/fixtures/edit */
export const fixturesEditBodySchema = z
  .object({
    mode: modeSchema,
    fixtureId: z.string().uuid(),
    /** What to change, in the person's words: "make the handle thicker and red". */
    prompt: z.string().trim().min(1).max(400),
    /** The model as the editor has it now, saved or not, so a follow-up builds on the last edit. */
    item: isoItemSchema,
    /** Ids of the parts the person brushed over, to say what the request means by "it" or "this". */
    focus: z.array(z.string().min(1).max(60)).max(12).optional(),
    jobId: z.string().uuid().optional(),
  })
  .strict();
export type FixturesEditBody = z.input<typeof fixturesEditBodySchema>;

/** POST /api/fixtures/sculpt/reapply */
export const fixturesSculptReapplyBodySchema = z
  .object({ mode: modeSchema, jobId: z.string().uuid() })
  .strict();
export type FixturesSculptReapplyBody = z.input<typeof fixturesSculptReapplyBodySchema>;

/** POST /api/fixtures/photo */
export const fixturesPhotoBodySchema = z
  .object({
    mode: modeSchema,
    fixtureId: z.string().uuid(),
    imageDataUrl: z.string().max(7_000_000).optional(),
  })
  .strict();
export type FixturesPhotoBody = z.input<typeof fixturesPhotoBodySchema>;

/** POST /api/fixtures/refine3d */
export const fixturesRefine3dBodySchema = z
  .object({ mode: modeSchema, fixtureId: z.string().uuid(), jobId: z.string().uuid() })
  .strict();
export type FixturesRefine3dBody = z.input<typeof fixturesRefine3dBodySchema>;

/** POST /api/fixtures/choose */
export const fixturesChooseBodySchema = z
  .object({
    mode: modeSchema,
    fixtureId: z.string().uuid(),
    draft: z
      .number()
      .int()
      .min(0)
      .max(MAX_DRAFTS - 1),
  })
  .strict();
export type FixturesChooseBody = z.input<typeof fixturesChooseBodySchema>;

/** POST /api/fixtures/save */
export const fixturesSaveBodySchema = z
  .object({ mode: modeSchema, fixture: fixtureInputSchema })
  .strict();
export type FixturesSaveBody = z.input<typeof fixturesSaveBodySchema>;

/** POST /api/fixtures/promote */
export const fixturesPromoteBodySchema = z
  .object({
    mode: modeSchema,
    /** The room the thing is drawn with: a preset's built-in thing, or the person's own layout. */
    scene: z.union([isoSceneKindSchema, z.literal('custom')]),
    /** Its group in that room's layout. */
    group: z.string().min(1).max(48),
  })
  .strict();
export type FixturesPromoteBody = z.input<typeof fixturesPromoteBodySchema>;

/** POST /api/fixtures/seat */
export const fixturesSeatBodySchema = z
  .object({
    mode: modeSchema,
    /** The person who sits down or stands up. */
    id: z.string().uuid(),
    /** A seat that is a thing, a chair of their room's layout (made a thing to sit in), or null to stand up. */
    seat: z.union([
      z.object({ fixtureId: z.string().uuid() }).strict(),
      z.object({ group: z.string().min(1).max(48) }).strict(),
      z.null(),
    ]),
  })
  .strict();
export type FixturesSeatBody = z.input<typeof fixturesSeatBodySchema>;
export const fixturesAwayBodySchema = z
  .object({
    mode: modeSchema,
    /** The person or pet who went out, or came home. */
    id: z.string().uuid(),
    away: z.boolean(),
  })
  .strict();
export type FixturesAwayBody = z.input<typeof fixturesAwayBodySchema>;

/** GET /api/fixtures/reference */
export const fixturesReferenceQuerySchema = z.object({ runId: z.string().uuid() }).strict();
export type FixturesReferenceQuery = z.input<typeof fixturesReferenceQuerySchema>;

/** POST /api/fixtures/find */
export const fixturesFindBodySchema = z
  .object({
    mode: modeSchema,
    id: z.string().uuid(),
    imageDataUrl: z.string().max(7_000_000).optional(),
  })
  .strict();
export type FixturesFindBody = z.input<typeof fixturesFindBodySchema>;

/** POST /api/fixtures/delete */
export const fixturesDeleteBodySchema = z
  .object({
    mode: modeSchema,
    fixtureId: z.string().uuid().optional(),
    fixtureIds: z.array(z.string().uuid()).min(1).max(MAX_FIXTURES).optional(),
    dismiss: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Boolean(b.fixtureId) !== Boolean(b.fixtureIds), {
    message: 'Give fixtureId or fixtureIds.',
  });
export type FixturesDeleteBody = z.input<typeof fixturesDeleteBodySchema>;

/** POST /api/fixtures/release */
export const fixturesReleaseBodySchema = z
  .object({ mode: modeSchema, scene: z.union([isoSceneKindSchema, z.literal('custom')]) })
  .strict();
export type FixturesReleaseBody = z.input<typeof fixturesReleaseBodySchema>;

/** POST /api/fixtures/undismiss */
export const fixturesUndismissBodySchema = z
  .object({ mode: modeSchema, label: z.string().min(1).max(40) })
  .strict();
export type FixturesUndismissBody = z.input<typeof fixturesUndismissBodySchema>;

/** POST /api/fixtures/state */
export const fixturesStateBodySchema = z
  .object({
    mode: modeSchema,
    fixtureId: z.string().uuid(),
    state: fixtureStateNameSchema.nullable().optional(),
    fixture: fixtureStateInputSchema.optional(),
    remove: fixtureStateNameSchema.optional(),
    /** Which stat a state shows while on, or null for none; the shown state stays as it is. */
    follow: z
      .object({ state: fixtureStateNameSchema, stat: z.enum(STATE_FOLLOWS).nullable() })
      .strict()
      .optional(),
  })
  .strict();
export type FixturesStateBody = z.input<typeof fixturesStateBodySchema>;

/** POST /api/fixtures/layer: a thing's draw layer alone, so a tracked thing stays tracked. */
export const fixturesLayerBodySchema = z
  .object({ mode: modeSchema, fixtureId: z.string().uuid(), layer: layerSchema })
  .strict();
export type FixturesLayerBody = z.input<typeof fixturesLayerBodySchema>;

/** POST /api/fixtures/control */
export const fixturesControlBodySchema = z
  .object({
    mode: modeSchema,
    fixtureId: z.string().uuid().optional(),
    entityId: entityIdSchema.optional(),
    /** One of the fixture's light sources, switched by its own entity. */
    part: z.string().min(1).max(24).optional(),
    action: fixtureStateNameSchema,
  })
  .strict()
  .refine((x) => Boolean(x.fixtureId) !== Boolean(x.entityId), {
    message: 'Name a fixture or an entity, not both.',
  })
  .refine((x) => !x.part || x.fixtureId, { message: 'A light source is a fixture’s.' });
export type FixturesControlBody = z.input<typeof fixturesControlBodySchema>;

/** POST /api/desk/select */
export const deskSelectBodySchema = z
  .object({
    mode: modeSchema,
    segmentRunId: z.string().uuid(),
    detectionId: z.string().min(1).max(80),
  })
  .strict();
export type DeskSelectBody = z.input<typeof deskSelectBodySchema>;

/** POST /api/desk/track */
export const deskTrackBodySchema = z
  .object({ mode: modeSchema, segmentRunId: z.string().uuid() })
  .strict();
export type DeskTrackBody = z.input<typeof deskTrackBodySchema>;

/** POST /api/desk/zone/options */
export const deskZoneOptionsBodySchema = z
  .object({
    mode: modeSchema,
    offWhenEmpty: z.boolean().optional(),
    look: lightLookSchema.optional(),
  })
  .strict();
export type DeskZoneOptionsBody = z.input<typeof deskZoneOptionsBodySchema>;

/** POST /api/desk/camera */
export const deskCameraBodySchema = z.object({ mode: modeSchema, fixed: z.boolean() }).strict();
export type DeskCameraBody = z.input<typeof deskCameraBodySchema>;

/** POST /api/desk/surface */
export const deskSurfaceBodySchema = z
  .object({ mode: modeSchema, pin: surfacePinSchema.nullable() })
  .strict();
export type DeskSurfaceBody = z.input<typeof deskSurfaceBodySchema>;

/** POST /api/desk/objects/select */
export const deskObjectsSelectBodySchema = z
  .object({
    mode: modeSchema,
    segmentRunId: z.string().uuid(),
    detectionId: z.string().min(1).max(80),
    label: z.string().trim().min(1).max(40),
  })
  .strict();
export type DeskObjectsSelectBody = z.input<typeof deskObjectsSelectBodySchema>;

/** POST /api/desk/objects/track */
export const deskObjectsTrackBodySchema = z
  .object({ mode: modeSchema, objectId: z.string().uuid(), segmentRunId: z.string().uuid() })
  .strict();
export type DeskObjectsTrackBody = z.input<typeof deskObjectsTrackBodySchema>;

/** POST /api/fixtures/anchor */
export const fixturesAnchorBodySchema = z
  .object({
    mode: modeSchema,
    id: z.string().uuid(),
    segmentRunId: z.string().uuid(),
    detectionId: z.string().min(1).max(80),
  })
  .strict();
export type FixturesAnchorBody = z.input<typeof fixturesAnchorBodySchema>;

/** POST /api/desk/objects/forget */
export const deskObjectsForgetBodySchema = z
  .object({ mode: modeSchema, objectId: z.string().uuid() })
  .strict();
export type DeskObjectsForgetBody = z.input<typeof deskObjectsForgetBodySchema>;

/** POST /api/desk/rules/save */
export const deskRulesSaveBodySchema = z
  .object({ mode: modeSchema, rule: ruleInputSchema })
  .strict();
export type DeskRulesSaveBody = z.input<typeof deskRulesSaveBodySchema>;

/** POST /api/desk/rules/delete */
/** A rule's id: the main zone's, or another's. */
const ruleIdSchema = z.union([z.literal(MAIN_RULE), z.string().uuid()]);
export const deskRulesDeleteBodySchema = z
  .object({ mode: modeSchema, ruleId: ruleIdSchema })
  .strict();
export type DeskRulesDeleteBody = z.input<typeof deskRulesDeleteBodySchema>;

/** POST /api/desk/rules/options: a zone's name or steps, its zone and story kept. */
export const deskRulesOptionsBodySchema = z
  .object({
    mode: modeSchema,
    ruleId: ruleIdSchema,
    label: z.string().trim().min(1).max(40).optional(),
    /** Its steps each way, or null for the main zone to switch the main lamp as it did. */
    actions: zoneActionsSchema.nullable().optional(),
    /** What sets it off: any thing, or the ones named, one of them or all together. */
    triggers: zoneTriggersSchema.optional(),
  })
  .strict();
export type DeskRulesOptionsBody = z.input<typeof deskRulesOptionsBodySchema>;

/** POST /api/scene/save */
export const sceneSaveBodySchema = z
  .object({ mode: modeSchema, scene: isoSceneSchema.nullable() })
  .strict();
export type SceneSaveBody = z.input<typeof sceneSaveBodySchema>;

/** GET /api/scene/texture */
export const sceneTextureQuerySchema = z.object({ asset: textureRef }).strict();
export type SceneTextureQuery = z.input<typeof sceneTextureQuerySchema>;

/** POST /api/scene/from-photo/save */
export const sceneFromPhotoSaveBodySchema = z
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
  .strict();
export type SceneFromPhotoSaveBody = z.input<typeof sceneFromPhotoSaveBodySchema>;

/** POST /api/item/save */
export const itemSaveBodySchema = z
  .object({
    mode: modeSchema,
    item: isoItemSchema.nullable(),
    objectId: z.string().uuid().optional(),
  })
  .strict();
export type ItemSaveBody = z.input<typeof itemSaveBodySchema>;

/** POST /api/desk/zone */
export const deskZoneBodySchema = z
  .object({
    mode: modeSchema,
    observationId: z.string().uuid(),
    rect: zoneRectSchema,
    onSurface: zoneOnSurfaceSchema.optional(),
  })
  .strict();
export type DeskZoneBody = z.input<typeof deskZoneBodySchema>;

/** POST /api/desk/restore */
export const deskRestoreBodySchema = z
  .object({
    mode: modeSchema,
    memory: z
      .object({
        mode: modeSchema,
        // Saves from before every thing was a fixture name the mug here; `upgradeMemory` moves it.
        object: z
          .object({ id: z.string().min(1), label: z.string(), createdAt: z.string() })
          .nullable()
          .optional(),
        surface: surfacePinSchema.nullable().optional(),
        camera: roomCalibrationSchema.nullable().optional(),
        scene: isoSceneSchema.nullable().optional(),
        scenePhoto: z.string().regex(SOURCE_ASSET).nullable().optional(),
        illustration: sceneIllustrationSchema.nullable().optional(),
        deskIllustration: sceneIllustrationSchema.nullable().optional(),
        others: z
          .array(z.object({ id: z.string().min(1) }).loose())
          .max(MAX_OTHER_OBJECTS)
          .optional(),
        // The main zone is a rule, and the mug and other objects are things, beside the rest.
        rules: z
          .array(z.object({ id: z.string().min(1) }).loose())
          .max(MAX_RULES + 1)
          .optional(),
        fixtures: z
          .array(z.object({ id: z.string().min(1) }).loose())
          .max(MAX_FIXTURES + MAX_OTHER_OBJECTS + 1)
          .optional(),
        dismissed: z.array(z.string().min(1).max(40)).max(MAX_DISMISSED).optional(),
        exposed: z
          .array(exposedInputSchema.required({ id: true }))
          .max(MAX_EXPOSED)
          .optional(),
      })
      .loose(),
  })
  .strict();
export type DeskRestoreBody = z.input<typeof deskRestoreBodySchema>;

/** POST /api/desk/verify */
export const deskVerifyBodySchema = z
  .object({ mode: modeSchema, observationId: z.string().uuid(), zoneId: ruleIdSchema })
  .strict();
export type DeskVerifyBody = z.input<typeof deskVerifyBodySchema>;

/** POST /api/scene/illustrate */
export const sceneIllustrateBodySchema = z
  .object({
    mode: modeSchema,
    imageDataUrl: z.string().max(7_000_000).optional(),
    /** The room, from its photo; or its desk, from a close camera frame. */
    view: z.enum(['room', 'desk']).default('room'),
    /** Report the steps under this id while the call runs, so the page can follow and stop it. */
    jobId: z.string().uuid().optional(),
    /** What to change this time, added to the prompt. */
    note: z.string().trim().max(ILLUSTRATION_NOTE_MAX).optional(),
  })
  .strict();
export type SceneIllustrateBody = z.input<typeof sceneIllustrateBodySchema>;

/** POST /api/scene/separate */
export const sceneSeparateBodySchema = z
  .object({
    mode: modeSchema,
    /** The page's id for following the steps as they go. */
    jobId: z.string().uuid().optional(),
  })
  .strict();
export type SceneSeparateBody = z.input<typeof sceneSeparateBodySchema>;

/** GET /api/scene/illustration */
export const sceneIllustrationQuerySchema = z.object({ asset: pictureLayerRef }).strict();
export type SceneIllustrationQuery = z.input<typeof sceneIllustrationQuerySchema>;

/** POST /api/item/draft */
export const itemDraftBodySchema = z
  .object({
    mode: modeSchema,
    source: z.enum(['sampled', 'spark']),
    objectId: z.string().uuid().optional(),
  })
  .strict();
export type ItemDraftBody = z.input<typeof itemDraftBodySchema>;

/** POST /api/item/refit */
export const itemRefitBodySchema = z
  .object({
    mode: modeSchema,
    objectId: z.string().uuid().optional(),
    item: isoItemSchema.optional(),
  })
  .strict();
export type ItemRefitBody = z.input<typeof itemRefitBodySchema>;

/** GET /api/item/crop */
export const itemCropQuerySchema = z
  .object({
    mode: modeSchema,
    objectId: z.string().uuid().optional(),
    /** Changes with the crop, so a browser never shows a stale one. */
    v: z.string().max(200).optional(),
  })
  .strict();
export type ItemCropQuery = z.input<typeof itemCropQuerySchema>;

/** GET /api/jobs/:id, POST /api/jobs/:id/stop */
export const idOnlySchema = z.object({ id: z.string().uuid() }).strict();
export type IdOnly = z.input<typeof idOnlySchema>;

/** GET /api/jobs */
export const jobsQuerySchema = z.object({ pictures: z.enum(['0', '1']).default('0') }).strict();
export type JobsQuery = z.input<typeof jobsQuerySchema>;

/** POST /api/desk/auto-pin */
export const deskAutoPinBodySchema = z
  .object({
    mode: modeSchema,
    imageDataUrl: z.string().max(7_000_000).optional(),
    surfaceId: z.string().min(1).max(40).optional(),
  })
  .strict();
export type DeskAutoPinBody = z.input<typeof deskAutoPinBodySchema>;

/** POST /api/scene/from-photo */
export const sceneFromPhotoBodySchema = z
  .object({
    mode: modeSchema,
    imageDataUrl: z.string().max(7_000_000).optional(),
    check: z.boolean().optional(),
    /** The page's id for following the steps as they go. */
    jobId: z.string().uuid().optional(),
  })
  .strict();
export type SceneFromPhotoBody = z.input<typeof sceneFromPhotoBodySchema>;

/** POST /api/scene/setup */
export const sceneSetupBodySchema = z
  .object({
    mode: modeSchema,
    imageDataUrl: z.string().max(7_000_000).optional(),
    check: z.boolean().optional(),
    scene: z.union([isoSceneKindSchema, z.literal('custom')]),
    crop: cameraCropSchema.nullable().optional(),
    jobId: z.string().uuid().optional(),
  })
  .strict();
export type SceneSetupBody = z.input<typeof sceneSetupBodySchema>;

/** POST /r/:token/answer */
export const remoteAnswerSchema = z
  .object({ id: z.string().uuid(), sdp: z.string().min(1).max(60_000) })
  .strict();
export type RemoteAnswer = z.input<typeof remoteAnswerSchema>;

/** POST /r/:token/stats */
const measure = z.number().finite().nonnegative().max(1e9).nullable();

/** What the phone's encoder did lately, as its page reports it. */
export const phoneStatsSchema = z
  .object({
    codec: z.string().max(60).nullable(),
    encoder: z.string().max(60).nullable(),
    powerEfficient: z.boolean().nullable(),
    width: measure,
    height: measure,
    fps: measure,
    kbps: measure,
    targetKbps: measure,
    /** Why the encoder sent less than it could, and for how long, in seconds, by reason. */
    limitedBy: z.string().max(20).nullable(),
    limitedS: z
      .record(z.string().max(20), z.number().nonnegative())
      .refine((r) => Object.keys(r).length <= 8),
    rttMs: measure,
    /** What the camera captures at, before the encoder. */
    capture: z.object({ width: measure, height: measure, fps: measure }).strict(),
    /** Exposure, focus and colour held where they were. */
    held: z.boolean(),
  })
  .strict();
export type PhoneStats = z.infer<typeof phoneStatsSchema>;

/** POST /api/room/floor, POST /api/room/keep */
export const modeImageSchema = z
  .object({ mode: modeSchema, imageDataUrl: z.string().max(7_000_000).optional() })
  .strict();
export type ModeImage = z.input<typeof modeImageSchema>;

/** POST /api/room/calibrate */
export const roomCalibrateBodySchema = z
  .object({
    mode: modeSchema,
    imageDataUrl: z.string().max(7_000_000).optional(),
    marks: roomMarksSchema,
    room: roomCm,
    heightCm: z.number().min(100).max(400).optional(),
    scene: z.union([isoSceneKindSchema, z.literal('custom')]),
    /** The zoomed view the frame was taken through, so the lens is fitted whole. */
    crop: cameraCropSchema.nullable().optional(),
  })
  .strict();
export type RoomCalibrateBody = z.input<typeof roomCalibrateBodySchema>;

/** POST /api/scene/fit */
export const sceneFitBodySchema = z
  .object({
    mode: modeSchema,
    scene: isoSceneSchema,
    group: z.string().min(1).max(48),
    imageDataUrl: z.string().max(7_000_000).optional(),
  })
  .strict();
export type SceneFitBody = z.input<typeof sceneFitBodySchema>;

/** POST /api/select/resolve */
export const selectResolveBodySchema = z
  .object({ mode: modeSchema, shape: selectionShapeSchema })
  .strict();
export type SelectResolveBody = z.input<typeof selectResolveBodySchema>;

/** POST /api/watch */
export const watchBodySchema = z
  .object({
    mode: modeSchema,
    on: z.boolean(),
    streamId: z.string().min(1).max(300).optional(),
  })
  .strict();
export type WatchBody = z.input<typeof watchBodySchema>;

/** POST /api/watch/backend: what follows things for the live watcher. */
export const watchBackendBodySchema = z
  .object({ backend: z.enum(['local', 'vision', 'gpu']) })
  .strict();
export type WatchBackendBody = z.input<typeof watchBackendBodySchema>;

/** POST /api/watch/demo */
export const watchDemoBodySchema = z.object({ position: demoPositionSchema }).strict();
export type WatchDemoBody = z.input<typeof watchDemoBodySchema>;

/** POST /api/ha/login */
export const haLoginBodySchema = z
  .object({
    mode: modeSchema.optional(),
    url: z.string().min(1).max(200),
    username: z.string().max(100),
    password: z.string().max(200),
    code: z.string().max(20).optional(),
    flowId: z.string().max(100).optional(),
  })
  .strict();
export type HaLoginBody = z.input<typeof haLoginBodySchema>;

/** POST /api/ha/chosen. `mode` rides along from the lab; the choice is for live mode, demo has its own devices. */
export const haChosenBodySchema = z
  .object({ mode: modeSchema.optional(), entityIds: z.array(entityIdSchema).max(MAX_CHOSEN) })
  .strict();
export type HaChosenBody = z.input<typeof haChosenBodySchema>;

/** POST /api/nodes/adopt: a node found over mDNS, by id, or one at an address typed in. */
export const nodesAdoptBodySchema = z
  .object({
    mode: modeSchema,
    id: desktopNodeIdSchema.optional(),
    host: z
      .string()
      .regex(/^[\w.-]{1,253}$/)
      .optional(),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict()
  .refine((x) => Boolean(x.id) !== Boolean(x.host), {
    message: 'Name a desktop found here, or its address, not both.',
  });
export type NodesAdoptBody = z.input<typeof nodesAdoptBodySchema>;

/** POST /api/nodes/forget */
export const nodesForgetBodySchema = z
  .object({ mode: modeSchema, id: desktopNodeIdSchema })
  .strict();
export type NodesForgetBody = z.input<typeof nodesForgetBodySchema>;

/** POST /api/nodes/link: the Thing in the room that is this desktop's monitor. */
export const nodesLinkBodySchema = z
  .object({ mode: modeSchema, id: desktopNodeIdSchema, fixtureId: z.string().uuid() })
  .strict();
export type NodesLinkBody = z.input<typeof nodesLinkBodySchema>;

/** POST /api/nodes/command */
export const nodesCommandBodySchema = z
  .object({ mode: modeSchema, id: desktopNodeIdSchema, command: desktopNodeCommandSchema })
  .strict();
export type NodesCommandBody = z.input<typeof nodesCommandBodySchema>;
