import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CAMERA_LIMIT,
  cameraCropSchema,
  cameraInputSchema,
  cameraView,
  savedIdOf,
  savedStreamId,
  redactCameraUrl,
  type CameraCrop,
  type SavedCamera,
  type WatchCamera,
} from '@livinglayer/domain';
import type { EvidenceStore } from './store.js';
import { LabError, parseInput } from './errors.js';
import { FfmpegSource, type FrameSource } from './frames.js';
import type { NetworkStream } from './streams.js';

const KEY = 'cameras';
const PHONE_CROP_KEY = 'phone-crop';

/**
 * Cameras a person added by stream URL, kept in `settings` rather than desk
 * memory: they serve both modes' rooms, survive reset, and their URLs (which
 * may carry a password) never go back to the page. The phone's zoomed view is
 * kept here too: a pairing's id changes, the phone on its mount doesn't.
 */
export class CameraRegistry {
  constructor(private store: EvidenceStore) {}
  list(): SavedCamera[] {
    try {
      return JSON.parse(this.store.setting(KEY) ?? '[]') as SavedCamera[];
    } catch {
      return [];
    }
  }
  get(id: string) {
    return this.list().find((c) => c.id === id) ?? null;
  }
  private write(cameras: SavedCamera[]) {
    this.store.setSetting(KEY, JSON.stringify(cameras));
  }
  save(input: z.infer<typeof cameraInputSchema>): SavedCamera {
    const cameras = this.list();
    const existing = input.id ? cameras.find((c) => c.id === input.id) : undefined;
    if (input.id && !existing) throw new LabError('camera_missing', 'That camera is gone.', 404);
    const url = input.url ?? existing?.url;
    if (!url) throw new LabError('camera_url', 'Give the camera’s stream URL.');
    if (cameras.some((c) => c.url === url && c.id !== existing?.id))
      throw new LabError('camera_duplicate', 'That stream is already a camera.', 409);
    if (!existing && cameras.length >= CAMERA_LIMIT)
      throw new LabError('camera_limit', `The lab keeps at most ${CAMERA_LIMIT} cameras.`, 409);
    const camera: SavedCamera = {
      id: existing?.id ?? randomUUID().slice(0, 8),
      name: input.name,
      url,
      scene: input.scene,
      crop: existing?.crop ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.write(
      existing ? cameras.map((c) => (c.id === camera.id ? camera : c)) : [...cameras, camera],
    );
    return camera;
  }
  /** Keeps a camera's zoomed view, or the whole frame with null; false when the camera is gone. */
  setCrop(id: string, crop: CameraCrop | null): boolean {
    const cameras = this.list();
    if (!cameras.some((c) => c.id === id)) return false;
    this.write(cameras.map((c) => (c.id === id ? { ...c, crop } : c)));
    return true;
  }
  phoneCrop(): CameraCrop | null {
    const parsed = cameraCropSchema.safeParse(
      JSON.parse(this.store.setting(PHONE_CROP_KEY) ?? 'null'),
    );
    return parsed.success ? parsed.data : null;
  }
  setPhoneCrop(crop: CameraCrop | null) {
    this.store.setSetting(PHONE_CROP_KEY, JSON.stringify(crop));
  }
  remove(id: string): boolean {
    const cameras = this.list();
    if (!cameras.some((c) => c.id === id)) return false;
    this.write(cameras.filter((c) => c.id !== id));
    return true;
  }
  /** Saved cameras in the stream list. Only the server reads them, so there's no WHEP. */
  streams(): NetworkStream[] {
    return this.list().map((c) => {
      const view = cameraView(c);
      return {
        id: savedStreamId(c.id),
        name: c.name,
        host: view.host,
        whep: '',
        rtsp: view.url,
        scene: c.scene,
        crop: c.crop ?? null,
        snapshot: `/api/cameras/${c.id}/snapshot`,
        preview: `/api/cameras/${c.id}/stream`,
        source: 'saved',
      };
    });
  }
  /** What the watcher reads: a saved camera's real URL, null once it's removed; anything else as kept. */
  urlOf(camera: WatchCamera): string | null {
    const id = savedIdOf(camera.id);
    return id === null ? camera.url : (this.get(id)?.url ?? null);
  }
  /** The zoomed view a watched camera's frames are cut to. */
  cropOf(camera: WatchCamera): CameraCrop | null {
    const id = savedIdOf(camera.id);
    return id === null ? null : (this.get(id)?.crop ?? null);
  }
  /** A camera to keep in desk memory as `watch`: shown there, so with the password hidden. */
  watchCamera(id: string): WatchCamera | null {
    const camera = this.get(id);
    return camera
      ? { id: savedStreamId(camera.id), name: camera.name, url: redactCameraUrl(camera.url) }
      : null;
  }
}

/**
 * Adding, changing and removing saved cameras, a still from one, and a
 * camera's zoomed view. Live only in effect: the demo never opens a stream.
 * `onRemoved` lets watching stop when its camera goes, and `onCropped` lets
 * it start again on the new view.
 */
export function cameraRoutes(
  app: FastifyInstance,
  cameras: CameraRegistry,
  {
    onRemoved,
    onCropped = () => {},
    source = (url, crop) => new FfmpegSource(url, 'ffmpeg', crop),
    preview = (url, crop) => new FfmpegSource(url, 'ffmpeg', crop).preview(),
  }: {
    onRemoved: (streamId: string) => void;
    /** A camera's zoomed view changed: saved camera stream ids, or `phone`. */
    onCropped?: (streamId: string) => void;
    /** Frames for a stream URL; tests pass their own. */
    source?: (url: string, crop: CameraCrop | null) => Pick<FrameSource, 'snapshot'>;
    /** A stream URL as MJPEG; tests pass their own. */
    preview?: (
      url: string,
      crop: CameraCrop | null,
    ) => { stream: ReadableStream<Uint8Array>; stop: () => void };
  },
) {
  const all = () => ({ cameras: cameras.list().map(cameraView) });
  app.get('/api/cameras', async () => all());
  app.post('/api/cameras/save', async (request) => {
    const input = parseInput(cameraInputSchema, request.body);
    return { camera: cameraView(cameras.save(input)), ...all() };
  });
  app.post('/api/cameras/delete', async (request) => {
    const { id } = parseInput(z.object({ id: z.string().min(1).max(40) }).strict(), request.body);
    if (!cameras.remove(id)) throw new LabError('camera_missing', 'That camera is gone.', 404);
    onRemoved(savedStreamId(id));
    return all();
  });
  // A saved camera or the phone keeps its zoomed view, and every later connection opens on it.
  app.post('/api/streams/crop', async (request) => {
    const { streamId, crop } = parseInput(
      z
        .object({
          streamId: z.string().min(1).max(200),
          crop: cameraCropSchema.nullable(),
        })
        .strict(),
      request.body,
    );
    const id = savedIdOf(streamId);
    if (streamId.startsWith('phone:')) cameras.setPhoneCrop(crop);
    else if (id === null)
      throw new LabError(
        'crop_camera',
        'Only a saved camera or the phone keeps a zoomed view. Save this camera by its URL first.',
      );
    else if (!cameras.setCrop(id, crop))
      throw new LabError('camera_missing', 'That camera is gone.', 404);
    onCropped(id === null ? 'phone' : streamId);
    return { crop };
  });
  app.get('/api/cameras/:id/snapshot', async (request, reply) => {
    const { id } = parseInput(
      z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict(),
      request.params,
    );
    const camera = cameras.get(id);
    if (!camera) throw new LabError('camera_missing', 'That camera is gone.', 404);
    let png: Buffer;
    try {
      ({ png } = await source(camera.url, camera.crop ?? null).snapshot());
    } catch {
      throw new LabError(
        'camera_unreachable',
        `Could not get a picture from ${camera.name}. Check the URL, its credentials and that ffmpeg is installed.`,
        502,
      );
    }
    return reply.header('content-type', 'image/png').header('cache-control', 'no-store').send(png);
  });
  // The camera as a live picture for a tab, for as long as the tab reads it.
  app.get('/api/cameras/:id/stream', async (request, reply) => {
    const { id } = parseInput(
      z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict(),
      request.params,
    );
    const camera = cameras.get(id);
    if (!camera) throw new LabError('camera_missing', 'That camera is gone.', 404);
    const { stream, stop } = preview(camera.url, camera.crop ?? null);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace;boundary=ffmpeg',
      'cache-control': 'no-store',
      connection: 'close',
    });
    request.raw.on('close', stop);
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || reply.raw.destroyed) break;
        reply.raw.write(value);
      }
    } catch {
      // The camera or the tab went away; either way the picture is over.
    } finally {
      stop();
      reply.raw.end();
    }
  });
}
