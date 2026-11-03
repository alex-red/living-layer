import { useEffect, useState } from 'react';
import { demoFrame, type DemoPosition } from '@livinglayer/domain';
import type { DemoFrameReply } from './demoFrame.worker';

/** The picture's pixels as a canvas, on this thread. */
function canvasOf(position: DemoPosition): HTMLCanvasElement {
  const { width, height, rgba } = demoFrame(position);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas
    .getContext('2d')!
    .putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return canvas;
}

const dataUrls = new Map<DemoPosition, string>();
/**
 * The demo camera's frame as an image URL: the office rendered from its
 * corner with the mug at `position`, the same picture the server's demo
 * camera and synthetic SAM use. Rendered on this thread when not yet made:
 * for an action that needs it now. What a pane shows goes through
 * `useDemoFrameUrl`, which never renders on the way to a paint.
 */
export function demoFrameUrl(position: DemoPosition = 'centre'): string {
  let url = dataUrls.get(position);
  if (!url) {
    url = canvasOf(position).toDataURL('image/png');
    dataUrls.set(position, url);
  }
  return url;
}

/** Object URLs of the frames made off the render path, newest last; the oldest is let go past `KEEP`. */
const blobUrls = new Map<DemoPosition, Promise<string>>();
const KEEP = 3;
let worker: Worker | null | undefined;
const waiting = new Map<DemoPosition, (reply: DemoFrameReply) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  try {
    const w = new Worker(new URL('./demoFrame.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<DemoFrameReply>) => {
      waiting.get(e.data.position)?.(e.data);
      waiting.delete(e.data.position);
    };
    w.onerror = () => {
      // A worker that can't start or crashed: render on this thread, when idle, from now on.
      worker = null;
      w.terminate();
      for (const [position, done] of waiting) done({ position, error: 'demo frame worker failed' });
      waiting.clear();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** On this thread, once it is idle (or soon, where there is no idle callback). */
function blobHere(position: DemoPosition): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const work = () =>
      canvasOf(position).toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('The demo frame could not be drawn.'))),
        'image/png',
      );
    if (typeof requestIdleCallback === 'function') requestIdleCallback(work, { timeout: 500 });
    else setTimeout(work, 0);
  });
}

function blobOf(position: DemoPosition): Promise<Blob> {
  const w = getWorker();
  if (!w) return blobHere(position);
  return new Promise<DemoFrameReply>((resolve) => {
    waiting.set(position, resolve);
    w.postMessage(position);
  }).then((reply) => reply.blob ?? blobHere(position));
}

/** The demo frame at `position` as an object URL, rendered off the render path and kept for the last few positions. */
function demoFrameBlobUrl(position: DemoPosition = 'centre'): Promise<string> {
  let url = blobUrls.get(position);
  if (url) {
    // The newest goes last, so eviction lets go of the least recently asked.
    blobUrls.delete(position);
    blobUrls.set(position, url);
    return url;
  }
  url = blobOf(position).then((blob) => URL.createObjectURL(blob));
  blobUrls.set(position, url);
  url.catch(() => blobUrls.delete(position));
  while (blobUrls.size > KEEP) {
    const [oldest, old] = blobUrls.entries().next().value!;
    blobUrls.delete(oldest);
    void old.then(URL.revokeObjectURL, () => {});
  }
  return url;
}

/**
 * The demo frame at `position` for a pane to show: undefined until it is
 * ready, then its URL. The last frame shown stays until the next is ready.
 */
export function useDemoFrameUrl(position: DemoPosition, on = true): string | undefined {
  const [shown, setShown] = useState<{ position: DemoPosition; url: string }>();
  useEffect(() => {
    if (!on) return;
    let current = true;
    void demoFrameBlobUrl(position)
      .then((url) => {
        if (current) setShown({ position, url });
      })
      .catch(() => {
        if (current) setShown({ position, url: demoFrameUrl(position) });
      });
    return () => {
      current = false;
    };
  }, [on, position]);
  return shown?.url;
}
