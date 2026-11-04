import { fixtureBox, type Fixture } from './fixture.js';
import { ISO_TILE_CM } from './iso-furniture.js';
import { MAX_ITEM_PARTS, type IsoItem, type ItemPart } from './iso-item.js';
import { ISO_PRESETS } from './iso-presets.js';
import type { IsoScene } from './iso.js';
import { sittingParts } from './member-models.js';
import { isMember, personLook } from './members.js';
import { withoutPromoted } from './promote.js';

/**
 * A person sitting down ([plan](../../../docs/plans/people-and-pets.md)): drawn
 * into their seat's model as one of its states, so the room's depth order is
 * always right, and not drawn on their own while they sit.
 */
/** The state a seat shows while someone sits in it. */
const SEATED_STATE = 'seated';
/** How a seat is sat in, in its model's frame before its turns. */
interface SeatPlace {
  /** Where the hips go, item units. */
  hip: { x: number; y: number };
  /** The way someone sitting faces: away from the back. */
  facing: { x: number; y: number };
  /** The seat's top, item units. */
  seatZ: number;
  /** Centimetres per item unit. */
  unitCm: number;
}
/** The words that name something to sit on. */
const SEAT_NAME = /\b(chair|armchair|stool|seat|sofa|couch|bench)s?\b/i;
/** Whether a thing of this name is a seat: a chair, a sofa, a bench. */
const isSeatName = (label: string) => SEAT_NAME.test(label);

/**
 * How a seat's model is sat in: its back is its tallest part, the person
 * faces away from it, their hips against it on the highest top under the
 * seat's middle that is well below the back's. Null when the model has no
 * back to tell which way it faces, or no seat under its middle.
 */
function seatPlace(model: IsoItem, widthTiles: number): SeatPlace | null {
  const parts = model.parts;
  if (parts.length < 2) return null;
  const lo = { x: Math.min(...parts.map((p) => p.at.x)), y: Math.min(...parts.map((p) => p.at.y)) };
  const hi = {
    x: Math.max(...parts.map((p) => p.at.x + p.size.w)),
    y: Math.max(...parts.map((p) => p.at.y + p.size.d)),
  };
  const mid = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 };
  const top = (p: ItemPart) => p.at.z + p.size.h;
  const back = parts.reduce((a, b) => (top(b) > top(a) ? b : a));
  const backMid = { x: back.at.x + back.size.w / 2, y: back.at.y + back.size.d / 2 };
  const away = { x: mid.x - backMid.x, y: mid.y - backMid.y };
  if (Math.hypot(away.x, away.y) < 0.02) return null;
  // Square to the nearer axis: a seat stands square to the room.
  const facing =
    Math.abs(away.x) >= Math.abs(away.y)
      ? { x: Math.sign(away.x), y: 0 }
      : { x: 0, y: Math.sign(away.y) };
  const under = parts.filter(
    (p) =>
      p !== back &&
      top(p) < top(back) * 0.75 &&
      mid.x >= p.at.x &&
      mid.x <= p.at.x + p.size.w &&
      mid.y >= p.at.y &&
      mid.y <= p.at.y + p.size.d,
  );
  if (!under.length) return null;
  const seatZ = Math.max(...under.map(top));
  const unitCm = widthTiles * ISO_TILE_CM;
  // The back's face towards the seat, along the facing, from the middle.
  const backFace =
    facing.x !== 0
      ? (facing.x > 0 ? back.at.x + back.size.w : back.at.x) - mid.x
      : (facing.y > 0 ? back.at.y + back.size.d : back.at.y) - mid.y;
  const reach = Math.abs(backFace) * unitCm;
  // The torso, 19 cm round and 2 cm behind the hips, leans on the back.
  const behind = Math.min(15, Math.max(-10, reach - 17));
  return {
    hip: { x: mid.x - (facing.x * behind) / unitCm, y: mid.y - (facing.y * behind) / unitCm },
    facing,
    seatZ,
    unitCm,
  };
}

/**
 * A seat's model with a person sitting in it, and the size it then takes.
 * The person keeps every part; the seat keeps its biggest of the rest
 * (a chair's casters go first). Null when the seat can't be sat in.
 */
export function seatedModel(
  seat: { label: string; model: IsoItem; size: { w: number; d: number; h: number } },
  person: { label: string; look?: string | undefined },
): { model: IsoItem; size: { w: number; d: number; h: number } } | null {
  const place = seatPlace(seat.model, seat.size.w);
  if (!place) return null;
  const look = personLook(person.look, person.label);
  const sitting = sittingParts(look, place).map((p) => ({ ...p, id: `on-${p.id}`.slice(0, 24) }));
  const volume = (p: ItemPart) => p.size.w * p.size.d * p.size.h;
  const own = seat.model.parts
    .toSorted((a, b) => volume(b) - volume(a))
    .slice(0, MAX_ITEM_PARTS - sitting.length);
  const top = Math.max(...sitting.map((p) => p.at.z + p.size.h)) * seat.size.w;
  return {
    model: {
      label: `${seat.label} with ${person.label}`.slice(0, 60),
      parts: [...own, ...sitting],
    },
    size: { ...seat.size, h: Math.min(8, Math.max(seat.size.h, top)) },
  };
}

/** A prop of a scene that is a seat: a chair's group, by its form or template. */
function seatGroups(scene: Pick<IsoScene, 'props'>): Set<string> {
  return new Set(
    scene.props.filter((p) => p.form === 'chair' || p.template === 'chair').map((p) => p.group),
  );
}

/**
 * A person sitting in a seat: the seat shows them drawn into its model
 * (`SEATED_STATE`), and they keep `seatedOn` and aren't drawn on their own.
 * Someone already sitting there stands up first. Why not, when the seat
 * can't be sat in.
 */
export function seatPerson(
  fixtures: readonly Fixture[],
  personId: string,
  seatId: string,
  now: string,
): Fixture[] | { reason: string } {
  const person = fixtures.find((f) => f.id === personId);
  const seat = fixtures.find((f) => f.id === seatId);
  if (!person || person.type !== 'person') return { reason: 'Only a person sits.' };
  if (!seat || seat.id === person.id) return { reason: 'That seat isn’t in the room.' };
  if (seat.scene !== person.scene) return { reason: 'That seat is in another room.' };
  const made = seatedModel({ label: seat.label, model: seat.model, size: seat.size }, person);
  if (!made) return { reason: `The ${seat.label.toLowerCase()} has no seat to sit on.` };
  let next = [...fixtures];
  for (const other of fixtures)
    if (other.seatedOn && (other.id === personId || other.seatedOn === seatId))
      next = standUp(next, other.id, now);
  return next.map((f) => {
    if (f.id === personId) return { ...f, seatedOn: seatId, updatedAt: now };
    if (f.id !== seatId) return f;
    return {
      ...f,
      state: SEATED_STATE,
      states: {
        ...f.states,
        [SEATED_STATE]: {
          model: {
            ...made.model,
            source: 'placeholder',
            segmentRunId: null,
            swatches: f.model.swatches,
            updatedAt: now,
            fit: null,
          },
          size: made.size,
        },
      },
      updatedAt: now,
    };
  });
}

/**
 * A person standing up from their seat: the seat shows its own model again,
 * and they stand on the floor in front of it, facing as they sat. The same
 * list when they weren't sitting.
 */
export function standUp(fixtures: readonly Fixture[], personId: string, now: string): Fixture[] {
  const person = fixtures.find((f) => f.id === personId);
  if (!person?.seatedOn) return [...fixtures];
  const seat = fixtures.find((f) => f.id === person.seatedOn);
  const { seatedOn: _, ...standing } = person;
  const place = seat ? seatPlace(seat.model, seat.size.w) : null;
  let spot: Pick<Fixture, 'at' | 'surfaceId'> = { at: person.at, surfaceId: person.surfaceId };
  if (seat && place) {
    // The way they faced, turned as the seat is: a quarter turn takes (x, y) to (-y, x).
    let v = place.facing;
    for (let i = 0; i < seat.turns % 4; i++) v = { x: -v.y, y: v.x };
    const turned = seat.turns % 2 === 1;
    const sw = turned ? seat.size.d : seat.size.w;
    const sd = turned ? seat.size.w : seat.size.d;
    const pw = person.turns % 2 === 1 ? person.size.d : person.size.w;
    const pd = person.turns % 2 === 1 ? person.size.w : person.size.d;
    const centre = {
      x: seat.at.x + sw / 2 + v.x * (sw / 2 + pw / 2),
      y: seat.at.y + sd / 2 + v.y * (sd / 2 + pd / 2),
    };
    spot = {
      at: { x: Math.max(0, centre.x - pw / 2), y: Math.max(0, centre.y - pd / 2) },
      surfaceId: null,
    };
  }
  return fixtures.map((f) => {
    if (f.id === personId) return { ...standing, ...spot, updatedAt: now };
    if (f.id !== seat?.id || f.state !== SEATED_STATE) return f;
    const { [SEATED_STATE]: _gone, ...states } = f.states ?? {};
    return {
      ...f,
      state: null,
      ...(Object.keys(states).length ? { states } : { states: undefined }),
      updatedAt: now,
    };
  });
}

/**
 * Things as the room draws them: a person sitting in a seat that is there is
 * drawn by the seat, and whoever is out isn't drawn.
 */
export function drawnFixtures<F extends Pick<Fixture, 'id' | 'seatedOn' | 'away'>>(
  fixtures: readonly F[],
): F[] {
  const ids = new Set(fixtures.map((f) => f.id));
  return fixtures.filter((f) => !f.away && (!f.seatedOn || !ids.has(f.seatedOn)));
}

/**
 * The seat a person can sit in where they stand: under their middle, else a
 * step to any side of them. Null when there is none.
 */
export function seatNear(
  person: Fixture,
  fixtures: readonly Fixture[],
  custom: IsoScene | null | undefined,
  { reach = true }: { reach?: boolean } = {},
): { fixtureId: string } | { group: string } | null {
  const box = fixtureBox(person, custom);
  const scene =
    person.scene === 'custom'
      ? (custom ?? null)
      : withoutPromoted(ISO_PRESETS[person.scene], [...fixtures]);
  const mid = { x: box.at.x + box.size.w / 2, y: box.at.y + box.size.d / 2 };
  const step = Math.max(box.size.w, box.size.d);
  const tries = reach
    ? [
        mid,
        ...[-1, 1].flatMap((k) => [
          { x: mid.x + k * step, y: mid.y },
          { x: mid.x, y: mid.y + k * step },
        ]),
      ]
    : [mid];
  for (const p of tries) {
    const at = seatAt(scene, fixtures, person.scene, p, (f) => fixtureBox(f, custom));
    if (at) return at;
  }
  return null;
}

/**
 * The seat under a point of a scene, for a person put down there: a thing
 * that is a seat, else a chair of the layout (`seatGroups`), which is made a
 * thing to be sat in. Null when there is none.
 */
export function seatAt(
  scene: Pick<IsoScene, 'kind' | 'props'> | null,
  fixtures: readonly Fixture[],
  sceneKind: string,
  point: { x: number; y: number },
  boxOf: (f: Fixture) => { at: { x: number; y: number }; size: { w: number; d: number } },
): { fixtureId: string } | { group: string } | null {
  const inside = (b: { at: { x: number; y: number }; size: { w: number; d: number } }) =>
    point.x >= b.at.x &&
    point.x <= b.at.x + b.size.w &&
    point.y >= b.at.y &&
    point.y <= b.at.y + b.size.d;
  const thing = fixtures.find(
    (f) =>
      f.scene === sceneKind &&
      !isMember(f) &&
      (isSeatName(f.label) || f.builtIn === 'chair') &&
      inside(boxOf(f)) &&
      seatPlace(f.model, f.size.w),
  );
  if (thing) return { fixtureId: thing.id };
  if (!scene) return null;
  const seats = seatGroups(scene);
  const prop = scene.props.find((p) => seats.has(p.group) && inside(p));
  return prop ? { group: prop.group } : null;
}
