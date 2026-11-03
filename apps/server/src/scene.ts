import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import {
  buildScene,
  imageRequestSchema,
  isoSceneSchema,
  modeOnlySchema,
  sceneTextureQuerySchema,
  type SceneDraft,
} from '@livinglayer/domain';
import { demoSceneDraft, demoSceneGuess } from './demo.js';
import { LabError, liveImage, parseInput } from './errors.js';
import { roomPhotoBytes } from './fixture.js';
import { validateImage } from './images.js';
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

/**
 * Everything under `/api/scene` that has its own file: reading a room from a
 * photo (`draft`, `classify`, `from-photo`, `setup`), fitting and drawing it
 * (`fit`, `illustrate`, `separate`), and the pictures kept with it. Saving a
 * scene, and `from-photo/save`, stay with the desk's busy check in `desk.ts`.
 */
export async function sceneRoutes(
  app: FastifyInstance,
  deps: Pick<RouteDeps, 'store' | 'meta' | 'run' | 'jobs' | 'config'>,
) {
  const { store, meta, run, jobs, config } = deps;
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
  app.register(photoRoutes, own);
  app.register(sceneFitRoutes, own);
  app.register(illustrationRoutes, own);
}
