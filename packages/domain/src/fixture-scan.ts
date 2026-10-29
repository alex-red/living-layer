import { z } from 'zod';
import {
  CONTROL_KINDS,
  fixtureGroup,
  fixtureProblem,
  sizeInTiles,
  tileCm,
  type Fixture,
  type FixtureInput,
} from './fixture.js';
import { archetypeSchema, buildItem, defaultFit, type Archetype } from './iso-archetypes.js';
import { ITEM_MATERIALS, hexColorSchema, type IsoItem } from './iso-item.js';
import { ISO_PRESETS, isoSurface, pinFits } from './iso-presets.js';
import {
  surfaceWorld,
  type IsoScene,
  type IsoSceneKind,
  type IsoSurface,
  type Point,
  type SurfacePin,
} from './iso.js';
import type { Detection, Segmentation } from './index.js';
import {
  cameraFromPin,
  maskBits,
  onPinnedSurface,
  projectPoint,
  unprojectPoint,
} from './photo-scene.js';

/**
 * Scan and map: Spark lists what stays put in a view's photo, and each thing
 * is mapped onto the scene through the pin. A thing the room already has is
 * left where it is; one the library has (a fixture saved in any scene) is
 * placed with that fixture's model; anything else gets a placeholder model
 * built from its shape's usual proportions, to be refined later.
 */
export const MAX_SCAN_THINGS = 8;
const scanBoxSchema = z
  .object({
    x1: z.number().int().min(0).max(1000),
    y1: z.number().int().min(0).max(1000),
    x2: z.number().int().min(0).max(1000),
    y2: z.number().int().min(0).max(1000),
  })
  .strict();
export const scannedThingSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    archetype: archetypeSchema,
    material: z.enum(ITEM_MATERIALS),
    control: z.enum(CONTROL_KINDS),
    /** Its main colour, lowercase #rrggbb. */
    color: hexColorSchema,
    box: scanBoxSchema,
    sizeCm: z
      .object({
        w: z.number().positive().max(400),
        d: z.number().positive().max(400),
        h: z.number().positive().max(400),
      })
      .strict(),
  })
  .strict();
export type ScannedThing = z.infer<typeof scannedThingSchema>;
/** What Spark says about a view's photo: the things that stay put, never where they go. */
export const fixtureScanSchema = z
  .object({ things: z.array(scannedThingSchema).max(MAX_SCAN_THINGS) })
  .strict();
export type FixtureScan = z.infer<typeof fixtureScanSchema>;

/** How a scanned thing was mapped. */
export type ScanMatch =
  /** The room already has it; nothing was added. */
  | 'existing'
  /** Placed with the model of a fixture saved in another scene, or another of its kind. */
  | 'library'
  /** Placed with a model fitted to what SAM outlined of it. */
  | 'fitted'
  /** Skipped: the person said it isn't a fixture. */
  | 'dismissed'
  /** Placed with a placeholder model. */
  | 'placeholder';
export interface MappedThing {
  label: string;
  match: ScanMatch;
  /** The fixture it is (existing) or was modelled on (library). */
  fixtureId?: string;
  /** Where the scan saw it touch down, as shares of the photo. */
  seen?: Outline;
  /** Where a fixture the last scan placed moves to: it follows the latest scan. */
  moveTo?: Pick<FixtureInput, 'at' | 'surfaceId'>;
  /** A model fitted to its outline, for a fixture the last scan placed. */
  remodel?: IsoItem;
  /** The same thing in another scene, to link with: a room and its close view. */
  linkTo?: string;
  /** What to save, for a library or placeholder thing; null when it is skipped. */
  fixture: FixtureInput | null;
  /** Why it was skipped, or where it went. */
  note: string;
}

const STOP = new Set(['a', 'an', 'the', 'of', 'on', 'with', 'and', 'small', 'large', 'big']);
const words = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));

/** Names a person said aren't fixtures, so scans skip them; the most kept. */
export const MAX_DISMISSED = 50;
/** Whether a scanned thing is one the person dismissed: the same name, or the same last word. */
export function isDismissed(label: string, dismissed: string[]): boolean {
  const a = words(label);
  return dismissed.some((d) => {
    const b = words(d);
    return a.length > 0 && b.length > 0 && (a.join(' ') === b.join(' ') || a.at(-1) === b.at(-1));
  });
}

/**
 * How well a saved fixture fits a scanned thing, 0 to 1: the same name, the
 * same last word (a "brass lamp" and a "desk lamp") with the same shape, or
 * mostly the same words with the same shape. Under 0.5 is no match.
 */
export function libraryScore(
  thing: Pick<ScannedThing, 'label' | 'archetype'>,
  fixture: Pick<Fixture, 'label' | 'model'>,
): number {
  const a = words(thing.label);
  const b = words(fixture.label);
  if (!a.length || !b.length) return 0;
  if (a.join(' ') === b.join(' ')) return 1;
  const sameShape = fixture.model.fit ? fixture.model.fit.archetype === thing.archetype : true;
  if (!sameShape) return 0;
  if (a.at(-1) === b.at(-1)) return 0.8;
  const shared = a.filter((w) => b.includes(w)).length;
  const jaccard = shared / new Set([...a, ...b]).size;
  return jaccard >= 0.5 ? 0.6 : 0;
}

/**
 * Where an outlined thing touches what it stands on, and how big it is, as
 * shares of the photo: the middle of the mask's lowest few rows. A loose box
 * runs past the thing; the mask stops where it does.
 */
export interface Outline {
  foot: Point;
  size: { w: number; h: number };
}
export function outlineOf(d: Detection, frame: Segmentation['frame']): Outline | null {
  const scale = Math.min(1, 480 / Math.max(frame.width, frame.height));
  const bits = maskBits(d, frame, scale);
  let bottom = -1;
  for (let y = bits.height - 1; y >= 0 && bottom < 0; y--)
    for (let x = 0; x < bits.width; x++) if (bits.data[y * bits.width + x]) bottom = y;
  if (bottom < 0) return null;
  // The lowest rows, a few percent of its height: a base, legs, a mouse's belly.
  const band = Math.max(1, Math.round(d.box.height * scale * 0.04));
  let sum = 0;
  let n = 0;
  for (let y = Math.max(0, bottom - band); y <= bottom; y++)
    for (let x = 0; x < bits.width; x++)
      if (bits.data[y * bits.width + x]) {
        sum += x + 0.5;
        n++;
      }
  return {
    foot: { x: sum / n / bits.width, y: (bottom + 1) / bits.height },
    size: { w: d.box.width / frame.width, h: d.box.height / frame.height },
  };
}

/** A model from the shape's usual proportions in the thing's colour, until it is drafted properly. */
export function placeholderModel(
  label: string,
  archetype: Archetype,
  color: string,
  material: ScannedThing['material'],
): IsoItem {
  const fit = defaultFit(archetype, [color]);
  return buildItem(label, { ...fit, material });
}

const inside = (poly: Point[], p: Point) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      hit = !hit;
  }
  return hit;
};
/** The nearest point of a polygon's edge to p, and how far it is. */
function nearestEdge(poly: Point[], p: Point): { at: Point; distance: number } {
  let best = { at: poly[0]!, distance: Infinity };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(
      0,
      Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
    );
    const at = { x: a.x + t * dx, y: a.y + t * dy };
    const distance = Math.hypot(p.x - at.x, p.y - at.y);
    if (distance < best.distance) best = { at, distance };
  }
  return best;
}
/** How far past a surface's outline a thing's foot may be, as a share of its box's larger side. */
const REACH = 0.6;

/**
 * Where a thing stands, from where its box meets the ground in the photo.
 * Every surface of the scene is drawn into the frame by the pin's camera;
 * the thing stands on the highest one its foot is on, or else the nearest
 * one its foot is within reach of (a monitor's base sits behind the desk's
 * drawn edge, a laptop hangs over it), at the nearest point of it. Anything
 * else stands on the floor below the camera when that is in the room, else
 * on the nearest surface, else in front of the pinned one. A centre point in scene tiles.
 */
function standing(
  pin: SurfacePin,
  scene: IsoSceneKind | 'custom',
  custom: IsoScene | null,
  foot: Point,
  boxSize: number,
): { centre: Point; surfaceId: string | null } | null {
  // The pin maps the frame onto the surface's unit square, so the same
  // surface in a room and its close view takes the thing to the same spot.
  const pinned = isoSurface(scene, pin.surfaceId, custom);
  const all = (scene === 'custom' ? custom : ISO_PRESETS[scene])?.surfaces ?? [];
  if (!pinned) return null;
  const { w, d } = pinned.rect;
  const camera = cameraFromPin(pin.corners, pin.frame, w, [d, d]);
  const outline = (s: IsoSurface): Point[] | null => {
    if (s.id === pinned.id) return [...pin.corners];
    if (!camera) return null;
    const { x, y } = pinned.rect;
    const z = s.z - pinned.z;
    const r = s.rect;
    const ps = [
      projectPoint(camera, r.x - x, r.y - y, z),
      projectPoint(camera, r.x + r.w - x, r.y - y, z),
      projectPoint(camera, r.x + r.w - x, r.y + r.d - y, z),
      projectPoint(camera, r.x - x, r.y + r.d - y, z),
    ];
    return ps.every(Boolean) ? (ps as Point[]) : null;
  };
  // Where a frame point lands on a surface's plane, as shares of it.
  const onPlane = (s: IsoSurface, p: Point): Point | null => {
    if (s.id === pinned.id) return onPinnedSurface(pin, p);
    const hit = camera && unprojectPoint(camera, p, s.z - pinned.z);
    return hit
      ? {
          x: (pinned.rect.x + hit.X - s.rect.x) / s.rect.w,
          y: (pinned.rect.y + hit.Y - s.rect.y) / s.rect.d,
        }
      : null;
  };
  const reach = REACH * boxSize;
  const near = all
    .map((s) => {
      const poly = outline(s);
      if (!poly) return null;
      if (inside(poly, foot)) return { s, at: foot, distance: 0 };
      const edge = nearestEdge(poly, foot);
      return { s, at: edge.at, distance: edge.distance };
    })
    .filter((x) => x !== null)
    // Standing on two at once (a shelf drawn over the desk): the higher one.
    .sort((a, b) =>
      a.distance === 0 && b.distance === 0 ? b.s.z - a.s.z : a.distance - b.distance,
    );
  const onto = (hit: (typeof near)[number] | undefined) => {
    const uv = hit && onPlane(hit.s, hit.at);
    if (!hit || !uv) return null;
    const at = surfaceWorld(hit.s, {
      x: Math.min(0.98, Math.max(0.02, uv.x)),
      y: Math.min(0.98, Math.max(0.02, uv.y)),
    });
    return { centre: { x: at.x, y: at.y }, surfaceId: hit.s.id };
  };
  const found = near[0] && near[0].distance <= reach ? near[0] : undefined;
  const standsOn = onto(found);
  if (standsOn) return standsOn;
  const floor = camera && unprojectPoint(camera, foot, -pinned.z);
  const grid = (scene === 'custom' ? custom : ISO_PRESETS[scene])?.grid;
  const centre = floor && { x: pinned.rect.x + floor.X, y: pinned.rect.y + floor.Y };
  // A floor spot off the grid is the camera looking past the room or up at
  // something high, like a shelf drafted a little off: the nearest surface
  // is a better guess than the room's edge.
  const M = 0.5;
  if (
    centre &&
    grid &&
    centre.x > -M &&
    centre.y > -M &&
    centre.x < grid.w + M &&
    centre.y < grid.d + M
  )
    return { centre, surfaceId: null };
  const nearest = onto(near[0]);
  if (nearest) return nearest;
  const across = onPinnedSurface(pin, foot)?.x ?? 0.5;
  return {
    centre: { x: pinned.rect.x + Math.min(1, Math.max(0, across)) * w, y: pinned.rect.y + d + 0.5 },
    surfaceId: null,
  };
}

/**
 * The scene's place for a thing: its box's footprint centred where it
 * stands (the foot is the box's front, so the centre is half a depth back),
 * kept inside the grid, and on the floor if the surface can't hold it.
 */
function place(
  base: Pick<FixtureInput, 'scene' | 'turns' | 'size'>,
  where: { centre: Point; surfaceId: string | null },
  custom: IsoScene | null,
  grid: { w: number; d: number },
): Pick<FixtureInput, 'at' | 'surfaceId'> {
  const turned = base.turns % 2 === 1;
  const w = turned ? base.size.d : base.size.w;
  const d = turned ? base.size.w : base.size.d;
  const clampAt = (c: Point) => ({
    x: Math.min(Math.max(c.x - w / 2, 0), Math.max(grid.w - w, 0)),
    y: Math.min(Math.max(c.y - d, 0), Math.max(grid.d - d, 0)),
  });
  const on = { at: clampAt(where.centre), surfaceId: where.surfaceId };
  if (!fixtureProblem({ ...base, ...on }, custom)) return on;
  // The centre slid off the surface's back edge: stand it on the surface's edge.
  const surface = where.surfaceId ? isoSurface(base.scene, where.surfaceId, custom) : undefined;
  if (surface) {
    const r = surface.rect;
    const centre = {
      x: Math.min(Math.max(where.centre.x, r.x + 0.01), r.x + r.w - 0.01),
      y: Math.min(Math.max(where.centre.y - d / 2, r.y + 0.01), r.y + r.d - 0.01) + d / 2,
    };
    const edge = { at: clampAt(centre), surfaceId: surface.id };
    if (!fixtureProblem({ ...base, ...edge }, custom)) return edge;
  }
  return { at: clampAt(where.centre), surfaceId: null };
}

/**
 * A fixture's place with its footprint centred on a point of its scene, on a
 * surface or the floor: kept inside the grid, and on the floor when the
 * surface can't hold it. For moving one by hand.
 */
export function fixtureAt(
  fixture: Pick<FixtureInput, 'scene' | 'turns' | 'size'>,
  centre: Point,
  surfaceId: string | null,
  custom: IsoScene | null,
): Pick<FixtureInput, 'at' | 'surfaceId'> | null {
  const grid = fixture.scene === 'custom' ? custom?.grid : ISO_PRESETS[fixture.scene].grid;
  if (!grid) return null;
  const d = fixture.turns % 2 === 1 ? fixture.size.w : fixture.size.d;
  // `place` takes the front of the footprint, where a thing touches down in a photo.
  return place(fixture, { centre: { x: centre.x, y: centre.y + d / 2 }, surfaceId }, custom, grid);
}

/**
 * Where a fixture a scan placed stands under a new pin: from where the scan
 * saw it touch down, as the scan would have placed it. Null when it wasn't
 * seen by a scan, or the pin doesn't fit its scene.
 */
export function placeSeen(
  fixture: Pick<Fixture, 'scene' | 'turns' | 'size' | 'seen'>,
  pin: SurfacePin,
  custom: IsoScene | null,
): Pick<FixtureInput, 'at' | 'surfaceId'> | null {
  const seen = fixture.seen;
  const grid = fixture.scene === 'custom' ? custom?.grid : ISO_PRESETS[fixture.scene].grid;
  if (!seen || !grid || !pinFits(pin, fixture.scene)) return null;
  const where = standing(
    pin,
    fixture.scene,
    custom,
    { x: seen.foot.x * pin.frame.width, y: seen.foot.y * pin.frame.height },
    Math.max(seen.size.h * pin.frame.height, seen.size.w * pin.frame.width),
  );
  return where && place(fixture, where, custom, grid);
}

/**
 * Map a scan onto a scene the pin fits: its own, or the room it is a close
 * view of (the office desk's top is the office's too). Each saved fixture of
 * that scene can be claimed by one scanned thing; further things of its kind
 * are added with its model. A thing found in another scene is linked with
 * it, once per scene, so a room and its close view share one lamp. `room` is
 * how many more fixtures may be added.
 */
export function mapScan({
  scan,
  pin,
  scene = pin.scene,
  custom,
  library,
  room,
  entities,
  outlines = [],
  models = [],
  dismissed = [],
}: {
  /** Names the person said aren't fixtures. */
  dismissed?: string[];
  /** Of a photo the pin's camera took, at any size. */
  scan: FixtureScan;
  /** What SAM outlined of each thing, by its place in the scan. */
  outlines?: (Outline | null)[];
  /** A model fitted to each thing's mask, to use instead of a placeholder. */
  models?: (IsoItem | null)[];
  pin: SurfacePin;
  scene?: IsoSceneKind | 'custom';
  custom: IsoScene | null;
  library: Fixture[];
  room: number;
  /** The configured lights and switches a reused fixture may keep. */
  entities: string[];
}): MappedThing[] {
  const grid = scene === 'custom' ? custom?.grid : ISO_PRESETS[scene].grid;
  if (!grid || !pinFits(pin, scene)) return [];
  const claimed = new Set<string>();
  // Groups that already have a member in this scene, or got one in this scan.
  const present = new Set(library.filter((f) => f.scene === scene).map(fixtureGroup));
  /** The best match elsewhere whose group has nothing in this scene yet. */
  const linkable = (ranked: { f: Fixture }[], self?: Fixture) =>
    ranked.find(
      (x) =>
        x.f.scene !== scene &&
        (!present.has(fixtureGroup(x.f)) || (self && fixtureGroup(self) === fixtureGroup(x.f))),
    )?.f;
  let left = room;
  return scan.things.map((thing, index): MappedThing => {
    if (isDismissed(thing.label, dismissed))
      return {
        label: thing.label.charAt(0).toUpperCase() + thing.label.slice(1),
        match: 'dismissed',
        fixture: null,
        note: 'You said this isn’t a fixture, so it was skipped.',
      };
    const ranked = library
      .map((f) => ({ f, score: libraryScore(thing, f) }))
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score);
    // Where it touches down, in the pin's frame (shares travel across sizes):
    // its mask's lowest rows when SAM outlined it, else its box's bottom centre.
    const outline = outlines[index];
    const share = outline ?? {
      foot: {
        x: (thing.box.x1 + thing.box.x2) / 2000,
        y: Math.max(thing.box.y1, thing.box.y2) / 1000,
      },
      size: {
        w: Math.abs(thing.box.x2 - thing.box.x1) / 1000,
        h: Math.abs(thing.box.y2 - thing.box.y1) / 1000,
      },
    };
    const where = standing(
      pin,
      scene,
      custom,
      { x: share.foot.x * pin.frame.width, y: share.foot.y * pin.frame.height },
      Math.max(share.size.h * pin.frame.height, share.size.w * pin.frame.width),
    );
    const fitted = models[index] ?? null;
    const here = ranked.find((x) => x.f.scene === scene && !claimed.has(x.f.id));
    if (here) {
      claimed.add(here.f.id);
      const other = linkable(ranked, here.f);
      const link = other && fixtureGroup(other) !== fixtureGroup(here.f) ? other : undefined;
      if (link) present.add(fixtureGroup(link));
      // What a scan placed and nobody has touched since follows the latest scan.
      const follows = here.f.scanned || here.f.model.source === 'placeholder';
      const moveTo = where && follows ? place(here.f, where, custom, grid) : undefined;
      const remodel = fitted && follows ? { ...fitted, label: here.f.model.label } : undefined;
      return {
        label: here.f.label,
        match: 'existing',
        fixtureId: here.f.id,
        seen: share,
        ...(link ? { linkTo: link.id } : {}),
        ...(moveTo ? { moveTo } : {}),
        ...(remodel ? { remodel } : {}),
        fixture: null,
        note: `Already in the room as the ${here.f.label.toLowerCase()}${moveTo ? ', moved to where the scan found it' : ''}${remodel ? ', modelled from its outline' : ''}${link ? '; now linked with the one in the other scene' : ''}.`,
      };
    }
    const label = thing.label.charAt(0).toUpperCase() + thing.label.slice(1);
    if (left <= 0)
      return { label, match: 'placeholder', fixture: null, note: 'No room for more fixtures.' };
    if (!where)
      return { label, match: 'placeholder', fixture: null, note: 'The pin’s surface is gone.' };
    // The same thing elsewhere first; else another of its kind, unlinked.
    const same = linkable(ranked);
    const known = same ?? ranked[0]?.f;
    if (same) present.add(fixtureGroup(same));
    let base: Omit<FixtureInput, 'at' | 'surfaceId'>;
    if (known) {
      const k = tileCm(known.scene, custom) / tileCm(scene, custom);
      const entity = known.control.kind === 'none' ? null : known.control.entityId;
      base = {
        label: known.label,
        scene,
        turns: known.turns,
        size: {
          w: round(known.size.w * k),
          d: round(known.size.d * k),
          h: round(known.size.h * k),
        },
        model: { label: known.model.label, parts: known.model.parts },
        reference: known.reference,
        control: entity && entities.includes(entity) ? known.control : { kind: 'none' },
      };
    } else
      base = {
        label,
        scene,
        turns: 0,
        size: sizeInTiles(thing.sizeCm, scene, custom),
        model: fitted ?? placeholderModel(label, thing.archetype, thing.color, thing.material),
        reference: null,
        control: { kind: 'none' },
      };
    left--;
    const fixture: FixtureInput = { ...base, ...place(base, where, custom, grid) };
    return known
      ? {
          label: base.label,
          match: 'library',
          fixtureId: known.id,
          seen: share,
          ...(same ? { linkTo: same.id } : {}),
          fixture,
          note: same
            ? `The ${known.label.toLowerCase()} from the other scene, linked.`
            : `Placed with the model of the ${known.label.toLowerCase()}.`,
        }
      : {
          label,
          match: fitted ? 'fitted' : 'placeholder',
          fixture,
          seen: share,
          note: fitted
            ? `Placed with a ${thing.archetype} model fitted to its outline.`
            : `Placed with a placeholder ${thing.archetype} model.`,
        };
  });
}
const round = (n: number) => Math.round(Math.min(8, Math.max(0.1, n)) * 100) / 100;
