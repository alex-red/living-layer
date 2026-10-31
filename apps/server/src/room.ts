import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ISO_PRESETS,
  META_PRICES,
  cameraEdges,
  cameraFromMarks,
  convexHull,
  demoSourceKey,
  isoSceneKindSchema,
  isoSurface,
  maskBits,
  marksFromFloor,
  marksFromWalls,
  modeSchema,
  pinOf,
  roomMarksSchema,
  type DeskMemory,
  type EvidenceRun,
  type RoomCalibration,
  type RoomMarks,
  type Segmentation,
} from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import { demoPng, demoSegmentation } from './demo.js';
import { lumaOf } from './frames.js';
import { validateImage } from './images.js';
import type { Runner } from './item.js';
import type { MetaAdapter } from './meta.js';
import type { EvidenceStore } from './store.js';

export interface FloorMarks {
  /** The SAM runs that outlined the floor and the walls, kept as evidence like any segmentation. */
  run: EvidenceRun<Segmentation>;
  wallRun: EvidenceRun<Segmentation>;
  /** Where the floor's far corner and walls are, or null when no floor was found. */
  marks: RoomMarks | null;
  frame: Segmentation['frame'];
}

/** A room's size in centimetres, as a person measures it. */
const roomCm = z
  .object({ w: z.number().min(60).max(480), d: z.number().min(60).max(480) })
  .strict();

/**
 * Calibrating the room's one camera. `room/floor` has SAM outline the floor
 * (one call, live) and reads the marks off it: the far corner, both walls'
 * floor lines and, where the frame shows them, their far ends. Nothing is
 * saved: the person drags the marks into place and gives the room's size,
 * and `room/calibrate` fits the camera, keeps the frame's edges to tell later
 * whether the camera moved, and pins the room's main surface through it.
 */
export function roomRoutes(
  app: FastifyInstance,
  { store, meta, run }: { store: EvidenceStore; meta: MetaAdapter; run: Runner },
) {
  app.post('/api/room/floor', async (request): Promise<FloorMarks> => {
    const input = parseInput(
      z.object({ mode: modeSchema, imageDataUrl: z.string().max(7_000_000).optional() }).strict(),
      request.body,
    );
    const live = input.mode === 'live';
    if (!live && input.imageDataUrl)
      throw new LabError('demo_image', 'Demo mode uses only the demo room’s camera.');
    if (live && !meta.canAfford(2 * META_PRICES.samPerImage))
      throw new LabError(
        'spend_limit',
        "Finding the floor and walls would pass today's Meta spending limit. Raise the limit, or place the marks by hand.",
        429,
      );
    const image = live ? await validateImage(input.imageDataUrl) : null;
    // Two outlines: where the floor meets the walls is where the marks are.
    const outline = (concept: string) =>
      run('segment', input.mode, async (id) => {
        if (!image) {
          const result = await demoSegmentation(concept);
          return {
            output: { ...result.output, sourceKey: demoSourceKey() },
            assets: [store.asset(id, 'synthetic-sam.txt', result.raw)],
          };
        }
        const result = await meta.segment(image.dataUrl, concept, image.width, image.height);
        return {
          ...result,
          output: {
            ...result.output,
            sourceKey: createHash('sha256').update(image.bytes).digest('hex'),
          },
          assets: [
            store.asset(id, 'source.png', image.bytes),
            store.asset(id, 'sam-output.txt', result.raw),
          ],
        };
      }) as Promise<EvidenceRun<Segmentation>>;
    const floorRun = await outline('floor');
    const wallRun = await outline('wall');
    const { frame } = floorRun.output;
    const union = (runOf: EvidenceRun<Segmentation>) => {
      const bits = {
        width: frame.width,
        height: frame.height,
        data: new Uint8Array(frame.width * frame.height),
      };
      for (const d of runOf.output.detections) {
        const one = maskBits(d, frame, 1);
        for (let i = 0; i < bits.data.length; i++) bits.data[i]! |= one.data[i]!;
      }
      return bits;
    };
    const floor = union(floorRun);
    const marks = wallRun.output.detections.length
      ? (marksFromWalls(floor, union(wallRun)) ?? marksFromFloor(floor, convexHull))
      : marksFromFloor(floor, convexHull);
    return { run: floorRun, wallRun, marks, frame };
  });

  app.post('/api/room/calibrate', async (request) => {
    const input = parseInput(
      z
        .object({
          mode: modeSchema,
          imageDataUrl: z.string().max(7_000_000).optional(),
          marks: roomMarksSchema,
          room: roomCm,
          heightCm: z.number().min(100).max(400).optional(),
          scene: z.union([isoSceneKindSchema, z.literal('custom')]),
        })
        .strict(),
      request.body,
    );
    const live = input.mode === 'live';
    if (!live && input.imageDataUrl)
      throw new LabError('demo_image', 'Demo mode uses only the demo room’s camera.');
    const image = live ? await validateImage(input.imageDataUrl) : null;
    const png = image ? image.bytes : await demoPng();
    const luma = await lumaOf(png);
    const frame = image ? { width: image.width, height: image.height } : null;
    const memory = store.memory(input.mode);
    if (input.scene === 'custom' && !memory.scene)
      throw new LabError('calibrate_scene', 'Build or draft the room’s scene first.', 409);
    const size = frame ?? { width: 960, height: 640 };
    const room = { w: input.room.w / 30, d: input.room.d / 30 };
    const scene = input.scene === 'custom' ? memory.scene! : ISO_PRESETS[input.scene];
    // The room's floor starts inside its walls: the scene's coordinates include them.
    const wall = (g: string) => scene.props.find((p) => p.group === g);
    const origin = { x: wall('wall-left')?.size.w ?? 0, y: wall('wall-back')?.size.d ?? 0 };
    const fit = cameraFromMarks(input.marks, size, room, {
      origin,
      ...(input.heightCm ? { heightCm: input.heightCm } : {}),
    });
    // Marks a few pixels off are a slip; tens of pixels mean they don't fit any corner camera.
    if (fit.error > Math.hypot(size.width, size.height) / 60)
      throw new LabError(
        'calibrate_fit',
        `The marks don't fit a camera in the room's front corner (off by ${fit.error.toFixed(0)} px). Check the corner and the walls' floor lines, and the room's size.`,
        422,
      );
    const calibration: RoomCalibration = {
      camera: fit.camera,
      marks: input.marks,
      scene: input.scene,
      error: fit.error,
      calibratedAt: new Date().toISOString(),
      reference: cameraEdges(luma),
    };
    const next: DeskMemory = { ...memory, camera: calibration, fixedCamera: true };
    // The room's desk or table, seen through the camera, is the pin things are placed by.
    const main = scene.surfaces
      .filter((s) => /desk|table/i.test(`${s.id} ${s.label}`))
      .sort((a, b) => b.rect.w * b.rect.d - a.rect.w * a.rect.d)[0];
    const pin = main ? pinOf(fit.camera, main, size) : null;
    if (pin && isoSurface(input.scene, pin.surfaceId, memory.scene))
      next.surface = { ...pin, scene: input.scene };
    store.saveMemory(next);
    return {
      memory: store.memory(input.mode),
      fit: { error: fit.error, heightCm: fit.heightCm, hfovDeg: Math.round(fit.hfovDeg) },
    };
  });

  app.post('/api/room/forget', async (request) => {
    const { mode } = parseInput(z.object({ mode: modeSchema }).strict(), request.body);
    const memory = store.memory(mode);
    store.saveMemory({ ...memory, camera: null });
    return store.memory(mode);
  });
}
