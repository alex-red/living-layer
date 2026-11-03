import type { FastifyInstance } from 'fastify';
import { renderRoomAsync } from './workers/compute.js';
import { z } from 'zod';
import {
  calibrationOf,
  DEMO_CAMERA,
  DEMO_ROOM,
  fitGroup,
  fitKept,
  floorSolid,
  groupBounds,
  groupInFrame,
  ISO_TILE_CM,
  isoSceneSchema,
  modeSchema,
  roomMask,
  sceneSolids,
  type IsoScene,
  type SceneFit,
  type Segmentation,
} from '@livinglayer/domain';
import { samWhole } from './assist.js';
import { LabError, parseInput } from './errors.js';
import { samDataUrl, validateImage } from './images.js';
import type { Runner } from './item.js';
import type { MetaAdapter } from './meta.js';
import { NOT_CALIBRATED } from './photo.js';
import type { EvidenceStore } from './store.js';

/**
 * Fit one prop of the scene being edited to where the room's camera sees it:
 * SAM outlines what stands in a box around the prop's drawing (one call,
 * live; the demo reads its own render), and the prop is moved, and turned
 * round if that fits better, until its drawing matches (`fitGroup`). Nothing
 * is saved: the editor takes the scene and the person saves it.
 */
export function sceneFitRoutes(
  app: FastifyInstance,
  { store, meta, run }: { store: EvidenceStore; meta: MetaAdapter; run: Runner },
) {
  app.post('/api/scene/fit', async (request): Promise<SceneFit> => {
    const { mode, scene, group, imageDataUrl } = parseInput(
      z
        .object({
          mode: modeSchema,
          scene: isoSceneSchema,
          group: z.string().min(1).max(48),
          imageDataUrl: z.string().max(7_000_000).optional(),
        })
        .strict(),
      request.body,
    );
    const camera = mode === 'demo' ? DEMO_CAMERA : calibrationOf(store.memory(mode))?.camera;
    if (!camera) throw new LabError('not_calibrated', NOT_CALIBRATED, 409);
    if (!groupBounds(scene as IsoScene, group))
      throw new LabError('fit_group', 'That prop isn’t in the scene.', 404);
    if (mode === 'live' && !imageDataUrl)
      throw new LabError('fit_frame', 'Send a frame of the room’s camera to fit it to.', 400);
    if (mode === 'demo' && imageDataUrl)
      throw new LabError('demo_image', 'Demo mode uses only the demo room’s camera.');
    const { width, height } = camera.frame;
    // Its drawing's box, grown by a quarter each way: where it stands is the guess being corrected.
    const box = groupInFrame(camera, scene as IsoScene, group, 1 / 4);
    if (!box) throw new LabError('fit_view', 'The camera doesn’t see all of it.', 409);
    let outline: ReturnType<typeof samWhole> = null;
    const outlined = await run('segment', mode, async (id) => {
      if (mode === 'demo') {
        // The demo's frame is its own room drawn through its camera.
        const picture = await renderRoomAsync(
          DEMO_CAMERA,
          [floorSolid(DEMO_ROOM.grid), ...sceneSolids(DEMO_ROOM)],
          { labels: true },
        );
        outline = roomMask(picture, group);
        const output: Segmentation = { concept: group, frame: { width, height }, detections: [] };
        return { output };
      }
      const image = await validateImage(imageDataUrl!);
      if (image.width !== width || image.height !== height)
        throw new LabError(
          'not_calibrated',
          `This frame is ${image.width} × ${image.height}, but the room’s camera was calibrated on ${width} × ${height} frames.`,
          409,
        );
      const result = await meta.segmentBoxes(
        await samDataUrl(image),
        [{ id: 1, box }],
        width,
        height,
      );
      outline = samWhole(result.output, { width, height });
      return {
        ...result,
        assets: [
          store.asset(id, `source.${image.ext}`, image.bytes),
          store.asset(id, 'sam-output.txt', result.raw),
        ],
      };
    });
    if (!outline)
      throw new LabError(
        'fit_nothing',
        mode === 'demo'
          ? 'The demo frame doesn’t show that prop.'
          : 'SAM found nothing there to fit it to.',
        422,
      );
    const fit = fitGroup(camera, scene as IsoScene, group, outline)!;
    const kept = fitKept(fit);
    return {
      scene: kept ? fit.scene : (scene as IsoScene),
      fit: {
        from: fit.from,
        iou: fit.iou,
        movedCm: { x: fit.moved.x * ISO_TILE_CM, y: fit.moved.y * ISO_TILE_CM },
        turned: fit.turned,
        kept,
      },
      runId: outlined.id,
    };
  });
}
