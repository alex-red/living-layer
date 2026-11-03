import type { Fixture } from './fixture.js';
import type { IsoBox, IsoScene, Point } from './iso.js';
import { isoItemSchema, rotateItem, type IsoItem, type ItemPart } from './iso-item.js';
import { unprojectRoom, type RoomCamera } from './room-camera.js';

/**
 * A variant of a Thing ([plan](../../../docs/plans/brush-relations.md)): its
 * model with what stands on it drawn in, kept as one of its named states
 * (`Fixture.states`), the way a cat has `idle` and `sleeping`. Props stay
 * layout and never carry one: furniture is made a thing first
 * (`promoteGroup`). A thing with an `occupied` state shows it while its
 * occupied stat is on (`followOccupied`).
 */
export const OCCUPIED_STATE = 'occupied';
/** The most parts an item model holds (`isoItemSchema`). */
const ITEM_PARTS = 12;
/** The fewest of the occupant's parts a variant keeps, so it still reads as it. */
const OCCUPANT_PARTS = 2;
/** Tiles of slack when judging whether one thing stands on another's top. */
const ON_TOP = 0.1;

/** A thing as the room draws it: its box in the scene's tiles, its turns, and its model before turning. */
export interface DrawnThing {
  label: string;
  box: IsoBox;
  turns: number;
  model: IsoItem;
}

/**
 * Whether `a` stands on `b`: its footprint's middle over `b`'s footprint,
 * its base between `b`'s base and a little over its top. A cat on a cat tree
 * that is a thing stands on it this way; a thing on furniture names its
 * surface (`surfaceId`) instead.
 */
export function standsOn(a: IsoBox, b: IsoBox): boolean {
  const cx = a.at.x + a.size.w / 2;
  const cy = a.at.y + a.size.d / 2;
  return (
    cx >= b.at.x &&
    cx <= b.at.x + b.size.w &&
    cy >= b.at.y &&
    cy <= b.at.y + b.size.d &&
    a.at.z >= b.at.z - ON_TOP &&
    a.at.z <= b.at.z + b.size.h + ON_TOP
  );
}

/**
 * Where a thing placed by its sightings stands in the room: its foot (the
 * bottom middle of its box in the camera's frame) through the calibrated
 * camera, on the highest top whose footprint that ray meets (a surface of
 * the layout, or another thing's box), else the floor. Its footprint is
 * centred there, at its own size; `surfaceId` names the layout's surface it
 * touches down on.
 */
export function sightingBox(
  camera: RoomCamera,
  scene: Pick<IsoScene, 'surfaces'>,
  others: IsoBox[],
  foot: Point,
  size: { w: number; d: number; h: number },
): { box: IsoBox; surfaceId: string | null } | null {
  const tops = [
    ...scene.surfaces.map((s) => ({ z: s.z, rect: s.rect, id: s.id as string | null })),
    ...others.map((b) => ({
      z: b.at.z + b.size.h,
      rect: { x: b.at.x, y: b.at.y, w: b.size.w, d: b.size.d },
      id: null,
    })),
  ].sort((a, b) => b.z - a.z);
  const inside = (p: { x: number; y: number }, r: { x: number; y: number; w: number; d: number }) =>
    p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.d;
  let at = null;
  let surfaceId: string | null = null;
  for (const t of tops) {
    const p = unprojectRoom(camera, foot, t.z);
    if (p && inside(p, t.rect)) {
      [at, surfaceId] = [p, t.id];
      break;
    }
  }
  at ??= unprojectRoom(camera, foot, 0);
  if (!at) return null;
  return { box: { at: { x: at.x - size.w / 2, y: at.y - size.d / 2, z: at.z }, size }, surfaceId };
}

/**
 * The subject's model with the occupant's drawn into it where the room has
 * it now, in the subject's own item frame before its turns, and the size the
 * subject then takes (taller when the occupant lies on its top). A model
 * holds 12 parts: the occupant keeps its biggest, at least two, and the
 * subject its biggest of the rest. Why not, when it can't be made.
 */
export function variantItem(
  subject: DrawnThing & { size: { w: number; d: number; h: number } },
  occupant: DrawnThing | null,
  label: string,
): { model: IsoItem; size: { w: number; d: number; h: number } } | { reason: string } {
  if (!occupant) return { model: { ...subject.model, label }, size: subject.size };
  // Each is drawn turned, one item unit to its box's width (`ItemSprite`).
  const s = subject.box.size.w;
  const so = occupant.box.size.w;
  const k = so / s;
  const o = occupant.box.at;
  const b = subject.box.at;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const turned = rotateItem(occupant.model, occupant.turns).parts.map((p): ItemPart => {
    const size = {
      w: clamp(p.size.w * k, 0.02, 3),
      d: clamp(p.size.d * k, 0.02, 3),
      h: clamp(p.size.h * k, 0.02, 6),
    };
    const moved: ItemPart = {
      ...p,
      at: {
        x: clamp((o.x - b.x) / s + p.at.x * k, -0.5, 1.5),
        y: clamp((o.y - b.y) / s + p.at.y * k, -0.5, 1.5),
        z: clamp((o.z - b.z) / s + p.at.z * k, 0, 6 - size.h),
      },
      size,
    };
    if (moved.shape === 'tube' && moved.radius !== undefined)
      moved.radius = clamp(moved.radius * k, 0, 1.5);
    return moved;
  });
  // A thing's box is taller than much of its model: the occupant settles onto the top of the part
  // under its middle (the tree's bed), the highest one not above where the camera saw it.
  const mid = {
    x:
      Math.min(...turned.map((p) => p.at.x)) / 2 +
      Math.max(...turned.map((p) => p.at.x + p.size.w)) / 2,
    y:
      Math.min(...turned.map((p) => p.at.y)) / 2 +
      Math.max(...turned.map((p) => p.at.y + p.size.d)) / 2,
  };
  const base = Math.min(...turned.map((p) => p.at.z));
  const under = rotateItem(subject.model, subject.turns)
    .parts.filter(
      (p) =>
        mid.x >= p.at.x &&
        mid.x <= p.at.x + p.size.w &&
        mid.y >= p.at.y &&
        mid.y <= p.at.y + p.size.d &&
        p.at.z + p.size.h <= base + ON_TOP / s,
    )
    .map((p) => p.at.z + p.size.h);
  const dz = under.length ? Math.max(...under) - base : 0;
  const settled = turned.map((p) => ({
    ...p,
    at: { ...p.at, z: clamp(p.at.z + dz, 0, 6 - p.size.h) },
  }));
  // Back into the subject's frame before its turns: the same quarter turn, the rest of the way round.
  const placed = rotateItem({ label, parts: settled }, (4 - (subject.turns % 4)) % 4).parts;
  const volume = (p: ItemPart) => p.size.w * p.size.d * p.size.h;
  const theirs = placed.toSorted((a, c) => volume(c) - volume(a));
  const keepOccupant = Math.min(
    theirs.length,
    Math.max(OCCUPANT_PARTS, ITEM_PARTS - subject.model.parts.length),
  );
  const own = subject.model.parts
    .toSorted((a, c) => volume(c) - volume(a))
    .slice(0, ITEM_PARTS - keepOccupant);
  const taken = new Set(own.map((p) => p.id));
  const extra = theirs.slice(0, keepOccupant).map((p, i) => {
    let id = `on-${p.id}`.slice(0, 24);
    if (taken.has(id)) id = `on-${i + 1}`;
    taken.add(id);
    return { ...p, id };
  });
  const checked = isoItemSchema.safeParse({ label, parts: [...own, ...extra] });
  if (!checked.success)
    return { reason: checked.error.issues[0]?.message ?? 'The variant’s model isn’t valid.' };
  const top = Math.max(...placed.map((p) => p.at.z + p.size.h)) * s;
  return {
    model: checked.data,
    size: { ...subject.size, h: Math.min(8, Math.max(subject.size.h, top)) },
  };
}

/**
 * Things with an `occupied` state showing what their occupied stat says: that
 * state while on, their own model when it turns off, as they are while it has
 * no value. Only the occupied state is switched off, so a lamp's `on` stays.
 * The same list when nothing changes.
 */
export function followOccupied<F extends Pick<Fixture, 'id' | 'state' | 'states'>>(
  fixtures: F[],
  occupied: (thingId: string) => boolean | null,
): F[] {
  let changed = false;
  const next = fixtures.map((f) => {
    if (!f.states?.[OCCUPIED_STATE]) return f;
    const on = occupied(f.id);
    const want =
      on === true ? OCCUPIED_STATE : on === false && f.state === OCCUPIED_STATE ? null : f.state;
    if ((want ?? null) === (f.state ?? null)) return f;
    changed = true;
    return { ...f, state: want ?? null };
  });
  return changed ? next : fixtures;
}
