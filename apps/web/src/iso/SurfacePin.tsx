import { useState, type PointerEvent } from 'react';
import { quadIsConvex, type Point, type Quad } from '@livinglayer/domain';
import { Button } from '../ui/controls';

const CORNERS = ['back left', 'back right', 'front right', 'front left'];

/**
 * Pins a surface on the photo, in the frame's own pixels. With no `initial`
 * corners it collects four clicks, clockwise from the back-left corner; a
 * folded or tiny shape starts over. With `initial` corners (found from the
 * photo), each corner can be dragged, and the pin is saved from the tag.
 */
export function SurfacePin({
  frame,
  label,
  initial,
  note,
  onDone,
}: {
  frame: { width: number; height: number };
  label: string;
  /** Corners found automatically, to check and adjust. */
  initial?: Quad;
  /** What to say about the found corners, such as how sure the fit is. */
  note?: string;
  onDone: (corners: Quad) => void;
}) {
  const [points, setPoints] = useState<Point[]>([]);
  const [corners, setCorners] = useState<Quad | null>(initial ?? null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [hint, setHint] = useState('');
  const r = Math.max(4, frame.width / 160);
  const at = (e: PointerEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.round(Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) * frame.width),
      y: Math.round(Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)) * frame.height),
    };
  };
  function add(e: PointerEvent<SVGSVGElement>) {
    const p = at(e);
    const next = [...points, p];
    if (next.length < 4) {
      setPoints(next);
      setHint('');
      return;
    }
    if (!quadIsConvex(next as Quad, (frame.width * frame.height) / 400)) {
      setPoints([]);
      setHint('Those corners cross or are too close. Start again from the back left.');
      return;
    }
    setPoints([]);
    onDone(next as Quad);
  }

  if (corners) {
    const ok = quadIsConvex(corners, (frame.width * frame.height) / 400);
    return (
      <>
        <svg
          className="pin-overlay adjusting"
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          preserveAspectRatio="none"
          aria-label={`Corners found for the ${label}; drag any that are off`}
          onPointerDown={(e) => {
            const p = at(e);
            // The nearest corner within reach, scaled for the frame's size on screen.
            const reach = (frame.width / e.currentTarget.getBoundingClientRect().width) * 28;
            const near = corners
              .map((c, i) => ({ i, d: Math.hypot(c.x - p.x, c.y - p.y) }))
              .sort((a, b) => a.d - b.d)[0]!;
            if (near.d > reach) return;
            setDragging(near.i);
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (dragging === null) return;
            const p = at(e);
            setCorners(corners.map((c, i) => (i === dragging ? p : c)) as Quad);
          }}
          onPointerUp={() => setDragging(null)}
          onPointerCancel={() => setDragging(null)}
        >
          <polygon points={corners.map((c) => `${c.x},${c.y}`).join(' ')} />
          {corners.map((c, i) => (
            <circle
              key={i}
              className={dragging === i ? 'active' : ''}
              cx={c.x}
              cy={c.y}
              r={r * 1.6}
              role="slider"
              aria-label={`${CORNERS[i]} corner`}
              aria-valuetext={`${Math.round(c.x)}, ${Math.round(c.y)}`}
            />
          ))}
        </svg>
        <span className="pin-tag pin-review" aria-live="polite">
          <span>
            {ok
              ? (note ?? `Found the ${label}. Drag any corner that’s off, then save.`)
              : 'Those corners cross. Drag them apart, or click the corners yourself.'}
          </span>
          <Button variant="primary" disabled={!ok} onClick={() => onDone(corners)}>
            Save pin
          </Button>
          <Button onClick={() => setCorners(null)}>Click corners instead</Button>
        </span>
      </>
    );
  }
  return (
    <>
      <svg
        className="pin-overlay"
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        preserveAspectRatio="none"
        aria-label={`Click the ${CORNERS[points.length]} corner of the ${label}`}
        onPointerDown={add}
      >
        {points.length > 1 && <polyline points={points.map((p) => `${p.x},${p.y}`).join(' ')} />}
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={r} />
        ))}
      </svg>
      <span className="pin-tag" aria-live="polite">
        {hint ||
          `Click the ${CORNERS[points.length]} corner of the ${label} · ${points.length + 1}/4`}
      </span>
    </>
  );
}
