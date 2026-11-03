import { z } from 'zod';
import { demoPositionSchema, lightLookSchema, modeSchema } from './api.js';
import { cameraCropSchema } from './camera.js';
import { MAX_EXPOSED, exposedInputSchema } from './expose.js';
import {
  DEMO_REFERENCES,
  MAX_DRAFTS,
  MAX_FIXTURES,
  entityIdSchema,
  fixtureInputSchema,
  fixtureStateInputSchema,
  fixtureStateNameSchema,
} from './fixture.js';
import { MAX_DISMISSED } from './fixture-scan.js';
import { ILLUSTRATION_NOTE_MAX, pictureLayerRef, sceneIllustrationSchema } from './illustration.js';
import { isoSceneKindSchema, isoSceneSchema, surfacePinSchema, textureRef } from './iso.js';
import { isoItemSchema } from './iso-item.js';
import { roomCalibrationSchema, zoneOnSurfaceSchema, zoneRectSchema } from './memory.js';
import { MAX_PHOTO_THINGS, PHOTO_AS } from './photo-scene.js';
import { roomMarksSchema } from './room-camera.js';
import { MAX_OTHER_OBJECTS, MAX_RULES, ruleInputSchema } from './rules.js';
import { selectionShapeSchema } from './selection.js';

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
  })
  .strict();
export type FixturesSculptBody = z.input<typeof fixturesSculptBodySchema>;

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
  })
  .strict();
export type FixturesStateBody = z.input<typeof fixturesStateBodySchema>;

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
export const deskRulesDeleteBodySchema = z
  .object({ mode: modeSchema, ruleId: z.string().uuid() })
  .strict();
export type DeskRulesDeleteBody = z.input<typeof deskRulesDeleteBodySchema>;

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
        object: z
          .object({ id: z.string().min(1), label: z.string(), createdAt: z.string() })
          .nullable(),
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
  .strict();
export type DeskRestoreBody = z.input<typeof deskRestoreBodySchema>;

/** POST /api/desk/verify */
export const deskVerifyBodySchema = z
  .object({ mode: modeSchema, observationId: z.string().uuid(), zoneId: z.string().uuid() })
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
