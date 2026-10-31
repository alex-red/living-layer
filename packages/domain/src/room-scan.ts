import type { IsoScene, Quad, SurfacePin } from './iso.js';
import { ISO_PRESETS } from './iso-presets.js';
import {
  PROP_TEMPLATES,
  freshGroupId,
  groupBounds,
  placeTemplate,
  rotateGroup,
  settleGroup,
  type TemplateId,
} from './iso-templates.js';
import type { RoomCalibration, Segmentation } from './index.js';
import {
  PHOTO_SURFACES,
  detectionFromBits,
  maskBits,
  type Bits,
  type PhotoInventory,
  type LayoutInput,
  type PhotoAs,
  type PhotoLayout,
  type PlacedThing,
} from './photo-scene.js';
import { cornerCamera, projectRoom, unprojectRoom, type RoomCamera } from './room-camera.js';
import { floorSolid, renderRoom, sceneSolids } from './room-render.js';

/**
 * A room's things laid out from one frame of its calibrated camera. The
 * camera is known, so nothing is guessed from a surface: furniture stands
 * where its drawing, through that camera, best matches its mask, at whichever
 * of its four turns matches best; a thing on a surface stands where its mask
 * meets that surface's top. Nothing from the photo is pasted onto the room.
 */
export interface RoomLayoutInput extends Pick<
  LayoutInput,
  'inventory' | 'segmentation' | 'detections' | 'edits'
> {
  calibration: RoomCalibration;
}

/** Mask pixels at the working scale, at most this many across. */
const WORK_WIDTH = 240;
/** Under this many working pixels a thing is too small to place by its drawing. */
const SMALL = 60;
const isTemplate = (as: string): as is TemplateId => as in PROP_TEMPLATES;

/** The camera for a frame scaled by `s`. */
const scaled = (c: RoomCamera, s: number): RoomCamera => ({
  ...c,
  f: c.f * s,
  cx: c.cx * s,
  cy: c.cy * s,
  frame: { width: Math.round(c.frame.width * s), height: Math.round(c.frame.height * s) },
});

/**
 * A template standing centred on (cx, cy) at height z, turned `turns` quarter
 * turns, `size` across x and y once turned.
 */
function standing(
  id: TemplateId,
  g: string,
  cx: number,
  cy: number,
  z: number,
  turns: number,
  size: { w: number; d: number } = PROP_TEMPLATES[id].size,
) {
  // Turned a quarter, its width runs along y: build it so that it ends up `size` as placed.
  const { w, d } = turns % 2 ? { w: size.d, d: size.w } : size;
  let scene: IsoScene = {
    kind: 'custom',
    label: 'probe',
    grid: { w: 64, d: 64 },
    ...placeTemplate(id, g, 32 + cx - w / 2, 32 + cy - d / 2, z, { size: { w, d } }),
  };
  for (let k = 0; k < turns; k++) scene = rotateGroup(scene, g);
  const back = (x: number) => x - 32;
  return {
    props: scene.props.map((p) => ({ ...p, at: { ...p.at, x: back(p.at.x), y: back(p.at.y) } })),
    surfaces: scene.surfaces.map((s) => ({
      ...s,
      rect: { ...s.rect, x: back(s.rect.x), y: back(s.rect.y) },
    })),
  };
}

/** Where a template's drawing covers the frame. */
function drawn(camera: RoomCamera, built: ReturnType<typeof standing>): Bits {
  const probe: IsoScene = { kind: 'custom', label: 'probe', grid: { w: 1, d: 1 }, ...built };
  const picture = renderRoom(camera, sceneSolids(probe), { labels: true });
  const data = new Uint8Array(picture.width * picture.height);
  for (let i = 0; i < data.length; i++) data[i] = picture.ids[i]! >= 0 ? 1 : 0;
  return { width: picture.width, height: picture.height, data };
}

/** How well a drawing matches a mask, ignoring pixels another thing's mask may hide. */
function match(drawing: Bits, mask: Bits, hidden: Uint8Array): number {
  let and = 0;
  let or = 0;
  for (let i = 0; i < mask.data.length; i++) {
    const m = mask.data[i]!;
    const d = drawing.data[i]!;
    if (!m && d && hidden[i]) continue;
    and += m & d;
    or += m | d;
  }
  return or ? and / or : 0;
}

/** Where a mask meets a plane at height z: the middle of its lowest pixels, in the room. */
function footOf(camera: RoomCamera, mask: Bits, z: number, lowestOnly = false) {
  const bottoms: { x: number; y: number }[] = [];
  for (let x = 0; x < mask.width; x++) {
    for (let y = mask.height - 1; y >= 0; y--)
      if (mask.data[y * mask.width + x]) {
        bottoms.push({ x, y });
        break;
      }
  }
  if (!bottoms.length) return null;
  // For a small thing, only columns that reach near the lowest point: at a tall thing's
  // sides the lowest pixel of a column is up its slanted outline, not on what it stands on.
  const lowest = Math.max(...bottoms.map((b) => b.y));
  const reach = lowestOnly ? Math.max(2, 0.3 * bottoms.length) : Infinity;
  const points = bottoms
    .filter((b) => b.y >= lowest - reach)
    .flatMap((b) => unprojectRoom(camera, { x: b.x + 0.5, y: b.y + 1 }, z) ?? []);
  if (!points.length) return null;
  const mid = (vs: number[]) => vs.sort((a, b) => a - b)[Math.floor(vs.length / 2)]!;
  return { x: mid(points.map((p) => p.x)), y: mid(points.map((p) => p.y)), points };
}

export function layoutRoom(input: RoomLayoutInput): PhotoLayout {
  const { inventory, segmentation, calibration } = input;
  const camera = calibration.camera;
  const frame = segmentation.frame;
  if (frame.width !== camera.frame.width || frame.height !== camera.frame.height)
    throw new Error('The frame is not the calibrated camera’s.');
  const edits = input.edits ?? {};
  const byId = new Map(segmentation.detections.map((d) => [d.objectId, d]));
  const things: PlacedThing[] = inventory.things.map((t) => {
    const as = (edits[t.id]?.as ?? t.as) as PhotoAs;
    const detectionId = input.detections[t.id] ?? null;
    const found = detectionId !== null && byId.has(detectionId);
    return {
      ...t,
      as,
      detectionId: found ? detectionId : null,
      status: edits[t.id]?.removed ? 'removed' : found ? 'placed' : 'not-found',
    };
  });
  const live = things.filter((t) => t.status === 'placed');
  const scale = Math.min(1, WORK_WIDTH / frame.width);
  const work = scaled(camera, scale);
  const masks = new Map(
    live.map((t) => [t.id, maskBits(byId.get(t.detectionId!)!, frame, scale) as Bits]),
  );
  const hiddenFor = (id: string) => {
    const hidden = new Uint8Array(work.frame.width * work.frame.height);
    for (const [other, m] of masks)
      if (other !== id) for (let i = 0; i < hidden.length; i++) hidden[i]! |= m.data[i]!;
    return hidden;
  };

  const room = camera.room;
  let scene: IsoScene = {
    kind: 'custom',
    label: 'From the room camera',
    grid: { w: Math.min(16, Math.ceil(room.w)), d: Math.min(16, Math.ceil(room.d)) },
    ...(() => {
      const back = placeTemplate('wall', 'wall-back', 0, 0, 0, {
        size: { w: room.w, d: 0.2 },
        label: 'Back wall',
      });
      const left = placeTemplate('wall', 'wall-left', 0, 0.2, 0, {
        size: { w: 0.2, d: room.d - 0.2 },
        label: 'Left wall',
      });
      return {
        props: [...back.props, ...left.props],
        surfaces: [...back.surfaces, ...left.surfaces],
      };
    })(),
  };
  const inside = (x: number, y: number) =>
    x > -0.5 && y > -0.5 && x < room.w + 0.5 && y < room.d + 0.5;
  // Floor things first, so what stands on them finds their tops.
  const order = [...live].sort((a, b) => Number(a.role === 'object') - Number(b.role === 'object'));
  const groups = new Map<string, string>();
  for (const t of order) {
    const mask = masks.get(t.id)!;
    const on = t.on && t.on !== 'floor' ? groups.get(t.on) : undefined;
    const own = new Set(scene.props.filter((p) => p.group === on).map((p) => p.id));
    const top = on
      ? Math.max(0, ...scene.surfaces.filter((s) => own.has(s.propId)).map((s) => s.z))
      : 0;
    const foot = footOf(work, mask, top);
    if (!foot || !inside(foot.x, foot.y)) {
      t.status = 'unplaced';
      continue;
    }
    const pixels = mask.data.reduce((n, v) => n + v, 0);
    if (!isTemplate(t.as) || (t.role === 'object' && pixels < SMALL)) {
      // Too small to place by its drawing: it stands where its mask meets what it is on,
      // read at full size, since a mug across the room is a few working pixels.
      const full = footOf(camera, maskBits(byId.get(t.detectionId!)!, frame, 1), top, true) ?? foot;
      // Its lowest pixels are the front of its base: its middle is half its width further back.
      const xs = full.points.map((p) => p.x);
      const ys = full.points.map((p) => p.y);
      const r = Math.max(
        0.05,
        Math.min(
          0.6,
          Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2,
        ),
      );
      const away = [full.x - camera.position[0], full.y - camera.position[1]];
      const n = Math.hypot(away[0]!, away[1]!) || 1;
      foot.x = full.x + (away[0]! / n) * r;
      foot.y = full.y + (away[1]! / n) * r;
      t.status = 'object';
      t.foot = {
        at: { x: foot.x - r, y: foot.y - r, z: top },
        size: { w: 2 * r, d: 2 * r, h: 0.4 },
      };
      continue;
    }
    const id = t.as;
    const g = freshGroupId(scene, id);
    const hidden = hiddenFor(t.id);
    const { w, d } = PROP_TEMPLATES[id].size;
    // The lowest pixels are its front: its middle is half a depth further back.
    const toward = [camera.position[0] - foot.x, camera.position[1] - foot.y];
    const n = Math.hypot(toward[0]!, toward[1]!) || 1;
    const start = {
      x: foot.x - (toward[0]! / n) * Math.min(w, d) * 0.5,
      y: foot.y - (toward[1]! / n) * Math.min(w, d) * 0.5,
    };
    // Sizes are the template's own, a little either way: a desk can be 120 or 180 cm wide.
    const base = PROP_TEMPLATES[id].size;
    // Chairs and small things come in their usual sizes; desks, tables and shelves vary.
    const sizeOk = (v: number, of: number) =>
      t.role === 'surface' && v >= of * 0.6 && v <= of * 1.6;
    type Pose = { x: number; y: number; turns: number; w: number; d: number; iou: number };
    const score = (p: Omit<Pose, 'iou'>): Pose => ({
      ...p,
      iou: match(drawn(work, standing(id, g, p.x, p.y, top, p.turns, p)), mask, hidden),
    });
    // Each turn is fitted on its own: from one start, a turned drawing can match nearly
    // as well somewhere else and keep the search from the true turn.
    const descend = (from: Pose): Pose => {
      let best = from;
      const along = from.turns % 2 ? { w: base.d, d: base.w } : base;
      for (const step of [0.5, 0.25, 0.1, 0.05])
        for (let k = 0; k < 16; k++) {
          const { x, y, turns, w, d } = best;
          const tries = [
            { x: x + step, y, turns, w, d },
            { x: x - step, y, turns, w, d },
            { x, y: y + step, turns, w, d },
            { x, y: y - step, turns, w, d },
            // Growing one side keeps the opposite edge where it is.
            ...[step, -step].flatMap((sw) =>
              sizeOk(w + sw, along.w) ? [{ x: x + sw / 2, y, turns, w: w + sw, d }] : [],
            ),
            ...[step, -step].flatMap((sd) =>
              sizeOk(d + sd, along.d) ? [{ x, y: y + sd / 2, turns, w, d: d + sd }] : [],
            ),
          ].map(score);
          const next = tries.reduce((a, b) => (b.iou > a.iou ? b : a), best);
          if (next.iou <= best.iou + 1e-4) break;
          best = next;
        }
      return best;
    };
    const starts = [0, 1, 2, 3].map((turns) => {
      const turned = turns % 2 ? { w: base.d, d: base.w } : base;
      return score({ x: start.x, y: start.y, turns, ...turned });
    });
    const lead = Math.max(...starts.map((p) => p.iou));
    const fitted = starts.filter((p) => p.iou >= lead - 0.25).map(descend);
    const most = Math.max(...fitted.map((p) => p.iou));
    // A thin panel's outline is the same from behind: when turns tie, the one facing
    // the camera wins, as a screen or a shelf in view usually faces the room.
    const facing = (p: Pose) => {
      const [fx, fy] = [
        [0, 1],
        [-1, 0],
        [0, -1],
        [1, 0],
      ][p.turns]!;
      return fx! * (camera.position[0] - p.x) + fy! * (camera.position[1] - p.y);
    };
    const best = fitted
      .filter((p) => p.iou >= most - 0.02)
      .reduce((a, b) => (facing(b) > facing(a) ? b : a));
    const built = standing(id, g, best.x, best.y, top, best.turns, { w: best.w, d: best.d });
    scene = {
      ...scene,
      props: [
        ...scene.props,
        ...built.props.map((p) => (p.id === g ? { ...p, label: capital(t.label) } : p)),
      ],
      surfaces: [...scene.surfaces, ...built.surfaces],
    };
    if (top > 0) scene = settleGroup(scene, g);
    groups.set(t.id, g);
    t.group = g;
    t.iou = best.iou;
  }

  // The biggest surface's top, as the camera sees it: the pin it implies.
  const main = things
    .filter((t) => t.role === 'surface' && t.group)
    .map((t) => scene.surfaces.find((s) => s.propId === t.group))
    .filter((s) => !!s)
    .sort((a, b) => b.rect.w * b.rect.d - a.rect.w * a.rect.d)[0];
  const pin = main ? pinOf(camera, main, frame) : null;
  const scored = things.filter((t) => typeof t.iou === 'number');
  const area = (t: PlacedThing) => masks.get(t.id)!.data.reduce((s, v) => s + v, 0);
  const total = scored.reduce((s, t) => s + area(t), 0);
  return {
    scene,
    pin,
    surfaceThing: main ? (things.find((t) => t.group === main.propId)?.id ?? null) : null,
    things,
    score: total ? scored.reduce((s, t) => s + t.iou! * area(t), 0) / total : null,
  };
}

/** A surface's top seen through the camera, as the pin a person would have set. */
export function pinOf(
  camera: RoomCamera,
  surface: IsoScene['surfaces'][number],
  frame: Segmentation['frame'],
): SurfacePin | null {
  const { x, y, w, d } = surface.rect;
  const corners = (
    [
      [x, y],
      [x + w, y],
      [x + w, y + d],
      [x, y + d],
    ] as const
  ).map(([px, py]) => projectRoom(camera, { x: px, y: py, z: surface.z }));
  if (corners.some((c) => !c || c.x < 0 || c.y < 0 || c.x > frame.width || c.y > frame.height))
    return null;
  return {
    scene: 'custom',
    surfaceId: surface.id,
    corners: corners.map((c) => ({ x: round(c!.x), y: round(c!.y) })) as Quad,
    frame,
  };
}
const round = (v: number) => Math.round(v * 10) / 10;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// --- Known rooms, for tests and the benchmark ---------------------------------

/**
 * What a room scan should reach, shared by the room bench and the tests:
 * every thing within this many tiles of where it really stands, furniture at
 * its true turn (a symmetric thing at either of its two), measured furniture
 * within this many tiles of its true width and depth, and a drawing that
 * matches its mask at least this well.
 */
export const ROOM_TARGETS = { position: 0.3, size: 0.4, iou: 0.75 } as const;

/** A room seen by its corner camera, outlined the way SAM would, with where everything really is. */
export function roomCase(scene: IsoScene, camera: RoomCamera) {
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

/** A small living room: a table and two chairs, a bookcase and a plant. */
const LOUNGE: IsoScene = (() => {
  let scene: IsoScene = {
    kind: 'custom',
    label: 'Lounge',
    grid: { w: 12, d: 10 },
    props: [],
    surfaces: [],
  };
  const add = (id: TemplateId, g: string, x: number, y: number, turns = 0) => {
    const built = placeTemplate(id, g, x, y, 0);
    scene = {
      ...scene,
      props: [...scene.props, ...built.props],
      surfaces: [...scene.surfaces, ...built.surfaces],
    };
    for (let k = 0; k < turns; k++) scene = rotateGroup(scene, g);
  };
  add('wall', 'wall-back', 0, 0);
  add('table', 'table', 4, 3.5);
  add('chair', 'chair', 3.5, 6.5, 2);
  add('chair', 'chair-2', 6.5, 1.2);
  add('shelf', 'shelf', 8.5, 0.3);
  add('plant', 'plant', 0.6, 7.5);
  return scene;
})();

/** The rooms a scan is judged on against `ROOM_TARGETS`, by the room bench and the tests alike. */
export const ROOM_CASES: {
  name: string;
  scene: () => IsoScene;
  camera: (s: IsoScene) => RoomCamera;
}[] = [
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
];

const ROUND = new Set<string>(['plant', 'lamp', 'bottle', 'jar']);
const HALF = new Set<string>(['desk', 'table', 'rug']);
/** How a scan of a case turned out against where everything really is. */
export function judgeRoom(layout: PhotoLayout, truth: ReturnType<typeof roomCase>['truth']) {
  let worst = 0;
  let who = '';
  let wrongTurns = 0;
  let size = 0;
  const ious: number[] = [];
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
      if (typeof t.iou === 'number' && t.role !== 'object') ious.push(t.iou);
    } else {
      worst = Infinity;
      who = t.id;
      continue;
    }
    const e = Math.hypot(x - at.x, y - at.y);
    if (e > worst) [worst, who] = [e, t.id];
  }
  return { worst, who, wrongTurns, size, iou: ious.length ? Math.min(...ious) : 1 };
}
