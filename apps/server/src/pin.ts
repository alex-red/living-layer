import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ISO_PRESETS,
  calibrationOf,
  pinOf,
  modeSchema,
  type EvidenceRun,
  type Quad,
  type Segmentation,
} from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import { NOT_CALIBRATED } from './photo.js';
import type { EvidenceStore } from './store.js';

export interface AutoPin {
  /** Always null: the calibrated camera places the surface, with no SAM call. */
  run: EvidenceRun<Segmentation> | null;
  /** Corners in frame pixels, clockwise from the back left, or null when the camera can't see it. */
  pin: { corners: Quad; iou: number; frame: Segmentation['frame'] } | null;
}

/**
 * Pin a surface of the room by itself: it is where the room's calibrated
 * camera sees its top, so no call is made. With no surface named, the
 * room's biggest desk or table. Nothing is saved: the person checks the
 * corners and saves them through `desk/surface` like a hand-made pin.
 */
export function pinRoutes(app: FastifyInstance, { store }: { store: EvidenceStore }) {
  app.post('/api/desk/auto-pin', async (request): Promise<AutoPin> => {
    const input = parseInput(
      z
        .object({
          mode: modeSchema,
          imageDataUrl: z.string().max(7_000_000).optional(),
          surfaceId: z.string().min(1).max(40).optional(),
        })
        .strict(),
      request.body,
    );
    if (input.mode !== 'live' && input.imageDataUrl)
      throw new LabError('demo_image', 'Demo mode uses only the demo room’s camera.');
    const memory = store.memory(input.mode);
    const calibration = calibrationOf(memory);
    if (!calibration) throw new LabError('not_calibrated', NOT_CALIBRATED, 409);
    const scene = calibration.scene === 'custom' ? memory.scene : ISO_PRESETS[calibration.scene];
    const surfaces = scene?.surfaces ?? [];
    const surface = input.surfaceId
      ? surfaces.find((s) => s.id === input.surfaceId)
      : surfaces
          .filter((s) => /desk|table/i.test(`${s.id} ${s.label}`))
          .sort((a, b) => b.rect.w * b.rect.d - a.rect.w * a.rect.d)[0];
    const pin = surface ? pinOf(calibration.camera, surface, calibration.camera.frame) : null;
    return { run: null, pin: pin && { corners: pin.corners, iou: 1, frame: pin.frame } };
  });
}
