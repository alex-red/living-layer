import { quantile } from './math.js';
import type { IsoScene, Point, Quad, SurfacePin } from './iso.js';
import {
  PROP_TEMPLATES,
  SCAN_TEMPLATE_IDS,
  TEMPLATE_IDS,
  freshGroupId,
  placeTemplate,
  rotateGroup,
  settleGroup,
  type TemplateId,
} from './iso-templates.js';
import type { Segmentation } from './api.js';
import type { RoomCalibration } from './memory.js';
import {
  maskBits,
  type Bits,
  type LayoutInput,
  type PhotoAs,
  type PhotoLayout,
  type PlacedThing,
} from './photo-scene.js';
import { projectRoom, unprojectRoom, type RoomCamera } from './room-camera.js';
import { renderRoom, sceneSolids } from './room-render.js';
import { cm } from './iso-furniture.js';
import { layoutTuning } from './layout-tuning.js';
import { deskModel } from './iso-archetypes.js';

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

const isTemplate = (as: string): as is TemplateId =>
  (SCAN_TEMPLATE_IDS as readonly string[]).includes(as);
/**
 * The template that draws a thing like it, when one does: what stands on a
 * surface is a model, not a template, but the template's drawing still says
 * how far in from its box it touches down (a monitor's stand, a book's cover).
 */
const drawnLike = (t: Pick<PlacedThing, 'label' | 'as'>): TemplateId | null => {
  const like = (TEMPLATE_IDS as readonly string[]).includes(t.as) ? t.as : deskModel(t.label, t.as);
  return like && (TEMPLATE_IDS as readonly string[]).includes(like) ? (like as TemplateId) : null;
};
/** Templates that come in many sizes, drawn at Spark's estimate within reason. */
const SIZED = new Set<string>(['desk', 'table', 'shelf', 'cabinet', 'rug']);
/** Of those, the ones whose height varies a lot too: a bookcase can be 80 or 200 cm tall. */
const TALL = new Set<string>(['shelf', 'cabinet']);
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
  size: { w: number; d: number; h?: number } = PROP_TEMPLATES[id].size,
) {
  // Turned a quarter, its width runs along y: build it so that it ends up `size` as placed.
  const { w, d } = turns % 2 ? { w: size.d, d: size.w } : size;
  const h = size.h;
  let scene: IsoScene = {
    kind: 'custom',
    label: 'probe',
    grid: { w: 64, d: 64 },
    ...placeTemplate(id, g, 32 + cx - w / 2, 32 + cy - d / 2, z, {
      size: { w, d, ...(h ? { h } : {}) },
    }),
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
  const picture = renderRoom(camera, sceneSolids(probe), { labels: true, scratch: true });
  const bits = {
    width: picture.width,
    height: picture.height,
    data: new Uint8Array(picture.ids.length),
  };
  for (let i = 0; i < bits.data.length; i++) bits.data[i] = picture.ids[i]! >= 0 ? 1 : 0;
  const points = nearPoints(camera, bits, z);
  if (!points.length) return { x: 0, y: 0 };
  const q = layoutTuning().reachQuantile;
  return {
    x:
      at.x +
      size.w / 2 -
      quantile(
        points.map((p) => p.x),
        q,
      ),
    y:
      at.y +
      size.d / 2 -
      quantile(
        points.map((p) => p.y),
        q,
      ),
  };
}
/** The walls' inner faces, in tiles: the back and left walls are 0.2 thick, the others the room's edge. */
type Walls = { x0: number; y0: number; x1: number; y1: number };
interface NearPoint {
  x: number;
  y: number;
  /** Only a bound, nothing seen there: the frame cuts the column off, or it fell behind a wall. */
  open: boolean;
}
/**
 * Where a mask meets a plane at height z, in the room: each column's lowest
 * pixel, dropped onto the plane. Seen from the camera's corner they lie on
 * the footprint's near sides or behind them, never in front: whatever hides
 * the thing only pushes them back. So does the frame's edge: a column it cuts
 * off still says the thing reaches at least that far, which is all that is
 * known of a desk's near end when the frame cuts its drawers off. A point
 * behind a wall can't be where the thing stands either: something hides its
 * foot there, so that too says only how far it reaches at least.
 */
function nearPoints(camera: RoomCamera, mask: Bits, z: number, walls?: Walls) {
  const points: NearPoint[] = [];
  const edge = layoutTuning().edgePx;
  for (let x = 0; x < mask.width; x++)
    for (let y = mask.height - 1; y >= 0; y--) {
      if (!mask.data[y * mask.width + x]) continue;
      const p = unprojectRoom(camera, { x: x + 0.5, y: y + 1 }, z);
      if (p) {
        const cut = y >= mask.height - edge || x < edge || x >= mask.width - edge;
        const hidden = !!walls && (p.x < walls.x0 || p.y < walls.y0);
        points.push({ x: p.x, y: p.y, open: cut || hidden });
      }
      break;
    }
  return points;
}
/**
 * Whether a footprint's near side on an axis is only a bound: most of the
 * points that reach furthest that way were cut off by the frame or hidden.
 */
function openTowards(points: NearPoint[], axis: 'x' | 'y') {
  const from = quantile(
    points.map((p) => p[axis]),
    0.9,
  );
  const front = points.filter((p) => p[axis] >= from);
  return front.filter((p) => p.open).length * 2 > front.length;
}
/** Whether the frame's bottom edge cuts a mask off: the thing goes on out of view, towards the camera. */
function cutBelow(mask: Bits) {
  for (let i = (mask.height - layoutTuning().edgePx) * mask.width; i < mask.data.length; i++)
    if (mask.data[i]) return true;
  return false;
}
/**
 * How far back a desk's or table's top is seen to reach: its outline dropped
 * onto the plane of its top. A pixel of the top lands on the top, and one of
 * a leg or a drawer below it lands nearer the camera than it is, so the
 * furthest back they reach (bar a stray few) is a point on the top, and its
 * far sides lie at least that far back.
 */
function topFar(camera: RoomCamera, mask: Bits, z: number) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < mask.height; y += 2)
    for (let x = 0; x < mask.width; x += 2) {
      if (!mask.data[y * mask.width + x]) continue;
      const p = unprojectRoom(camera, { x: x + 0.5, y: y + 0.5 }, z);
      if (p) [xs.push(p.x), ys.push(p.y)];
    }
  const q = layoutTuning().topQuantile;
  return xs.length ? { x: quantile(xs, q), y: quantile(ys, q) } : null;
}

/** A thing's place before it is built: its corner nearest the origin, size once turned, and turn. */
interface Plan {
  t: PlacedThing;
  template: TemplateId | null;
  x: number;
  y: number;
  top: number;
  turns: number;
  turned: { w: number; d: number; h?: number };
  /** How small it may shrink, for a surface whose size is an estimate; null when it can't. */
  least: { w: number; d: number } | null;
  /**
   * How far it may move towards the camera along each axis without going
   * against what the camera saw: a near side the frame cut off or something
   * hid is only a bound.
   */
  slack: { x: number; y: number };
  /**
   * How far its far sides may come forward before they cut into the top the
   * camera saw reaching back, for a desk or table; no limit for a guess.
   */
  give: { x: number; y: number };
  /** How tall it stands. */
  h: number;
  /** Already built: others move out of its way, it doesn't. */
  fixed?: boolean;
}
/** Under a desk or table: a chair, or a cabinet no taller than its top (drawers). */
const tucked = (a: Plan, b: Plan) =>
  (a.template === 'desk' || a.template === 'table') &&
  (b.template === 'chair' || b.h <= a.h + 0.05);
const tiles = (v: number) => v.toFixed(2);
/**
 * Pull overlapping floor pieces apart, each pair by the cheapest fix: a desk,
 * table or shelf gives up a side (its size is only an estimate), or the other
 * moves away, within the walls. Pieces that can do neither stay as they are.
 * Moving costs more than shrinking: the side a piece shows the camera was
 * seen, while its far side was only estimated. Unless what was seen is only
 * a bound: then moving towards the camera, within its slack, costs little,
 * and a desk the frame cuts off moves out from the shelf behind it rather
 * than losing a third of its length. The costs are `LAYOUT_TUNING`'s.
 */
function apart(
  plans: Plan[],
  walls: Walls,
  steps?: ApartStep[],
  phase: ApartStep['phase'] = 'floor',
) {
  const T = layoutTuning();
  /** Ways to clear a of b: a shrinks away from b, or b moves out of a. */
  const fixesFor = (a: Plan, b: Plan) => {
    const fixes: { what: string; cost: number; apply: () => void }[] = [];
    for (const axis of ['x', 'y'] as const) {
      const side = axis === 'x' ? 'w' : 'd';
      const least = a.least?.[side];
      const bFirst = b[axis] + b.turned[side] / 2 < a[axis] + a.turned[side] / 2;
      // Enough to clear b, which may lie inside a's span rather than over one end.
      const by = bFirst ? b[axis] + b.turned[side] - a[axis] : a[axis] + a.turned[side] - b[axis];
      if (!a.fixed && least !== undefined && a.turned[side] - by >= least)
        fixes.push({
          what: `${a.t.id} gives up ${tiles(by)} of its ${bFirst ? 'far' : 'near'} ${axis} side`,
          // A share of that side: a long desk gives up length before depth, but
          // not the length its top was seen to have, nor the near side it showed.
          cost:
            (by / a.turned[side]) * T.shrinkCost +
            (bFirst ? Math.max(0, by - a.give[axis]) * T.pastTop : by * T.moveCost),
          apply: () => {
            a.turned[side] -= by;
            if (!bFirst) return;
            a[axis] += by;
            a.give[axis] = Math.max(0, a.give[axis] - by);
            a.slack[axis] = Math.min(a.slack[axis], a.give[axis]);
          },
        });
      const lo = axis === 'x' ? walls.x0 : walls.y0;
      const hi = axis === 'x' ? walls.x1 : walls.y1;
      for (const to of [a[axis] - b.turned[side], a[axis] + a.turned[side]]) {
        if (b.fixed || to < lo - 1e-6 || to + b.turned[side] > hi + 1e-6) continue;
        const move = to - b[axis];
        const free = Math.min(Math.max(move, 0), b.slack[axis]);
        // Pushed forward past where its top was seen, a desk's far side leaves the top behind.
        const past = Math.max(0, move - b.give[axis]);
        fixes.push({
          what: `${b.t.id} moves ${move > 0 ? '+' : ''}${tiles(move)} along ${axis}`,
          cost: free * T.slackCost + (Math.abs(move) - free - past) * T.moveCost + past * T.pastTop,
          apply: () => {
            b[axis] = to;
            b.slack[axis] = Math.max(0, b.slack[axis] - move);
            b.give[axis] = Math.max(0, b.give[axis] - move);
          },
        });
      }
    }
    return fixes;
  };
  for (let pass = 0; pass < 3; pass++)
    plans.forEach((a, i) =>
      plans.slice(i + 1).forEach((b) => {
        if (tucked(a, b) || tucked(b, a)) return;
        const ox = Math.min(a.x + a.turned.w, b.x + b.turned.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.turned.d, b.y + b.turned.d) - Math.max(a.y, b.y);
        if (ox <= 0.02 || oy <= 0.02) return;
        // Either way round, whichever is cheapest.
        const fixes = [...fixesFor(a, b), ...fixesFor(b, a)].sort((p, q) => p.cost - q.cost);
        steps?.push({
          phase,
          pass,
          a: a.t.id,
          b: b.t.id,
          overlap: { x: ox, y: oy },
          fixes: fixes.map(({ what, cost }) => ({ what, cost })),
        });
        fixes[0]?.apply();
      }),
    );
}

/** How far a thing's planned footprint reached behind the back and left walls, in tiles (negative: in front). */
export interface WallGap {
  back: number;
  left: number;
}
/** A footprint: its corner nearest the origin and its size once turned, in tiles. */
interface Footprint {
  x: number;
  y: number;
  w: number;
  d: number;
}
/** How one thing's place was found. */
interface PlanTrace {
  /** The height it stands at, and the turn it took. */
  top: number;
  turns: number;
  /** Each column's lowest pixel, dropped onto the plane it stands on. */
  points: NearPoint[];
  /** How far those reach (its near sides), and how far in from them its template touches down. */
  reach: { x: number; y: number };
  inset: { x: number; y: number };
  /** Where its top was seen reaching back, for a desk or table. */
  topFar: { x: number; y: number } | null;
  /** Whether the frame cuts it off below, and whether each near side is only a bound. */
  cut: boolean;
  open: { x: boolean; y: boolean };
  /** The axis it was put flush against a wall along, if it was. */
  flush: 'x' | 'y' | null;
  slack: { x: number; y: number };
  give: { x: number; y: number };
  /** Before overlaps were pulled apart, and after. */
  planned: Footprint;
  placed?: Footprint;
}
/** One overlap `apart` met: every way it could clear it, cheapest first, and it took the first. */
interface ApartStep {
  /** Floor pieces first, then chairs among them. */
  phase: 'floor' | 'chairs';
  pass: number;
  a: string;
  b: string;
  overlap: { x: number; y: number };
  fixes: { what: string; cost: number }[];
}
/** What `layoutRoom` weighed, for `bun run draft --why` and `--trace`. */
export interface LayoutTrace {
  things: Record<string, PlanTrace>;
  apart: ApartStep[];
}
export const layoutTrace = (): LayoutTrace => ({ things: {}, apart: [] });

/**
 * `behind`, when given, collects how far each thing whose size is known (not
 * a desk, table, shelf or rug Spark sized, nor a chair) stood behind the walls
 * before it was put in front of them: what `refineWalls` reads the walls from.
 * `trace`, when given, collects how each thing's place was found and every
 * overlap pulled apart.
 */
export function layoutRoom(
  input: RoomLayoutInput,
  { behind, trace }: { behind?: Map<string, WallGap>; trace?: LayoutTrace } = {},
): PhotoLayout {
  const T = layoutTuning();
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
  const walls: Walls = { x0: 0.2, y0: 0.2, x1: room.w, y1: room.d };
  const groups = new Map<string, { g: string; turns: number; x: number; y: number }>();
  /** Where a thing goes and how big it is, before anything is built; null when it can't be placed. */
  const plan = (t: PlacedThing): Plan | null => {
    const below = t.on && t.on !== 'floor' ? groups.get(t.on) : undefined;
    const own = new Set(scene.props.filter((p) => p.group === below?.g).map((p) => p.id));
    const tops = scene.surfaces.filter((x) => own.has(x.propId));
    const surface = tops.sort((a, b) => b.z - a.z)[0];
    const top = surface?.z ?? 0;
    const points = nearPoints(camera, masks.get(t.id)!, top, walls);
    if (!points.length) return null;
    const template = isTemplate(t.as) ? t.as : null;
    const drawn = template ?? drawnLike(t);
    // Its own size, before turning: the template's, or Spark's for what comes in many sizes.
    const sized = (v: number, of: number) => Math.min(of * T.sizeMax, Math.max(of * T.sizeMin, v));
    const spark = { w: cm(t.sizeCm.w), d: cm(t.sizeCm.d) };
    const base = template ? PROP_TEMPLATES[template].size : spark;
    const size: { w: number; d: number; h?: number } =
      template && SIZED.has(template)
        ? { w: sized(spark.w, base.w), d: sized(spark.d, base.d) }
        : { w: base.w, d: base.d };
    if (template && TALL.has(template)) size.h = sized(cm(t.sizeCm.h), usualHeight(template));
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
    const turned = turns % 2 ? { ...size, w: size.d, d: size.w } : { ...size };
    // The camera is in the room's front corner, so it sees each footprint's
    // far-from-origin sides: they are where the near points reach furthest,
    // less how far in from them its parts touch down.
    const reach = {
      x: quantile(
        points.map((p) => p.x),
        T.reachQuantile,
      ),
      y: quantile(
        points.map((p) => p.y),
        T.reachQuantile,
      ),
    };
    let x = reach.x - turned.w;
    let y = reach.y - turned.d;
    let inset = { x: 0, y: 0 };
    if (drawn) {
      // Twice: where the outline reaches down shifts a little with where it stands.
      for (let k = 0; k < 2; k++) {
        inset = drawnInset(
          camera,
          drawn,
          turns,
          turned,
          { x: x + turned.w / 2, y: y + turned.d / 2 },
          top,
        );
        x = reach.x + inset.x - turned.w;
        y = reach.y + inset.y - turned.d;
      }
    }
    // How high its top is, for one whose size varies: what stands on it stands there.
    const height =
      template && SIZED.has(template)
        ? Math.max(
            0,
            ...standing(template, 'probe', 0, 0, 0, turns, turned).surfaces.map((x) => x.z),
          )
        : 0;
    // What stands on a surface has to fit on it: Spark can guess a long desk short,
    // and what stands at its far end says how far it reaches (within reason).
    if (template && SIZED.has(template)) {
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
                  T.reachQuantile,
                ) - own,
              y:
                quantile(
                  points.map((p) => p.y),
                  T.reachQuantile,
                ) - own,
            },
          ];
        });
      if (held.length) {
        const most =
          turns % 2
            ? { w: base.d * T.sizeMax, d: base.w * T.sizeMax }
            : { w: base.w * T.sizeMax, d: base.d * T.sizeMax };
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
    if (template !== 'chair' && !(template && SIZED.has(template)))
      behind?.set(t.id, { back: walls.y0 - y, left: walls.x0 - x });
    // Its back against the wall it nearly touches, and never through one or off its surface.
    let flush: 'x' | 'y' | null = null;
    if (!surface && template && !ROUND_TEMPLATES.has(template) && template !== 'chair') {
      if (turns === 0 && y - walls.y0 < T.flush) [y, flush] = [walls.y0, 'y'];
      if (turns === 1 && walls.x1 - (x + turned.w) < T.flush) x = walls.x1 - turned.w;
      if (turns === 2 && walls.y1 - (y + turned.d) < T.flush) y = walls.y1 - turned.d;
      if (turns === 3 && x - walls.x0 < T.flush) [x, flush] = [walls.x0, 'x'];
    }
    x = Math.min(Math.max(x, area.x0), Math.max(area.x0, area.x1 - turned.w));
    y = Math.min(Math.max(y, area.y0), Math.max(area.y0, area.y1 - turned.d));
    // How far it may come forward without going against what was seen: some way when
    // its near side is only a bound (the frame cuts it off below, or something hides it),
    // and for a desk or table only as far as its top, seen reaching back, lets it.
    const mask = masks.get(t.id)!;
    const far =
      template === 'desk' || template === 'table' ? topFar(camera, mask, top + height) : null;
    const cut = cutBelow(mask);
    const open = { x: openTowards(points, 'x'), y: openTowards(points, 'y') };
    const slack = { x: 0, y: 0 };
    const give = { x: Infinity, y: Infinity };
    for (const axis of ['x', 'y'] as const) {
      const at = axis === 'x' ? x : y;
      if (far) give[axis] = Math.max(0, Math.max(walls[`${axis}0`], far[axis]) - at);
      if (surface || axis === flush) continue;
      if (cut || open[axis]) slack[axis] = Math.min(T.openSlack, give[axis]);
    }
    if (trace)
      trace.things[t.id] = {
        top,
        turns,
        points,
        reach,
        inset,
        topFar: far,
        cut,
        open,
        flush,
        slack: { ...slack },
        give: { ...give },
        planned: { x, y, w: turned.w, d: turned.d },
      };
    if (x + turned.w < -0.5 || y + turned.d < -0.5 || x > room.w + 0.5 || y > room.d + 0.5)
      return null;
    const least = { w: base.w * T.sizeMin, d: base.d * T.sizeMin };
    return {
      t,
      template,
      x,
      y,
      top,
      turns,
      turned,
      // A desk, table or shelf can give a little of its estimated size; nothing else can.
      least:
        !template || !SIZED.has(template) ? null : turns % 2 ? { w: least.d, d: least.w } : least,
      slack,
      give,
      h: turned.h ?? (template ? usualHeight(template) : cm(t.sizeCm.h)),
    };
  };
  /** Stand a planned thing in the room: a template's props, or a model's box. */
  const build = ({ t, template, x, y, top, turns, turned }: Plan) => {
    const traced = trace?.things[t.id];
    if (traced) traced.placed = { x, y, w: turned.w, d: turned.d };
    if (!template) {
      // Not in the catalogue: a model of Spark's size, standing there.
      t.status = 'object';
      t.turns = turns;
      t.foot = {
        at: { x, y, z: top },
        size: { w: turned.w, d: turned.d, h: cm(t.sizeCm.h) },
      };
      return;
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
  };
  const place = (t: PlacedThing, planned = plan(t)) => {
    if (planned) build(planned);
    else t.status = 'unplaced';
  };
  // The floor's furniture first, all of it planned before any is built, so two pieces
  // never stand in each other (a box drawn inside another can't be put in order).
  // Chairs come after, as they tuck under desks; then what stands on things.
  const onFloor = (t: PlacedThing) => !t.on || t.on === 'floor';
  const free = (t: PlacedThing) => t.as === 'chair' || t.as === 'rug';
  const rank = (t: PlacedThing) => (t.role === 'surface' ? 0 : t.role === 'furniture' ? 1 : 2);
  const order = [...live].sort((a, b) => rank(a) - rank(b));
  const floor = order.filter((t) => onFloor(t) && !free(t));
  const plans = floor.map((t) => ({ t, planned: plan(t) }));
  apart(
    plans.flatMap((x) => (x.planned ? [x.planned] : [])),
    walls,
    trace?.apart,
  );
  for (const { t, planned } of plans) place(t, planned);
  // Chairs face the desks just built, and step out of anything else's way.
  const built = plans.flatMap((x) => (x.planned ? [{ ...x.planned, fixed: true }] : []));
  const chairs = order
    .filter((t) => onFloor(t) && t.as === 'chair')
    .map((t) => ({ t, planned: plan(t) }));
  apart(
    [...built, ...chairs.flatMap((x) => (x.planned ? [x.planned] : []))],
    walls,
    trace?.apart,
    'chairs',
  );
  for (const { t, planned } of chairs) place(t, planned);
  for (const t of order) if (!floor.includes(t) && !chairs.some((c) => c.t === t)) place(t);

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

/** How tall a template is built when nothing says otherwise. */
function usualHeight(id: TemplateId) {
  const { props } = placeTemplate(id, 'probe', 0, 0, 0);
  return Math.max(...props.map((p) => p.at.z + p.size.h));
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
/**
 * A pin's corners in the surface's own order, by the calibrated camera. A
 * person clicks "back left" as it looks on screen, which for a turned desk
 * is another corner of its rect: the pin would map the desk's width onto
 * its length. The corners are turned (or their winding reversed) to the
 * order nearest where the camera sees the rect's. As it was when the frame
 * is another size or a corner is behind the camera.
 */
export function pinInOrder(
  pin: SurfacePin,
  camera: RoomCamera,
  surface: IsoScene['surfaces'][number],
): SurfacePin {
  if (pin.frame.width !== camera.frame.width || pin.frame.height !== camera.frame.height)
    return pin;
  // Where the camera sees the rect's corners, on the frame or past its edge.
  const { x, y, w, d } = surface.rect;
  const seen = [
    [x, y],
    [x + w, y],
    [x + w, y + d],
    [x, y + d],
  ].map(([px, py]) => projectRoom(camera, { x: px!, y: py!, z: surface.z }));
  if (seen.some((c) => !c)) return pin;
  const orders = [0, 1, 2, 3].flatMap((k) => [
    [0, 1, 2, 3].map((i) => pin.corners[(i + k) % 4]!),
    [0, 1, 2, 3].map((i) => pin.corners[(k - i + 4) % 4]!),
  ]);
  const off = (cs: Point[]) =>
    cs.reduce((s, c, i) => s + Math.hypot(c.x - seen[i]!.x, c.y - seen[i]!.y), 0);
  const best = orders.reduce((a, b) => (off(b) < off(a) ? b : a));
  return { ...pin, corners: best as Quad };
}
const round = (v: number) => Math.round(v * 10) / 10;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
