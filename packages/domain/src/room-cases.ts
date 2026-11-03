import type { IsoScene } from './iso.js';
import { ISO_PRESETS } from './iso-presets.js';
import {
  PROP_TEMPLATES,
  groupBounds,
  moveGroup,
  placeTemplate,
  rotateGroup,
  type TemplateId,
} from './iso-templates.js';
import type { Segmentation } from './api.js';
import type { RoomCalibration } from './memory.js';
import {
  PHOTO_SURFACES,
  detectionFromBits,
  type PhotoInventory,
  type PhotoLayout,
  type PlacedThing,
  type PhotoThing,
} from './photo-scene.js';
import {
  cameraFromMarks,
  cornerCamera,
  cropCamera,
  marksOf,
  type RoomCamera,
} from './room-camera.js';
import type { CameraCrop } from './camera.js';
import { floorSolid, renderRoom, sceneSolids } from './room-render.js';
import { ISO_TILE_CM, cm } from './iso-furniture.js';
import { layoutRoom } from './room-scan.js';

// --- Known rooms, for tests and the benchmark ---------------------------------

/**
 * What a room scan should reach, shared by the room bench and the tests:
 * every thing within this many tiles of where it really stands, furniture at
 * its true turn (a symmetric thing at either of its two), measured furniture
 * within this many tiles of its true width and depth.
 */
export const ROOM_TARGETS = { position: 0.3, size: 0.4 } as const;

/** A room seen by its corner camera, outlined the way SAM would, with where everything really is. */
export function roomCase(
  scene: IsoScene,
  camera: RoomCamera,
  guess: Record<string, Partial<PhotoThing['sizeCm']>> = {},
) {
  const picture = renderRoom(camera, [{ ...floorOf(scene), id: 'floor' }, ...sceneSolids(scene)]);
  const groups = [...new Set(scene.props.map((p) => p.group))].filter(
    (g) => !g.startsWith('wall') && picture.names.includes(g),
  );
  const main = (g: string) =>
    scene.props.find((p) => p.group === g && p.id === g) ?? scene.props.find((p) => p.group === g)!;
  const detections: Segmentation['detections'] = [];
  const ids: Record<string, string> = {};
  const things: PlacedThing[] = [];
  const truth: Record<string, { x: number; y: number; w: number; d: number; turns: number }> = {};
  for (const g of groups) {
    const bits = {
      width: picture.width,
      height: picture.height,
      data: new Uint8Array(picture.width * picture.height),
    };
    const k = picture.names.indexOf(g);
    for (let i = 0; i < bits.data.length; i++) if (picture.ids[i] === k) bits.data[i] = 1;
    const d = detectionFromBits(String(detections.length + 1), bits);
    if (!d) continue;
    detections.push(d);
    ids[g] = d.objectId;
    const p = main(g);
    const template = p.template as TemplateId;
    const b = groupBounds(scene, g)!;
    truth[g] = {
      x: b.at.x + b.size.w / 2,
      y: b.at.y + b.size.d / 2,
      w: b.size.w,
      d: b.size.d,
      turns: p.turns ?? 0,
    };
    // What it stands on is under its lowest part: a lamp's shade is higher than its stand.
    const z0 = Math.min(...scene.props.filter((q) => q.group === g).map((q) => q.at.z));
    const under =
      z0 > 0
        ? scene.surfaces.find(
            (s) =>
              Math.abs(s.z - z0) < 0.05 &&
              s.rect.x <= truth[g]!.x &&
              truth[g]!.x <= s.rect.x + s.rect.w &&
              s.rect.y <= truth[g]!.y &&
              truth[g]!.y <= s.rect.y + s.rect.d,
          )
        : undefined;
    const on = under ? scene.props.find((q) => q.id === under.propId)!.group : 'floor';
    // Its real size, as Spark would estimate it: before turning, and how tall.
    const own = truth[g]!.turns % 2 ? { w: b.size.d, d: b.size.w } : b.size;
    const z1 = Math.max(...scene.props.filter((q) => q.group === g).map((q) => q.at.z + q.size.h));
    things.push({
      id: g,
      label: PROP_TEMPLATES[template].label.toLowerCase(),
      as: template,
      role:
        z0 > 0
          ? 'object'
          : (PHOTO_SURFACES as readonly string[]).includes(template)
            ? 'surface'
            : 'furniture',
      on,
      box: { x1: 0, y1: 0, x2: 1000, y2: 1000 },
      sizeCm: {
        w: own.w * ISO_TILE_CM,
        d: own.d * ISO_TILE_CM,
        h: (z1 - z0) * ISO_TILE_CM,
        ...guess[g],
      },
      color: '#888888',
      material: 'matte',
      detectionId: d.objectId,
      status: 'placed',
    });
  }
  return {
    inventory: { kind: 'desk', things, summary: 'A rendered room.' } as PhotoInventory,
    segmentation: { concept: 'room scan', frame: { ...camera.frame }, detections } as Segmentation,
    detections: ids,
    truth,
  };
}
const floorOf = (scene: IsoScene) => floorSolid(scene.grid);

/** One thing of a scene built by `sceneOf`. */
interface ScenePiece {
  template: TemplateId;
  /** Where its footprint's corner nearest the origin lands, once turned. */
  x: number;
  y: number;
  /** Its group; the template's name by default, or that with -2, -3… when taken. */
  id?: string;
  turns?: number;
  /** Its size before turning, in tiles; the template's by default. */
  size?: { w: number; d: number; h?: number };
  /** The group whose top it stands on; the floor by default. */
  on?: string;
}
/**
 * A room of templates, each turned and then moved so that its footprint's
 * corner nearest the origin is at (x, y): turning a group about its centre
 * moves that corner, so placing then turning puts an oblong thing elsewhere.
 */
export function sceneOf(
  pieces: ScenePiece[],
  { grid = { w: 12, d: 10 }, label = 'Room' }: { grid?: IsoScene['grid']; label?: string } = {},
): IsoScene {
  let scene: IsoScene = { kind: 'custom', label, grid, props: [], surfaces: [] };
  for (const p of pieces) {
    let g = p.id ?? p.template;
    for (let k = 2; !p.id && scene.props.some((q) => q.group === g); k++) g = `${p.template}-${k}`;
    const z = p.on
      ? Math.max(
          ...scene.surfaces
            .filter((s) => scene.props.some((q) => q.id === s.propId && q.group === p.on))
            .map((s) => s.z),
        )
      : 0;
    const built = placeTemplate(p.template, g, p.x, p.y, z, p.size ? { size: p.size } : {});
    scene = {
      ...scene,
      props: [...scene.props, ...built.props],
      surfaces: [...scene.surfaces, ...built.surfaces],
    };
    for (let k = 0; k < (p.turns ?? 0); k++) scene = rotateGroup(scene, g);
    const b = groupBounds(scene, g)!;
    scene = moveGroup(scene, g, p.x - b.at.x, p.y - b.at.y);
  }
  return scene;
}

/** A small living room: a table and two chairs, a bookcase and a plant. */
const LOUNGE = sceneOf(
  [
    { template: 'wall', id: 'wall-back', x: 0, y: 0 },
    { template: 'table', x: 4, y: 3.5 },
    // Both chairs face the table.
    { template: 'chair', x: 3.5, y: 6.5 },
    { template: 'chair', x: 6.5, y: 1.2, turns: 2 },
    { template: 'shelf', x: 8.5, y: 0.3 },
    { template: 'plant', x: 0.6, y: 7.5 },
  ],
  { label: 'Lounge' },
);

/**
 * A 140 cm desk along the left wall, its far end to a bookcase in the back
 * corner, as a live draft saw one; `hidden` puts a low cabinet in front of
 * its near end, hiding its feet.
 */
const deskByShelf = (hidden = false) =>
  sceneOf(
    [
      { template: 'wall', id: 'wall-back', x: 0, y: 0 },
      { template: 'wall', id: 'wall-left', x: 0, y: 0.2, turns: 1 },
      { template: 'shelf', x: 0.2, y: 0.2, turns: 3 },
      { template: 'desk', x: 0.2, y: 0.2 + cm(80), turns: 3, size: { w: cm(140), d: 2.5 } },
      ...(hidden
        ? [
            {
              template: 'cabinet',
              x: 2.8,
              y: 6.6,
              turns: 2,
              size: { w: cm(60), d: cm(40), h: cm(60) },
            } as const,
          ]
        : []),
    ],
    { label: 'Study' },
  );

/** The rooms a scan is judged on against `ROOM_TARGETS`, by the room bench and the tests alike. */
export const ROOM_CASES: ({
  name: string;
  scene: () => IsoScene;
  camera: (s: IsoScene) => RoomCamera;
} & ScanOptions)[] = [
  { name: 'office', scene: () => ISO_PRESETS.office, camera: (s) => cornerCamera(s.grid) },
  {
    name: 'office, low and wide',
    scene: () => ISO_PRESETS.office,
    camera: (s) => cornerCamera(s.grid, { heightCm: 210, hfovDeg: 105 }),
  },
  {
    name: 'office, high and narrow',
    scene: () => ISO_PRESETS.office,
    camera: (s) => cornerCamera(s.grid, { heightCm: 270, hfovDeg: 80 }),
  },
  { name: 'lounge', scene: () => LOUNGE, camera: (s) => cornerCamera(s.grid) },
  {
    // A 160 cm desk guessed at 120: what stands at its far end says how long it is.
    name: 'office, desk guessed short',
    scene: () => ISO_PRESETS.office,
    camera: (s) => cornerCamera(s.grid),
    guess: { desk: { w: 120 } },
  },
  {
    // Zoomed so the frame's bottom edge cuts the desk's near end off: it keeps its length.
    name: 'desk cut off by the frame',
    scene: () => deskByShelf(),
    camera: (s) => cornerCamera(s.grid),
    crop: { x: 0.15, y: 0.05, w: 0.6, h: 0.35 },
  },
  {
    name: "desk's near end hidden",
    scene: () => deskByShelf(true),
    camera: (s) => cornerCamera(s.grid),
  },
];

const ROUND = new Set<string>(['plant', 'lamp', 'bottle', 'jar']);
const HALF = new Set<string>(['desk', 'table', 'rug']);
/** How a scan of a case turned out against where everything really is. */
function judgeRoom(layout: PhotoLayout, truth: ReturnType<typeof roomCase>['truth']) {
  let worst = 0;
  let who = '';
  let wrongTurns = 0;
  let size = 0;
  for (const t of layout.things) {
    const at = truth[t.id];
    if (!at) continue;
    let x: number;
    let y: number;
    if (t.status === 'object' && t.foot) {
      x = t.foot.at.x + t.foot.size.w / 2;
      y = t.foot.at.y + t.foot.size.d / 2;
    } else if (t.group) {
      const b = groupBounds(layout.scene, t.group)!;
      x = b.at.x + b.size.w / 2;
      y = b.at.y + b.size.d / 2;
      const turns =
        layout.scene.props.find((p) => p.group === t.group && p.id === t.group)?.turns ?? 0;
      // A round thing looks the same at any turn. A desk or table is measured, so a
      // quarter turn with its sides swapped is the same table: its footprint is judged.
      if (!ROUND.has(t.as) && !HALF.has(t.as) && turns !== at.turns) wrongTurns++;
      if (t.role !== 'object')
        size = Math.max(size, Math.abs(b.size.w - at.w), Math.abs(b.size.d - at.d));
    } else {
      worst = Infinity;
      who = t.id;
      continue;
    }
    const e = Math.hypot(x - at.x, y - at.y);
    if (e > worst) [worst, who] = [e, t.id];
  }
  return { worst, who, wrongTurns, size };
}

interface ScanOptions {
  /** Sizes Spark gets wrong, by group, in centimetres. */
  guess?: Record<string, Partial<PhotoThing['sizeCm']>>;
  /**
   * The camera's zoomed view, so the frame's edges can cut things off. Not a
   * narrower lens: at 60° or less `cameraFromMarks` fits the marks to a tenth
   * of a pixel with the wrong camera.
   */
  crop?: CameraCrop;
}
/**
 * A room scanned the way a person's would be: seen through `camera` (zoomed
 * by `crop`), outlined, the camera calibrated from the room's floor marks
 * rather than handed over, and laid out. With each thing's box as drawn, and
 * how it did against where everything really is.
 */
export function scanCase(scene: IsoScene, camera: RoomCamera, { guess, crop }: ScanOptions = {}) {
  const seen = crop ? cropCamera(camera, crop) : camera;
  const s = roomCase(scene, seen, guess);
  const marks = marksOf(seen);
  const fit = cameraFromMarks(marks, seen.frame, seen.room, crop ? { crop } : {});
  const calibration: RoomCalibration = {
    camera: fit.camera,
    marks,
    scene: 'custom',
    error: fit.error,
    calibratedAt: new Date(0).toISOString(),
    ...(crop ? { crop } : {}),
  };
  const start = performance.now();
  const layout = layoutRoom({ ...s, calibration });
  const ms = performance.now() - start;
  const boxes = Object.fromEntries(
    layout.things.flatMap((t) => {
      const b = t.group && groupBounds(layout.scene, t.group);
      return b ? [[t.id, b] as const] : [];
    }),
  );
  return { ...s, calibration, layout, boxes, judged: judgeRoom(layout, s.truth), ms };
}
