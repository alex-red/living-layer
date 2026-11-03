/**
 * Moving and stretching a rectangle being drawn: a zone on the camera's
 * picture or on the room's surface, in units of 0 to 1 either way. A press
 * on the rectangle moves it, on a side or corner stretches it, and anywhere
 * else draws a new one.
 */
import './RectGrab.css';

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

/** What a press takes hold of: the body, a side or corner, or nothing (a new rectangle). */
export type Grab = 'draw' | 'move' | Side | Corner;
type Side = 'n' | 'e' | 's' | 'w';
type Corner = 'nw' | 'ne' | 'se' | 'sw';

const SIDES: readonly Side[] = ['n', 'e', 's', 'w'];
const CORNERS: readonly Corner[] = ['nw', 'ne', 'se', 'sw'];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A corner's point: north is the rectangle's smaller y. */
function cornerOf(r: Rect, c: Corner): Point {
  return { x: c.endsWith('w') ? r.x : r.x + r.width, y: c[0] === 'n' ? r.y : r.y + r.height };
}

/** A side's two ends, clockwise. */
function sideOf(r: Rect, s: Side): [Point, Point] {
  const at = { n: ['nw', 'ne'], e: ['ne', 'se'], s: ['se', 'sw'], w: ['sw', 'nw'] } as const;
  return [cornerOf(r, at[s][0]), cornerOf(r, at[s][1])];
}

/** The grab an element stands for, by its `data-grab`; anything else draws. */
export function grabOf(target: EventTarget): Grab {
  const g = (target as Element).getAttribute?.('data-grab');
  return g && (g === 'move' || (SIDES as string[]).includes(g) || (CORNERS as string[]).includes(g))
    ? (g as Grab)
    : 'draw';
}

/** The rectangle from `from` with what `grab` holds dragged from `a` to `p`, kept inside 0 to 1. */
export function dragRect(from: Rect | null | undefined, grab: Grab, a: Point, p: Point): Rect {
  if (grab === 'draw' || !from) {
    const x = clamp01(Math.min(a.x, p.x)),
      y = clamp01(Math.min(a.y, p.y));
    return {
      x,
      y,
      width: clamp01(Math.max(a.x, p.x)) - x,
      height: clamp01(Math.max(a.y, p.y)) - y,
    };
  }
  const dx = p.x - a.x,
    dy = p.y - a.y;
  // Moved, it stays inside, or no further out than it already was.
  const slide = (v: number, d: number, size: number) =>
    Math.min(Math.max(1 - size, v), Math.max(Math.min(0, v), v + d));
  if (grab === 'move')
    return { ...from, x: slide(from.x, dx, from.width), y: slide(from.y, dy, from.height) };
  let x0 = from.x,
    y0 = from.y,
    x1 = from.x + from.width,
    y1 = from.y + from.height;
  if (grab.includes('w')) x0 = clamp01(x0 + dx);
  if (grab.includes('e')) x1 = clamp01(x1 + dx);
  if (grab.includes('n')) y0 = clamp01(y0 + dy);
  if (grab.includes('s')) y1 = clamp01(y1 + dy);
  // Dragged past the opposite side, it turns over rather than going negative.
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/** The resize cursor nearest a drag along (dx, dy) on screen, y down. */
function cursorAlong(dx: number, dy: number): string {
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180;
  return deg < 22.5 || deg >= 157.5
    ? 'ew-resize'
    : deg < 67.5
      ? 'nwse-resize'
      : deg < 112.5
        ? 'ns-resize'
        : 'nesw-resize';
}

/**
 * What to take hold of on a rectangle being drawn, drawn through `to` (the
 * picture's or the room's own drawing, on screen): its body, its sides and
 * its corners, each marked with its `data-grab` for `grabOf`. Handles keep
 * their size in pixels however the picture is scaled, and each cursor points
 * the way its handle goes as drawn, so a side in the room slants like it.
 */
export function RectHandles({
  rect,
  to,
  scale = { x: 1, y: 1 },
}: {
  rect: Rect;
  to: (p: Point) => Point;
  /** Screen pixels per unit of what `to` gives, when the drawing is stretched. */
  scale?: Point;
}) {
  const body = CORNERS.map((c) => to(cornerOf(rect, c)));
  const mid = {
    x: body.reduce((a, p) => a + p.x, 0) / 4,
    y: body.reduce((a, p) => a + p.y, 0) / 4,
  };
  const cursor = (from: Point, toward: Point) =>
    cursorAlong((toward.x - from.x) * scale.x, (toward.y - from.y) * scale.y);
  return (
    <g className="rect-handles">
      <polygon
        className="rect-body"
        data-grab="move"
        style={{ cursor: 'move' }}
        points={body.map((p) => `${p.x},${p.y}`).join(' ')}
      />
      {SIDES.map((s) => {
        const [p, q] = sideOf(rect, s).map(to) as [Point, Point];
        const half = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        return (
          <line
            key={s}
            className="rect-side"
            data-grab={s}
            style={{ cursor: cursor(mid, half) }}
            x1={p.x}
            y1={p.y}
            x2={q.x}
            y2={q.y}
          />
        );
      })}
      {CORNERS.map((c, i) => {
        const p = body[i]!;
        return (
          <line
            key={c}
            className="rect-corner"
            data-grab={c}
            style={{ cursor: cursor(mid, p) }}
            x1={p.x}
            y1={p.y}
            x2={p.x}
            y2={p.y}
          />
        );
      })}
    </g>
  );
}
