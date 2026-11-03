/**
 * A zone that is a thing: a coaster, a tray, a dog's bed. It has no place of
 * its own; it is the thing's footprint, grown by a pad, wherever the thing is
 * now: where the camera last saw it, or where it was put in the room. A thing
 * stands in it as in any zone drawn on the pinned surface.
 *
 * The anchor is often hidden by what stands on it (a mug on its coaster), so
 * its last place holds until it is seen elsewhere: an unseen anchor never
 * empties its zone.
 */
import { z } from 'zod';
import type { Segmentation } from './api.js';
import type { Fixture } from './fixture.js';
import { ISO_TILE_CM, cm } from './iso-furniture.js';
import {
  applyHomography,
  isoSurface,
  projectBox,
  surfaceMap,
  worldSurface,
  type IsoSurface,
  type Point,
  type SurfacePin,
} from './iso.js';
import type { DeskMemory, ZoneOnSurface, ZoneRect } from './memory.js';

export const THING_ZONE = {
  /** How far past the thing's edge still counts as on it, cm: a mug's foot over a coaster's rim. */
  padCm: 2,
  maxPadCm: 30,
};

export const zoneAnchorSchema = z
  .object({
    thingId: z.string().uuid(),
    padCm: z.number().finite().min(0).max(THING_ZONE.maxPadCm),
  })
  .strict();
/** The thing a zone is: its footprint, grown by `padCm` each way. */
export type ZoneAnchor = z.infer<typeof zoneAnchorSchema>;

/** Where an anchored zone is now, in the shape every zone has. */
interface AnchoredZone {
  sourceKey: string;
  rect: ZoneRect;
  frame: Segmentation['frame'];
  onSurface?: ZoneOnSurface;
}

/** The surface the zones are drawn on, with its map onto a frame of `frame`'s size. */
function pinned(memory: Pick<DeskMemory, 'surface' | 'scene'>, frame: Segmentation['frame']) {
  const pin = memory.surface;
  const surface = pin ? isoSurface(pin.scene, pin.surfaceId, memory.scene) : undefined;
  const map = pin && surface ? surfaceMap(pin, frame) : null;
  return pin && surface && map ? { pin, surface, map } : null;
}

/**
 * A footprint on the pinned surface, from `lo` to `hi` in room tiles, as a
 * zone: its corners on the surface and, for the frame, the box round where
 * the camera sees them.
 */
function onPin(
  pin: SurfacePin,
  surface: IsoSurface,
  map: NonNullable<ReturnType<typeof surfaceMap>>,
  lo: Point,
  hi: Point,
  frame: Segmentation['frame'],
  sourceKey: string,
): AnchoredZone {
  const a = worldSurface(surface, lo);
  const b = worldSurface(surface, hi);
  const corners = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }].map((p) =>
    applyHomography(map.toFrame, p),
  );
  return {
    sourceKey,
    frame,
    rect: shareRect(corners, frame),
    onSurface: { scene: pin.scene, surfaceId: pin.surfaceId, a, b },
  };
}

/** The box round some frame points, as shares of the frame, kept on it and at least the least zone. */
function shareRect(points: Point[], frame: Segmentation['frame']): ZoneRect {
  const xs = points.map((p) => p.x / frame.width);
  const ys = points.map((p) => p.y / frame.height);
  const least = 0.01;
  const span = (lo: number, hi: number) => {
    const from = Math.min(Math.max(lo, 0), 1 - least);
    return { from, size: Math.max(least, Math.min(hi, 1) - from) };
  };
  const x = span(Math.min(...xs), Math.max(...xs));
  const y = span(Math.min(...ys), Math.max(...ys));
  return { x: x.from, y: y.from, width: x.size, height: y.size };
}

/**
 * Where a thing's zone is now, or null when it can't be told: a followed
 * thing never seen, or a placed one off the pinned surface. A followed thing
 * is where its last sighting stands on the pinned surface (`projectBox`, as
 * the room draws it), or its box in the frame when nothing is pinned. A
 * placed thing is its footprint where it was put, turned as it stands.
 */
export function anchoredZone(
  memory: Pick<DeskMemory, 'surface' | 'scene' | 'fixtures'>,
  anchor: ZoneAnchor,
): AnchoredZone | null {
  const thing = memory.fixtures?.find((f) => f.id === anchor.thingId);
  if (!thing) return null;
  const pad = cm(anchor.padCm);
  const o = thing.track?.observation;
  if (o) {
    const at = pinned(memory, o.frame);
    if (!at) return framed(thing, o, anchor.padCm);
    const { foot, box } = projectBox(o.box, at.surface, at.map.toSurface);
    const centre = {
      x: at.surface.rect.x + foot.x * at.surface.rect.w,
      y: at.surface.rect.y + foot.y * at.surface.rect.d,
    };
    const half = box.size.w / 2 + pad;
    return onPin(
      at.pin,
      at.surface,
      at.map,
      { x: centre.x - half, y: centre.y - half },
      { x: centre.x + half, y: centre.y + half },
      o.frame,
      o.sourceKey,
    );
  }
  const pin = memory.surface;
  if (!pin || thing.place === 'sightings') return null;
  if (thing.scene !== pin.scene || thing.surfaceId !== pin.surfaceId) return null;
  const at = pinned(memory, pin.frame);
  if (!at) return null;
  const { w, d } = footprint(thing);
  return onPin(
    at.pin,
    at.surface,
    at.map,
    { x: thing.at.x - pad, y: thing.at.y - pad },
    { x: thing.at.x + w + pad, y: thing.at.y + d + pad },
    pin.frame,
    `thing:${thing.id}`,
  );
}

/** A placed thing's footprint in tiles, turned as it stands. */
const footprint = (f: Pick<Fixture, 'size' | 'turns'>) =>
  f.turns % 2 === 1 ? { w: f.size.d, d: f.size.w } : { w: f.size.w, d: f.size.d };

/**
 * A followed thing's zone with nothing pinned: its box in the frame, grown by
 * the pad at the box's own scale (its width taken as the thing's).
 */
function framed(
  thing: Pick<Fixture, 'size'>,
  o: NonNullable<Fixture['track']>['observation'],
  padCm: number,
): AnchoredZone {
  const px = (o.box.width / (thing.size.w * ISO_TILE_CM)) * padCm;
  const { x, y, width, height } = o.box;
  return {
    sourceKey: o.sourceKey,
    frame: o.frame,
    rect: shareRect(
      [
        { x: x - px, y: y - px },
        { x: x + width + px, y: y + height + px },
      ],
      o.frame,
    ),
  };
}
