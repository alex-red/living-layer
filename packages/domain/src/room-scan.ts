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
  type PhotoThing,
} from './photo-scene.js';
import { cornerCamera, projectRoom, unprojectRoom, type RoomCamera } from './room-camera.js';
import { floorSolid, renderRoom, sceneSolids } from './room-render.js';
import { ISO_TILE_CM, cm } from './iso-furniture.js';

/**
 * A room's things laid out from one frame of its calibrated camera. Nothing
 * is fitted to its outline: each thing is drawn as its template, at its usual
 * size (or Spark's, for things that come in many sizes), or as a model of
 * Spark's size. It stands where its outline meets the floor or what it is on,
 * turned square to the nearest wall; a chair faces its desk, and what stands
 * on a surface faces as the surface does. Nothing from the photo is pasted on.
 */
export interface RoomLayoutInput extends Pick<
  LayoutInput,
  'inventory' | 'segmentation' | 'detections' | 'edits'
> {
  calibration: RoomCalibration;
}

const isTemplate = (as: string): as is TemplateId => as in PROP_TEMPLATES;
/** Templates that come in many sizes, drawn at Spark's estimate within reason. */
const SIZED = new Set<string>(['desk', 'table', 'shelf', 'cabinet', 'rug']);
/** A thing whose back is within this many tiles of a wall is put flush against it. */
const FLUSH = 0.5;
/** Round things have no back to put to a wall. */
const ROUND_TEMPLATES = new Set<string>(['plant', 'lamp', 'bottle', 'jar', 'carton']);
/** The way a chair at each turn faces, in the room: at turn 0 its back is to the room's front. */
const CHAIR_FRONT = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;
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

/**
 * How far in from its box's far sides a template's outline reaches down, as
 * the camera sees it standing at (cx, cy): a desk stands on legs set in from
 * its top's edges, and a monitor's screen hangs past its narrow stand. Read
 * off its own drawing the way a mask is read, so the two agree.
 */
function drawnInset(
  camera: RoomCamera,
  id: TemplateId,
  turns: number,
  size: { w: number; d: number },
  at: { x: number; y: number },
  z: number,
) {
  const built = standing(id, 'probe', at.x, at.y, z, turns, size);
  const probe: IsoScene = { kind: 'custom', label: 'probe', grid: { w: 1, d: 1 }, ...built };
  const picture = renderRoom(camera, sceneSolids(probe), { labels: true });
  const bits = {
    width: picture.width,
    height: picture.height,
    data: new Uint8Array(picture.ids.length),
  };
  for (let i = 0; i < bits.data.length; i++) bits.data[i] = picture.ids[i]! >= 0 ? 1 : 0;
  const points = nearPoints(camera, bits, z);
  if (!points.length) return { x: 0, y: 0 };
  return {
    x:
      at.x +
      size.w / 2 -
      quantile(
        points.map((p) => p.x),
        0.98,
      ),
    y:
      at.y +
      size.d / 2 -
      quantile(
        points.map((p) => p.y),
        0.98,
      ),
  };
}
/**
 * Where a mask meets a plane at height z, in the room: each column's lowest
 * pixel, dropped onto the plane. Seen from the camera's corner they lie on
 * the footprint's near sides or behind them, never in front: whatever hides
 * the thing only pushes them back. Columns the frame cuts off are left out.
 */
function nearPoints(camera: RoomCamera, mask: Bits, z: number) {
  const points: { x: number; y: number }[] = [];
  const cut: { x: number; y: number }[] = [];
  for (let x = 0; x < mask.width; x++)
    for (let y = mask.height - 1; y >= 0; y--) {
      if (!mask.data[y * mask.width + x]) continue;
      const p = unprojectRoom(camera, { x: x + 0.5, y: y + 1 }, z);
      if (p) (y === mask.height - 1 ? cut : points).push(p);
      break;
    }
  return points.length ? points : cut;
}
/** The value below which a share `q` of the values lie. */
const quantile = (vs: number[], q: number) =>
  [...vs].sort((a, b) => a - b)[Math.min(vs.length - 1, Math.floor(q * vs.length))]!;

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
  const masks = new Map(
    live.map((t) => [t.id, maskBits(byId.get(t.detectionId!)!, frame, 1) as Bits]),
  );

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
  // The walls' inner faces: the back and left walls are 0.2 thick, the others the room's edge.
  const walls = { x0: 0.2, y0: 0.2, x1: room.w, y1: room.d };
  // Surfaces first, then the rest of the floor, then what stands on them.
  const rank = (t: PlacedThing) => (t.role === 'surface' ? 0 : t.role === 'furniture' ? 1 : 2);
  const order = [...live].sort((a, b) => rank(a) - rank(b));
  const groups = new Map<string, { g: string; turns: number; x: number; y: number }>();
  for (const t of order) {
    const below = t.on && t.on !== 'floor' ? groups.get(t.on) : undefined;
    const own = new Set(scene.props.filter((p) => p.group === below?.g).map((p) => p.id));
    const tops = scene.surfaces.filter((x) => own.has(x.propId));
    const surface = tops.sort((a, b) => b.z - a.z)[0];
    const top = surface?.z ?? 0;
    const points = nearPoints(camera, masks.get(t.id)!, top);
    if (!points.length) {
      t.status = 'unplaced';
      continue;
    }
    const template = isTemplate(t.as) ? t.as : null;
    // Its own size, before turning: the template's, or Spark's for what comes in many sizes.
    const sized = (v: number, of: number) => Math.min(of * 1.6, Math.max(of * 0.6, v));
    const spark = { w: cm(t.sizeCm.w), d: cm(t.sizeCm.d) };
    const base = template ? PROP_TEMPLATES[template].size : spark;
    const size =
      template && SIZED.has(template)
        ? { w: sized(spark.w, base.w), d: sized(spark.d, base.d) }
        : { w: base.w, d: base.d };
    // Roughly where it is, to choose its turn: the near points' middle, half a depth back.
    const mid = {
      x:
        quantile(
          points.map((p) => p.x),
          0.5,
        ) -
        Math.min(size.w, size.d) / 2,
      y:
        quantile(
          points.map((p) => p.y),
          0.5,
        ) -
        Math.min(size.w, size.d) / 2,
    };
    // On a surface, things face as it does (a laptop along a desk); on the floor, to a wall.
    const turns = below
      ? below.turns
      : template === 'chair'
        ? facing(mid, groups)
        : backToWall(mid, walls);
    const turned = turns % 2 ? { w: size.d, d: size.w } : { ...size };
    // The camera is in the room's front corner, so it sees each footprint's
    // far-from-origin sides: they are where the near points reach furthest,
    // less how far in from them its parts touch down.
    const reach = {
      x: quantile(
        points.map((p) => p.x),
        0.98,
      ),
      y: quantile(
        points.map((p) => p.y),
        0.98,
      ),
    };
    let x = reach.x - turned.w;
    let y = reach.y - turned.d;
    if (template) {
      // Twice: where the outline reaches down shifts a little with where it stands.
      for (let k = 0; k < 2; k++) {
        const inset = drawnInset(
          camera,
          template,
          turns,
          turned,
          { x: x + turned.w / 2, y: y + turned.d / 2 },
          top,
        );
        x = reach.x + inset.x - turned.w;
        y = reach.y + inset.y - turned.d;
      }
    }
    // What stands on a surface has to fit on it: Spark can guess a long desk short,
    // and what stands at its far end says how far it reaches (within reason).
    if (template && SIZED.has(template)) {
      const height = Math.max(
        0,
        ...standing(template, 'probe', 0, 0, 0, turns, turned).surfaces.map((x) => x.z),
      );
      // Each thing's near side, which its lowest points give reliably, less its own depth.
      const held = live
        .filter((c) => c.on === t.id && masks.has(c.id))
        .flatMap((c) => {
          const points = nearPoints(camera, masks.get(c.id)!, top + height);
          if (!points.length) return [];
          const own = cm(Math.min(c.sizeCm.w, c.sizeCm.d));
          return [
            {
              x:
                quantile(
                  points.map((p) => p.x),
                  0.98,
                ) - own,
              y:
                quantile(
                  points.map((p) => p.y),
                  0.98,
                ) - own,
            },
          ];
        });
      if (held.length) {
        const most =
          turns % 2 ? { w: base.d * 1.6, d: base.w * 1.6 } : { w: base.w * 1.6, d: base.d * 1.6 };
        const far = {
          x: Math.max(walls.x0, Math.min(...held.map((p) => p.x))),
          y: Math.max(walls.y0, Math.min(...held.map((p) => p.y))),
        };
        const right = x + turned.w;
        const front = y + turned.d;
        if (far.x < x) {
          turned.w = Math.min(most.w, right - far.x);
          x = right - turned.w;
        }
        if (far.y < y) {
          turned.d = Math.min(most.d, front - far.y);
          y = front - turned.d;
        }
      }
    }
    const area = surface
      ? {
          x0: surface.rect.x,
          y0: surface.rect.y,
          x1: surface.rect.x + surface.rect.w,
          y1: surface.rect.y + surface.rect.d,
        }
      : walls;
    // Its back against the wall it nearly touches, and never through one or off its surface.
    if (!surface && template && !ROUND_TEMPLATES.has(template) && template !== 'chair') {
      if (turns === 0 && y - walls.y0 < FLUSH) y = walls.y0;
      if (turns === 1 && walls.x1 - (x + turned.w) < FLUSH) x = walls.x1 - turned.w;
      if (turns === 2 && walls.y1 - (y + turned.d) < FLUSH) y = walls.y1 - turned.d;
      if (turns === 3 && x - walls.x0 < FLUSH) x = walls.x0;
    }
    x = Math.min(Math.max(x, area.x0), Math.max(area.x0, area.x1 - turned.w));
    y = Math.min(Math.max(y, area.y0), Math.max(area.y0, area.y1 - turned.d));
    if (x + turned.w < -0.5 || y + turned.d < -0.5 || x > room.w + 0.5 || y > room.d + 0.5) {
      t.status = 'unplaced';
      continue;
    }
    if (!template) {
      // Not in the catalogue: a model of Spark's size, standing there.
      t.status = 'object';
      t.turns = turns;
      t.foot = {
        at: { x, y, z: top },
        size: { w: turned.w, d: turned.d, h: cm(t.sizeCm.h) },
      };
      continue;
    }
    const g = freshGroupId(scene, template);
    const built = standing(template, g, x + turned.w / 2, y + turned.d / 2, top, turns, turned);
    scene = {
      ...scene,
      props: [
        ...scene.props,
        ...built.props.map((p) => (p.id === g ? { ...p, label: capital(t.label) } : p)),
      ],
      surfaces: [...scene.surfaces, ...built.surfaces],
    };
    if (top > 0) scene = settleGroup(scene, g);
    groups.set(t.id, { g, turns, x: x + turned.w / 2, y: y + turned.d / 2 });
    t.group = g;
  }

  // The biggest surface's top, as the camera sees it: the pin it implies.
  const main = things
    .filter((t) => t.role === 'surface' && t.group)
    .map((t) => scene.surfaces.find((s) => s.propId === t.group))
    .filter((s) => !!s)
    .sort((a, b) => b.rect.w * b.rect.d - a.rect.w * a.rect.d)[0];
  const pin = main ? pinOf(camera, main, frame) : null;
  return {
    scene,
    pin,
    surfaceThing: main ? (things.find((t) => t.group === main.propId)?.id ?? null) : null,
    things,
  };
}

/** The turn that puts a thing's back to the wall nearest it. */
function backToWall(
  at: { x: number; y: number },
  walls: { x0: number; y0: number; x1: number; y1: number },
) {
  // Turn 0's back is to the back wall, 1's to the right, 2's to the front, 3's to the left.
  const gaps = [at.y - walls.y0, walls.x1 - at.x, walls.y1 - at.y, at.x - walls.x0];
  return gaps.indexOf(Math.min(...gaps));
}
/** The turn that faces a chair towards the nearest desk or table, else away from its wall. */
function facing(
  at: { x: number; y: number },
  groups: Map<string, { g: string; turns: number; x: number; y: number }>,
) {
  const tables = [...groups.values()].filter((v) => /^(desk|table)/.test(v.g));
  const near = tables.sort(
    (a, b) => Math.hypot(a.x - at.x, a.y - at.y) - Math.hypot(b.x - at.x, b.y - at.y),
  )[0];
  if (!near) return 0;
  const to = [near.x - at.x, near.y - at.y];
  const along = CHAIR_FRONT.map(([fx, fy]) => fx * to[0]! + fy * to[1]!);
  return along.indexOf(Math.max(...along));
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
  // Both chairs face the table.
  add('chair', 'chair', 3.5, 6.5);
  add('chair', 'chair-2', 6.5, 1.2, 2);
  add('shelf', 'shelf', 8.5, 0.3);
  add('plant', 'plant', 0.6, 7.5);
  return scene;
})();

/** The rooms a scan is judged on against `ROOM_TARGETS`, by the room bench and the tests alike. */
export const ROOM_CASES: {
  name: string;
  scene: () => IsoScene;
  camera: (s: IsoScene) => RoomCamera;
  /** Sizes Spark gets wrong, by group, in centimetres. */
  guess?: Record<string, Partial<PhotoThing['sizeCm']>>;
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
  {
    // A 160 cm desk guessed at 120: what stands at its far end says how long it is.
    name: 'office, desk guessed short',
    scene: () => ISO_PRESETS.office,
    camera: (s) => cornerCamera(s.grid),
    guess: { desk: { w: 120 } },
  },
];

const ROUND = new Set<string>(['plant', 'lamp', 'bottle', 'jar']);
const HALF = new Set<string>(['desk', 'table', 'rug']);
/** How a scan of a case turned out against where everything really is. */
export function judgeRoom(layout: PhotoLayout, truth: ReturnType<typeof roomCase>['truth']) {
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
