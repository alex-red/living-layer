import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import {
  runOutput,
  MAX_FIXTURES,
  MAX_OTHER_OBJECTS,
  draftModel,
  isoSurface,
  modelTarget,
  sceneFromPhotoSaveBodySchema,
  sceneSaveBodySchema,
  setModel,
  settleFixtures,
  followSurfaces,
  uniqueParts,
  type DeskMemory,
  type EvidenceRun,
  type Fixture,
  type Mode,
  type IsoScene,
  type PhotoThing,
  type SavedItem,
  type SurfacePin,
  buildScene,
  imageRequestSchema,
  isoSceneSchema,
  modeOnlySchema,
  sceneTextureQuerySchema,
  type SceneDraft,
} from '@livinglayer/domain';
import { demoSceneDraft, demoSceneGuess } from './demo.js';
import { LabError, liveImage, parseInput } from './errors.js';
import { roomPhotoBytes } from './fixture/shared.js';
import { validateImage } from './images.js';
import { keepLocked } from './item.js';
import type { EvidenceStore } from './store.js';
import { refitToScene } from './room.js';
import { illustrationRoutes } from './illustration.js';
import { photoRoutes } from './photo.js';
import type { RouteDeps } from './route-deps.js';
import { sceneFitRoutes } from './scene-fit.js';

/** A drafted layout, checked against the scene schema. */
function drafted(draft: SceneDraft) {
  const scene = buildScene(draft);
  if (!isoSceneSchema.safeParse(scene).success)
    throw new LabError('invalid_scene', 'The drafted layout did not fit its grid.', 502);
  return { draft, scene };
}

type Parsed<S extends { parse: (data: unknown) => unknown }> = ReturnType<S['parse']>;
type PhotoSaveBody = Parsed<typeof sceneFromPhotoSaveBodySchema>;
type PhotoDraftOutput = NonNullable<ReturnType<typeof runOutput<'photo'>>>;
type PhotoSegmentation = NonNullable<ReturnType<typeof runOutput<'segment'>>>;
type Picked = { thing: PhotoThing; detection: PhotoSegmentation['detections'][number] };

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The completed photo draft a save is for, and the segmentation it was drawn from, still the latest. */
function photoDraftOf(store: EvidenceStore, mode: Mode, runId: string) {
  const draftRun = store.getRun(runId);
  if (
    !draftRun ||
    draftRun.kind !== 'photo' ||
    draftRun.mode !== mode ||
    draftRun.status !== 'completed'
  )
    throw new LabError('photo_draft', 'Draft a scene from a photo first.', 409);
  const draft = runOutput(draftRun, 'photo')!;
  const segment = store.getRun(draft.segmentRunId);
  if (!segment || store.latestSegment(mode) !== segment.id)
    throw new LabError(
      'photo_stale',
      'A newer segmentation came after this photo draft. Draft the photo again.',
      409,
    );
  return { draft, segment, segmentation: runOutput(segment, 'segment')! };
}

/** The ticked things, each with the mask SAM outlined for it. */
function pickedThings(
  draft: PhotoDraftOutput,
  segmentation: PhotoSegmentation,
  track: string[],
): Picked[] {
  return track.map((thingId) => {
    const detectionId = draft.detections[thingId];
    const detection = segmentation.detections.find((d) => d.objectId === detectionId);
    const thing = draft.inventory.things.find((t) => t.id === thingId);
    if (!detection || !thing)
      throw new LabError('photo_object', 'Pick objects that SAM outlined in this draft.');
    return { thing, detection };
  });
}

/** The drafted scene, its pin and its photo replace the room's; its old pictures no longer fit. */
function applyPhotoScene(
  store: EvidenceStore,
  memory: DeskMemory,
  draft: PhotoDraftOutput,
  { mode, runId, scene, pin }: Pick<PhotoSaveBody, 'mode' | 'runId' | 'scene' | 'pin'>,
) {
  // The room is drawn from its templates; nothing from the photo is pasted on.
  memory.scene = scene as IsoScene;
  // Through the camera it was laid out through: newer when the draft turned a hidden wall.
  if (memory.camera && draft.calibration.calibratedAt > memory.camera.calibratedAt)
    memory.camera = { ...memory.camera, ...draft.calibration };
  if (memory.fixtures) memory.fixtures = settleFixtures(memory.fixtures, memory.scene);
  memory.surface = pin as SurfacePin | null;
  memory.scenePhoto =
    mode === 'live'
      ? (['webp', 'png'].map((ext) => `${runId}/source.${ext}`).find((a) => store.readAsset(a)) ??
        null)
      : null;
  memory.illustration = null;
  memory.deskIllustration = null;
  store.saveMemory(memory);
}

/** What a thing is saved as: chosen again with what the person changed it to, against the fixtures saved before. */
function photoModels(
  draft: PhotoDraftOutput,
  as: NonNullable<PhotoSaveBody['as']>,
  library: Fixture[],
  now: string,
) {
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
  return { chosen, saved, model };
}

/** The highest surface a fixture of this height and middle stands on, if it isn't on the floor. */
function standingSurface(scene: IsoScene, f: NonNullable<PhotoSaveBody['fixtures']>[number]) {
  if (f.at.z <= 0.05) return undefined;
  const c = { x: f.at.x + f.size.w / 2, y: f.at.y + f.size.d / 2 };
  return scene.surfaces
    .filter(
      (x) =>
        Math.abs(x.z - f.at.z) < 0.1 &&
        c.x >= x.rect.x &&
        c.x <= x.rect.x + x.rect.w &&
        c.y >= x.rect.y &&
        c.y <= x.rect.y + x.rect.d,
    )
    .sort((a, b) => b.z - a.z)[0];
}

/**
 * What no template draws stays as a fixture, with its model and the crop Spark can model it from.
 * The same thing already in this room moves here, and keeps its model, size and switch.
 */
function photoFixtures(
  draft: PhotoDraftOutput,
  models: ReturnType<typeof photoModels>,
  { runId, scene, fixtures = [], track }: PhotoSaveBody,
  library: Fixture[],
  now: string,
) {
  const claimed = new Set<string>();
  const added: Fixture[] = [];
  for (const f of fixtures) {
    const thing = draft.inventory.things.find((t) => t.id === f.id);
    if (!thing || track.includes(f.id))
      throw new LabError(
        'photo_object',
        'Keep as fixtures only things from this draft that aren’t tracked.',
      );
    const where = {
      at: { x: f.at.x, y: f.at.y },
      surfaceId: standingSurface(scene as IsoScene, f)?.id ?? null,
    };
    const pick = models.chosen(thing);
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
      label: capital(thing.label),
      scene: 'custom',
      ...where,
      turns,
      size: { w: fit(own.w), d: fit(own.d), h: fit(f.size.h) },
      model: models.saved(thing),
      reference: crop ? { runId, asset: crop } : null,
      control: { kind: 'none' },
      createdAt: now,
      updatedAt: now,
    });
  }
  return added;
}

/** The first ticked object is the main one (identity stays a person's choice); the rest are remembered beside it. */
function rememberPicked(
  { store, desk }: { store: EvidenceStore; desk: RouteDeps['desk'] },
  mode: Mode,
  memory: DeskMemory,
  seen: { segment: EvidenceRun; segmentation: PhotoSegmentation },
  models: ReturnType<typeof photoModels>,
  picked: Picked[],
) {
  const { segment, segmentation } = seen;
  const [main, ...rest] = picked;
  if (main) {
    const fresh = !memory.object;
    desk.observe(memory, segment, segmentation, main.detection, 'manual', null);
    memory = store.memory(mode);
    if (fresh && memory.object) memory.object.label = capital(main.thing.label);
    const item = models.model(main.thing.id, modelTarget(memory));
    if (item) setModel(memory, memory.object!.id, item);
  }
  for (const { thing, detection } of rest) {
    const id = randomUUID();
    const observation = desk.sightingOf(id, segment, segmentation, detection, 'manual', null);
    memory.others = [
      ...(memory.others ?? []),
      {
        id,
        label: capital(thing.label),
        concept: thing.label,
        createdAt: new Date().toISOString(),
        observation,
        history: [],
        item: models.model(thing.id, null),
      },
    ];
    store.save(desk.evidence('observation', mode, observation));
  }
  store.saveMemory(memory);
}

/**
 * Save a reviewed photo draft in one go: the scene, the pin, and the
 * objects the person ticked, each remembered from its own mask with the
 * model fitted to it.
 */
function savePhotoDraft(
  deps: { store: EvidenceStore; desk: RouteDeps['desk'] },
  body: PhotoSaveBody,
) {
  const { store, desk } = deps;
  const { mode, runId, scene, pin, track, as = {} } = body;
  desk.available(mode);
  const { draft, segment, segmentation } = photoDraftOf(store, mode, runId);
  if (pin && (pin.scene !== 'custom' || !isoSurface('custom', pin.surfaceId, scene as IsoScene)))
    throw new LabError('surface_unknown', 'The pin must be on a surface of the drafted scene.');
  const picked = pickedThings(draft, segmentation, track);
  const memory = store.memory(mode);
  if ((memory.others?.length ?? 0) + Math.max(0, picked.length - 1) > MAX_OTHER_OBJECTS)
    throw new LabError(
      'object_limit',
      `Up to ${MAX_OTHER_OBJECTS} more objects can be remembered. Forget one, or tick fewer.`,
      409,
    );
  applyPhotoScene(store, memory, draft, body);
  const now = new Date().toISOString();
  const library = memory.fixtures ?? [];
  const models = photoModels(draft, as, library, now);
  const added = photoFixtures(draft, models, body, library, now);
  if (added.length) {
    const moved = new Set(added.map((f) => f.id));
    const rest = library.filter((f) => !moved.has(f.id));
    memory.fixtures = settleFixtures([...rest, ...added].slice(0, MAX_FIXTURES), memory.scene!);
    store.saveMemory(memory);
  }
  rememberPicked(deps, mode, memory, { segment, segmentation }, models, picked);
  return store.memory(mode);
}

/**
 * Everything under `/api/scene` that has its own file: reading a room from a
 * photo (`draft`, `classify`, `from-photo`, `setup`), fitting and drawing it
 * (`fit`, `illustrate`, `separate`), and the pictures kept with it. Saving a
 * scene, and `from-photo/save`, take the desk's busy check.
 */
export async function sceneRoutes(
  app: FastifyInstance,
  deps: Pick<RouteDeps, 'store' | 'meta' | 'run' | 'jobs' | 'config' | 'desk'>,
) {
  const { store, meta, run, jobs, config, desk } = deps;
  const { available } = desk;
  // Not `deps` itself: its `prefix` would be applied a second time.
  const own = { store, meta, run, jobs, config };
  /**
   * Draft a whole scene from a photo: Spark places templates on a grid, the
   * server builds and checks the geometry. Nothing is saved until the person
   * saves it from the scene editor.
   */
  app.post('/draft', async (request) => {
    const input = parseInput(imageRequestSchema, request.body);
    return run('layout', input.mode, async (id) => {
      if (input.mode === 'demo') {
        liveImage(input.mode, input.imageDataUrl);
        return { output: drafted(demoSceneDraft) };
      }
      const image = await validateImage(input.imageDataUrl);
      const result = await meta.layout(image.dataUrl);
      return {
        ...result,
        output: drafted(result.output),
        assets: [store.asset(id, `source.${image.ext}`, image.bytes)],
      };
    });
  });
  app.post('/classify', async (request) => {
    const input = parseInput(imageRequestSchema, request.body);
    return run('scene', input.mode, async (id) => {
      if (input.mode === 'demo') {
        liveImage(input.mode, input.imageDataUrl);
        return { output: demoSceneGuess };
      }
      const image = await validateImage(input.imageDataUrl);
      const result = await meta.classify(image.dataUrl);
      return { ...result, assets: [store.asset(id, `source.${image.ext}`, image.bytes)] };
    });
  });
  /** A face texture of a scene drafted from a photo, before the room had a calibrated camera. */
  app.get('/texture', async (request, reply) => {
    const { asset } = parseInput(sceneTextureQuerySchema, request.query);
    const png = store.readAsset(asset);
    if (!png) throw new LabError('texture_missing', 'This texture is gone.', 404);
    return reply.type('image/png').header('cache-control', 'no-cache').send(png);
  });
  /**
   * The photo a drafted room's pin was set on, at the pin's frame size, for
   * checking the pin's corners on it after the page has lost its photo.
   */
  app.get('/photo', async (request, reply) => {
    const { mode } = parseInput(modeOnlySchema, request.query);
    const memory = store.memory(mode);
    const bytes = mode === 'live' ? roomPhotoBytes(memory, store) : null;
    if (!bytes || !memory.surface)
      throw new LabError('photo_missing', 'This room has no photo of its own kept.', 404);
    const { width, height } = memory.surface.frame;
    // A photo of another shape is from another camera: stretched, its desk would
    // pass for the pinned camera's, and the pin would be dragged onto the wrong view.
    const size = await sharp(bytes).metadata();
    if (Math.abs(size.width! / size.height! - width / height) > 0.02 * (width / height))
      throw new LabError(
        'photo_shape',
        `The room’s photo is ${size.width}×${size.height}, and the pin was set on ${width}×${height} frames from another camera. Start that camera to check the pin on what it shows.`,
        409,
      );
    const png = await sharp(bytes).resize(width, height, { fit: 'fill' }).png().toBuffer();
    return reply.type('image/png').header('cache-control', 'no-cache').send(png);
  });
  /**
   * Save the person's own scene, or drop it. A pin on a surface the new
   * scene no longer has is cleared, since it would point at nothing.
   */
  app.post('/save', async (request) => {
    const { mode, scene } = parseInput(sceneSaveBodySchema, request.body);
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
  app.post('/from-photo/save', async (request) =>
    savePhotoDraft({ store, desk }, parseInput(sceneFromPhotoSaveBodySchema, request.body)),
  );
  app.register(photoRoutes, own);
  app.register(sceneFitRoutes, own);
  app.register(illustrationRoutes, own);
}
