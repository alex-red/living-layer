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
  type Point,
  type SurfacePin,
} from './iso.js';
import { cameraFromPin, onPinnedSurface, unprojectPoint } from './photo-scene.js';

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
  /** Placed with a placeholder model. */
  | 'placeholder';
export interface MappedThing {
  label: string;
  match: ScanMatch;
  /** The fixture it is (existing) or was modelled on (library). */
  fixtureId?: string;
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

/**
 * Where a thing stands, from where its box meets the ground in the photo:
 * on the pinned surface when its foot lands on it, else on the floor below
 * the camera, else in front of the surface. A centre point in scene tiles.
 */
function standing(
  pin: SurfacePin,
  scene: IsoSceneKind | 'custom',
  custom: IsoScene | null,
  foot: Point,
): { centre: Point; surfaceId: string | null } | null {
  // The pin maps the frame onto the surface's unit square, so the same
  // surface in a room and its close view takes the thing to the same spot.
  const surface = isoSurface(scene, pin.surfaceId, custom);
  if (!surface) return null;
  const uv = onPinnedSurface(pin, foot);
  const EDGE = 0.04;
  if (uv && uv.x >= -EDGE && uv.x <= 1 + EDGE && uv.y >= -EDGE && uv.y <= 1 + EDGE) {
    const at = surfaceWorld(surface, {
      x: Math.min(1, Math.max(0, uv.x)),
      y: Math.min(1, Math.max(0, uv.y)),
    });
    return { centre: { x: at.x, y: at.y }, surfaceId: surface.id };
  }
  const { w, d } = surface.rect;
  const camera = cameraFromPin(pin.corners, pin.frame, w, [d, d]);
  const floor = camera && unprojectPoint(camera, foot, -surface.z);
  if (floor)
    return {
      centre: { x: surface.rect.x + floor.X, y: surface.rect.y + floor.Y },
      surfaceId: null,
    };
  return {
    centre: { x: surface.rect.x + (uv?.x ?? 0.5) * w, y: surface.rect.y + d + 0.5 },
    surfaceId: null,
  };
}

/**
 * The scene's place for a thing: its box's footprint centred where it
 * stands (the foot is the box's front, so the centre is half a depth back),
 * kept inside the grid, and on the floor if the surface can't hold it.
 */
function place(
  base: Omit<FixtureInput, 'at' | 'surfaceId'>,
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
}: {
  /** Of a photo the pin's camera took, at any size. */
  scan: FixtureScan;
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
  return scan.things.map((thing): MappedThing => {
    const ranked = library
      .map((f) => ({ f, score: libraryScore(thing, f) }))
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score);
    const here = ranked.find((x) => x.f.scene === scene && !claimed.has(x.f.id));
    if (here) {
      claimed.add(here.f.id);
      const other = linkable(ranked, here.f);
      const link = other && fixtureGroup(other) !== fixtureGroup(here.f) ? other : undefined;
      if (link) present.add(fixtureGroup(link));
      return {
        label: here.f.label,
        match: 'existing',
        fixtureId: here.f.id,
        ...(link ? { linkTo: link.id } : {}),
        fixture: null,
        note: link
          ? `Already in the room as the ${here.f.label.toLowerCase()}; now linked with the one in the other scene.`
          : `Already in the room as the ${here.f.label.toLowerCase()}.`,
      };
    }
    const label = thing.label.charAt(0).toUpperCase() + thing.label.slice(1);
    if (left <= 0)
      return { label, match: 'placeholder', fixture: null, note: 'No room for more fixtures.' };
    // Its box's bottom centre, in the pin's frame: thousandths travel across sizes.
    const foot = {
      x: ((thing.box.x1 + thing.box.x2) / 2000) * pin.frame.width,
      y: (Math.max(thing.box.y1, thing.box.y2) / 1000) * pin.frame.height,
    };
    const where = standing(pin, scene, custom, foot);
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
        model: placeholderModel(label, thing.archetype, thing.color, thing.material),
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
          ...(same ? { linkTo: same.id } : {}),
          fixture,
          note: same
            ? `The ${known.label.toLowerCase()} from the other scene, linked.`
            : `Placed with the model of the ${known.label.toLowerCase()}.`,
        }
      : {
          label,
          match: 'placeholder',
          fixture,
          note: `Placed with a placeholder ${thing.archetype} model.`,
        };
  });
}
const round = (n: number) => Math.round(Math.min(8, Math.max(0.1, n)) * 100) / 100;
