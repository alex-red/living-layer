import type { CameraCrop, GpuSeen, UnitBox } from '@livinglayer/domain';
import type { Fetcher } from './config.js';

/** One result from the GPU tracker: every followed thing on one camera frame. */
export interface GpuTracks {
  seq: number;
  ms: number;
  things: GpuSeen[];
}
type Things = { id: string; box: UnitBox }[];

/** How long to wait before following again after the node or its stream fails, ms. */
const RETRY_MS = 5000;
/** A stream with no result or keep-alive for this long has stalled, ms; the node sends one every 15 s. */
const STALL_MS = 40_000;
/** How long one request to the node may take before it counts as down, ms (the results stream: until it opens). */
const CALL_MS = 10_000;

/** Reads server-sent events from a byte stream, one `data:` payload at a time. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      if (data) yield data;
    }
  }
}

/**
 * The GPU tracker node, from the watcher's side: it opens the camera there
 * with the things followed here, and hands each result to `onTracks`. A
 * failure is reported through `onState` and retried; it never stops the
 * watcher, which follows on this machine either way.
 */
export class GpuTracker {
  private generation = 0;
  private controller: AbortController | null = null;
  private things: Things = [];
  constructor(
    private url: string,
    private token: string,
    private fetcher: Fetcher = fetch,
    /** Its waits, ms; tests shorten them. */
    private timing = { callMs: CALL_MS, stallMs: STALL_MS, retryMs: RETRY_MS },
  ) {}
  /** One request; it gives up after `CALL_MS` unless `signal` is given, which then decides alone. */
  private async call(path: string, method: string, body?: unknown, signal?: AbortSignal) {
    const response = await this.fetcher(`${this.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(this.timing.callMs),
    });
    if (!response.ok)
      throw new Error(`GPU tracker ${method} ${path}: ${response.status} ${await response.text()}`);
    return response;
  }
  /** Follow `things` on the camera at `source`, cut to `crop`, until `stop`. */
  start(
    source: string,
    crop: CameraCrop | null,
    things: Things,
    onTracks: (tracks: GpuTracks) => void,
    onState: (state: 'connecting' | 'following' | 'error', note: string) => void,
  ) {
    this.stop();
    const generation = ++this.generation;
    this.things = things;
    const controller = (this.controller = new AbortController());
    const live = () => generation === this.generation;
    void (async () => {
      while (live()) {
        onState('connecting', 'Opening the camera on the GPU tracker…');
        // Each attempt can be given up on its own; stopping gives up on all of them.
        const attempt = new AbortController();
        const signal = AbortSignal.any([controller.signal, attempt.signal]);
        let stall = setTimeout(() => attempt.abort(), this.timing.callMs);
        try {
          await this.call(
            '/session',
            'PUT',
            { source, crop, fps: 10, things: this.things },
            signal,
          );
          const stream = await this.call('/tracks', 'GET', undefined, signal);
          clearTimeout(stall);
          stall = setTimeout(() => attempt.abort(), this.timing.stallMs);
          try {
            for await (const data of sseData(stream.body!)) {
              clearTimeout(stall);
              stall = setTimeout(() => attempt.abort(), this.timing.stallMs);
              if (!live()) break;
              const event = JSON.parse(data) as GpuTracks & { type: string; error?: string };
              if (event.type === 'error')
                onState('error', event.error ?? 'The GPU tracker failed.');
              else if (event.type === 'tracks') {
                onState('following', '');
                onTracks(event);
              }
            }
          } finally {
            clearTimeout(stall);
          }
          if (live()) onState('error', 'The GPU tracker closed its stream.');
        } catch (error) {
          clearTimeout(stall);
          if (!live()) return;
          onState(
            'error',
            attempt.signal.aborted
              ? 'The GPU tracker doesn’t answer.'
              : error instanceof Error
                ? error.message
                : String(error),
          );
        }
        await new Promise((done) => setTimeout(done, this.timing.retryMs));
      }
    })();
  }
  /** The things followed now, replacing the node's set without reopening the camera; sent only when it changes. */
  setThings(things: Things) {
    const same = (a: Things, b: Things) =>
      a.length === b.length && a.every((t) => b.some((o) => o.id === t.id));
    if (same(things, this.things)) return;
    this.things = things;
    if (this.controller) void this.call('/session/things', 'PUT', { things }).catch(() => {});
  }
  /** Start these things again on the node at these boxes (the local match follows them). */
  reseed(things: Things) {
    if (!things.length || !this.controller) return;
    const byId = new Map(things.map((t) => [t.id, t.box]));
    this.things = this.things.map((t) => ({ id: t.id, box: byId.get(t.id) ?? t.box }));
    void this.call('/session/things', 'POST', { things }).catch(() => {});
  }
  stop() {
    this.generation++;
    if (!this.controller) return;
    this.controller.abort();
    this.controller = null;
    void this.call('/session', 'DELETE').catch(() => {});
  }
}
