import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { readUi, writeUi } from './session';
import { typing } from './shortcuts';
import { Button, IconButton } from './ui/controls';
import './zoom-pan.css';

const MAX = 8;
const STEP = 1.25;
/** How far a press moves before it pans rather than clicks. */
const SLOP = 3;
/** How far past its edges the content may be panned, as a share of the view. */
const SLACK = 0.5;

/** The highest zoom step `useZoomStep` reports. */
const MAX_STEP = 4;
/**
 * The view's zoom rounded to a power of two (1, 2 or 4), and 1 outside a
 * `ZoomPan`: content drawn at a fixed pixel size redraws finer only when it
 * changes, not on every wheel step.
 */
const ZoomStep = createContext(1);
export function useZoomStep(): number {
  return useContext(ZoomStep);
}

/**
 * The view as it is drawn: its zoom `s`, its pan `x`, `y` and the box's size
 * `w`, `h`, in pixels; `s` is 1 and the box 0 × 0 outside a `ZoomPan`. It
 * changes on every pan and zoom step, so only small parts should read it.
 */
interface ZoomView {
  s: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
const ZoomViewContext = createContext<ZoomView>({ s: 1, x: 0, y: 0, w: 0, h: 0 });
export function useZoomView(): ZoomView {
  return useContext(ZoomViewContext);
}

interface View {
  s: number;
  x: number;
  y: number;
}
const FIT: View = { s: 1, x: 0, y: 0 };
/** Views kept per `store`, newest last; older ones are dropped. */
const KEPT_VIEWS = 20;
/** A kept view: its zoom, and its pan as shares of the box, so it survives a resize. */
type Kept = { s: number; x: number; y: number };
function keptViews(store: string): [string, Kept][] {
  const data = readUi(`zoom:${store}`);
  return Array.isArray(data) ? (data as [string, Kept][]) : [];
}

/**
 * A view that zooms and pans what it holds, by CSS transform: the scroll
 * wheel or a pinch zooms about the pointer; a drag with Space held or with
 * the middle button pans, as does any drag with the `hand` tool, and so does
 * dragging the background (an element marked `data-pan`, not what is drawn
 * on it) once zoomed in. The content keeps its own pointer
 * handling: pointer maths through `getScreenCTM` or `getBoundingClientRect`
 * already sees the transform. A new `resetKey` goes back to fit, and `off`
 * (nothing to look at) keeps it there with no controls. With `store`, this
 * browser keeps the zoom of each `resetKey` and puts it back on a reload.
 */
export function ZoomPan({
  children,
  className = '',
  resetKey,
  off = false,
  hand = false,
  store,
}: {
  children: ReactNode;
  className?: string;
  resetKey?: unknown;
  off?: boolean;
  /** The hand tool: every drag pans, as with Space held. */
  hand?: boolean;
  /** The name this view's zoom is kept under, per `resetKey`. */
  store?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT);
  const offRef = useRef(off);
  offRef.current = off;
  const [space, setSpace] = useState(false);
  const grabbing = space || hand;
  const hovered = useRef(false);
  const press = useRef<{ id: number; x: number; y: number; from: View; panning: boolean } | null>(
    null,
  );
  const swallowClick = useRef(false);
  // The box's size, for what reads the view (`useZoomView`).
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const read = () => setSize({ w: b.clientWidth, h: b.clientHeight });
    read();
    const watch = new ResizeObserver(read);
    watch.observe(b);
    return () => watch.disconnect();
  }, []);
  const drawn = useMemo(
    () => ({ s: view.s, x: view.x, y: view.y, w: size.w, h: size.h }),
    [view, size],
  );

  const viewKey = String(resetKey);
  // The view written next, with where and at what box size, kept until it is
  // written so an unmount (a hot reload) doesn't lose it.
  const unsaved = useRef<{ store: string; key: string; kept: Kept } | null>(null);
  const skipSave = useRef(false);
  const save = () => {
    const next = unsaved.current;
    unsaved.current = null;
    if (!next) return;
    const rest = keptViews(next.store).filter(([k]) => k !== next.key);
    writeUi(
      `zoom:${next.store}`,
      next.kept.s === 1 ? rest : [...rest, [next.key, next.kept]].slice(-KEPT_VIEWS),
    );
  };
  useEffect(() => {
    skipSave.current = true;
    const b = box.current;
    const kept = store && !off ? keptViews(store).find(([k]) => k === viewKey)?.[1] : undefined;
    setView(
      kept && b?.clientWidth
        ? clamp({ s: kept.s, x: kept.x * b.clientWidth, y: kept.y * b.clientHeight })
        : FIT,
    );
    // The view is read again for a new reset key or when the zoom is switched off, not when `store` changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, off]);
  // Kept a moment after it settles, not on every wheel step or drag move.
  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    const b = box.current;
    if (!store || off || !b?.clientWidth || !b.clientHeight) return;
    unsaved.current = {
      store,
      key: viewKey,
      kept: { s: view.s, x: view.x / b.clientWidth, y: view.y / b.clientHeight },
    };
    const timer = window.setTimeout(save, 300);
    return () => window.clearTimeout(timer);
    // Kept a moment after `view` settles; `store`, `off` and the key are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  useEffect(() => () => save(), []);

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
    // The box's place, read once per gesture: a pinch sends many steps a frame,
    // and reading it on each would lay the page out again each time.
    let rect: DOMRect | null = null;
    let gestureEnd = 0;
    const onWheel = (e: WheelEvent) => {
      if (offRef.current) return;
      e.preventDefault();
      rect ??= b.getBoundingClientRect();
      window.clearTimeout(gestureEnd);
      gestureEnd = window.setTimeout(() => (rect = null), 150);
      // Line and page deltas (some mouse wheels) come in far fewer, larger steps than pixels.
      const dy = e.deltaMode ? e.deltaY * 16 : e.deltaY;
      // A pinch arrives as small Ctrl + wheel steps; a wheel notch is about 100 pixels.
      const rate = e.ctrlKey ? 0.01 : 0.002;
      const factor = Math.exp(-dy * rate);
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // From the view as the last step left it, even if it isn't drawn yet, so no step is lost.
      setView((v) => zoomAt(v, factor, px, py));
    };
    b.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      b.removeEventListener('wheel', onWheel);
      window.clearTimeout(gestureEnd);
    };
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
        style={
          {
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
            '--zoom': view.s,
          } as CSSProperties
        }
      >
        <ZoomStep.Provider value={Math.min(MAX_STEP, 2 ** Math.round(Math.log2(view.s)))}>
          <ZoomViewContext.Provider value={drawn}>{children}</ZoomViewContext.Provider>
        </ZoomStep.Provider>
      </div>
      {!off && (
        <div
          className="zoom-controls"
          role="group"
          aria-label="Zoom"
          title="Scroll or pinch to zoom. Hold Space and drag, or drag with the middle button, to pan; once zoomed, dragging the background pans too. Double-click the background to fit."
        >
          <IconButton
            label="Zoom out"
            size="sm"
            disabled={!zoomed}
            onClick={() => zoomBy(1 / STEP)}
          >
            −
          </IconButton>
          <Button
            variant="ghost"
            size="sm"
            className="zoom-level"
            aria-label="Fit to view"
            disabled={fitted}
            onClick={() => setView(FIT)}
          >
            {Math.round(view.s * 100)}%
          </Button>
          <IconButton
            label="Zoom in"
            size="sm"
            disabled={view.s >= MAX}
            onClick={() => zoomBy(STEP)}
          >
            +
          </IconButton>
        </div>
      )}
    </div>
  );
}
