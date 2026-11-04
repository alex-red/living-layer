import {
  calibrationOf,
  dayOf,
  fixtureProblem,
  fixturesPromoteBodySchema,
  groupBounds,
  projectRoom,
  promoteBuiltIn,
  promoteGroup,
  runOutput,
  type DeskMemory,
  type FixtureInput,
  type IsoBox,
  type PhotoDraft,
  type RoomCamera,
} from '@livinglayer/domain';
import { LabError } from '../errors.js';
import type { EvidenceStore } from '../store.js';
import type { RouteDeps } from '../route-deps.js';
import { saveFixture } from './save.js';
import type { Parsed } from './shared.js';

/** Under this overlap with its SAM box, a draft's crop is of something else. */
const CROP_IOU = 0.2;

/**
 * The room draft's crop of a thing of the room: of the draft things named
 * like it (the same template, or what it is: its label's last word against
 * the draft thing's id or its label's last word), the one whose SAM box
 * overlaps its box seen through the room's camera most. Its group need not
 * keep the draft's id (`monitor-2` for `monitor`), and it may have been moved
 * a little since; a shelf behind a cat tower overlaps it but isn't named so,
 * nor is a black and white coaster under a white mug.
 */
export function draftCropOf(
  draft: PhotoDraft,
  camera: RoomCamera,
  box: IsoBox,
  name: { label: string; template?: string | undefined },
): string | null {
  const words = (text: string) => text.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  // What a thing is, not what it looks like: "white" names a colour, "mug" the thing.
  const own = words(name.label).at(-1);
  const named = (thingId: string) => {
    const t = draft.inventory.things.find((x) => x.id === thingId);
    if (!t) return false;
    if (name.template && t.as === name.template) return true;
    return Boolean(own) && [...words(t.id), words(t.label).at(-1)].includes(own);
  };
  const seen = [0, 1].flatMap((u) =>
    [0, 1].flatMap((v) =>
      [0, 1].flatMap((t) => {
        const p = projectRoom(camera, {
          x: box.at.x + u * box.size.w,
          y: box.at.y + v * box.size.d,
          z: box.at.z + t * box.size.h,
        });
        return p ? [p] : [];
      }),
    ),
  );
  if (!seen.length) return null;
  // SAM's boxes are in its frame's pixels; the camera's frame may be another size.
  const sx = draft.segmentation.frame.width / camera.frame.width;
  const sy = draft.segmentation.frame.height / camera.frame.height;
  const x0 = Math.min(...seen.map((p) => p.x)) * sx;
  const y0 = Math.min(...seen.map((p) => p.y)) * sy;
  const x1 = Math.max(...seen.map((p) => p.x)) * sx;
  const y1 = Math.max(...seen.map((p) => p.y)) * sy;
  let best: { asset: string; iou: number } | null = null;
  for (const [thingId, asset] of Object.entries(draft.crops)) {
    const d = draft.segmentation.detections.find((x) => x.objectId === draft.detections[thingId]);
    if (!d || !named(thingId)) continue;
    const w = Math.min(x1, d.box.x + d.box.width) - Math.max(x0, d.box.x);
    const h = Math.min(y1, d.box.y + d.box.height) - Math.max(y0, d.box.y);
    const both = Math.max(0, w) * Math.max(0, h);
    const iou = both / ((x1 - x0) * (y1 - y0) + d.box.width * d.box.height - both);
    if (iou >= CROP_IOU && iou > (best?.iou ?? 0)) best = { asset, iou };
  }
  return best?.asset ?? null;
}

/** The picture a group of the person's own room is modelled from: the room draft's crop of it. */
function draftReference(
  store: EvidenceStore,
  memory: DeskMemory,
  group: string,
): FixtureInput['reference'] {
  const runId = memory.scenePhoto?.split('/')[0];
  const draft = runId ? runOutput(store.getRun(runId), 'photo') : undefined;
  const camera = calibrationOf(memory)?.camera;
  const box = memory.scene && groupBounds(memory.scene, group);
  const head =
    memory.scene?.props.find((p) => p.id === group) ??
    memory.scene?.props.find((p) => p.group === group);
  const asset =
    draft && camera && box && head
      ? draftCropOf(draft, camera, box, { label: head.label, template: head.template })
      : null;
  return runId && asset ? { runId, asset } : null;
}

/**
 * A thing drawn with the room made a thing of its own, as _Make it a thing_
 * does: a preset's built-in one stands in for it (`promoteBuiltIn`), one of
 * the person's own layout leaves it (`promoteGroup`) and is pictured by the
 * room draft's crop of it, so it can be modelled with AI next.
 */
export async function promoteFixture(
  { store, entities }: Pick<RouteDeps, 'store' | 'entities'>,
  { mode, scene: kind, group }: Parsed<typeof fixturesPromoteBodySchema>,
) {
  const memory = store.memory(mode);
  const own = kind === 'custom';
  if (!own && memory.fixtures?.some((f) => f.scene === kind && f.builtIn === group))
    throw new LabError('fixture_promote', 'That is a thing of its own already.', 409);
  const made = own
    ? memory.scene && promoteGroup(memory.scene, group)
    : { scene: null, fixture: promoteBuiltIn(kind, group, dayOf(Date.now())) };
  if (!made?.fixture)
    throw new LabError('fixture_promote', 'That thing has nothing to draw as a thing.', 422);
  const reference = own ? draftReference(store, memory, group) : null;
  const fixture = { ...made.fixture, reference };
  const problem = fixtureProblem(fixture, made.scene ?? memory.scene);
  if (problem) throw new LabError('fixture_place', problem, 400);
  // The layout lets go of it first, so a failure never leaves it twice.
  if (made.scene) store.updateMemory(mode, (m) => void (m.scene = made.scene));
  const saved = await saveFixture({ store, entities }, { mode, fixture });
  return { memory: saved, fixtureId: saved.fixtures!.at(-1)!.id, pictured: Boolean(reference) };
}
