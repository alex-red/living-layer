import { z } from 'zod';
import type { Detection, Segmentation } from './api.js';
import type { IsoBox, IsoScene, Point } from './iso.js';
import { fillRings, maskBits, newBits, type Bits } from './photo-scene.js';
import type { RoomCamera } from './room-camera.js';
import { floorSolid, renderRoom, sceneSolids, type RoomPicture } from './room-render.js';

/**
 * What a person marks on the camera's picture with the AI brush
 * ([plan](../../../docs/plans/ai-brush.md#1-selection)): a rectangle or a
 * polygon, in thousandths of the frame so zooming and panning the view
 * don't change it, and what in the room it points at.
 */
const milli = z.number().min(0).max(1000);
export const selectionShapeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('rect'),
      box: z
        .object({ x1: milli, y1: milli, x2: milli, y2: milli })
        .strict()
        .refine((b) => b.x2 > b.x1 && b.y2 > b.y1, { message: 'The box must have an area.' }),
    })
    .strict(),
  z
    .object({
      kind: z.literal('polygon'),
      points: z
        .array(z.object({ x: milli, y: milli }).strict())
        .min(3)
        .max(64),
    })
    .strict(),
]);
export type SelectionShape = z.infer<typeof selectionShapeSchema>;
type Frame = Segmentation['frame'];

/** The shape's corners in the frame's pixels. */
function ringOf(shape: SelectionShape, { width, height }: Frame): Point[] {
  const px = (p: { x: number; y: number }) => ({
    x: (p.x / 1000) * width,
    y: (p.y / 1000) * height,
  });
  if (shape.kind === 'polygon') return shape.points.map(px);
  const { x1, y1, x2, y2 } = shape.box;
  return [px({ x: x1, y: y1 }), px({ x: x2, y: y1 }), px({ x: x2, y: y2 }), px({ x: x1, y: y2 })];
}
/** The pixels a shape covers, as a frame-sized mask. */
export function selectionMask(shape: SelectionShape, frame: Frame): Bits {
  const bits = newBits(frame.width, frame.height);
  fillRings(bits, [ringOf(shape, frame)]);
  return bits;
}
/** The shape's bounding box in pixels, for SAM's box prompt: a polygon is boxed, then clipped. */
export function selectionBox(shape: SelectionShape, frame: Frame) {
  const ring = ringOf(shape, frame);
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  return {
    left: Math.floor(Math.min(...xs)),
    top: Math.floor(Math.min(...ys)),
    right: Math.ceil(Math.max(...xs)),
    bottom: Math.ceil(Math.max(...ys)),
  };
}
/**
 * SAM's outline of the boxed thing, cut to the person's shape: SAM is
 * prompted with a polygon's bounding box, which may take in a neighbour the
 * polygon left out. Null when nothing of it is inside the shape.
 */
export function clipMask(detection: Detection, shape: SelectionShape, frame: Frame): Bits | null {
  const sam = maskBits(detection, frame, 1);
  const inside = selectionMask(shape, frame);
  let any = false;
  for (let i = 0; i < sam.data.length; i++) {
    sam.data[i] = sam.data[i]! & inside.data[i]!;
    any ||= sam.data[i] === 1;
  }
  return any ? sam : null;
}

/** Something in the room a selection can point at. */
export interface SelectionTarget {
  /** A template group in the room's scene, a fixture, or a tracked object. */
  kind: 'prop' | 'fixture' | 'object';
  id: string;
  label: string;
}
/** How well a selection points at one thing. */
export interface TargetScore {
  target: SelectionTarget;
  /** The share of the thing's visible pixels inside the selection. */
  covered: number;
  /** The share of the selection the thing fills. */
  fills: number;
}
export interface Resolved {
  /** The thing selected, or null when the selection is of something the room doesn't have yet. */
  target: SelectionTarget | null;
  /** Everything touched, best first. */
  candidates: TargetScore[];
  /** A runner-up fills almost as much of the selection, so the review should ask. */
  ambiguous: boolean;
}

/** A thing counts as selected only when this much of what the camera sees of it is inside. */
export const MIN_COVERED = 0.6;
/** A runner-up this close (in the share it fills) to the best makes the answer ambiguous. */
const CLOSE = 0.6;

/**
 * The room as its camera sees it, labelled per pixel: the scene's template
 * groups, and fixtures as their boxes, so a selection can be scored against
 * what is in front. Fixture ids are prefixed `fixture:`; floor and walls are
 * drawn, so they hide what they should, but are never a target.
 */
export function roomLabels(
  camera: RoomCamera,
  scene: IsoScene,
  fixtures: { id: string; box: IsoBox }[] = [],
): RoomPicture {
  return renderRoom(
    camera,
    [
      floorSolid(scene.grid),
      ...sceneSolids(scene),
      ...fixtures.map((f) => ({
        id: `fixture:${f.id}`,
        box: f.box,
        shape: 'prism' as const,
        color: [0, 0, 0] as [number, number, number],
      })),
    ],
    { labels: true },
  );
}

const WALLS = new Set(['floor', 'wall-back', 'wall-left']);
/**
 * Which thing a selection is of. Each candidate is scored by how much of
 * it the selection covers and how much of the selection it fills: among
 * things mostly inside, the one filling the most wins. A box around the
 * desk covers its monitor too, but the desk fills more of it; a box around
 * the mug on the desk covers only a sliver of the desk.
 *
 * `mask` is the selection (or SAM's outline cut to it). `picture` comes from
 * `roomLabels`; `labels` names its ids (a group's label, a fixture's name).
 * Tracked objects are only boxes in the frame, scored by their box.
 */
export function resolveSelection(
  mask: Bits,
  picture: RoomPicture,
  labels: Map<string, string>,
  objects: { id: string; label: string; box: Detection['box'] }[] = [],
): Resolved {
  const n = picture.names.length;
  const inside = new Float64Array(n);
  const total = new Float64Array(n);
  let selected = 0;
  for (let i = 0; i < mask.data.length; i++) {
    const k = picture.ids[i]!;
    if (k >= 0) total[k]!++;
    if (!mask.data[i]) continue;
    selected++;
    if (k >= 0) inside[k]!++;
  }
  if (!selected) return { target: null, candidates: [], ambiguous: false };
  const scores: TargetScore[] = [];
  for (let k = 0; k < n; k++) {
    const id = picture.names[k]!;
    if (WALLS.has(id) || !inside[k]) continue;
    const fixture = id.startsWith('fixture:');
    const own = fixture ? id.slice('fixture:'.length) : id;
    scores.push({
      target: { kind: fixture ? 'fixture' : 'prop', id: own, label: labels.get(id) ?? own },
      covered: inside[k]! / total[k]!,
      fills: inside[k]! / selected,
    });
  }
  for (const o of objects) {
    const x0 = Math.max(0, Math.floor(o.box.x));
    const y0 = Math.max(0, Math.floor(o.box.y));
    const x1 = Math.min(mask.width, Math.ceil(o.box.x + o.box.width));
    const y1 = Math.min(mask.height, Math.ceil(o.box.y + o.box.height));
    let hit = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) hit += mask.data[y * mask.width + x]!;
    const area = Math.max(1, (x1 - x0) * (y1 - y0));
    if (hit)
      scores.push({
        target: { kind: 'object', id: o.id, label: o.label },
        covered: hit / area,
        fills: hit / selected,
      });
  }
  const order = (a: TargetScore, b: TargetScore) => b.fills - a.fills || b.covered - a.covered;
  const whole = scores.filter((s) => s.covered >= MIN_COVERED).sort(order);
  const best = whole[0] ?? null;
  return {
    target: best?.target ?? null,
    candidates: [...whole, ...scores.filter((s) => s.covered < MIN_COVERED).sort(order)],
    ambiguous: Boolean(best && whole[1] && whole[1].fills >= best.fills * CLOSE),
  };
}

/** A scene's template groups by id, with the name a person knows each by. */
export function groupLabels(scene: IsoScene): Map<string, string> {
  const labels = new Map<string, string>();
  for (const p of scene.props)
    if (p.id === p.group || !labels.has(p.group)) labels.set(p.group, p.label);
  return labels;
}
