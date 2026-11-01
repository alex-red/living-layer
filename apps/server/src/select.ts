import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ISO_PRESETS,
  calibrationOf,
  fixtureBox,
  groupLabels,
  inRoomView,
  modeSchema,
  resolveSelection,
  roomLabels,
  selectionMask,
  selectionShapeSchema,
  type DeskMemory,
  type SelectResolve,
  type Segmentation,
  type Bits,
} from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import { NOT_CALIBRATED } from './photo.js';
import type { EvidenceStore } from './store.js';

/** The most candidates a resolve sends back: the review only shows a few. */
const MAX_CANDIDATES = 5;

/** Tracked objects with a sighting on frames of this size, by their last box. */
function trackedObjects(memory: DeskMemory, frame: Segmentation['frame']) {
  const all = [
    ...(memory.object ? [{ ...memory.object, observation: memory.observation }] : []),
    ...(memory.others ?? []),
  ];
  return all.flatMap((o) =>
    o.observation &&
    o.observation.frame.width === frame.width &&
    o.observation.frame.height === frame.height
      ? [{ id: o.id, label: o.label, box: o.observation.box }]
      : [],
  );
}

/**
 * The room as the calibrated camera sees it, ready to resolve selections
 * against: its scene, its picture labelled per pixel (fixtures included),
 * the names of what is in it, and the tracked objects' last boxes. Refuses
 * with 409 `not_calibrated` when there is no camera to read through.
 */
export function selectionRoom(memory: DeskMemory) {
  const calibration = calibrationOf(memory);
  if (!calibration) throw new LabError('not_calibrated', NOT_CALIBRATED, 409);
  const scene = calibration.scene === 'custom' ? memory.scene : ISO_PRESETS[calibration.scene];
  if (!scene) throw new LabError('not_calibrated', NOT_CALIBRATED, 409);
  const frame = { ...calibration.camera.frame };
  const fixtures = (memory.fixtures ?? []).filter((f) => f.scene === calibration.scene);
  const picture = roomLabels(
    calibration.camera,
    scene,
    // Each where the room's own view puts it, as the room picture does.
    fixtures.map((f) => ({ id: f.id, box: fixtureBox(inRoomView(f), memory.scene) })),
  );
  const labels = groupLabels(scene);
  for (const f of fixtures) labels.set(`fixture:${f.id}`, f.label);
  const resolve = (mask: Bits) =>
    resolveSelection(mask, picture, labels, trackedObjects(memory, frame));
  return { calibration, camera: calibration.camera, scene, frame, picture, resolve };
}

/**
 * What a selection on the camera's picture points at
 * ([plan](../../../docs/plans/ai-brush.md#1-selection)): a template group of
 * the room, a fixture or a tracked object, or nothing the room has yet. Read
 * through the calibrated camera with no model call, so it is free; SAM's
 * outline sharpens it when the AI brush runs (`/api/assist`).
 */
export function selectRoutes(app: FastifyInstance, { store }: { store: EvidenceStore }) {
  app.post('/api/select/resolve', async (request): Promise<SelectResolve> => {
    const input = parseInput(
      z.object({ mode: modeSchema, shape: selectionShapeSchema }).strict(),
      request.body,
    );
    const room = selectionRoom(store.memory(input.mode));
    const resolved = room.resolve(selectionMask(input.shape, room.frame));
    return {
      ...resolved,
      candidates: resolved.candidates.slice(0, MAX_CANDIDATES),
      frame: room.frame,
    };
  });
}
