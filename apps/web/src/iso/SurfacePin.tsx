import { useState, type PointerEvent } from 'react';
import { quadIsConvex, type Point, type Quad } from '@livinglayer/domain';

const CORNERS = ['back left', 'back right', 'front right', 'front left'];

/**
 * Collects four clicks on the photo, clockwise from the surface's back-left
 * corner, in the frame's own pixels. A folded or tiny shape starts over.
 */
export function SurfacePin({
  frame,
  label,
  onDone,
}: {
  frame: { width: number; height: number };
  label: string;
  onDone: (corners: Quad) => void;
}) {
  const [points, setPoints] = useState<Point[]>([]);
  const [hint, setHint] = useState('');
  function add(e: PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const p = {
      x: Math.round(((e.clientX - r.left) / r.width) * frame.width),
      y: Math.round(((e.clientY - r.top) / r.height) * frame.height),
    };
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
          <circle key={i} cx={p.x} cy={p.y} r={Math.max(4, frame.width / 160)} />
        ))}
      </svg>
      <span className="pin-tag" aria-live="polite">
        {hint ||
          `Click the ${CORNERS[points.length]} corner of the ${label} · ${points.length + 1}/4`}
      </span>
    </>
  );
}
