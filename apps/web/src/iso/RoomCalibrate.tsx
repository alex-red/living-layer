import { useEffect, useMemo, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  cameraFromMarks,
  projectRoom,
  roomScaleFor,
  roomShapeFor,
  roomSizeFor,
  unprojectRoom,
  uprightAt,
  type CameraCrop,
  type HeightMark,
  type Point,
  type RoomMarks,
  type VerticalMark,
} from '@livinglayer/domain';

/** What a calibration needs from the person: the marks, and the room's size. */
export interface CalibrationDraft {
  marks: RoomMarks;
  /** Inside the walls, in centimetres. */
  room: { w: number; d: number };
  /** The camera's height, when the person knows it. */
  heightCm?: number;
}
const HANDLES = ['far corner', 'back wall', 'left wall'] as const;
/** A room size that fits the marks better: one wall's length, the other kept, or both scaled to the heights. */
interface Suggestion {
  wall: 'Back wall' | 'Left wall' | 'Both walls';
  room: { w: number; d: number };
  error: number;
}

/**
 * Calibrates the room's corner camera on its frame. Three handles: the far
 * floor corner, and a point along the floor line of each wall, as far along
 * as the frame shows it. When a wall's far end is in view, ticking it says
 * the handle is that end, which pins the lens down. While dragging, the
 * camera is fitted in the browser and the floor's tiles are drawn through it,
 * so a wrong mark shows as a floor grid that doesn't sit on the floor. The
 * frame's zoomed view is fitted as the server will fit it, so the grid and
 * the check agree with what saving does. The size and buttons go in `panel`,
 * outside the zoomable frame, so they never pan away or cover the marks.
 *
 * Height lines go straight up from the floor to something of known height,
 * a desk's top or a door's frame. The floor marks only give the room's
 * shape; a known height gives its size and the camera's, and the room's size
 * that fits them is offered like a wall's.
 *
 * Vertical lines go along anything that stands straight up, a shelf's post
 * or a door's edge, with no length: the floor marks barely say which way is
 * up, so these set the camera's tilt. The upright the camera draws through
 * each one's middle shows beside it.
 */
export function RoomCalibrate({
  frame,
  initial,
  busy,
  crop = null,
  panel,
  onSave,
  onCancel,
}: {
  frame: { width: number; height: number };
  /** The camera's zoomed view the frame came through. */
  crop?: CameraCrop | null;
  /** Where the size and buttons go; over the frame when there is none. */
  panel?: HTMLElement | null;
  initial: CalibrationDraft;
  busy: boolean;
  onSave: (draft: CalibrationDraft) => void;
  onCancel: () => void;
}) {
  const start = initial.marks;
  const [handles, setHandles] = useState<Point[]>([
    start.corner,
    start.backEnd ?? start.back.at(-1) ?? { x: frame.width * 0.8, y: frame.height * 0.7 },
    start.leftEnd ?? start.left.at(-1) ?? { x: frame.width * 0.2, y: frame.height * 0.6 },
  ]);
  const [ends, setEnds] = useState({ back: Boolean(start.backEnd), left: Boolean(start.leftEnd) });
  const [room, setRoom] = useState(initial.room);
  const [height, setHeight] = useState(initial.heightCm ? String(initial.heightCm) : '');
  const [lines, setLines] = useState<HeightMark[]>(start.heights ?? []);
  const [uprights, setUprights] = useState<VerticalMark[]>(start.verticals ?? []);
  // Handles 0–2 are the corner and the walls; then each height line's foot and top; then
  // each vertical line's ends.
  const [dragging, setDragging] = useState<number | null>(null);
  const r = Math.max(4, frame.width / 160);
  const all = [
    ...handles,
    ...lines.flatMap((l) => [l.foot, l.top]),
    ...uprights.flatMap((l) => [l.a, l.b]),
  ];
  const firstUpright = handles.length + lines.length * 2;
  const moveHandle = (i: number, p: Point) => {
    if (i < handles.length) return setHandles(handles.map((c, j) => (j === i ? p : c)));
    if (i >= firstUpright) {
      const k = Math.floor((i - firstUpright) / 2);
      const end = (i - firstUpright) % 2 ? 'b' : 'a';
      return setUprights(uprights.map((l, j) => (j === k ? { ...l, [end]: p } : l)));
    }
    const k = Math.floor((i - handles.length) / 2);
    const end = (i - handles.length) % 2 ? 'top' : 'foot';
    setLines(lines.map((l, j) => (j === k ? { ...l, [end]: p } : l)));
  };

  const marks: RoomMarks = useMemo(() => {
    const [corner, back, left] = handles as [Point, Point, Point];
    const along = (to: Point) =>
      [1, 2, 3, 4, 5, 6].map((k) => ({
        x: corner.x + ((to.x - corner.x) * k) / 6,
        y: corner.y + ((to.y - corner.y) * k) / 6,
      }));
    return {
      corner,
      back: along(back),
      left: along(left),
      backEnd: ends.back ? back : null,
      leftEnd: ends.left ? left : null,
      ...(lines.length ? { heights: lines } : {}),
      ...(uprights.length ? { verticals: uprights } : {}),
    };
  }, [handles, ends, lines, uprights]);
  const heightCm = Number(height) || undefined;
  // The camera these marks imply, and the floor's tiles drawn through it.
  const fit = useMemo(() => {
    if (!(room.w >= 60 && room.d >= 60)) return null;
    const tiles = { w: room.w / 30, d: room.d / 30 };
    const f = cameraFromMarks(marks, frame, tiles, { ...(heightCm ? { heightCm } : {}), crop });
    const lines: string[] = [];
    const draw = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const p = projectRoom(f.camera, { ...a, z: 0 });
      const q = projectRoom(f.camera, { ...b, z: 0 });
      if (p && q) lines.push(`M${p.x} ${p.y}L${q.x} ${q.y}`);
    };
    for (let x = 0; x <= tiles.w; x += 1) draw({ x, y: 0 }, { x, y: tiles.d });
    for (let y = 0; y <= tiles.d; y += 1) draw({ x: 0, y }, { x: tiles.w, y });
    // Where the camera puts each height line's top: on its mark when the size and height agree.
    const tops = (marks.heights ?? []).map((m) => {
      const foot = unprojectRoom(f.camera, m.foot, 0);
      return foot && projectRoom(f.camera, { x: foot.x, y: foot.y, z: m.cm / 30 });
    });
    // The camera's upright through each vertical line's middle, as long as the line.
    const ups = (marks.verticals ?? []).map((m) => {
      const mid = { x: (m.a.x + m.b.x) / 2, y: (m.a.y + m.b.y) / 2 };
      const u = uprightAt(f.camera, mid);
      const half = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) / 2;
      return `M${mid.x - u.x * half} ${mid.y - u.y * half}L${mid.x + u.x * half} ${mid.y + u.y * half}`;
    });
    return { ...f, path: lines.join(''), tops, ups };
  }, [marks, room, heightCm, frame, crop]);

  // Marks pin the room's shape, not its size: when the grid misses them, the
  // shape is wrong, so say which length of either wall would fit, keeping the
  // other. Searched once a drag ends, after the grid has drawn.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const miss = Math.hypot(frame.width, frame.height) / 250;
  useEffect(() => {
    setSuggestions([]);
    if (dragging !== null || !fit || fit.error < miss) return;
    const timer = setTimeout(() => {
      const tiles = { w: room.w / 30, d: room.d / 30 };
      const options = { ...(heightCm ? { heightCm } : {}), crop };
      // Both walls: scaled by known heights, else each found again by the uprights.
      const scaled = marks.heights?.length
        ? roomScaleFor(marks, frame, tiles, options)
        : marks.verticals?.length
          ? roomShapeFor(marks, frame, tiles, options)
          : null;
      setSuggestions(
        [
          ...(scaled ? [{ wall: 'Both walls' as const, found: scaled }] : []),
          ...(['d', 'w'] as const).map((solve) => ({
            wall: solve === 'w' ? ('Back wall' as const) : ('Left wall' as const),
            found: roomSizeFor(marks, frame, tiles, solve, options),
          })),
        ]
          .map(({ wall, found }) => ({
            wall,
            room: { w: Math.round(found.room.w * 30), d: Math.round(found.room.d * 30) },
            error: found.error,
          }))
          // Only a clear gain, and not the size already there.
          .filter((x) => x.error < fit.error * 0.7 && x.error < fit.error - 2)
          .filter((x) => x.room.w !== room.w || x.room.d !== room.d)
          .sort((a, b) => a.error - b.error),
      );
    }, 50);
    return () => clearTimeout(timer);
  }, [fit, dragging, marks, room, heightCm, crop, frame, miss]);

  const at = (e: PointerEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) * frame.width,
      y: Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)) * frame.height,
    };
  };
  const good = fit && fit.error < Math.hypot(frame.width, frame.height) / 60;
  return (
    <>
      <svg
        className="pin-overlay adjusting calibrate-overlay"
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        preserveAspectRatio="none"
        aria-label="Room calibration: drag the far corner and a point along each wall's floor line"
        onPointerDown={(e) => {
          const p = at(e);
          const reach = (frame.width / e.currentTarget.getBoundingClientRect().width) * 28;
          const near = all
            .map((c, i) => ({ i, d: Math.hypot(c.x - p.x, c.y - p.y) }))
            .sort((a, b) => a.d - b.d)[0]!;
          if (near.d > reach) return;
          setDragging(near.i);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (dragging === null) return;
          moveHandle(dragging, at(e));
        }}
        onPointerUp={() => setDragging(null)}
        onPointerCancel={() => setDragging(null)}
      >
        {fit && <path className="calibrate-grid" d={fit.path} vectorEffect="non-scaling-stroke" />}
        <polyline
          points={[handles[2]!, handles[0]!, handles[1]!].map((p) => `${p.x},${p.y}`).join(' ')}
          vectorEffect="non-scaling-stroke"
        />
        {lines.map((l, k) => {
          const drawn = fit?.tops[k];
          return (
            <g key={`h${k}`} className="calibrate-height">
              <line
                x1={l.foot.x}
                y1={l.foot.y}
                x2={l.top.x}
                y2={l.top.y}
                vectorEffect="non-scaling-stroke"
              />
              {drawn && (
                <path
                  className="calibrate-height-fit"
                  d={`M${drawn.x - r} ${drawn.y}H${drawn.x + r}M${drawn.x} ${drawn.y - r}V${drawn.y + r}`}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <text x={l.top.x + r * 2} y={l.top.y} fontSize={r * 3}>
                {l.cm} cm
              </text>
            </g>
          );
        })}
        {uprights.map((l, k) => (
          <g key={`v${k}`} className="calibrate-upright">
            <line x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} vectorEffect="non-scaling-stroke" />
            {fit?.ups[k] && (
              <path
                className="calibrate-upright-fit"
                d={fit.ups[k]}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </g>
        ))}
        {all.map((c, i) => (
          <circle
            key={i}
            className={dragging === i ? 'active' : ''}
            cx={c.x}
            cy={c.y}
            r={r * 1.6}
            role="slider"
            aria-label={
              HANDLES[i] ??
              (i >= firstUpright
                ? `vertical line ${Math.floor((i - firstUpright) / 2) + 1} ${(i - firstUpright) % 2 ? 'top' : 'bottom'}`
                : `height line ${Math.floor((i - handles.length) / 2) + 1} ${(i - handles.length) % 2 ? 'top' : 'floor'}`)
            }
            aria-valuetext={`${Math.round(c.x)}, ${Math.round(c.y)}`}
          />
        ))}
      </svg>
      {(panel ? (c: ReactNode) => createPortal(c, panel) : (c: ReactNode) => c)(
        <span
          className={panel ? 'calibrate-tag calibrate-panel' : 'pin-tag pin-review calibrate-tag'}
          aria-live="polite"
        >
          <span>
            {fit
              ? suggestions.length
                ? (lines.length || uprights.length) && suggestions[0]!.wall === 'Both walls'
                  ? `The marks miss by ${fit.error.toFixed(0)} px: the ${lines.length ? 'height' : 'vertical'} lines say the room is another size. Try:`
                  : `The grid misses the marks by ${fit.error.toFixed(0)} px: a room this shape can’t look like that from its front corner. Measure a wall, or try:`
                : good
                  ? `The floor grid should sit on the floor. Camera about ${fit.heightCm} cm up, ${Math.round(fit.hfovDeg)}° wide.`
                  : `These marks don't fit a camera in the room's front corner (off by ${fit.error.toFixed(0)} px).`
              : 'Give the room’s size inside its walls.'}
          </span>
          {suggestions.map((x) => (
            <button
              key={x.wall}
              className="secondary"
              title={
                x.wall === 'Both walls'
                  ? lines.length
                    ? `The room’s size the height lines say, its shape kept; the marks then miss by ${x.error.toFixed(1)} px.`
                    : `The room’s size at which the floor and the uprights agree; the marks then miss by ${x.error.toFixed(1)} px. A wall you have measured pins it exactly.`
                  : `Keeps the ${x.wall === 'Back wall' ? 'left' : 'back'} wall as it is; the grid then misses by ${x.error.toFixed(1)} px.`
              }
              onClick={() => setRoom(x.room)}
            >
              {x.wall === 'Both walls'
                ? `Room ${x.room.w} × ${x.room.d} cm`
                : `${x.wall} ${x.wall === 'Back wall' ? x.room.w : x.room.d} cm`}{' '}
              · {x.error.toFixed(0)} px
            </button>
          ))}
          <label title="The back wall: the one running right from the far corner.">
            Back wall
            <input
              type="number"
              min={60}
              max={480}
              value={room.w}
              onChange={(e) => setRoom({ ...room, w: Number(e.target.value) })}
            />
            cm
          </label>
          <label title="The left wall: the one running left from the far corner.">
            Left wall
            <input
              type="number"
              min={60}
              max={480}
              value={room.d}
              onChange={(e) => setRoom({ ...room, d: Number(e.target.value) })}
            />
            cm
          </label>
          <label>
            Camera height
            <input
              type="number"
              min={100}
              max={400}
              placeholder="240"
              value={height}
              onChange={(e) => setHeight(e.target.value)}
            />
            cm
          </label>
          {lines.map((l, k) => (
            <label key={k} title="How high the line's top is above the floor it stands on.">
              Height line {k + 1}
              <input
                type="number"
                min={5}
                max={400}
                value={l.cm}
                aria-label={`Height line ${k + 1} in centimetres`}
                onChange={(e) =>
                  setLines(
                    lines.map((x, j) => (j === k ? { ...x, cm: Number(e.target.value) } : x)),
                  )
                }
              />
              cm
              <button
                className="secondary"
                aria-label={`Remove height line ${k + 1}`}
                onClick={() => setLines(lines.filter((_, j) => j !== k))}
              >
                ✕
              </button>
            </label>
          ))}
          {lines.length < 8 && (
            <button
              className="secondary"
              title="Draw a line from the floor straight up to something whose height you know, like a desk's top (76 cm for an ALEX), then type its height. It gives the room's real size."
              onClick={() =>
                setLines([
                  ...lines,
                  {
                    foot: { x: frame.width * (0.4 + 0.08 * lines.length), y: frame.height * 0.8 },
                    top: { x: frame.width * (0.4 + 0.08 * lines.length), y: frame.height * 0.62 },
                    cm: 76,
                  },
                ])
              }
            >
              Add height line
            </button>
          )}
          {uprights.map((_, k) => (
            <label key={`v${k}`} title="Drag its ends along something that stands straight up.">
              Vertical line {k + 1}
              <button
                className="secondary"
                aria-label={`Remove vertical line ${k + 1}`}
                onClick={() => setUprights(uprights.filter((_, j) => j !== k))}
              >
                ✕
              </button>
            </label>
          ))}
          {uprights.length < 8 && (
            <button
              className="secondary"
              title="Drag a line along something that stands straight up, like a shelf's post, a door's edge or a desk's leg; no length needed. Two or three, apart across the frame, set the camera's tilt, so the room's uprights lean as they do in the picture."
              onClick={() =>
                setUprights([
                  ...uprights,
                  {
                    a: { x: frame.width * (0.3 + 0.12 * uprights.length), y: frame.height * 0.75 },
                    b: { x: frame.width * (0.3 + 0.12 * uprights.length), y: frame.height * 0.35 },
                  },
                ])
              }
            >
              Add vertical line
            </button>
          )}
          <label>
            <input
              type="checkbox"
              checked={ends.back}
              onChange={(e) => setEnds({ ...ends, back: e.target.checked })}
            />
            Back wall handle is its far corner
          </label>
          <label>
            <input
              type="checkbox"
              checked={ends.left}
              onChange={(e) => setEnds({ ...ends, left: e.target.checked })}
            />
            Left wall handle is its far corner
          </label>
          <button
            className="primary"
            disabled={!good || busy}
            onClick={() => onSave({ marks, room, ...(heightCm ? { heightCm } : {}) })}
          >
            {busy ? 'Saving…' : 'Save calibration'}
          </button>
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </span>,
      )}
    </>
  );
}
