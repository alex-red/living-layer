import { z } from 'zod';
import type { Detection, Segmentation } from './index.js';
import {
  applyHomography,
  homography,
  pointSchema,
  type Point,
  type Quad,
  type SurfacePin,
} from './iso.js';
import { isoSurface } from './iso-presets.js';
import { worldSurface, type IsoScene, type IsoVec } from './iso.js';
import {
  cameraFromPin,
  fitSurfaceQuad,
  maskBits,
  projectPoint,
  surfaceTop,
} from './photo-scene.js';

/** A room's picture: `runId/illustration.png` in the evidence store. */
export const illustrationRef = z.string().regex(/^[a-z0-9-]{1,64}\/illustration\.png$/);
/**
 * A clean isometric picture of a person's room, drawn by an image model from
 * its photo, and where the pinned surface's top is in it. The corners follow
 * the pin's order, so the pin's unit square maps onto them: a point the camera
 * sees on the desk lands on the desk in the picture.
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
    /** The top's corners in picture pixels, or null when no desk was found in it. */
    desk: z.tuple([pointSchema, pointSchema, pointSchema, pointSchema]).nullable(),
    /**
     * The camera frame a desk picture redraws, keeping its composition: a point
     * of a frame this size maps onto the picture by scale alone.
     */
    drawnFrom: frameSchema.optional(),
    createdAt: z.string(),
  })
  .strict();
export type SceneIllustration = z.infer<typeof sceneIllustrationSchema>;

/**
 * A close camera frame of the desk redrawn in the room picture's style, when
 * there is one (the second image). The frame's composition is kept, so what
 * the camera tracks maps straight onto the drawing.
 */
export function deskIllustrationPrompt(withStyle: boolean): string {
  return (
    'Redraw the desk in the first image (a close camera photo) as a clean illustration of the desk top ' +
    'and everything standing on it' +
    (withStyle
      ? ', in exactly the art style of the second image: the same line weight, flat colours and soft lighting.'
      : ': crisp outlines, flat colours and soft even lighting.') +
    ' Keep the camera’s viewpoint and framing, and every object where it is in the photo, with its shape ' +
    'and colour. Plain black background beyond the desk, no text, no labels.'
  );
}
/** What the image model is asked for: the photo redrawn as clean isometric line art. */
export const ILLUSTRATION_PROMPT =
  'Redraw this photo as a clean isometric 2.5D illustration of the same room: a true isometric ' +
  'view (2:1 dimetric, 30 degree angles, no perspective), seen from the front, on a plain black ' +
  'background. Keep every piece of furniture and every object where it is in the photo, with the ' +
  'same shapes, colours and relative sizes. Draw the desk top as a clean flat surface with its ' +
  'edges visible. Soft even lighting, crisp outlines, no text, no labels, no walls or floor beyond ' +
  "the furniture's footprint.";

const UNIT: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
const centre = (q: Quad) => ({
  x: q.reduce((s, p) => s + p.x, 0) / 4,
  y: q.reduce((s, p) => s + p.y, 0) / 4,
});
const angle = (p: Point, c: Point) => Math.atan2(p.y - c.y, p.x - c.x);

/**
 * The desk top's corners in the picture from SAM's outline of the desk. The
 * picture is clean line art, so the surface fitter finds the top as it does
 * on a photo, without needing a camera.
 */
export function pictureDesk(d: Detection, frame: Segmentation['frame']): Quad | null {
  const scale = Math.min(1, 200 / frame.width);
  return fitSurfaceQuad(surfaceTop(maskBits(d, frame, scale), []), frame)?.corners ?? null;
}

/**
 * The picture's corners in the pin's order. The picture keeps the photo's
 * composition, so each pin corner is matched with the picture corner in the
 * same direction from the middle: of the four ways round, the one whose
 * directions agree best.
 */
export function alignCorners(picture: Quad, pin: Quad): Quad {
  const cp = centre(picture);
  const cq = centre(pin);
  let best = picture;
  let least = Infinity;
  for (let k = 0; k < 4; k++) {
    const turned = [0, 1, 2, 3].map((i) => picture[(i + k) % 4]!) as Quad;
    let off = 0;
    for (let i = 0; i < 4; i++) {
      const d = Math.abs(angle(turned[i]!, cp) - angle(pin[i]!, cq));
      off += Math.min(d, 2 * Math.PI - d);
    }
    if (off < least) {
      least = off;
      best = turned;
    }
  }
  return best;
}

/**
 * A camera frame point in picture pixels. A desk picture redraws one frame,
 * so a frame of that size maps by scale. A room picture goes through the
 * pinned surface: frame to the surface's unit square by the pin, then onto the
 * picture's desk top. Null when the picture can't place a frame of this size.
 */
export function framePointInPicture(
  pin: SurfacePin,
  picture: SceneIllustration,
  frame: Segmentation['frame'],
  p: Point,
): Point | null {
  const from = picture.drawnFrom;
  if (from)
    return frame.width === from.width && frame.height === from.height
      ? {
          x: (p.x / from.width) * picture.frame.width,
          y: (p.y / from.height) * picture.frame.height,
        }
      : null;
  if (!picture.desk || frame.width !== pin.frame.width || frame.height !== pin.frame.height)
    return null;
  const toUnit = homography(pin.corners, UNIT);
  const toPicture = homography(UNIT, picture.desk);
  return toUnit && toPicture ? applyHomography(toPicture, applyHomography(toUnit, p)) : null;
}

/**
 * Where a point of the pinned scene shows in its picture. On the room's
 * picture the desk top is known, so a point is placed on that plane and
 * raised or lowered by its height: the picture is drawn in parallel
 * projection, where up is up the page at about a tile's length per tile. On
 * a picture redrawn from a frame, the point goes through the pin's camera
 * into the frame first, when the pin was set on frames of that size.
 */
export function scenePointInPicture(
  pin: SurfacePin,
  picture: SceneIllustration,
  custom: IsoScene | null,
  p: IsoVec,
): Point | null {
  const surface = isoSurface(pin.scene, pin.surfaceId, custom);
  if (!surface) return null;
  if (picture.drawnFrom) {
    const { w, d } = surface.rect;
    const camera = cameraFromPin(pin.corners, pin.frame, w, [d, d]);
    const at =
      camera && projectPoint(camera, p.x - surface.rect.x, p.y - surface.rect.y, p.z - surface.z);
    return at && framePointInPicture(pin, picture, pin.frame, at);
  }
  const desk = picture.desk;
  if (!desk) return null;
  // Parallel projection maps the plane affinely; a homography through four
  // drawn corners would run off to a horizon away from the desk.
  const [d0, d1, d2, d3] = desk;
  const a = { x: (d1.x - d0.x + d2.x - d3.x) / 2, y: (d1.y - d0.y + d2.y - d3.y) / 2 };
  const b = { x: (d3.x - d0.x + d2.x - d1.x) / 2, y: (d3.y - d0.y + d2.y - d1.y) / 2 };
  const c = {
    x: (d0.x + d1.x + d2.x + d3.x) / 4 - (a.x + b.x) / 2,
    y: (d0.y + d1.y + d2.y + d3.y) / 4 - (a.y + b.y) / 2,
  };
  const uv = worldSurface(surface, p);
  const on = { x: c.x + uv.x * a.x + uv.y * b.x, y: c.y + uv.x * a.y + uv.y * b.y };
  const len = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
  const tile =
    ((len(desk[0], desk[1]) + len(desk[3], desk[2])) / surface.rect.w +
      (len(desk[0], desk[3]) + len(desk[1], desk[2])) / surface.rect.d) /
    4;
  return { x: on.x, y: on.y - (p.z - surface.z) * tile };
}
