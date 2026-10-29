import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { typing } from './shortcuts';

const MAX = 8;
const STEP = 1.25;
/** How far a press moves before it pans rather than clicks. */
const SLOP = 3;
/** How far past its edges the content may be panned, as a share of the view. */
const SLACK = 0.5;

interface View {
  s: number;
  x: number;
  y: number;
}
const FIT: View = { s: 1, x: 0, y: 0 };

/**
 * A view that zooms and pans what it holds, by CSS transform: the scroll
 * wheel or a pinch zooms about the pointer; a drag with Space held or with
 * the middle button pans, as does any drag with the `hand` tool, and so does
 * dragging the background (an element marked `data-pan`, not what is drawn
 * on it) once zoomed in. The content keeps its own pointer
 * handling: pointer maths through `getScreenCTM` or `getBoundingClientRect`
 * already sees the transform. A new `resetKey` goes back to fit, and `off`
 * (nothing to look at) keeps it there with no controls.
 */
export function ZoomPan({
  children,
  className = '',
  resetKey,
  off = false,
  hand = false,
}: {
  children: ReactNode;
  className?: string;
  resetKey?: unknown;
  off?: boolean;
  /** The hand tool: every drag pans, as with Space held. */
  hand?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT);
  const latest = useRef(view);
  latest.current = view;
  const offRef = useRef(off);
  offRef.current = off;
  const [space, setSpace] = useState(false);
  const grabbing = space || hand;
  const hovered = useRef(false);
  const press = useRef<{ id: number; x: number; y: number; from: View; panning: boolean } | null>(
    null,
  );
  const swallowClick = useRef(false);

  useEffect(() => setView(FIT), [resetKey, off]);

  /** The view kept near the box: no zooming out past fit, and the content never panned out of sight. */
  const clamp = (v: View): View => {
    const b = box.current;
    if (!b) return FIT;
    const s = Math.min(MAX, Math.max(1, v.s));
    const w = b.clientWidth;
    const h = b.clientHeight;
    return {
      s,
      x: Math.min(w * SLACK, Math.max(w - w * s - w * SLACK, v.x)),
      y: Math.min(h * SLACK, Math.max(h - h * s - h * SLACK, v.y)),
    };
  };
  /** Zoom by a factor about a point of the box, so that point stays put. */
  const zoomAt = (from: View, factor: number, px: number, py: number) => {
    const s = Math.min(MAX, Math.max(1, from.s * factor));
    const k = s / from.s;
    return clamp({ s, x: px - (px - from.x) * k, y: py - (py - from.y) * k });
  };
  const zoomBy = (factor: number) => {
    const b = box.current;
    if (b) setView((v) => zoomAt(v, factor, b.clientWidth / 2, b.clientHeight / 2));
  };

  // Wheel needs a listener that may cancel, which React's isn't.
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const onWheel = (e: WheelEvent) => {
      if (offRef.current) return;
      e.preventDefault();
      const r = b.getBoundingClientRect();
      // Line and page deltas (some mouse wheels) come in far fewer, larger steps than pixels.
      const dy = e.deltaMode ? e.deltaY * 16 : e.deltaY;
      // A pinch arrives as small Ctrl + wheel steps; a wheel notch is about 100 pixels.
      const rate = e.ctrlKey ? 0.01 : 0.002;
      setView(zoomAt(latest.current, Math.exp(-dy * rate), e.clientX - r.left, e.clientY - r.top));
    };
    b.addEventListener('wheel', onWheel, { passive: false });
    return () => b.removeEventListener('wheel', onWheel);
  }, []);

  // Space held over the view pans with any button, as in drawing tools.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !hovered.current || typing(e.target)) return;
      e.preventDefault();
      setSpace(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpace(false);
    };
    const blur = () => setSpace(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (off || press.current) return;
    const target = e.target as Element;
    if (target.closest('.zoom-controls')) return;
    // Only the background itself: a fixture or a zone drawn on it keeps its own drag.
    const background = e.button === 0 && view.s > 1 && target.hasAttribute('data-pan');
    if (!(e.button === 1 || grabbing || background)) return;
    // Space and the middle button pan whatever is under them; keep the content out of it.
    if (!background) {
      e.preventDefault();
      e.stopPropagation();
    }
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: view, panning: false };
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.panning) {
      if (Math.hypot(dx, dy) < SLOP) return;
      p.panning = true;
      try {
        box.current?.setPointerCapture(e.pointerId);
      } catch {
        /* panning still follows while the pointer stays over the view */
      }
    }
    setView(clamp({ ...p.from, x: p.from.x + dx, y: p.from.y + dy }));
  }
  function onPointerEnd(e: PointerEvent<HTMLDivElement>) {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    // A drag that panned isn't also a click on what it started over.
    swallowClick.current = p.panning;
    press.current = null;
  }

  const zoomed = view.s > 1;
  const fitted = view.s === 1 && view.x === 0 && view.y === 0;
  return (
    <div
      ref={box}
      className={`zoom-pan ${className} ${zoomed ? 'zoomed' : ''} ${grabbing && !off ? 'grab' : ''} ${press.current?.panning ? 'panning' : ''}`}
      onPointerEnter={() => (hovered.current = true)}
      onPointerLeave={() => (hovered.current = false)}
      onPointerDownCapture={(e) => {
        // The hand, Space and the middle button pan before the content sees the press.
        if (grabbing || e.button === 1) onPointerDown(e);
      }}
      onPointerDown={(e) => {
        if (!grabbing && e.button !== 1) onPointerDown(e);
      }}
      // The middle button would otherwise start the browser's autoscroll.
      onMouseDown={(e) => {
        if (e.button === 1 && !off) e.preventDefault();
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.stopPropagation();
      }}
      onDoubleClick={(e) => {
        if (!grabbing && (e.target as Element).hasAttribute('data-pan')) setView(FIT);
      }}
    >
      <div
        className="zoom-pan-content"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
      >
        {children}
      </div>
      {!off && (
        <div
          className="zoom-controls"
          role="group"
          aria-label="Zoom"
          title="Scroll or pinch to zoom. Hold Space and drag, or drag with the middle button, to pan; once zoomed, dragging the background pans too. Double-click the background to fit."
        >
          <button aria-label="Zoom out" disabled={!zoomed} onClick={() => zoomBy(1 / STEP)}>
            −
          </button>
          <button
            className="zoom-level"
            aria-label="Fit to view"
            disabled={fitted}
            onClick={() => setView(FIT)}
          >
            {Math.round(view.s * 100)}%
          </button>
          <button aria-label="Zoom in" disabled={view.s >= MAX} onClick={() => zoomBy(STEP)}>
            +
          </button>
        </div>
      )}
    </div>
  );
}
