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
  fixtureModel,
  fixtureSize,
  groupBounds,
  promoteGroup,
  sightingBox,
  type DrawnThing,
  type Fixture,
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
  // Every Thing where the room has it: by hand where the room's view puts it, by its
  // sightings where the camera saw its foot touch down.
  const camera = calibration.camera;
  const hand = fixtures
    .filter((f) => f.place !== 'sightings')
    .map((f) => {
      const v = inRoomView(f);
      return {
        f,
        target: { kind: 'fixture' as const, id: f.id, label: f.label },
        box: fixtureBox(v, memory.scene),
        surfaceId: v.surfaceId,
      };
    });
  const sighted = fixtures.flatMap((f) => {
    const o = f.place === 'sightings' ? f.track?.observation : null;
    if (!o) return [];
    const foot = {
      x: ((o.box.x + o.box.width / 2) / o.frame.width) * frame.width,
      y: ((o.box.y + o.box.height) / o.frame.height) * frame.height,
    };
    const size = fixtureSize(f);
    const seen = sightingBox(
      camera,
      scene,
      hand.map((h) => h.box),
      foot,
      size,
    );
    return seen
      ? [{ f, target: { kind: 'object' as const, id: f.id, label: f.label }, ...seen }]
      : [];
  });
  const things = [...hand, ...sighted];
  const thingOf = (t: SelectionTarget | null) =>
    t && t.kind !== 'prop' ? things.find((x) => x.f.id === t.id) : undefined;
  /** What the target stands on and what stands on it. */
  const related = (target: SelectionTarget | null) => relatedTargets(scene, things, target, labels);
  /**
   * A Thing as a variant reads it: drawn as it is now when it is what stands
   * on another (the cat asleep), with its own model and size when it is what
   * gets the variant. Furniture is read as the thing it would be made
   * (`promoteGroup`), standing where it stands.
   */
  const drawn = (
    target: SelectionTarget | null,
    as: 'subject' | 'occupant',
  ): (DrawnThing & { size: Fixture['size'] }) | null => {
    if (target?.kind === 'prop') {
      const made = promoteGroup(scene, target.id);
      const b = groupBounds(scene, target.id);
      if (!made || !b) return null;
      return {
        label: made.fixture.label,
        box: { at: b.at, size: made.fixture.size },
        turns: 0,
        model: made.fixture.model,
        size: made.fixture.size,
      };
    }
    const t = thingOf(target);
    if (!t) return null;
    const state = as === 'subject' ? null : (t.f.state ?? null);
    const size = fixtureSize(t.f, state);
    const turned = t.f.turns % 2 === 1;
    return {
      label: t.f.label,
      // A sighted thing is drawn unturned where it was seen.
      box:
        as === 'occupant'
          ? t.box
          : {
              at: t.box.at,
              size: { w: turned ? size.d : size.w, d: turned ? size.w : size.d, h: size.h },
            },
      turns: t.f.place === 'sightings' ? 0 : t.f.turns,
      model: fixtureModel(t.f, state),
      size,
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
    drawn,
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
