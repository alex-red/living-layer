import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  cameraIdOnlySchema,
  camerasDeleteBodySchema,
  streamsCropBodySchema,
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
import type { Relay } from './relay.js';
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
  constructor(
    private store: EvidenceStore,
    /** Relays saved RTSP cameras as WebRTC and RTSP, when mediamtx is there. */
    private relay: Relay | null = null,
  ) {}
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
    void this.relay?.sync(cameras);
  }
  /** Starts relaying the saved cameras; the app calls it once it is ready. */
  startRelay() {
    return this.relay?.sync(this.list());
  }
  /** What ffmpeg reads for a saved camera: the relay while it runs, else the camera itself. */
  readUrl(camera: SavedCamera) {
    return this.relay?.rtspFor(camera) ?? camera.url;
  }
  /** The relay's WHEP endpoint for a saved camera, while it runs. */
  whepOf(camera: SavedCamera) {
    return this.relay?.whepFor(camera) ?? null;
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
      throw new LabError(
        'camera_limit',
        `Living Layer keeps at most ${CAMERA_LIMIT} cameras.`,
        409,
      );
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
  /**
   * Saved cameras in the stream list. A tab plays one through the relay's WHEP,
   * forwarded by the lab; without the relay, only as the server's MJPEG preview.
   */
  streams(): NetworkStream[] {
    return this.list().map((c) => {
      const view = cameraView(c);
      return {
        id: savedStreamId(c.id),
        name: c.name,
        host: view.host,
        whep: this.whepOf(c) ? `/api/cameras/${c.id}/whep` : '',
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
    const saved = id === null ? null : this.get(id);
    return id === null ? camera.url : saved && this.readUrl(saved);
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
export async function cameraRoutes(
  app: FastifyInstance,
  cameras: CameraRegistry,
  {
    onRemoved,
    onCropped = () => {},
    onSaved = () => {},
    source = (url, crop) => new FfmpegSource(url, 'ffmpeg', crop),
    preview = (url, crop) => new FfmpegSource(url, 'ffmpeg', crop).preview(),
  }: {
    onRemoved: (streamId: string) => void;
    /** A camera's zoomed view changed: saved camera stream ids, or `phone`. */
    onCropped?: (streamId: string) => void;
    /** A camera was added or changed. */
    onSaved?: () => void;
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
  app.get('/cameras', async () => all());
  app.post('/cameras/save', async (request) => {
    const input = parseInput(cameraInputSchema, request.body);
    const camera = cameraView(cameras.save(input));
    onSaved();
    return { camera, ...all() };
  });
  app.post('/cameras/delete', async (request) => {
    const { id } = parseInput(camerasDeleteBodySchema, request.body);
    if (!cameras.remove(id)) throw new LabError('camera_missing', 'That camera is gone.', 404);
    onRemoved(savedStreamId(id));
    return all();
  });
  // A saved camera or the phone keeps its zoomed view, and every later connection opens on it.
  app.post('/streams/crop', async (request) => {
    const { streamId, crop } = parseInput(streamsCropBodySchema, request.body);
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
  app.get('/cameras/:id/snapshot', async (request, reply) => {
    const { id } = parseInput(cameraIdOnlySchema, request.params);
    const camera = cameras.get(id);
    if (!camera) throw new LabError('camera_missing', 'That camera is gone.', 404);
    let png: Buffer;
    try {
      ({ png } = await source(cameras.readUrl(camera), camera.crop ?? null).snapshot());
    } catch {
      throw new LabError(
        'camera_unreachable',
        `Could not get a picture from ${camera.name}. Check the URL, its credentials and that ffmpeg is installed.`,
        502,
      );
    }
    return reply.header('content-type', 'image/png').header('cache-control', 'no-store').send(png);
  });
  // A tab plays a saved camera through the relay: its WHEP offer goes there, and the
  // session it gets back is closed through here too, since the lab is all the tab can reach.
  if (!app.hasContentTypeParser('application/sdp'))
    app.addContentTypeParser('application/sdp', { parseAs: 'string' }, (_request, body, done) =>
      done(null, body),
    );
  const relayed = (params: unknown) => {
    const { id } = parseInput(cameraIdOnlySchema, params);
    const camera = cameras.get(id);
    if (!camera) throw new LabError('camera_missing', 'That camera is gone.', 404);
    const whep = cameras.whepOf(camera);
    if (!whep)
      throw new LabError('relay_off', `${camera.name} isn’t relayed; use its preview.`, 409);
    return { id, whep };
  };
  app.post('/cameras/:id/whep', async (request, reply) => {
    const { id, whep } = relayed(request.params);
    const offer = z.string().min(1).max(60_000).safeParse(request.body);
    if (!offer.success) throw new LabError('whep_offer', 'Send an SDP offer.');
    let answer: Response;
    try {
      answer = await fetch(whep, {
        method: 'POST',
        headers: { 'content-type': 'application/sdp' },
        body: offer.data,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new LabError('relay_unreachable', 'The camera relay did not answer.', 502);
    }
    const session = answer.headers.get('location')?.match(/\/whep\/([\w-]{1,80})$/)?.[1];
    if (session) reply.header('location', `/api/cameras/${id}/whep/${session}`);
    return reply
      .status(answer.status)
      .header('content-type', answer.headers.get('content-type') ?? 'application/sdp')
      .send(await answer.text());
  });
  app.delete('/cameras/:id/whep/:session', async (request, reply) => {
    const { session, ...params } = request.params as { session: string; id: string };
    const { whep } = relayed(params);
    if (!/^[\w-]{1,80}$/.test(session)) throw new LabError('whep_session', 'No such session.');
    await fetch(`${whep}/${session}`, { method: 'DELETE' }).catch(() => {});
    return reply.status(200).send();
  });
  // The camera as a live picture for a tab, for as long as the tab reads it.
  app.get('/cameras/:id/stream', async (request, reply) => {
    const { id } = parseInput(cameraIdOnlySchema, request.params);
    const camera = cameras.get(id);
    if (!camera) throw new LabError('camera_missing', 'That camera is gone.', 404);
    const { stream, stop } = preview(cameras.readUrl(camera), camera.crop ?? null);
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
