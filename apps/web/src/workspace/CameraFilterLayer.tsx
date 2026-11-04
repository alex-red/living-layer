import { useEffect, useRef, type RefObject } from 'react';
import { paintPixels, pixelGrid, type CameraFilterView, type PixelSpec } from './cameraFilter';
import './camera-filter.css';

// Privacy canvases redraw at most this often: blocks this big need no more, and it spares the page.
const PIXEL_FPS = 20;
// A crawling dither steps once per this many redraws.
const CRAWL_EVERY = 3;

/** The privacy canvas: the frame drawn small and scaled up in hard blocks, its colours cut down. */
function PixelCanvas({
  video,
  spec,
}: {
  video: RefObject<HTMLVideoElement | null>;
  spec: PixelSpec;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d', { willReadFrequently: true });
    if (!el || !ctx) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Black until the first frame: the video under it is hidden, so nothing private shows meanwhile.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, el.width, el.height);
    let raf = 0;
    let last = 0;
    let drawn = 0;
    // Frames that cannot be read back (a tainted source) are still drawn small, just not recoloured.
    let readable = true;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const v = video.current;
      if (!v || v.readyState < 2 || !v.videoWidth || now - last < 1000 / PIXEL_FPS) return;
      last = now;
      const { width, height } = pixelGrid(v.videoWidth, v.videoHeight, spec.cols);
      if (el.width !== width || el.height !== height) {
        el.width = width;
        el.height = height;
      }
      ctx.drawImage(v, 0, 0, width, height);
      if (!readable) return;
      try {
        const image = ctx.getImageData(0, 0, width, height);
        paintPixels(image.data, width, height, spec, still ? 0 : Math.floor(drawn / CRAWL_EVERY));
        ctx.putImageData(image, 0, 0);
        drawn++;
      } catch {
        readable = false;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [video, spec]);
  return <canvas ref={canvas} className="camera-pixels" width={1} height={1} aria-hidden="true" />;
}

/** What a camera filter draws over the video: a privacy canvas, or scan lines. */
export function CameraFilterLayer({
  video,
  view,
}: {
  video: RefObject<HTMLVideoElement | null>;
  view: CameraFilterView;
}) {
  return (
    <>
      {view.pixel && <PixelCanvas video={video} spec={view.pixel} />}
      {view.overlay === 'scan' && <div className="camera-scan" aria-hidden="true" />}
    </>
  );
}
