import { z } from 'zod';
import type { Segmentation } from './api.js';
import { pointSchema, toIso, type IsoScreen, type Point, type SurfacePin } from './iso.js';
import { ISO_PRESETS, isoSurface } from './iso-presets.js';
import type { IsoBox, IsoScene, IsoVec } from './iso.js';
import { pinCamera, projectPoint, unprojectPoint } from './photo-scene.js';

/** A room's picture: `runId/illustration.png` in the evidence store. */
export const illustrationRef = z.string().regex(/^[a-z0-9-]{1,64}\/illustration\.png$/);
/** A picture or one of its layers: the base it is drawn on, or one fixture cut out of it. */
export const pictureLayerRef = z
  .string()
  .regex(/^[a-z0-9-]{1,64}\/(illustration|base|sprite-\d{1,2})\.png$/);
/** The most fixtures one picture is separated into: what one SAM call outlines. */
export const MAX_SPRITES = 16;
const boxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();
/**
 * One fixture cut out of the picture: its pixels, where they were, and where
 * its base's centre was and how big its footprint was when it was cut. The
 * sprite follows the fixture from there: moved with the base's centre, and
 * scaled with its footprint.
 */
export const pictureSpriteSchema = z
  .object({
    fixtureId: z.string().min(1).max(80),
    asset: pictureLayerRef,
    box: boxSchema,
    anchor: pointSchema,
    size: z.object({ w: z.number().positive(), d: z.number().positive() }).strict(),
  })
  .strict();
export type PictureSprite = z.infer<typeof pictureSpriteSchema>;
/**
 * A clean picture of a person's room, or of its desk close up, redrawn by an
 * image model from one camera frame and keeping that frame's composition. A
 * point of the scene goes through the pinned surface's camera into the frame,
 * and onto the picture by scale alone, so what the camera sees on the desk
 * lands on the desk in the picture.
 */
const frameSchema = z
  .object({ width: z.number().int().positive(), height: z.number().int().positive() })
  .strict();
export const sceneIllustrationSchema = z
  .object({
    asset: illustrationRef,
    frame: frameSchema,
    /** The surface of the scene the corners belong to. */
    surfaceId: z.string().min(1).max(40),
    /**
     * Where the top's corners were found on a picture drawn before the room
     * had its corner camera; always null now. Such a picture is dropped on load.
     */
    desk: z.tuple([pointSchema, pointSchema, pointSchema, pointSchema]).nullable(),
    /**
     * The camera frame the picture redraws, keeping its composition: a point
     * of a frame this size maps onto the picture by scale alone.
     */
    drawnFrom: frameSchema.optional(),
    /**
     * The picture with its fixtures lifted off: a base with them removed, and
     * each one as a sprite drawn over it where the fixture stands now.
     */
    layers: z
      .object({
        base: pictureLayerRef,
        sprites: z.array(pictureSpriteSchema).max(MAX_SPRITES),
        createdAt: z.string(),
      })
      .strict()
      .optional(),
    createdAt: z.string(),
  })
  .strict();
export type SceneIllustration = z.infer<typeof sceneIllustrationSchema>;

/**
 * A close camera frame of the desk redrawn in the room picture's style, when
 * there is one (the second image). The frame's composition is kept, so what
 * the camera tracks maps straight onto the drawing.
 */
export function deskIllustrationPrompt(withStyle: boolean, note?: string): string {
  return withNote(
    'Redraw the desk in the first image (a close camera photo) as a clean illustration of the desk top ' +
      'and everything standing on it' +
      (withStyle
        ? ', in exactly the art style of the second image: the same line weight, flat colours and soft lighting.'
        : ': crisp outlines, flat colours and soft even lighting.') +
      ' Keep the camera’s viewpoint and framing, and every object where it is in the photo, with its shape ' +
      'and colour. Plain black background beyond the desk, no text, no labels.',
    note,
  );
}
/** The longest note a person may add to a redraw. */
export const ILLUSTRATION_NOTE_MAX = 200;
/**
 * A prompt with what the person asked to change this time. The photo and the
 * prompt are otherwise the same on every redraw, and so is the picture.
 */
export function withNote(prompt: string, note?: string): string {
  const text = note?.trim().slice(0, ILLUSTRATION_NOTE_MAX);
  return text ? `${prompt} This time, also: ${text}` : prompt;
}
/**
 * What the image model is asked for: the room's corner camera frame redrawn
 * as clean line art. Its viewpoint and framing are kept, so the room's camera
 * maps the scene onto the picture as it does onto the frame.
 */
export const ILLUSTRATION_PROMPT =
  'Redraw this photo, taken by a camera high in a corner of the room, as a clean illustration ' +
  'of the same room. Keep the camera’s viewpoint, perspective and framing exactly, and every ' +
  'piece of furniture and every object where it is in the photo, with the same shapes, colours ' +
  'and relative sizes. Crisp outlines, flat colours, soft even lighting. Plain black background ' +
  'beyond the walls and floor, no text, no labels.';

/**
 * A camera frame point in picture pixels. A picture redraws one frame, so a
 * frame of that size maps by scale. Null for a frame of another size.
 */
export function framePointInPicture(
  _pin: SurfacePin,
  picture: SceneIllustration,
  frame: Segmentation['frame'],
  p: Point,
): Point | null {
  const from = picture.drawnFrom;
  return from && frame.width === from.width && frame.height === from.height
    ? { x: (p.x / from.width) * picture.frame.width, y: (p.y / from.height) * picture.frame.height }
    : null;
}

/** The pinned surface and its camera, for a picture redrawn from frames of the pin's size. */
function pictureCamera(pin: SurfacePin, picture: SceneIllustration, custom: IsoScene | null) {
  const surface = isoSurface(pin.scene, pin.surfaceId, custom);
  const from = picture.drawnFrom;
  if (!surface || !from || from.width !== pin.frame.width || from.height !== pin.frame.height)
    return null;
  const camera = pinCamera(pin.corners, pin.frame, surface.rect.w, surface.rect.d);
  return camera && { surface, camera, from };
}
/**
 * Where a point of the pinned scene shows in its picture: through the pin's
 * camera into the frame the picture redraws, then onto the picture by scale.
 */
export function scenePointInPicture(
  pin: SurfacePin,
  picture: SceneIllustration,
  custom: IsoScene | null,
  p: IsoVec,
): Point | null {
  const seen = pictureCamera(pin, picture, custom);
  if (!seen) return null;
  const { surface, camera } = seen;
  const at = projectPoint(camera, p.x - surface.rect.x, p.y - surface.rect.y, p.z - surface.z);
  return at && framePointInPicture(pin, picture, pin.frame, at);
}
/**
 * The point of the scene at height `z` that a point of the picture shows,
 * for following the pointer across a plane, as a resize handle does. Null
 * where `pictureToScene` would be.
 */
export function pictureToSceneAt(
  pin: SurfacePin,
  picture: SceneIllustration,
  custom: IsoScene | null,
  pt: Point,
  z: number,
): { x: number; y: number } | null {
  const seen = pictureCamera(pin, picture, custom);
  if (!seen) return null;
  const { surface, camera, from } = seen;
  const p = {
    x: (pt.x / picture.frame.width) * from.width,
    y: (pt.y / picture.frame.height) * from.height,
  };
  const at = unprojectPoint(camera, p, z - surface.z);
  return at && { x: surface.rect.x + at.X, y: surface.rect.y + at.Y };
}
/**
 * Where a point of the picture is in the scene: on the highest surface
 * whose top it falls on, else on the floor. The inverse of drawing, for
 * dragging a fixture to where the picture shows it. Null when the pinned
 * surface is gone, or the pin was set on frames of another size.
 */
export function pictureToScene(
  pin: SurfacePin,
  picture: SceneIllustration,
  custom: IsoScene | null,
  pt: Point,
): { x: number; y: number; surfaceId: string | null } | null {
  if (!pictureToSceneAt(pin, picture, custom, pt, 0)) return null;
  const at = (z: number) => pictureToSceneAt(pin, picture, custom, pt, z)!;
  const scene = pin.scene === 'custom' ? custom : ISO_PRESETS[pin.scene];
  const surfaces = [...(scene?.surfaces ?? [])].sort((p, q) => q.z - p.z);
  for (const s of surfaces) {
    const p = at(s.z);
    const r = s.rect;
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.d)
      return { ...p, surfaceId: s.id };
  }
  return { ...at(0), surfaceId: null };
}

/**
 * Where a fixture's box shows on the room picture: the box around its eight
 * corners, padded a little for what overhangs it, and its base's centre.
 * What a fixture is cut out of the picture by, and where its sprite goes.
 */
export function fixtureInPicture(
  pin: SurfacePin,
  picture: SceneIllustration,
  custom: IsoScene | null,
  box: IsoBox,
): {
  box: { x: number; y: number; width: number; height: number };
  anchor: Point;
  /** The box's eight corners in the picture, for its silhouette. */
  corners: Point[];
} | null {
  const { at, size } = box;
  const to = (x: number, y: number, z: number) =>
    scenePointInPicture(pin, picture, custom, { x, y, z });
  const corners = [0, 1].flatMap((i) =>
    [0, 1].flatMap((j) =>
      [0, 1].map((k) => to(at.x + i * size.w, at.y + j * size.d, at.z + k * size.h)),
    ),
  );
  const anchor = to(at.x + size.w / 2, at.y + size.d / 2, at.z);
  if (!anchor || !corners.every(Boolean)) return null;
  const xs = corners.map((p) => p!.x);
  const ys = corners.map((p) => p!.y);
  const pad = 0.12 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const x = Math.max(0, Math.min(...xs) - pad);
  const y = Math.max(0, Math.min(...ys) - pad);
  const right = Math.min(picture.frame.width, Math.max(...xs) + pad);
  const bottom = Math.min(picture.frame.height, Math.max(...ys) + pad);
  if (right - x < 2 || bottom - y < 2) return null;
  return {
    box: { x, y, width: right - x, height: bottom - y },
    anchor,
    corners: corners as Point[],
  };
}
/**
 * Where a sprite is drawn for its fixture as it stands now: moved with its
 * base's centre, and scaled about it as the footprint's area changed since
 * the cut. A short move across the room barely changes how far it is from
 * the camera, so a move alone keeps it the same size.
 */
export function spriteBox(
  sprite: PictureSprite,
  now: { anchor: Point; w: number; d: number },
): { x: number; y: number; width: number; height: number } {
  const k = Math.sqrt((now.w * now.d) / (sprite.size.w * sprite.size.d));
  return {
    x: now.anchor.x + (sprite.box.x - sprite.anchor.x) * k,
    y: now.anchor.y + (sprite.box.y - sprite.anchor.y) * k,
    width: sprite.box.width * k,
    height: sprite.box.height * k,
  };
}

/**
 * What Spark says about where the room's fixtures are drawn in its picture:
 * each by its number in the list it was given, with a tight box in
 * thousandths of the picture, or not seen.
 */
export const pictureFindSchema = z
  .object({
    found: z
      .array(
        z
          .object({
            index: z.number().int().min(1).max(MAX_SPRITES),
            seen: z.boolean(),
            box: z
              .object({
                x1: z.number().int().min(0).max(1000),
                y1: z.number().int().min(0).max(1000),
                x2: z.number().int().min(0).max(1000),
                y2: z.number().int().min(0).max(1000),
              })
              .strict(),
          })
          .strict(),
      )
      .max(MAX_SPRITES),
  })
  .strict();
export type PictureFind = z.infer<typeof pictureFindSchema>;

/**
 * The affine map that lays a fixture's model, drawn in the iso view's own
 * screen space, onto the room picture where its box stands: fitted by least
 * squares to the eight corners of its box, as SVG's matrix(a b c d e f). Over
 * one fixture the corner camera's perspective is close to the iso view's
 * parallel projection, so the fit is close too.
 * Null where the box doesn't place on the picture.
 */
export function isoToPicture(
  pin: SurfacePin,
  picture: SceneIllustration,
  custom: IsoScene | null,
  box: IsoBox,
): [number, number, number, number, number, number] | null {
  const { at, size } = box;
  const pairs: { s: IsoScreen; p: Point }[] = [];
  for (const i of [0, 1])
    for (const j of [0, 1])
      for (const k of [0, 1]) {
        const v = { x: at.x + i * size.w, y: at.y + j * size.d, z: at.z + k * size.h };
        const p = scenePointInPicture(pin, picture, custom, v);
        if (!p) return null;
        pairs.push({ s: toIso(v), p });
      }
  // Normal equations for [sx, sy, 1] -> px and -> py.
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bx = [0, 0, 0];
  const by = [0, 0, 0];
  for (const { s, p } of pairs) {
    const r = [s.sx, s.sy, 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) m[a]![b]! += r[a]! * r[b]!;
      bx[a]! += r[a]! * p.x;
      by[a]! += r[a]! * p.y;
    }
  }
  const x = solve3(m, bx);
  const y = solve3(m, by);
  return x && y ? [x[0], y[0], x[1], y[1], x[2], y[2]] : null;
}
function solve3(m: number[][], b: number[]): [number, number, number] | null {
  const [[a, b1, c], [d, e, f], [g, h, i]] = m as [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const col = (j: number) => {
    const n = m.map((row, r) => row.map((v, k) => (k === j ? b[r]! : v)));
    const [[p, q, r], [s, t, u], [v, w, z]] = n as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    return (p * (t * z - u * w) - q * (s * z - u * v) + r * (s * w - t * v)) / det;
  };
  return [col(0), col(1), col(2)];
}
