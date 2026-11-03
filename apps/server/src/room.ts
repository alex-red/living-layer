import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import {
  modeImageSchema,
  modeOnlySchema,
  roomCalibrateBodySchema,
  ISO_PRESETS,
  META_PRICES,
  cameraEdges,
  MOVED_CAMERA,
  cameraFromMarks,
  fitLimit,
  convexHull,
  demoSourceKey,
  isoSurface,
  maskBits,
  marksFromFloor,
  marksFromWalls,
  pinOf,
  ISO_TILE_CM,
  type IsoScene,
  type CameraCrop,
  type DeskMemory,
  type EvidenceRun,
  type IsoSceneKind,
  type Mode,
  type RoomCalibration,
  type RoomMarks,
  type Segmentation,
} from '@livinglayer/domain';
import { LabError, liveImage, parseInput } from './errors.js';
import { demoPng, demoSegmentation } from './demo.js';
import { lumaOf } from './frames.js';
import { samDataUrl, requireFrame, validateImage, type ValidatedImage } from './images.js';
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

/** What a room calibration needs besides the marks; `room` is the inner floor in centimetres. */
export interface CalibrateInput {
  mode: Mode;
  image: ValidatedImage | null;
  marks: RoomMarks;
  room: { w: number; d: number };
  heightCm?: number;
  /** How sure the height is, in centimetres: an estimate rather than a measurement. */
  heightSpreadCm?: number;
  scene: IsoSceneKind | 'custom';
  crop?: CameraCrop | null;
}

/**
 * Has SAM outline the floor and the walls of a frame (two calls, live) and
 * reads the marks off them: the far corner, both walls' floor lines and,
 * where the frame shows them, their far ends. Nothing is saved.
 */
export async function findFloorMarks(
  { store, meta, run }: { store: EvidenceStore; meta: MetaAdapter; run: Runner },
  mode: Mode,
  image: ValidatedImage | null,
): Promise<FloorMarks> {
  // Two outlines: where the floor meets the walls is where the marks are.
  const outline = (concept: string) =>
    run('segment', mode, async (id) => {
      if (!image) {
        const result = await demoSegmentation(concept);
        return {
          output: { ...result.output, sourceKey: demoSourceKey() },
          assets: [store.asset(id, 'synthetic-sam.txt', result.raw)],
        };
      }
      const result = await meta.segment(
        await samDataUrl(image),
        concept,
        image.width,
        image.height,
      );
      return {
        ...result,
        output: {
          ...result.output,
          sourceKey: createHash('sha256').update(image.bytes).digest('hex'),
        },
        assets: [
          store.asset(id, `source.${image.ext}`, image.bytes),
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
    ? (marksFromWalls(
        floor,
        union(wallRun),
        wallRun.output.detections.map((d) => maskBits(d, frame, 1)),
      ) ?? marksFromFloor(floor, convexHull))
    : marksFromFloor(floor, convexHull);
  return { run: floorRun, wallRun, marks, frame };
}

/**
 * Fits the room's camera to the marks, keeps the frame's edges to tell later
 * whether the camera moved, pins the room's main surface through it, and
 * saves it all to desk memory. Refuses marks that fit no corner camera.
 */
export async function calibrateRoom(store: EvidenceStore, input: CalibrateInput) {
  const live = input.mode === 'live';
  const png = input.image ? input.image.bytes : await demoPng();
  const luma = await lumaOf(png);
  const memory = store.memory(input.mode);
  if (input.scene === 'custom' && !memory.scene)
    throw new LabError('calibrate_scene', 'Build or draft the room’s scene first.', 409);
  const size = input.image
    ? { width: input.image.width, height: input.image.height }
    : { width: 960, height: 640 };
  const fit = fitRoom(input, size, memory);
  // Marks a few pixels off are a slip; tens of pixels mean they don't fit any corner camera.
  if (fit.error > fitLimit(size))
    throw new LabError(
      'calibrate_fit',
      `The marks don't fit a camera in the room's front corner (off by ${fit.error.toFixed(0)} px). Check the corner and the walls' floor lines, and the room's size.`,
      422,
    );
  const scene = input.scene === 'custom' ? memory.scene! : ISO_PRESETS[input.scene];
  const calibration: RoomCalibration = {
    camera: fit.camera,
    marks: input.marks,
    scene: input.scene,
    error: fit.error,
    calibratedAt: new Date().toISOString(),
    reference: cameraEdges(luma),
    ...(live && input.crop ? { crop: input.crop } : {}),
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
}

/**
 * The room's scene changed size: its calibrated camera is fitted again to the
 * same marks at the new size (the marks pin the room's shape, the scene its
 * size), and the desk is pinned through it again. Unchanged otherwise.
 */
export function refitToScene(memory: DeskMemory, before: IsoScene | null): DeskMemory {
  const calibration = memory.camera;
  const scene = memory.scene;
  if (!calibration || calibration.scene !== 'custom' || !scene || !before) return memory;
  if (scene.grid.w === before.grid.w && scene.grid.d === before.grid.d) return memory;
  const wall = (g: string) => scene.props.find((p) => p.group === g);
  const inner = {
    w: (scene.grid.w - (wall('wall-left')?.size.w ?? 0)) * ISO_TILE_CM,
    d: (scene.grid.d - (wall('wall-back')?.size.d ?? 0)) * ISO_TILE_CM,
  };
  const { frame } = calibration.camera;
  const fit = fitRoom(
    {
      mode: memory.mode,
      marks: calibration.marks,
      room: inner,
      scene: 'custom',
      crop: calibration.crop ?? null,
    },
    frame,
    memory,
  );
  const next: DeskMemory = {
    ...memory,
    camera: {
      ...calibration,
      camera: fit.camera,
      error: fit.error,
      calibratedAt: new Date().toISOString(),
    },
  };
  const pinned =
    memory.surface?.scene === 'custom' &&
    scene.surfaces.find((s) => s.id === memory.surface!.surfaceId);
  const pin = pinned ? pinOf(fit.camera, pinned, frame) : null;
  if (pin) next.surface = { ...pin, scene: 'custom' };
  return next;
}

/** The camera behind the marks, in the scene's own tiles, walls and all. */
export function fitRoom(
  input: Omit<CalibrateInput, 'image'>,
  size: { width: number; height: number },
  memory: DeskMemory,
) {
  const room = { w: input.room.w / 30, d: input.room.d / 30 };
  const scene =
    input.scene === 'custom' ? (memory.scene ?? ISO_PRESETS.office) : ISO_PRESETS[input.scene];
  // The room's floor starts inside its walls: the scene's coordinates include them.
  const wall = (g: string) => scene.props.find((p) => p.group === g);
  const origin = { x: wall('wall-left')?.size.w ?? 0, y: wall('wall-back')?.size.d ?? 0 };
  return cameraFromMarks(input.marks, size, room, {
    origin,
    ...(input.heightCm ? { heightCm: input.heightCm } : {}),
    ...(input.heightSpreadCm ? { heightSpreadCm: input.heightSpreadCm } : {}),
    crop: input.mode === 'live' ? input.crop : null,
  });
}

/**
 * Calibrating the room's one camera. `room/floor` finds the marks and saves
 * nothing: the person drags them into place and gives the room's size, and
 * `room/calibrate` fits the camera and saves it (`calibrateRoom`).
 */
export function roomRoutes(
  app: FastifyInstance,
  { store, meta, run }: { store: EvidenceStore; meta: MetaAdapter; run: Runner },
) {
  app.post('/api/room/floor', async (request): Promise<FloorMarks> => {
    const input = parseInput(modeImageSchema, request.body);
    const live = input.mode === 'live';
    liveImage(input.mode, input.imageDataUrl);
    if (live)
      meta.mustAfford(
        2 * META_PRICES.samPerImage,
        'Finding the floor and walls',
        "Finding the floor and walls would pass today's Meta spending limit. Raise the limit, or place the marks by hand.",
      );
    const image = live ? await validateImage(input.imageDataUrl) : null;
    return findFloorMarks({ store, meta, run }, input.mode, image);
  });

  app.post('/api/room/calibrate', async (request) => {
    const input = parseInput(roomCalibrateBodySchema, request.body);
    const live = input.mode === 'live';
    liveImage(input.mode, input.imageDataUrl);
    const image = live ? await validateImage(input.imageDataUrl) : null;
    const { imageDataUrl: _, ...rest } = input;
    return calibrateRoom(store, { ...rest, image });
  });

  /**
   * The camera was taken to have moved, but its calibration still holds (a
   * false alarm, or zones about to be drawn again): the current frame becomes
   * the one later frames are compared with, and zones apply again.
   */
  app.post('/api/room/keep', async (request) => {
    const input = parseInput(modeImageSchema, request.body);
    const live = input.mode === 'live';
    liveImage(input.mode, input.imageDataUrl);
    const memory = store.memory(input.mode);
    const calibration = memory.camera;
    if (!calibration)
      throw new LabError('not_calibrated', 'Calibrate the room’s camera first.', 409);
    const image = live ? await validateImage(input.imageDataUrl) : null;
    const { frame } = calibration.camera;
    if (image)
      requireFrame(
        image,
        frame,
        `This frame is ${image.width}×${image.height}, but the camera was calibrated at ${frame.width}×${frame.height}. Calibrate it again.`,
      );
    const luma = await lumaOf(image ? image.bytes : await demoPng());
    const { moved: _, ...kept } = calibration;
    // A check blocked only by the move no longer stands.
    const stale = (d: DeskMemory['lastDecision'] | undefined) =>
      d?.output.reason === MOVED_CAMERA ? null : (d ?? null);
    store.saveMemory({
      ...memory,
      camera: { ...kept, reference: cameraEdges(luma) },
      lastDecision: stale(memory.lastDecision),
      rules: memory.rules?.map((r) => ({ ...r, lastDecision: stale(r.lastDecision) })),
    });
    return store.memory(input.mode);
  });

  app.post('/api/room/forget', async (request) => {
    const { mode } = parseInput(modeOnlySchema, request.body);
    const memory = store.memory(mode);
    store.saveMemory({ ...memory, camera: null });
    return store.memory(mode);
  });
}
