import { z } from 'zod';
import { isoSceneKindSchema, type IsoSceneKind } from './iso.js';
import { ISO_SCENE_PARENT } from './iso-presets.js';

/** Stream URLs the server opens with ffmpeg: RTSP, or an HTTP(S) stream such as MJPEG or HLS. */
export const CAMERA_PROTOCOLS = ['rtsp:', 'rtsps:', 'http:', 'https:'] as const;
export const CAMERA_LIMIT = 16;

/** Why a stream URL can't be a camera, or null when it can. */
export function cameraUrlProblem(value: string): string | null {
  const url = URL.parse(value);
  if (!url || !(CAMERA_PROTOCOLS as readonly string[]).includes(url.protocol))
    return 'Use an rtsp://, rtsps://, http:// or https:// stream URL.';
  if (!url.hostname) return 'The stream URL needs a host.';
  if (url.hash) return 'Leave the #fragment off the stream URL.';
  if (/[\s\0]/.test(value)) return 'The stream URL can’t contain spaces.';
  return null;
}

export const cameraSceneSchema = z.union([isoSceneKindSchema, z.literal('custom')]).nullable();
export type CameraScene = z.infer<typeof cameraSceneSchema>;

/** What the lab sends to add or change a camera. Leaving `url` out on a change keeps the stored one. */
export const cameraInputSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .optional(),
    name: z.string().trim().min(1).max(60),
    url: z
      .string()
      .trim()
      .max(500)
      .refine((u) => !cameraUrlProblem(u))
      .optional(),
    scene: cameraSceneSchema,
  })
  .strict();
export type CameraInput = z.infer<typeof cameraInputSchema>;

/** A camera a person added by its stream URL, kept on the server with any credentials in it. */
export interface SavedCamera {
  id: string;
  name: string;
  url: string;
  /** The room it looks at, or null when it isn't assigned to one. */
  scene: CameraScene;
  createdAt: string;
}

/** A saved camera as the lab sees it: the URL with its password hidden. */
export interface CameraView {
  id: string;
  name: string;
  url: string;
  host: string;
  hasPassword: boolean;
  scene: CameraScene;
  createdAt: string;
}

/** The URL with any password replaced, so it can be shown and logged. */
export function redactCameraUrl(value: string): string {
  const url = URL.parse(value);
  if (!url) return '';
  if (url.password) url.password = '***';
  return url.href;
}

export function cameraView(camera: SavedCamera): CameraView {
  const url = URL.parse(camera.url);
  return {
    id: camera.id,
    name: camera.name,
    url: redactCameraUrl(camera.url),
    host: url?.host ?? '',
    hasPassword: Boolean(url?.password),
    scene: camera.scene,
    createdAt: camera.createdAt,
  };
}

/** A saved camera's id in the stream list, apart from mDNS instance names and configured URLs. */
export const savedStreamId = (id: string) => `cam:${id}`;
export const savedIdOf = (streamId: string) =>
  streamId.startsWith('cam:') ? streamId.slice(4) : null;

/**
 * The camera assigned to a room: one assigned to exactly that scene first,
 * else one on the room it's a close view of (the office for its desk), or
 * the other way round. Null when none is.
 */
export function cameraForScene<T extends { scene?: CameraScene }>(
  cameras: T[],
  scene: IsoSceneKind | 'custom' | null,
): T | null {
  if (!scene) return null;
  const exact = cameras.find((c) => c.scene === scene);
  if (exact || scene === 'custom') return exact ?? null;
  const room = (k: IsoSceneKind) => ISO_SCENE_PARENT[k] ?? k;
  return (
    cameras.find((c) => c.scene && c.scene !== 'custom' && room(c.scene) === room(scene)) ?? null
  );
}
