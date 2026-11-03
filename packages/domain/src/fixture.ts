import { z } from 'zod';
import { ISO_PRESETS, isoSurface } from './iso-presets.js';
import { ITEM_MATERIALS, isoItemSchema, mugItem, type SavedItem } from './iso-item.js';
import {
  archetypeSchema,
  buildItem,
  catItem,
  catTreeItem,
  archetypeOf,
  defaultFit,
  floorLampItem,
  monitorItem,
  type Archetype,
  type CatFit,
} from './iso-archetypes.js';
import { ISO_TILE_CM } from './iso-furniture.js';
import {
  isoSceneKindSchema,
  layerSchema,
  type IsoBox,
  type IsoScene,
  type IsoSceneKind,
} from './iso.js';
import type { DeskObservation } from './memory.js';

/**
 * A fixture is a thing in a room that belongs there: a lamp, a wall switch, a
 * mouse. It is placed by hand and is what rules act on. Once a person has
 * confirmed it in the camera's view it is followed like an object: its place
 * in the room follows what SAM sees, and it can decide rules too.
 */
export const CONTROL_KINDS = ['none', 'light', 'switch'] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];
/**
 * The Home Assistant domains that turn on and off: lights, and the ones that
 * act like a switch (a fan, a helper toggle). Anything else is never switched.
 */
export const SWITCHABLE_DOMAINS = ['light', 'switch', 'fan', 'input_boolean'] as const;
const lightEntitySchema = z.string().regex(/^light\.[a-z0-9_]+$/);
/** A switch, a fan or a helper toggle: on and off, no brightness. */
const switchEntitySchema = z.string().regex(/^(switch|fan|input_boolean)\.[a-z0-9_]+$/);
/** A Home Assistant entity a fixture or a rule can switch. */
export const entityIdSchema = z.string().regex(/^(light|switch|fan|input_boolean)\.[a-z0-9_]+$/);
/** Which fixture kind an entity is: a light, else a switch. */
export const controlKindOf = (entityId: string): 'light' | 'switch' =>
  entityId.startsWith('light.') ? 'light' : 'switch';
export const fixtureControlSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('light'), entityId: lightEntitySchema }).strict(),
  z.object({ kind: z.literal('switch'), entityId: switchEntitySchema }).strict(),
]);
export type FixtureControl = z.infer<typeof fixtureControlSchema>;
/**
 * One light source of a fixture's model, switched by its own entity: a floor
 * lamp's uplight bowl and its reading shade. A source is a part whose id is
 * `shade` or starts with `shade-` (`lightSources`).
 */
const fixtureLightSchema = z
  .object({ part: z.string().min(1).max(24), entityId: entityIdSchema })
  .strict();
const MAX_FIXTURE_LIGHTS = 4;
export const MAX_FIXTURES = 12;
/** Templates the Fixture Studio and Add Fixture panel can start from without a photo. */
export const STARTER_TEMPLATES = [
  'cat',
  'monitor',
  'lamp',
  'floor-lamp',
  'plant',
  'mug',
  'book',
  'device',
  'box',
  'cat-tree',
] as const;
export type StarterTemplate = (typeof STARTER_TEMPLATES)[number];
/** The illustrated reference pictures demo mode can draft fixtures from. */
export const DEMO_REFERENCES = ['mouse', 'lamp', 'monitor', 'cat'] as const;
export type DemoReference = (typeof DEMO_REFERENCES)[number];

export const fixtureStateNameSchema = z.string().trim().min(1).max(24);
const fixtureSizeSchema = z
  .object({
    w: z.number().min(0.1).max(8),
    d: z.number().min(0.1).max(8),
    h: z.number().min(0.1).max(8),
  })
  .strict();
const fixtureReferenceSchema = z
  .object({ runId: z.string().min(1), asset: z.string().min(1) })
  .strict()
  .nullable();
export const fixtureStateInputSchema = z
  .object({
    model: z.preprocess(
      (m) =>
        m && typeof m === 'object' && 'label' in m && 'parts' in m
          ? { label: (m as { label: unknown }).label, parts: (m as { parts: unknown }).parts }
          : m,
      isoItemSchema,
    ),
    size: fixtureSizeSchema.optional(),
    reference: fixtureReferenceSchema.optional(),
  })
  .strict();
export interface FixtureState {
  model: SavedItem;
  size?: z.infer<typeof fixtureSizeSchema>;
  reference?: z.infer<typeof fixtureReferenceSchema>;
}

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
    size: fixtureSizeSchema,
    /** Its draw layer, like a z-index: higher is drawn over lower where they meet. */
    layer: layerSchema.optional(),
    model: isoItemSchema,
    /** The reference photo's run and asset, for the editor's photo overlay. */
    reference: fixtureReferenceSchema,
    control: fixtureControlSchema,
    /** What it is, when a person chose it from the starters (`retypeFixture`). */
    type: z.enum(STARTER_TEMPLATES).optional(),
    /** Its light sources' own entities, one per source part, besides `control`. */
    lights: z
      .array(fixtureLightSchema)
      .max(MAX_FIXTURE_LIGHTS)
      .refine((ls) => new Set(ls.map((l) => l.part)).size === ls.length, {
        message: 'A light source is linked once.',
      })
      .optional(),
    /** Named states or poses, each with its own unique model, size or reference. */
    states: z.record(fixtureStateNameSchema, fixtureStateInputSchema).optional(),
    /** True hands its place back to scans; any other save keeps it where the person put it. */
    scanned: z.boolean().optional(),
    /**
     * Where it stands in the view of a photographed room that has a close
     * view (the office desk), when the person put it somewhere else there:
     * `at` and `surfaceId` are then where the desk's camera puts it, in the
     * close view. Null puts it back where the camera does.
     */
    room: z
      .object({
        surfaceId: z.string().min(1).max(48).nullable(),
        at: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type FixtureInput = z.infer<typeof fixtureInputSchema>;

export interface Fixture extends Omit<FixtureInput, 'id' | 'model' | 'states'> {
  id: string;
  model: SavedItem;
  /** The active state or pose of the fixture (`on`, `off`, `idle`, `sleeping`, or custom). */
  state?: string | null;
  /** Each linked light source's last confirmed state, by part; unknown when missing. */
  lit?: Record<string, boolean>;
  /** Each state's unique fixture model, size or reference. */
  states?: Record<string, FixtureState>;
  /**
   * One thing seen in several scenes (a room and its close view) shares a
   * link: what it is and what it switches stay the same in each.
   */
  link?: string;
  /** Placed by a scan and not saved by hand since: it follows the latest scan. */
  scanned?: boolean;
  /**
   * Where the last scan saw it touch down and how big it looked, as shares of
   * the photo the pin was set on, so a corrected pin can place it again;
   * with a sample of its outline's points when a scan outlined it.
   */
  seen?: {
    foot: { x: number; y: number };
    size: { w: number; h: number };
    points?: { x: number; y: number }[];
  };
  /** Set once a person confirmed it in the camera's view; moving it by hand clears it. */
  track?: FixtureTrack;
  /**
   * `sightings`: placed by where the camera last saw it, through the pin, as
   * the mug and other remembered objects are; it always has a `track`, and
   * its `scene`, `at` and `size` aren't where it is drawn. Unset: where the
   * person (or a scan) put it.
   */
  place?: 'sightings';
  /**
   * Models it had before, newest first (at most MAX_DRAFTS): each change of
   * model by Model with AI, SAM 3D or another photo keeps the one it replaced,
   * so the person can compare them and pick one back.
   */
  drafts?: EarlierDraft[];
  createdAt: string;
  updatedAt: string;
}

/** How many earlier models a fixture keeps to choose between. */
export const MAX_DRAFTS = 4;
/** What made a fixture's model, read off the model itself. */
type ModelOrigin = 'fit' | 'photos' | 'sculpt' | 'sam3d' | 'other';
export const MODEL_ORIGIN_LABEL: Record<ModelOrigin, string> = {
  fit: 'Fitted to its photo',
  photos: 'Fused from several photos',
  sculpt: 'Modelled with AI',
  sam3d: 'Refined with SAM 3D',
  other: 'Drawn by hand or a template',
};
export function modelOrigin(model: SavedItem): ModelOrigin {
  const fit = model.fit;
  if (fit?.assists.some((a) => a.startsWith('SAM 3D'))) return 'sam3d';
  if (fit && fit.views > 1) return 'photos';
  if (fit) return 'fit';
  return model.source === 'spark' ? 'sculpt' : 'other';
}
interface EarlierDraft {
  model: SavedItem;
  origin: ModelOrigin;
  /** When it was replaced. */
  replacedAt: string;
}
/**
 * The fixture with `model` in place of its own, the one it replaces kept as
 * an earlier draft unless it was only the stock one.
 */
export function withNewModel<F extends Pick<Fixture, 'model' | 'drafts'>>(
  f: F,
  model: SavedItem,
  now: string,
): F {
  // A stock model was never drafted for it, so there is nothing to go back to.
  if (isStockModel(f.model)) return { ...f, model };
  const kept: EarlierDraft = { model: f.model, origin: modelOrigin(f.model), replacedAt: now };
  return { ...f, model, drafts: [kept, ...(f.drafts ?? [])].slice(0, MAX_DRAFTS) };
}

/** A fixture the camera follows, like a remembered object. */
export interface FixtureTrack {
  /** The SAM concept it was confirmed from; it is looked for in outlines of the same one. */
  concept: string;
  observation: DeskObservation;
  /** Earlier sightings, newest first. */
  history: DeskObservation[];
  /**
   * `seen`: where SAM last confirmed it. `moved`: SAM saw it somewhere new
   * and its place in the room followed. `missing`: the watcher lost it; it
   * keeps its last place.
   */
  status: 'seen' | 'moved' | 'missing';
}
/** How far its foot must move, as a share of the frame, to count as moved rather than seen again. */
export const FIXTURE_MOVED = 0.03;
/** Where a sighting touches down and how big it looks, as shares of its frame, as a scan records it. */
export function sightingSpot(
  o: Pick<DeskObservation, 'box' | 'frame'>,
): NonNullable<Fixture['seen']> {
  const { box, frame } = o;
  return {
    foot: { x: (box.x + box.width / 2) / frame.width, y: (box.y + box.height) / frame.height },
    size: { w: box.width / frame.width, h: box.height / frame.height },
  };
}

/** The group a fixture belongs to: its link, or itself alone. */
export const fixtureGroup = (f: Pick<Fixture, 'id' | 'link'>) => f.link ?? f.id;
/** The same thing in the other scenes it is linked into. */
export function linkedFixtures(fixtures: Fixture[], f: Pick<Fixture, 'id' | 'link'>): Fixture[] {
  return f.link ? fixtures.filter((x) => x.id !== f.id && x.link === f.link) : [];
}

/** What a saved fixture sends back to be saved again, as it is. */
export function fixtureInput(f: Fixture): FixtureInput {
  return {
    id: f.id,
    label: f.label,
    scene: f.scene,
    surfaceId: f.surfaceId,
    at: f.at,
    turns: f.turns,
    size: f.size,
    ...(f.layer ? { layer: f.layer } : {}),
    model: { label: f.model.label, parts: f.model.parts },
    reference: f.reference,
    control: f.control,
    ...(f.type ? { type: f.type } : {}),
    ...(f.lights?.length ? { lights: f.lights } : {}),
    ...(f.states
      ? {
          states: Object.fromEntries(
            Object.entries(f.states).map(([k, v]) => [
              k,
              {
                model: { label: v.model.label, parts: v.model.parts },
                ...(v.size ? { size: v.size } : {}),
                ...(v.reference !== undefined ? { reference: v.reference } : {}),
              },
            ]),
          ),
        }
      : {}),
    ...(f.room ? { room: f.room } : {}),
  };
}

/** A cat by name: the name's last word, so a cat tower, bed or litter box isn't one. */
const CAT_NAME = /\b(cat|kitty|kitten)s?$/i;
/** The warm tone a lit shade takes. */
const WARM = '#ffe299';
/** A state's variant of a base model when no custom state model was saved for it. */
export function stateVariantModel(
  base: SavedItem,
  state: string,
  kind: ControlKind = 'none',
): SavedItem {
  if (
    (state === 'idle' || state === 'sleeping') &&
    (base.fit?.archetype === 'cat' || CAT_NAME.test(base.label.trim()))
  ) {
    const fit = base.fit?.params as CatFit | undefined;
    const colors =
      fit?.family === 'cat'
        ? [fit.colors.body, fit.colors.accent]
        : base.swatches.map((s) => s.hex);
    const built = catItem(base.label, state, colors);
    return {
      ...base,
      parts: built.parts,
      fit:
        base.fit && fit?.family === 'cat'
          ? { ...base.fit, params: { ...fit, pose: state } }
          : base.fit,
    };
  }
  if (state === 'on' || state === 'off') {
    if (base.parts.some((p) => p.id === 'screen')) {
      return {
        ...base,
        parts: base.parts.map((p) =>
          p.id === 'screen' ? { ...p, color: state === 'on' ? '#68b5e8' : '#2c3858' } : p,
        ),
      };
    }
    // A floor lamp's shades glow: the bowl from inside, the reading shade at its mouth.
    if (base.parts.some((p) => p.id.startsWith('shade-'))) {
      const lit = state === 'on';
      return {
        ...base,
        parts: base.parts.map((p) => (p.id.startsWith('shade-') ? glowShade(p, lit) : p)),
      };
    }
    if (
      state === 'on' &&
      (kind === 'light' ||
        base.fit?.archetype === 'lamp' ||
        /\b(lamp|light|bulb|sconce|lantern)\b/i.test(base.label))
    ) {
      return {
        ...base,
        parts: base.parts.map((p, i) => {
          if (p.shape === 'lathe' && p.profile.length >= 5) {
            const bands = (p.paint ?? []).filter((b) => !(b.kind === 'band' && b.from >= 0.55));
            return {
              ...p,
              paint: [
                ...bands,
                { kind: 'band' as const, from: 0.58, to: 1, color: '#ffe299' },
              ].slice(0, 6),
            };
          }
          return i === base.parts.length - 1 ? { ...p, color: '#ffe299' } : p;
        }),
      };
    }
  }
  return base;
}

type ItemPart = SavedItem['parts'][number];
/** A shade lit or not: the bowl glows from inside, any other shade at its mouth. */
function glowShade(p: ItemPart, lit: boolean): ItemPart {
  const rest = (p.paint ?? []).filter((b) => !(b.kind === 'band' && b.color === WARM));
  const glow = p.id === 'shade-bowl' ? { from: 0.7, to: 1 } : { from: 0, to: 0.3 };
  return {
    ...p,
    paint: lit ? [...rest, { kind: 'band' as const, ...glow, color: WARM }].slice(0, 6) : rest,
    ...(p.shape === 'lathe' && p.inside
      ? { inside: { ...p.inside, wall: lit ? WARM : p.color } }
      : {}),
  };
}

const isShade = (id: string) => id === 'shade' || id.startsWith('shade-');
const SOURCE_NAMES: Record<string, string> = {
  shade: 'Shade',
  'shade-bowl': 'Uplight bowl',
  'shade-reading': 'Reading shade',
};
interface LightSource {
  part: string;
  label: string;
}
/** The parts of a model that give light, each of which can be linked to its own entity. */
export function lightSources(model: Pick<SavedItem, 'parts'>): LightSource[] {
  return model.parts
    .filter((p) => isShade(p.id))
    .map((p) => ({
      part: p.id,
      label:
        SOURCE_NAMES[p.id] ??
        `${p.id
          .slice(6)
          .replace(/-/g, ' ')
          .replace(/^./, (c) => c.toUpperCase())} shade`,
    }));
}

/** Every entity a fixture switches: its own control, then its light sources'. */
export function fixtureEntities(f: Pick<Fixture, 'control' | 'lights'>): string[] {
  const own = fixtureEntity(f);
  return [...new Set([...(own ? [own] : []), ...(f.lights ?? []).map((l) => l.entityId)])];
}

/** Whether a fixture gives light now: its light is on, or one of its sources is. */
export function fixtureGlows(f: Pick<Fixture, 'control' | 'state' | 'lit'>): boolean {
  return (
    (f.control.kind === 'light' && f.state === 'on') || Object.values(f.lit ?? {}).some(Boolean)
  );
}

/**
 * Each linked source lit by its own entity's state; a source with no entity
 * of its own follows the fixture's state, as `stateVariantModel` drew it.
 */
function withLitSources(model: SavedItem, f: Partial<Pick<Fixture, 'lights' | 'lit'>>): SavedItem {
  const own = new Map((f.lights ?? []).map((l) => [l.part, f.lit?.[l.part] ?? false]));
  if (!model.parts.some((p) => own.has(p.id) && isShade(p.id))) return model;
  return {
    ...model,
    parts: model.parts.map((p) =>
      own.has(p.id) && isShade(p.id) ? glowShade(p, own.get(p.id)!) : p,
    ),
  };
}

/** Default per-state fixtures for a newly drafted or saved cat, monitor or lamp. */
export function defaultFixtureStates(f: {
  label: string;
  archetype?: Archetype;
  control?: ControlKind;
  model: SavedItem;
}): { state?: string | null; states?: Record<string, FixtureState> } {
  const isCat =
    f.archetype === 'cat' || f.model.fit?.archetype === 'cat' || CAT_NAME.test(f.label.trim());
  if (isCat) {
    return {
      state: 'idle',
      states: {
        idle: {
          model: stateVariantModel(f.model, 'idle'),
          size: sizeInTiles({ w: 26, d: 28, h: 32 }),
        },
        sleeping: {
          model: stateVariantModel(f.model, 'sleeping'),
          size: sizeInTiles({ w: 28, d: 26, h: 18 }),
        },
      },
    };
  }
  const isMonitor =
    /\b(monitor|display|screen)\b/i.test(f.label) || f.model.parts.some((p) => p.id === 'screen');
  if (isMonitor) {
    const base = f.model.parts.some((p) => p.id === 'screen')
      ? f.model
      : { ...f.model, ...monitorItem(f.label, false) };
    return {
      states: {
        off: { model: stateVariantModel(base, 'off', f.control) },
        on: { model: stateVariantModel(base, 'on', f.control) },
      },
    };
  }
  if (
    f.control === 'light' ||
    f.archetype === 'lamp' ||
    f.model.fit?.archetype === 'lamp' ||
    /\b(lamp|light|bulb|sconce|lantern)\b/i.test(f.label)
  ) {
    return {
      states: {
        off: { model: f.model },
        on: { model: stateVariantModel(f.model, 'on', 'light') },
      },
    };
  }
  return {};
}

/** The model a fixture shows in its active (or given) state. */
export function fixtureModel(
  f: Pick<Fixture, 'model'> &
    Partial<Pick<Fixture, 'state' | 'states' | 'control' | 'lights' | 'lit'>>,
  state = f.state,
): SavedItem {
  const model = !state
    ? f.model
    : (f.states?.[state]?.model ?? stateVariantModel(f.model, state, f.control?.kind));
  return withLitSources(model, f);
}

/** The size a fixture takes in its active (or given) state. */
export function fixtureSize(
  f: Pick<Fixture, 'size'> & Partial<Pick<Fixture, 'state' | 'states'>>,
  state = f.state,
): FixtureInput['size'] {
  return (state ? f.states?.[state]?.size : undefined) ?? f.size;
}

/** The reference photo a fixture uses in its active (or given) state. */
export function fixtureReference(
  f: Pick<Fixture, 'reference'> & Partial<Pick<Fixture, 'state' | 'states'>>,
  state = f.state,
): FixtureInput['reference'] {
  const custom = state ? f.states?.[state]?.reference : undefined;
  return custom !== undefined ? custom : f.reference;
}

/** All state names a fixture offers, in order. */
export function fixtureStateNames(
  f: Pick<Fixture, 'control'> & Partial<Pick<Fixture, 'state' | 'states'>>,
): string[] {
  const names = new Set<string>();
  if (f.control.kind !== 'none') {
    names.add('off');
    names.add('on');
  }
  for (const k of Object.keys(f.states ?? {})) names.add(k);
  if (f.state) names.add(f.state);
  return [...names];
}

/** A fixture where the room's own view shows it: its room place, else where the camera puts it. */
export function inRoomView<F extends Pick<Fixture, 'at' | 'surfaceId' | 'room'>>(f: F): F {
  return f.room ? { ...f, at: f.room.at, surfaceId: f.room.surfaceId } : f;
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
  fixture: Pick<Fixture, 'scene' | 'surfaceId' | 'at' | 'turns' | 'size'> &
    Partial<Pick<Fixture, 'state' | 'states' | 'layer'>>,
  custom?: IsoScene | null,
): IsoBox {
  const surface = fixture.surfaceId
    ? isoSurface(fixture.scene, fixture.surfaceId, custom)
    : undefined;
  const sz = fixtureSize(fixture);
  const turned = fixture.turns % 2 === 1;
  return {
    at: { x: fixture.at.x, y: fixture.at.y, z: surface?.z ?? 0 },
    size: {
      w: turned ? sz.d : sz.w,
      d: turned ? sz.w : sz.d,
      h: sz.h,
    },
    ...(fixture.layer ? { layer: fixture.layer } : {}),
  };
}

/**
 * Why a fixture can't stand where it says, or null when it can: its scene
 * must exist, its surface must be one of that scene's, and its footprint must
 * lie inside the grid (and on the surface, when it stands on one).
 */
export function fixtureProblem(
  fixture: Pick<Fixture, 'scene' | 'surfaceId' | 'at' | 'turns' | 'size' | 'room'>,
  custom?: IsoScene | null,
): string | null {
  // Its place in the room's view must hold as well.
  if (fixture.room) {
    const problem = fixtureProblem({ ...fixture, ...fixture.room, room: null }, custom);
    if (problem) return problem;
  }
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
 * Fixtures standing on a surface of the person's scene follow it when the
 * scene is saved with that surface moved or turned: a lamp on a desk that
 * was turned stays where it was on the desk, turned with it. A surface's
 * turn is its prop's (`turns`), or a quarter when its sides swapped.
 */
export function followSurfaces(
  fixtures: Fixture[],
  before: IsoScene | null,
  after: IsoScene | null,
): Fixture[] {
  if (!before || !after) return fixtures;
  return fixtures.map((f) => {
    if (f.scene !== 'custom' || !f.surfaceId) return f;
    const was = before.surfaces.find((t) => t.id === f.surfaceId);
    const now = after.surfaces.find((t) => t.id === f.surfaceId);
    if (!was || !now) return f;
    const turnsOf = (scene: IsoScene, propId: string) =>
      scene.props.find((p) => p.id === propId)?.turns ?? 0;
    const prop = after.props.find((p) => p.id === now.propId);
    const formed = prop?.form ?? prop?.recipe;
    const k = formed
      ? (((turnsOf(after, now.propId) - turnsOf(before, was.propId)) % 4) + 4) % 4
      : Math.abs(was.rect.w - now.rect.d) < 1e-6 &&
          Math.abs(was.rect.d - now.rect.w) < 1e-6 &&
          Math.abs(was.rect.w - was.rect.d) > 1e-6
        ? 1
        : 0;
    const moved =
      k !== 0 ||
      Math.abs(was.rect.x - now.rect.x) > 1e-6 ||
      Math.abs(was.rect.y - now.rect.y) > 1e-6;
    if (!moved) return f;
    const box = fixtureBox(f, before);
    // Its centre from the surface's centre, turned k quarters clockwise (seen from above).
    let u = box.at.x + box.size.w / 2 - (was.rect.x + was.rect.w / 2);
    let v = box.at.y + box.size.d / 2 - (was.rect.y + was.rect.d / 2);
    for (let i = 0; i < k; i++) [u, v] = [-v, u];
    const turns = ((f.turns + k) % 4) as Fixture['turns'];
    const size = fixtureBox({ ...f, turns }, after).size;
    return {
      ...f,
      turns,
      at: {
        x: now.rect.x + now.rect.w / 2 + u - size.w / 2,
        y: now.rect.y + now.rect.d / 2 + v - size.d / 2,
      },
    };
  });
}

/**
 * Fixtures after the person's own scene changed: one whose surface is gone
 * stands on the floor where it was, and one that no longer fits the grid is
 * pulled back inside it. Preset scenes never change, so their fixtures stay.
 */
export function settleFixtures(fixtures: Fixture[], custom: IsoScene | null): Fixture[] {
  return fixtures.flatMap((f) => {
    // A thing placed by its sightings stands wherever the camera saw it.
    if (f.scene !== 'custom' || f.place === 'sightings') return [f];
    if (!custom) return [];
    let next = f;
    if (next.surfaceId && !isoSurface('custom', next.surfaceId, custom))
      next = { ...next, surfaceId: null };
    const { size } = fixtureBox(next, custom);
    const x = Math.min(Math.max(next.at.x, 0), Math.max(custom.grid.w - size.w, 0));
    const y = Math.min(Math.max(next.at.y, 0), Math.max(custom.grid.d - size.d, 0));
    if (x !== next.at.x || y !== next.at.y) next = { ...next, at: { x, y } };
    // A room place that no longer holds goes; the room shows it where the camera puts it.
    if (next.room && fixtureProblem({ ...next, ...next.room, room: null }, custom)) {
      const { room: _gone, ...rest } = next;
      next = rest;
    }
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
  /** The saved product it was matched to, whose real size it took ("IKEA Alex desk"). */
  product?: string;
  reference: FixtureInput['reference'];
  state?: string | null;
  states?: Record<string, FixtureState>;
}

const STARTER_META: Record<
  StarterTemplate,
  {
    label: string;
    archetype: Archetype;
    suggested: ControlKind;
    description: string;
    sizeCm: { w: number; d: number; h: number };
    colors: [string, string];
  }
> = {
  cat: {
    label: 'Cat',
    archetype: 'cat',
    suggested: 'none',
    description: 'A cat with idle and sleeping poses.',
    sizeCm: { w: 26, d: 28, h: 32 },
    colors: ['#d88b4b', '#f2e6d8'],
  },
  monitor: {
    label: 'Monitor',
    archetype: 'box',
    suggested: 'switch',
    description: 'A monitor with off and on screen states.',
    sizeCm: { w: 52, d: 18, h: 38 },
    colors: ['#23283c', '#68b5e8'],
  },
  lamp: {
    label: 'Desk lamp',
    archetype: 'lamp',
    suggested: 'light',
    description: 'A lamp with off and warm on states.',
    sizeCm: { w: 18, d: 18, h: 36 },
    colors: ['#d7ccb8', '#8a7966'],
  },
  'floor-lamp': {
    label: 'Floor lamp',
    archetype: 'lamp',
    suggested: 'light',
    description: 'A floor lamp with an uplight bowl and a reading shade, off and warm on.',
    sizeCm: { w: 36, d: 36, h: 175 },
    colors: ['#1e1f24', '#f1ede4'],
  },
  plant: {
    label: 'Potted plant',
    archetype: 'plant',
    suggested: 'none',
    description: 'A leafy plant in a ceramic pot.',
    sizeCm: { w: 16, d: 16, h: 24 },
    colors: ['#b38b6d', '#4d6a54'],
  },
  mug: {
    label: 'Mug',
    archetype: 'mug',
    suggested: 'none',
    description: 'A ceramic mug with a handle.',
    sizeCm: { w: 12, d: 10, h: 10 },
    colors: ['#ece5d0', '#73604c'],
  },
  book: {
    label: 'Book',
    archetype: 'book',
    suggested: 'none',
    description: 'A hardcover book lying flat.',
    sizeCm: { w: 16, d: 22, h: 4 },
    colors: ['#3c554a', '#e6dfcc'],
  },
  device: {
    label: 'Device',
    archetype: 'device',
    suggested: 'switch',
    description: 'A compact tabletop device or switch.',
    sizeCm: { w: 8, d: 12, h: 4 },
    colors: ['#4a5164', '#1f232f'],
  },
  box: {
    label: 'Speaker box',
    archetype: 'box',
    suggested: 'none',
    description: 'A rounded box or tabletop speaker.',
    sizeCm: { w: 18, d: 14, h: 14 },
    colors: ['#5f7c88', '#4a5164'],
  },
  'cat-tree': {
    label: 'Cat tree',
    archetype: 'box',
    suggested: 'none',
    description:
      'A cat tree with a cubby, a perch and a bed on top: keeps whether the cat is on it.',
    sizeCm: { w: 50, d: 50, h: 120 },
    colors: ['#8d8f94', '#c9b48f'],
  },
};

/**
 * The usual model for a thing of this name, until one is drafted for it: a
 * mug's for a mug, else its archetype's (`placeholder`, so it reads as not
 * drafted yet).
 */
export function stockModel(label: string): SavedItem {
  const archetype = archetypeOf(label);
  const item =
    archetype === 'mug'
      ? mugItem(undefined, undefined, label)
      : buildItem(label, defaultFit(archetype));
  return {
    ...item,
    source: 'placeholder',
    segmentRunId: null,
    swatches: [],
    updatedAt: STOCK_AT,
    fit: null,
  };
}
/** When a stock model was made: never, which is how it is told from a drafted placeholder. */
const STOCK_AT = new Date(0).toISOString();
/** Whether a model is only a thing's stock one, not drafted for it. */
export const isStockModel = (model: SavedItem) =>
  model.source === 'placeholder' && model.updatedAt === STOCK_AT && !model.segmentRunId;

export function starterMeta(template: StarterTemplate) {
  return STARTER_META[template];
}

/** Build a model from a starter template and optional state (`idle`, `sleeping`, `on`, `off`). */
export function starterTemplateModel(
  template: StarterTemplate,
  opts: { label?: string; colors?: string[]; state?: string | null } = {},
): SavedItem {
  const meta = STARTER_META[template];
  const label = opts.label?.trim() || meta.label;
  const colors = opts.colors?.length ? opts.colors : meta.colors;
  const pose = opts.state === 'sleeping' ? 'sleeping' : 'idle';
  const base =
    template === 'cat'
      ? catItem(label, pose, colors)
      : template === 'monitor'
        ? {
            ...monitorItem(label, opts.state === 'on'),
            parts: monitorItem(label, opts.state === 'on').parts.map((p) =>
              p.id === 'screen'
                ? { ...p, color: opts.state === 'on' ? (colors[1] ?? '#68b5e8') : '#2c3858' }
                : { ...p, color: colors[0] ?? '#23283c' },
            ),
          }
        : template === 'floor-lamp'
          ? floorLampItem(label, colors)
          : template === 'cat-tree'
            ? catTreeItem(label, colors)
            : buildItem(label, defaultFit(meta.archetype, colors));
  const saved: SavedItem = {
    ...base,
    source: 'placeholder',
    segmentRunId: null,
    swatches: colors.map((hex, i) => ({ hex, share: i === 0 ? 0.7 : 0.3 })),
    updatedAt: new Date().toISOString(),
    fit: null,
  };
  return opts.state && template !== 'cat' && template !== 'monitor'
    ? stateVariantModel(saved, opts.state, meta.suggested)
    : saved;
}

/** Draft a complete fixture with its default states directly from a starter template. */
export function starterFixtureDraft(
  template: StarterTemplate,
  opts: { label?: string; colors?: string[] } = {},
): FixtureDraft {
  const meta = STARTER_META[template];
  const label = opts.label?.trim() || meta.label;
  const model = starterTemplateModel(template, { label, colors: opts.colors });
  const seeded = defaultFixtureStates({
    label,
    archetype: meta.archetype,
    control: meta.suggested,
    model,
  });
  return {
    label,
    archetype: meta.archetype,
    suggested: meta.suggested,
    description: meta.description,
    model,
    size: sizeInTiles(meta.sizeCm),
    reference: null,
    ...(seeded.state ? { state: seeded.state } : {}),
    ...(seeded.states ? { states: seeded.states } : {}),
  };
}

const TYPE_OF_ARCHETYPE: Partial<Record<Archetype, StarterTemplate>> = {
  cat: 'cat',
  lamp: 'lamp',
  plant: 'plant',
  mug: 'mug',
  book: 'book',
  device: 'device',
  box: 'box',
};
/** What a fixture is among the starters: as chosen, else read off its model; null for its own. */
export function fixtureType(f: Pick<Fixture, 'model'> & Partial<Pick<Fixture, 'type'>>) {
  if (f.type) return f.type;
  const ids = new Set(f.model.parts.map((p) => p.id));
  if (ids.has('shade-bowl')) return 'floor-lamp';
  if (ids.has('screen')) return 'monitor';
  if (ids.has('cubby') && ids.has('perch')) return 'cat-tree';
  const archetype = f.model.fit?.archetype;
  return (archetype && TYPE_OF_ARCHETYPE[archetype]) ?? null;
}

/**
 * The same fixture as another kind of thing: the starter's model in the
 * fixture's own colours, at the starter's real size and centred where it
 * stood (kept inside the room), with that kind's states. Its name goes too
 * when it was only a starter's name; its switch and the light sources the
 * new model still has stay linked.
 */
export function retypeFixture(
  f: Fixture,
  type: StarterTemplate,
  custom?: IsoScene | null,
): FixtureInput {
  const meta = STARTER_META[type];
  const defaults = new Set(STARTER_TEMPLATES.map((t) => STARTER_META[t].label));
  const label = defaults.has(f.label) ? meta.label : f.label;
  const own = f.model.swatches.map((s) => s.hex);
  const colors = [own[0] ?? meta.colors[0], own[1] ?? meta.colors[1]];
  const model = starterTemplateModel(type, { label, colors });
  const size = sizeInTiles(meta.sizeCm);
  const before = fixtureBox({ ...f, state: null }).size;
  const turned = f.turns % 2 === 1;
  const w = turned ? size.d : size.w;
  const d = turned ? size.w : size.d;
  const grid = sceneOf(f.scene, custom)?.grid;
  const fit = (v: number, span: number, max?: number) =>
    Math.max(0, max === undefined ? v : Math.min(v, max - span));
  const at = {
    x: fit(f.at.x + (before.w - w) / 2, w, grid?.w),
    y: fit(f.at.y + (before.d - d) / 2, d, grid?.d),
  };
  const seeded = defaultFixtureStates({
    label,
    archetype: meta.archetype,
    control: f.control.kind,
    model,
  });
  const parts = new Set(model.parts.map((p) => p.id));
  const lights = (f.lights ?? []).filter((l) => parts.has(l.part) && isShade(l.part));
  const { room: _room, ...rest } = fixtureInput(f);
  return {
    ...rest,
    label,
    type,
    at,
    size,
    model: { label: model.label, parts: model.parts },
    // States made for what it was don't fit what it is now.
    states: Object.fromEntries(
      Object.entries(seeded.states ?? {}).map(([k, v]) => [
        k,
        {
          model: { label: v.model.label, parts: v.model.parts },
          ...(v.size ? { size: v.size } : {}),
        },
      ]),
    ),
    ...(lights.length ? { lights } : { lights: [] }),
    ...(f.scanned ? { scanned: true } : {}),
  };
}

/** Centimetres per tile: every scene is built at real size, so one scale fits all. */
export const tileCm = () => ISO_TILE_CM;
/** A real size in tiles, within what a fixture may be. */
export function sizeInTiles(cm: FixtureClass['sizeCm']): FixtureInput['size'] {
  const per = tileCm();
  const tiles = (v: number) => Math.round(Math.min(8, Math.max(0.1, v / per)) * 100) / 100;
  return { w: tiles(cm.w), d: tiles(cm.d), h: tiles(cm.h) };
}
