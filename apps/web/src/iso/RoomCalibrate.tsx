import { useMemo, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  cameraFromMarks,
  projectRoom,
  type CameraCrop,
  type Point,
  type RoomMarks,
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
  const [dragging, setDragging] = useState<number | null>(null);
  const r = Math.max(4, frame.width / 160);

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
    };
  }, [handles, ends]);
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
    return { ...f, path: lines.join('') };
  }, [marks, room, heightCm, frame, crop]);

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
          const near = handles
            .map((c, i) => ({ i, d: Math.hypot(c.x - p.x, c.y - p.y) }))
            .sort((a, b) => a.d - b.d)[0]!;
          if (near.d > reach) return;
          setDragging(near.i);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (dragging === null) return;
          const p = at(e);
          setHandles(handles.map((c, i) => (i === dragging ? p : c)));
        }}
        onPointerUp={() => setDragging(null)}
        onPointerCancel={() => setDragging(null)}
      >
        {fit && <path className="calibrate-grid" d={fit.path} vectorEffect="non-scaling-stroke" />}
        <polyline
          points={[handles[2]!, handles[0]!, handles[1]!].map((p) => `${p.x},${p.y}`).join(' ')}
          vectorEffect="non-scaling-stroke"
        />
        {handles.map((c, i) => (
          <circle
            key={i}
            className={dragging === i ? 'active' : ''}
            cx={c.x}
            cy={c.y}
            r={r * 1.6}
            role="slider"
            aria-label={HANDLES[i]}
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
              ? good
                ? `The floor grid should sit on the floor. Camera about ${fit.heightCm} cm up, ${Math.round(fit.hfovDeg)}° wide.`
                : `These marks don't fit a camera in the room's front corner (off by ${fit.error.toFixed(0)} px).`
              : 'Give the room’s size inside its walls.'}
          </span>
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
