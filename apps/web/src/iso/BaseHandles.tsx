import { useRef, type PointerEvent } from 'react';
import { useFrameQueue } from './frame';
import type { Point } from '@livinglayer/domain';

/** A footprint in scene tiles, as drawn: already turned. */
export interface BaseRect {
  x: number;
  y: number;
  w: number;
  d: number;
}
/** The smallest and largest side a fixture may have, as its save allows. */
const MIN = 0.1;
const MAX = 8;
/** Sides snap to this much of a tile. */
const SNAP = 0.05;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

/** Corners and edge middles, as which way each moves the footprint's sides: -1 the near side, 1 the far. */
const HANDLES: [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
];

/**
 * Handles on a fixture's footprint that stretch it: a corner moves two
 * sides, an edge's middle one, and the opposite side stays where it is. The
 * pointer is followed across the footprint's own plane, so what is under it
 * is where the side goes, in the room model or on its picture alike.
 */
export function BaseHandles({
  rect,
  z,
  project,
  unproject,
  radius,
  label,
  onPreview,
  onDone,
}: {
  rect: BaseRect;
  /** The height the footprint stands at. */
  z: number;
  /** A point of the scene in the drawing's own units. */
  project: (x: number, y: number, z: number) => Point | null;
  /** The point of the scene at height z under the pointer. */
  unproject: (e: PointerEvent, z: number) => { x: number; y: number } | null;
  radius: number;
  label: string;
  /** The footprint as it is being dragged, or null when a drag comes to nothing. */
  onPreview: (rect: BaseRect | null) => void;
  /** A drag that changed the footprint: the preview stays until the owner clears it. */
  onDone: (rect: BaseRect) => void;
}) {
  const drag = useRef<{ id: number; side: [number, number]; from: BaseRect; now: BaseRect } | null>(
    null,
  );
  const stretch = (from: BaseRect, [sx, sy]: [number, number], p: { x: number; y: number }) => {
    let x0 = from.x;
    let x1 = from.x + from.w;
    let y0 = from.y;
    let y1 = from.y + from.d;
    if (sx < 0) x0 = Math.max(x1 - MAX, Math.min(x1 - MIN, snap(p.x)));
    if (sx > 0) x1 = Math.min(x0 + MAX, Math.max(x0 + MIN, snap(p.x)));
    if (sy < 0) y0 = Math.max(y1 - MAX, Math.min(y1 - MIN, snap(p.y)));
    if (sy > 0) y1 = Math.min(y0 + MAX, Math.max(y0 + MIN, snap(p.y)));
    return { x: x0, y: y0, w: x1 - x0, d: y1 - y0 };
  };
  // A preview a frame at most, and only when the snapped footprint changes.
  const preview = useFrameQueue(onPreview);
  const same = (a: BaseRect, b: BaseRect) =>
    a.x === b.x && a.y === b.y && a.w === b.w && a.d === b.d;
  return (
    <g className="base-handles">
      {HANDLES.map(([sx, sy]) => {
        const at = project(rect.x + ((sx + 1) / 2) * rect.w, rect.y + ((sy + 1) / 2) * rect.d, z);
        if (!at) return null;
        return (
          <circle
            key={`${sx}${sy}`}
            className={sx && sy ? 'corner' : 'edge'}
            cx={at.x}
            cy={at.y}
            r={radius}
            aria-label={`Stretch the ${label.toLowerCase()}'s base`}
            onPointerDown={(e) => {
              // The handle is the fixture's own: it doesn't also move or select it.
              e.stopPropagation();
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* the drag still follows while the pointer stays on the handle */
              }
              drag.current = { id: e.pointerId, side: [sx, sy], from: rect, now: rect };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              const p = d && d.id === e.pointerId ? unproject(e, z) : null;
              if (!d || !p) return;
              const next = stretch(d.from, d.side, p);
              if (same(next, d.now)) return;
              d.now = next;
              preview.push(next);
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              if (!d || d.id !== e.pointerId) return;
              drag.current = null;
              preview.flush();
              const moved =
                Math.abs(d.now.w - d.from.w) > 1e-6 ||
                Math.abs(d.now.d - d.from.d) > 1e-6 ||
                Math.abs(d.now.x - d.from.x) > 1e-6 ||
                Math.abs(d.now.y - d.from.y) > 1e-6;
              if (moved) onDone(d.now);
              else onPreview(null);
            }}
            onPointerCancel={() => {
              drag.current = null;
              preview.cancel();
              onPreview(null);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        );
      })}
    </g>
  );
}
