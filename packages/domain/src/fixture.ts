import { z } from 'zod';
import { ISO_PRESETS, isoSurface } from './iso-presets.js';
import { ITEM_MATERIALS, isoItemSchema, type SavedItem } from './iso-item.js';
import { archetypeSchema, type Archetype } from './iso-archetypes.js';
import { isoSceneKindSchema, type IsoBox, type IsoScene, type IsoSceneKind } from './iso.js';

/**
 * A fixture is a thing in a room that stays put: a lamp, a wall switch, a
 * mouse. Objects are followed by the camera and decide rules; fixtures are
 * placed by hand, never tracked, and are what rules act on.
 */
export const CONTROL_KINDS = ['none', 'light', 'switch'] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];
export const lightEntitySchema = z.string().regex(/^light\.[a-z0-9_]+$/);
export const switchEntitySchema = z.string().regex(/^switch\.[a-z0-9_]+$/);
/** A Home Assistant entity a fixture or a rule can switch. */
export const entityIdSchema = z.string().regex(/^(light|switch)\.[a-z0-9_]+$/);
export const fixtureControlSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('light'), entityId: lightEntitySchema }).strict(),
  z.object({ kind: z.literal('switch'), entityId: switchEntitySchema }).strict(),
]);
export type FixtureControl = z.infer<typeof fixtureControlSchema>;
export const MAX_FIXTURES = 12;
/** The illustrated reference pictures demo mode can draft fixtures from. */
export const DEMO_REFERENCES = ['mouse', 'lamp'] as const;
export type DemoReference = (typeof DEMO_REFERENCES)[number];

/** What a person sends to save a fixture; the server adds the rest. */
export const fixtureInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    label: z.string().trim().min(1).max(40),
    /** The scene it stands in: a preset room or close view, or the person's own. */
    scene: z.union([isoSceneKindSchema, z.literal('custom')]),
    /** The surface it stands on, or null for the floor. */
    surfaceId: z.string().min(1).max(48).nullable(),
    /** The corner nearest the origin, in the scene's tile space. */
    at: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    turns: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    /** Footprint and height in tiles before turning; the model is scaled to fit. */
    size: z
      .object({
        w: z.number().min(0.1).max(8),
        d: z.number().min(0.1).max(8),
        h: z.number().min(0.1).max(8),
      })
      .strict(),
    model: isoItemSchema,
    /** The reference photo's run and asset, for the editor's photo overlay. */
    reference: z
      .object({ runId: z.string().min(1), asset: z.string().min(1) })
      .strict()
      .nullable(),
    control: fixtureControlSchema,
  })
  .strict();
export type FixtureInput = z.infer<typeof fixtureInputSchema>;

export interface Fixture extends Omit<FixtureInput, 'id' | 'model'> {
  id: string;
  model: SavedItem;
  /** The last confirmed state of its entity, for drawing; never a verdict. */
  state?: 'on' | 'off' | null;
  /**
   * One thing seen in several scenes (a room and its close view) shares a
   * link: what it is and what it switches stay the same in each.
   */
  link?: string;
  createdAt: string;
  updatedAt: string;
}

/** The group a fixture belongs to: its link, or itself alone. */
export const fixtureGroup = (f: Pick<Fixture, 'id' | 'link'>) => f.link ?? f.id;
/** The same thing in the other scenes it is linked into. */
export function linkedFixtures(fixtures: Fixture[], f: Pick<Fixture, 'id' | 'link'>): Fixture[] {
  return f.link ? fixtures.filter((x) => x.id !== f.id && x.link === f.link) : [];
}

/** The entity a fixture switches, or null when it only stands there. */
export function fixtureEntity(fixture: Pick<Fixture, 'control'>): string | null {
  return fixture.control.kind === 'none' ? null : fixture.control.entityId;
}

function sceneOf(kind: IsoSceneKind | 'custom', custom?: IsoScene | null): IsoScene | null {
  return kind === 'custom' ? (custom ?? null) : ISO_PRESETS[kind];
}

/** Where a fixture stands in its scene, as a box for depth sorting and picking. */
export function fixtureBox(
  fixture: Pick<Fixture, 'scene' | 'surfaceId' | 'at' | 'turns' | 'size'>,
  custom?: IsoScene | null,
): IsoBox {
  const surface = fixture.surfaceId
    ? isoSurface(fixture.scene, fixture.surfaceId, custom)
    : undefined;
  const turned = fixture.turns % 2 === 1;
  return {
    at: { x: fixture.at.x, y: fixture.at.y, z: surface?.z ?? 0 },
    size: {
      w: turned ? fixture.size.d : fixture.size.w,
      d: turned ? fixture.size.w : fixture.size.d,
      h: fixture.size.h,
    },
  };
}

/**
 * Why a fixture can't stand where it says, or null when it can: its scene
 * must exist, its surface must be one of that scene's, and its footprint must
 * lie inside the grid (and on the surface, when it stands on one).
 */
export function fixtureProblem(
  fixture: Pick<Fixture, 'scene' | 'surfaceId' | 'at' | 'turns' | 'size'>,
  custom?: IsoScene | null,
): string | null {
  const scene = sceneOf(fixture.scene, custom);
  if (!scene) return 'Save your own scene before placing fixtures in it.';
  const { at, size } = fixtureBox(fixture, custom);
  const EPS = 1e-6;
  if (
    at.x < -EPS ||
    at.y < -EPS ||
    at.x + size.w > scene.grid.w + EPS ||
    at.y + size.d > scene.grid.d + EPS
  )
    return 'The fixture must stand inside the room.';
  if (!fixture.surfaceId) return null;
  const surface = isoSurface(fixture.scene, fixture.surfaceId, custom);
  if (!surface) return `The scene has no surface "${fixture.surfaceId}".`;
  const r = surface.rect;
  const cx = at.x + size.w / 2;
  const cy = at.y + size.d / 2;
  if (cx < r.x || cx > r.x + r.w || cy < r.y || cy > r.y + r.d)
    return `The fixture must stand on ${surface.label.toLowerCase()}.`;
  return null;
}

/**
 * Fixtures after the person's own scene changed: one whose surface is gone
 * stands on the floor where it was, and one that no longer fits the grid is
 * pulled back inside it. Preset scenes never change, so their fixtures stay.
 */
export function settleFixtures(fixtures: Fixture[], custom: IsoScene | null): Fixture[] {
  return fixtures.flatMap((f) => {
    if (f.scene !== 'custom') return [f];
    if (!custom) return [];
    let next = f;
    if (next.surfaceId && !isoSurface('custom', next.surfaceId, custom))
      next = { ...next, surfaceId: null };
    const { size } = fixtureBox(next, custom);
    const x = Math.min(Math.max(next.at.x, 0), Math.max(custom.grid.w - size.w, 0));
    const y = Math.min(Math.max(next.at.y, 0), Math.max(custom.grid.d - size.d, 0));
    if (x !== next.at.x || y !== next.at.y) next = { ...next, at: { x, y } };
    return [next];
  });
}

/**
 * What Spark says about a reference photo: the one thing in it, what shape
 * to model it as, a loose box in thousandths for SAM, whether it looks like
 * a light or a switch, and its typical real size. It never gives a model.
 */
export const fixtureClassSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    archetype: archetypeSchema,
    material: z.enum(ITEM_MATERIALS),
    control: z.enum(CONTROL_KINDS),
    description: z.string().max(240),
    box: z
      .object({
        x1: z.number().int().min(0).max(1000),
        y1: z.number().int().min(0).max(1000),
        x2: z.number().int().min(0).max(1000),
        y2: z.number().int().min(0).max(1000),
      })
      .strict()
      .refine((b) => b.x2 > b.x1 && b.y2 > b.y1, { message: 'The box must have an area.' }),
    /** Width, depth and height in centimetres, as the thing usually is. */
    sizeCm: z
      .object({
        w: z.number().positive().max(400),
        d: z.number().positive().max(400),
        h: z.number().positive().max(400),
      })
      .strict(),
  })
  .strict();
export type FixtureClass = z.infer<typeof fixtureClassSchema>;

/** A drafted fixture for review: nothing is saved until the person places it. */
export interface FixtureDraft {
  label: string;
  archetype: Archetype;
  /** What Spark (or the demo) thinks it is; the person picks the control. */
  suggested: ControlKind;
  description: string;
  model: SavedItem;
  /** Its size in the scene it was drafted for, in tiles. */
  size: FixtureInput['size'];
  reference: NonNullable<FixtureInput['reference']>;
}

/** A desk is about 120 cm wide; scenes without one get a tile of 25 cm. */
const DESK_CM = 120;
/** Centimetres per tile in a scene, from its desk when it has one. */
export function tileCm(kind: IsoSceneKind | 'custom', custom?: IsoScene | null): number {
  const desk = sceneOf(kind, custom)?.surfaces.find((s) => s.id.split(':')[0]?.startsWith('desk'));
  return desk ? DESK_CM / Math.max(desk.rect.w, desk.rect.d) : 25;
}
/** A real size in tiles of one scene, within what a fixture may be. */
export function sizeInTiles(
  cm: FixtureClass['sizeCm'],
  kind: IsoSceneKind | 'custom',
  custom?: IsoScene | null,
): FixtureInput['size'] {
  const per = tileCm(kind, custom);
  const tiles = (v: number) => Math.round(Math.min(8, Math.max(0.1, v / per)) * 100) / 100;
  return { w: tiles(cm.w), d: tiles(cm.d), h: tiles(cm.h) };
}
