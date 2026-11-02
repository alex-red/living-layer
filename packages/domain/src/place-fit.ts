import type { IsoScene } from './iso.js';
import { groupBounds, moveGroup, ridersOf, rotateGroup, settleGroup } from './iso-templates.js';
import type { Bits } from './photo-scene.js';
import { projectRoom, type RoomCamera } from './room-camera.js';
import { floorSolid, renderRoom, sceneSolids } from './room-render.js';

/**
 * Where a thing really stands, from its outline in the room camera's frame:
 * its group is moved, and turned half way round, over a shrinking grid of
 * places near where it stands. Each place is drawn through the camera behind
 * whatever else the room has in front of it, and the place whose drawing
 * best matches the outline is kept. Its size isn't searched: the catalog or
 * the template knows it better than an outline can. What stands on it stays
 * where it is in the room and settles onto whatever is under it then.
 */
export interface GroupFit {
  /** The scene with the group where it fits best. */
  scene: IsoScene;
  /** Its drawing against the outline (IoU), where it stood and where it fits. */
  from: number;
  iou: number;
  /** How far its footprint's middle moved, in tiles, and whether it was turned half way round. */
  moved: { x: number; y: number };
  turned: boolean;
  /** Places drawn. */
  tried: number;
}
/** A fit is used only when its drawing matches at least this well, and by this much more than before. */
export const FIT_KEEP = { iou: 0.45, gain: 0.05 } as const;
/** How much better a half turn must match to be taken over the turn it has. */
const TURN_MARGIN = 0.02;

export function fitGroup(
  camera: RoomCamera,
  scene: IsoScene,
  g: string,
  outline: Bits,
  { reach = 2, halfTurn = true }: { reach?: number; halfTurn?: boolean } = {},
): GroupFit | null {
  const own = scene.props.filter((p) => p.group === g);
  const b0 = groupBounds(scene, g);
  if (!own.length || !b0) return null;
  const others = scene.props.filter((p) => p.group !== g);
  const rest = renderRoom(
    camera,
    [floorSolid(scene.grid), ...sceneSolids({ ...scene, props: others })],
    { labels: true },
  );
  // The group alone, so moving and turning it leaves what stands on it behind.
  const alone: IsoScene = {
    ...scene,
    props: own,
    surfaces: scene.surfaces.filter((s) => own.some((p) => p.id === s.propId)),
  };
  let wanted = 0;
  for (let i = 0; i < outline.data.length; i++) wanted += outline.data[i]!;
  const placed = (dx: number, dy: number, turned: boolean) => {
    const s = turned ? rotateGroup(rotateGroup(alone, g), g) : alone;
    return moveGroup(s, g, dx, dy);
  };
  const score = (s: IsoScene) => {
    const pic = renderRoom(camera, sceneSolids(s), { labels: true });
    let both = 0;
    let drawn = 0;
    for (let i = 0; i < pic.ids.length; i++) {
      // Hidden where something else stands nearer, as in the photo.
      if (pic.ids[i]! < 0 || pic.depth[i]! > rest.depth[i]! + 1e-4) continue;
      drawn++;
      both += outline.data[i]!;
    }
    return both / Math.max(1, drawn + wanted - both);
  };
  const from = score(alone);
  let tried = 1;
  // Each way round on its own: a coarse grid over the whole reach, then finer around its best.
  const search = (turned: boolean) => {
    let best = { dx: 0, dy: 0, turned, iou: turned ? -1 : from };
    const at = (dx: number, dy: number) => {
      if (Math.hypot(dx, dy) > reach + 1e-9) return;
      tried++;
      const iou = score(placed(dx, dy, turned));
      if (iou > best.iou + 1e-9) best = { dx, dy, turned, iou };
    };
    for (let i = -4; i <= 4; i++)
      for (let j = -4; j <= 4; j++) if (i || j || turned) at((i * reach) / 4, (j * reach) / 4);
    for (const step of [reach / 8, reach / 20, reach / 40]) {
      const c = best;
      for (let i = -2; i <= 2; i++)
        for (let j = -2; j <= 2; j++) if (i || j) at(c.dx + i * step, c.dy + j * step);
    }
    return best;
  };
  const kept = search(false);
  const other = halfTurn ? search(true) : null;
  // A thing that looks the same either way round keeps its turn.
  const best = other && other.iou > kept.iou + TURN_MARGIN ? other : kept;
  const moved = placed(best.dx, best.dy, best.turned);
  const b1 = groupBounds(moved, g)!;
  let out: IsoScene = {
    ...scene,
    props: [...others, ...moved.props],
    surfaces: [
      ...scene.surfaces.filter((s) => !own.some((p) => p.id === s.propId)),
      ...moved.surfaces,
    ],
  };
  for (const r of ridersOf(scene, g)) out = settleGroup(out, r);
  return {
    scene: out,
    from,
    iou: best.iou,
    moved: {
      x: b1.at.x + b1.size.w / 2 - (b0.at.x + b0.size.w / 2),
      y: b1.at.y + b1.size.d / 2 - (b0.at.y + b0.size.d / 2),
    },
    turned: best.turned,
    tried,
  };
}
/** Whether a fit is good enough, and enough better, to use. */
export const fitKept = (f: Pick<GroupFit, 'from' | 'iou'>) =>
  f.iou >= FIT_KEEP.iou && f.iou - f.from >= FIT_KEEP.gain;

/** What `POST /api/scene/fit` answers: the scene with the group where the camera sees it, or as it was. */
export interface SceneFit {
  scene: IsoScene;
  /** IoU against SAM's outline before and after, how far it moved and whether it turned round; `kept` when it was moved. */
  fit: {
    from: number;
    iou: number;
    movedCm: { x: number; y: number };
    turned: boolean;
    kept: boolean;
  };
  runId: string;
}

/**
 * Where a group's box falls in the camera's frame, in whole pixels (as SAM's
 * box prompts take them): the box of its eight corners' drawing, grown by
 * `grow` of its size each way, rounded outwards and cut to the frame. Null
 * when the camera doesn't see all of it, or it is under 4 pixels.
 */
export function groupInFrame(
  camera: RoomCamera,
  scene: IsoScene,
  g: string,
  grow = 0,
): { left: number; top: number; right: number; bottom: number } | null {
  const b = groupBounds(scene, g);
  if (!b) return null;
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
  if (seen.length < corners.length) return null;
  const xs = seen.map((c) => c.x);
  const ys = seen.map((c) => c.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const { width, height } = camera.frame;
  const box = {
    left: Math.max(0, Math.floor(x0 - (x1 - x0) * grow)),
    top: Math.max(0, Math.floor(y0 - (y1 - y0) * grow)),
    right: Math.min(width, Math.ceil(x1 + (x1 - x0) * grow)),
    bottom: Math.min(height, Math.ceil(y1 + (y1 - y0) * grow)),
  };
  return box.right - box.left < 4 || box.bottom - box.top < 4 ? null : box;
}
