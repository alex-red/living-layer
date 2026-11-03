import type { FastifyInstance } from 'fastify';
import {
  selectResolveBodySchema,
  ISO_PRESETS,
  fixtureBox,
  groupLabels,
  inRoomView,
  resolveSelection,
  roomLabels,
  selectionMask,
  type DeskMemory,
  type SelectResolve,
  type Segmentation,
  type Bits,
  followedThings,
  relatedTargets,
  type Occupant,
  type SelectionTarget,
} from '@livinglayer/domain';
import { LabError, NOT_CALIBRATED, parseInput, requireCalibration } from './errors.js';
import type { RouteDeps } from './route-deps.js';

/** The most candidates a resolve sends back: the review only shows a few. */
const MAX_CANDIDATES = 5;

/** Tracked objects with a sighting on frames of this size, by their last box. */
function trackedObjects(memory: DeskMemory, frame: Segmentation['frame']) {
  return followedThings(memory).flatMap(({ id, label, place, track: { observation: o } }) =>
    place === 'sightings' && o.frame.width === frame.width && o.frame.height === frame.height
      ? [{ id, label, box: o.box }]
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
  const calibration = requireCalibration(memory);
  const scene = calibration.scene === 'custom' ? memory.scene : ISO_PRESETS[calibration.scene];
  if (!scene) throw new LabError('not_calibrated', NOT_CALIBRATED, 409);
  const frame = { ...calibration.camera.frame };
  const fixtures = (memory.fixtures ?? []).filter((f) => f.scene === calibration.scene);
  const picture = roomLabels(
    calibration.camera,
    scene,
    // Each where the room's own view puts it, as the room picture does.
    fixtures.map((f) => ({
      id: f.id,
      box: fixtureBox(inRoomView(f), memory.scene),
    })),
  );
  const labels = groupLabels(scene);
  for (const f of fixtures) labels.set(`fixture:${f.id}`, f.label);
  const resolve = (mask: Bits) =>
    resolveSelection(mask, picture, labels, trackedObjects(memory, frame));
  const placed = fixtures.map(inRoomView);
  /** What the target stands on and what stands on it. */
  const related = (target: SelectionTarget | null) => relatedTargets(scene, placed, target, labels);
  /** A fixture as a variant draws it in: where the room's view puts it, in its model's colours. */
  const occupant = (target: SelectionTarget | null): Occupant | null => {
    const f = target?.kind === 'fixture' ? placed.find((x) => x.id === target.id) : undefined;
    if (!f) return null;
    const own = f.state ? (f.states?.[f.state]?.model ?? f.model) : f.model;
    return {
      label: f.label,
      box: fixtureBox(f, memory.scene),
      // Its swatches, else its parts' colours, the largest part's first.
      colors: own.swatches.length
        ? own.swatches.map((x) => x.hex)
        : [
            ...new Set(
              own.parts
                .toSorted((a, b) => b.size.w * b.size.d * b.size.h - a.size.w * a.size.d * a.size.h)
                .map((p) => p.color),
            ),
          ],
    };
  };
  return {
    calibration,
    camera: calibration.camera,
    scene,
    frame,
    picture,
    resolve,
    related,
    occupant,
  };
}

/**
 * What a selection on the camera's picture points at
 * ([plan](../../../docs/plans/ai-brush.md#1-selection)): a template group of
 * the room, a fixture or a tracked object, or nothing the room has yet. Read
 * through the calibrated camera with no model call, so it is free; SAM's
 * outline sharpens it when the AI brush runs (`/api/assist`).
 */
export async function selectRoutes(app: FastifyInstance, { store }: Pick<RouteDeps, 'store'>) {
  app.post('/resolve', async (request): Promise<SelectResolve> => {
    const input = parseInput(selectResolveBodySchema, request.body);
    const room = selectionRoom(store.memory(input.mode));
    const resolved = room.resolve(selectionMask(input.shape, room.frame));
    const target = resolved.target;
    return {
      ...resolved,
      related: room.related(target),
      candidates: resolved.candidates.slice(0, MAX_CANDIDATES),
      frame: room.frame,
      hasModel:
        target?.kind === 'prop' && room.scene.props.some((p) => p.group === target.id && p.recipe),
    };
  });
}
