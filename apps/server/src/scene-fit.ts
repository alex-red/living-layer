import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  calibrationOf,
  DEMO_CAMERA,
  DEMO_ROOM,
  fitGroup,
  fitKept,
  floorSolid,
  groupBounds,
  ISO_TILE_CM,
  isoSceneSchema,
  modeSchema,
  projectRoom,
  renderRoom,
  roomMask,
  sceneSolids,
  type IsoScene,
  type SceneFit,
  type Segmentation,
} from '@livinglayer/domain';
import { samWhole } from './assist.js';
import { LabError, parseInput } from './errors.js';
import { validateImage } from './images.js';
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
    const b = groupBounds(scene as IsoScene, group);
    if (!b) throw new LabError('fit_group', 'That prop isn’t in the scene.', 404);
    if (mode === 'live' && !imageDataUrl)
      throw new LabError('fit_frame', 'Send a frame of the room’s camera to fit it to.', 400);
    if (mode === 'demo' && imageDataUrl)
      throw new LabError('demo_image', 'Demo mode uses only the demo room’s camera.');
    const { width, height } = camera.frame;
    // Its drawing's box, grown by a quarter each way: where it stands is the guess being corrected.
    const corners = [0, 1].flatMap((i) =>
      [0, 1].flatMap((j) =>
        [0, 1].map((k) =>
          projectRoom(camera, {
            x: b.at.x + i * b.size.w,
            y: b.at.y + j * b.size.d,
            z: b.at.z + k * b.size.h,
          }),
        ),
      ),
    );
    const seen = corners.filter((c) => c !== null);
    if (seen.length < corners.length)
      throw new LabError('fit_view', 'The camera doesn’t see all of it.', 409);
    const xs = seen.map((c) => c.x);
    const ys = seen.map((c) => c.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const box = {
      left: Math.max(0, x0 - (x1 - x0) / 4),
      top: Math.max(0, y0 - (y1 - y0) / 4),
      right: Math.min(width, x1 + (x1 - x0) / 4),
      bottom: Math.min(height, y1 + (y1 - y0) / 4),
    };
    if (box.right - box.left < 4 || box.bottom - box.top < 4)
      throw new LabError('fit_view', 'The camera doesn’t see it.', 409);
    let outline: ReturnType<typeof samWhole> = null;
    const outlined = await run('segment', mode, async (id) => {
      if (mode === 'demo') {
        // The demo's frame is its own room drawn through its camera.
        const picture = renderRoom(
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
      const result = await meta.segmentBoxes(image.dataUrl, [{ id: 1, box }], width, height);
      outline = samWhole(result.output, { width, height });
      return {
        ...result,
        assets: [
          store.asset(id, 'source.png', image.bytes),
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
