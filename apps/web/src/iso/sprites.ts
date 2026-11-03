import { useEffect, useState } from 'react';
import { PROP_TONES, type IsoItem, type IsoProp } from '@livinglayer/domain';
import { draw, spriteKey, type Drawn, type SpriteRequest } from './sprite-draw';
import type { WorkerReply } from './sprite.worker';

/**
 * Sprites drawn by the model kernel, turned into image URLs once and kept by
 * what they depend on, so dragging or re-rendering never draws them again.
 *
 * Drawing happens in a Worker (`sprite.worker.ts`) and the page gets object
 * URLs; `useItemSprite` and friends keep the last image until the new one is
 * ready. Where there is no Worker or OffscreenCanvas (and in bun tests) the
 * same `draw` runs on the main thread. The synchronous `itemSprite`,
 * `propSprite` and `viewOverlay` stay for code that needs pixels in the same
 * tick (`FixturePanel`'s sizing); they share the cache.
 */
export interface SpriteImage {
  url: string;
  /** Top-left corner and size in iso pixels, relative to the model's origin. */
  x: number;
  y: number;
  width: number;
  height: number;
}

// --- cache: least recently used, bounded by entries and bytes ----------------

interface Entry {
  image: SpriteImage;
  bytes: number;
}
const cache = new Map<string, Entry>();
const MAX_ENTRIES = 400;
const MAX_BYTES = 48 * 1024 * 1024;
/** An evicted image may still be on screen for a moment; revoke its URL after this. */
const REVOKE_DELAY_MS = 30_000;
let totalBytes = 0;

function remember(key: string, image: SpriteImage, bytes: number) {
  const old = cache.get(key);
  if (old) totalBytes -= old.bytes;
  cache.delete(key);
  cache.set(key, { image, bytes });
  totalBytes += bytes;
  for (const [k, e] of cache) {
    if (cache.size <= MAX_ENTRIES && totalBytes <= MAX_BYTES) break;
    if (k === key) break;
    cache.delete(k);
    totalBytes -= e.bytes;
    if (e.image.url.startsWith('blob:')) {
      const url = e.image.url;
      setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
    }
  }
}
function recall(key: string): SpriteImage | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  cache.delete(key);
  cache.set(key, e);
  return e.image;
}

// --- main thread -------------------------------------------------------------

function toDataUrl(d: Drawn): string {
  if (typeof document === 'undefined') return '';
  const canvas = document.createElement('canvas');
  canvas.width = d.width;
  canvas.height = d.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.putImageData(new ImageData(new Uint8ClampedArray(d.rgba), d.width, d.height), 0, 0);
  return canvas.toDataURL('image/png');
}
function imageOf(d: Omit<Drawn, 'rgba'>, url: string): SpriteImage {
  return { url, x: d.x, y: d.y, width: d.shownWidth, height: d.shownHeight };
}
function drawHere(request: SpriteRequest): SpriteImage {
  const key = spriteKey(request);
  const hit = recall(key);
  if (hit) return hit;
  const d = draw(request);
  const url = toDataUrl(d);
  const image = imageOf(d, url);
  remember(key, image, url.length);
  return image;
}

// --- worker ------------------------------------------------------------------

interface Pending {
  resolve: (r: WorkerReply) => void;
  reject: (e: unknown) => void;
}
let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof document === 'undefined'
  )
    return null;
  try {
    const w = new Worker(new URL('./sprite.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerReply>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      p.resolve(e.data);
    };
    w.onerror = () => {
      // A worker that can't start or crashed: finish what was asked on this thread from now on.
      worker = null;
      w.terminate();
      for (const p of pending.values()) p.reject(new Error('sprite worker failed'));
      pending.clear();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

const inflight = new Map<string, Promise<SpriteImage>>();

/** Draws a sprite off the main thread when it can; resolves at once for a cached one. */
export function loadSprite(request: SpriteRequest): Promise<SpriteImage> {
  const key = spriteKey(request);
  const hit = recall(key);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  const later = () => new Promise<SpriteImage>((r) => setTimeout(() => r(drawHere(request)), 0));
  const w = getWorker();
  const job = w
    ? new Promise<WorkerReply>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, request });
      }).then(
        (reply) => {
          if (!reply.blob || !reply.meta) return later();
          const image = imageOf(reply.meta, URL.createObjectURL(reply.blob));
          remember(key, image, reply.blob.size);
          return image;
        },
        () => later(),
      )
    : later();
  const tracked = job.finally(() => inflight.delete(key));
  inflight.set(key, tracked);
  return tracked;
}

/**
 * The image for `request`, or the previous one while the next is drawn
 * (`null` before the first, or with no request).
 */
export function useSprite(request: SpriteRequest | null): SpriteImage | null {
  const key = request ? spriteKey(request) : null;
  const hit = key ? recall(key) : undefined;
  const [ready, setReady] = useState<SpriteImage | null>(null);
  useEffect(() => {
    if (!request || hit) return;
    let live = true;
    void loadSprite(request).then((image) => {
      if (live) setReady(image);
    });
    return () => {
      live = false;
    };
    // `key` stands for `request`: it is what the sprite depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return key ? (hit ?? ready) : null;
}

export interface ItemSpriteOptions {
  scale: number;
  resolution?: number;
  select?: number;
  glow?: boolean;
}
function itemRequest(item: IsoItem, o: ItemSpriteOptions): SpriteRequest {
  return {
    kind: 'item',
    item,
    scale: o.scale,
    resolution: o.resolution ?? 32,
    ...(o.select !== undefined ? { select: o.select } : {}),
    ...(o.glow ? { glow: true } : {}),
  };
}

/** An item model as it stands in a scene or the editor, `scale` tiles per item unit. */
export function useItemSprite(item: IsoItem | null, o: ItemSpriteOptions): SpriteImage | null {
  return useSprite(item ? itemRequest(item, o) : null);
}
/** A scene prop drawn by the kernel, relative to its own corner `prop.at`. */
export function usePropSprite(prop: IsoProp | null, lit: boolean): SpriteImage | null {
  return useSprite(prop ? { kind: 'prop', prop, lit } : null);
}
/** The photo-camera silhouette of `item`; a `null` item draws nothing. */
export function useViewOverlay(
  item: IsoItem | null,
  elevation: number,
  ppu: number,
): SpriteImage | null {
  return useSprite(item ? { kind: 'view', item, elevation, ppu } : null);
}

// --- synchronous API (same cache) --------------------------------------------

export function itemSprite(item: IsoItem, o: ItemSpriteOptions): SpriteImage {
  return drawHere(itemRequest(item, o));
}
/** The room's tones, shared with the kernel's prop sprites. */
export const TONES = PROP_TONES;
export function propSprite(prop: IsoProp, lit: boolean): SpriteImage {
  return drawHere({ kind: 'prop', prop, lit });
}
/**
 * The model as the photo's camera saw it, as a translucent silhouette with an
 * outline, to lay over the crop. `ppu` is crop pixels per item unit.
 */
export function viewOverlay(item: IsoItem, elevation: number, ppu: number): SpriteImage {
  return drawHere({ kind: 'view', item, elevation, ppu });
}
