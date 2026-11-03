import { useEffect, useRef, useState } from 'react';
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
 * same `draw` runs on the main thread.
 *
 * An image someone holds (a mounted sprite, an open picker's thumbnails) is
 * pinned: the cache never evicts it, so its URL is never revoked under it.
 * Requests nobody waits for any more are dropped before they are drawn, so a
 * drag that asks for a sprite per pointer move draws only the latest.
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
/** How many holders each key has; a pinned entry is never evicted. */
const pins = new Map<string, number>();

function pin(key: string) {
  pins.set(key, (pins.get(key) ?? 0) + 1);
}
function unpin(key: string) {
  const n = (pins.get(key) ?? 0) - 1;
  if (n > 0) pins.set(key, n);
  else pins.delete(key);
}

function remember(key: string, image: SpriteImage, bytes: number) {
  const old = cache.get(key);
  if (old) totalBytes -= old.bytes;
  cache.delete(key);
  cache.set(key, { image, bytes });
  totalBytes += bytes;
  for (const [k, e] of cache) {
    if (cache.size <= MAX_ENTRIES && totalBytes <= MAX_BYTES) break;
    if (k === key) break;
    if (pins.has(k)) continue;
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

/**
 * Pins the cached image under `key` until the returned release is called, or
 * says `null` when it is no longer cached (it must be asked for again).
 */
export function holdSprite(key: string): (() => void) | null {
  if (!cache.has(key)) return null;
  pin(key);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    unpin(key);
  };
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
function drawHere(key: string, request: SpriteRequest): SpriteImage {
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

// --- jobs: one per key, queued here so the ones nobody waits for are dropped --

interface Job {
  key: string;
  request: SpriteRequest;
  /** Tickets still waiting for it. */
  waiters: number;
  started: boolean;
  promise: Promise<SpriteImage>;
  resolve: (image: SpriteImage) => void;
}
const jobs = new Map<string, Job>();
const queue: Job[] = [];
/** Requests handed to the worker at once: enough to keep it busy, few enough to drop the rest. */
const MAX_RUNNING = 2;
let running = 0;

function pump() {
  while (running < MAX_RUNNING && queue.length) {
    const job = queue.shift()!;
    if (job.waiters <= 0) continue;
    job.started = true;
    running++;
    void run(job)
      .then((image) => {
        if (image) job.resolve(image);
      })
      .finally(() => {
        running--;
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        pump();
      });
  }
}

/** Draws a started job; `null` when everyone who asked has gone (nothing is cached then). */
function run(job: Job): Promise<SpriteImage | null> {
  const here = () =>
    new Promise<SpriteImage | null>((r) =>
      setTimeout(() => r(job.waiters > 0 ? drawHere(job.key, job.request) : null), 0),
    );
  const w = getWorker();
  if (!w) return here();
  return new Promise<WorkerReply>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, request: job.request });
  }).then(
    (reply) => {
      if (!reply.blob || !reply.meta) return here();
      if (job.waiters <= 0) return null;
      const image = imageOf(reply.meta, URL.createObjectURL(reply.blob));
      remember(job.key, image, reply.blob.size);
      return image;
    },
    () => here(),
  );
}

/** One ask for a sprite: its image when drawn, and its pin on that image until released. */
interface SpriteTicket {
  key: string;
  promise: Promise<SpriteImage>;
  /** Whether drawing has begun (a cached image counts): it can no longer be dropped. */
  started(): boolean;
  /** Stop waiting and unpin: an unstarted request nobody else waits for is dropped. */
  release(): void;
}

/**
 * Asks for a sprite: at once for a cached one, else drawn off the main thread
 * when it can. The key stays pinned until the ticket is released; a released
 * ticket's promise may never settle.
 */
export function requestSprite(request: SpriteRequest): SpriteTicket {
  const key = spriteKey(request);
  pin(key);
  let held = true;
  const hit = recall(key);
  if (hit)
    return {
      key,
      promise: Promise.resolve(hit),
      started: () => true,
      release: () => {
        if (!held) return;
        held = false;
        unpin(key);
      },
    };
  let job = jobs.get(key);
  if (!job) {
    let resolve!: (image: SpriteImage) => void;
    const promise = new Promise<SpriteImage>((r) => (resolve = r));
    job = { key, request, waiters: 0, started: false, promise, resolve };
    jobs.set(key, job);
    queue.push(job);
  }
  const mine = job;
  mine.waiters++;
  pump();
  return {
    key,
    promise: mine.promise,
    started: () => mine.started,
    release: () => {
      if (!held) return;
      held = false;
      unpin(key);
      mine.waiters--;
      if (mine.waiters > 0 || mine.started) return;
      const at = queue.indexOf(mine);
      if (at >= 0) queue.splice(at, 1);
      if (jobs.get(key) === mine) jobs.delete(key);
    },
  };
}

/**
 * The image for `request`, or the previous one while the next is drawn
 * (`null` before the first, or with no request). What it shows stays pinned
 * while it is mounted; asks superseded before they were drawn are dropped.
 */
function useSprite(request: SpriteRequest | null): SpriteImage | null {
  const key = request ? spriteKey(request) : null;
  const hit = key ? recall(key) : undefined;
  const [held, setHeld] = useState<SpriteImage | null>(null);
  // The ticket behind `held` (its pin), and asks still out, by generation.
  const shown = useRef<{ gen: number; ticket: SpriteTicket } | null>(null);
  const out = useRef(new Map<number, SpriteTicket>());
  const gen = useRef(0);
  useEffect(() => {
    if (!request) return;
    const mine = ++gen.current;
    for (const [g, t] of out.current)
      if (!t.started()) {
        t.release();
        out.current.delete(g);
      }
    const ticket = requestSprite(request);
    out.current.set(mine, ticket);
    void ticket.promise.then((image) => {
      if (out.current.get(mine) !== ticket) return;
      out.current.delete(mine);
      const before = shown.current;
      if (before && before.gen > mine) {
        ticket.release();
        return;
      }
      shown.current = { gen: mine, ticket };
      if (before) before.ticket.release();
      setHeld(image);
    });
    // `key` stands for `request`: it is what the sprite depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const asks = out.current;
    return () => {
      for (const t of asks.values()) t.release();
      asks.clear();
      shown.current?.ticket.release();
      shown.current = null;
    };
  }, []);
  return key ? (hit ?? held) : null;
}

interface ItemSpriteOptions {
  scale: number;
  resolution?: number;
  pixel?: number;
  select?: number;
  glow?: boolean;
}
function itemRequest(item: IsoItem, o: ItemSpriteOptions): SpriteRequest {
  return {
    kind: 'item',
    item,
    scale: o.scale,
    resolution: o.resolution ?? 32,
    ...(o.pixel !== undefined ? { pixel: o.pixel } : {}),
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

/** The room's tones, shared with the kernel's prop sprites. */
export const TONES = PROP_TONES;
