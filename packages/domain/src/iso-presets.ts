import { z } from 'zod';
import type { IsoScene, IsoSceneKind, IsoSurface, SurfacePin } from './iso.js';
import { cm } from './iso-furniture.js';
import { placeTemplate, rotateGroup } from './iso-templates.js';

type Item = Parameters<typeof placeTemplate>;
/** A scene from placed templates, in order. */
function compose(
  kind: IsoSceneKind,
  label: string,
  grid: IsoScene['grid'],
  items: Item[],
): IsoScene {
  const built = items.map((args) => placeTemplate(...args));
  return {
    kind,
    label,
    grid,
    props: built.flatMap((b) => b.props),
    surfaces: built.flatMap((b) => b.surfaces),
  };
}

// The office desk is a close view of the office's desk. The illustrated
// demo is that desktop filling the frame, so its book (left) and bottle
// (right) sit where the photo shows them.
const deskScene = compose('desk', 'Office desk', { w: 8, d: 6 }, [
  ['desk', 'desk', 1, 1, 0, { size: { w: 6, d: 4 } }],
  ['book', 'book', 1.85, 2.9, 2.4, { label: 'Green book', optional: true }],
  ['bottle', 'bottle', 5.7, 2.7, 2.4, { label: 'Sage bottle', optional: true }],
  ['lamp', 'lamp', 5.95, 1.2, 2.4],
]);

const officeScene = compose('office', 'Office', { w: 10, d: 8 }, [
  ['wall', 'wall-back', 0, 0, 0, { size: { w: 10, d: 0.2 }, label: 'Back wall' }],
  ['wall', 'wall-left', 0, 0.2, 0, { size: { w: 0.2, d: 7.8 }, label: 'Left wall' }],
  // A 160 × 80 cm desk.
  ['desk', 'desk', 1.2, 1.2, 0, { size: { w: cm(160), d: cm(80) } }],
  ['monitor', 'monitor', 2.7, 1.45, 2.4, { optional: true }],
  ['keyboard', 'keyboard', 2.97, 2.75, 2.4, { optional: true }],
  ['book', 'book', 1.5, 1.55, 2.4, { label: 'Green book', optional: true }],
  ['bottle', 'bottle', 5.6, 3.3, 2.4, { label: 'Sage bottle', optional: true }],
  ['lamp', 'lamp', 5.3, 1.45, 2.4],
  ['chair', 'chair', 2.6, 4.5, 0, { optional: true }],
  ['shelf', 'shelf', 7.1, 0.2, 0, { optional: true }],
  ['plant', 'plant', 0.35, 6.1, 0, { optional: true }],
]);

/**
 * A thing standing in one of the fridge's door bins (it stands at 1.5, 1):
 * `along` cm from the bin's hinge end, square and `w` cm across, `h` tall,
 * set in from the door's lining.
 */
function doorThing(
  template: 'bottle' | 'carton' | 'jar',
  group: string,
  door: 'left' | 'right',
  bin: number,
  along: number,
  label: string,
  { w, h }: { w: number; h: number },
): Item[] {
  const binBottoms = [8, 46, 84];
  // A bin is 12.5 cm deep with a 1.5 cm lip: 11 cm to stand in, against the lining.
  const x = door === 'left' ? 1.5 + cm(1 + (11 - w) / 2) : 1.5 + cm(91 - 12.5 + 1.5 + (11 - w) / 2);
  const y = 1 + cm(74 + 3 + 1.5 + along);
  const z = cm(66 + binBottoms[bin]! + 1.5);
  return [
    [template, group, x, y, z, { label, optional: true, size: { w: cm(w), d: cm(w), h: cm(h) } }],
  ];
}
const fridgeScene = compose('fridge', 'Fridge', { w: 7, d: 7 }, [
  ['fridge', 'fridge', 1.5, 1, 0],
  // The things the fridge camera can follow, in its photo's order, each forward
  // and left enough for the room's corner to see it through the open front:
  // on the crisper lid (66 + 40 cm) the pickles, the leftovers and the milk,
  // the butter on the middle shelf (+ 68), the eggs and, beside them as in the
  // photo, a tub of spinach in the pantry drawer (+ 1.5).
  ['jar', 'jar', 2, 2.1, cm(66 + 40), { label: 'Pickle jar', optional: true }],
  ['tub', 'leftovers', 2.55, 2.8, cm(66 + 40), { label: 'Leftover chicken', optional: true }],
  ['carton', 'milk', 3.3, 3, cm(66 + 40), { label: 'Milk', optional: true }],
  ['butter', 'butter', 2.6, 2.7, cm(66 + 68), { optional: true }],
  ['eggs', 'eggs', 1.95, 2.7, cm(66 + 1.5), { label: 'Eggs', optional: true }],
  ['tub', 'spinach', 2.97, 2.85, cm(66 + 1.5), { label: 'Spinach', optional: true }],
  // In the door bins (bottom, middle, top: 8, 46 and 84 cm up, each tray's
  // floor 1.5 cm thick), as the photos' doors hold them: the left door's
  // sauces, the right door's juice, dressing and jam.
  // The bottom bin has 16.5 cm to the ice maker: the short mustard goes there.
  ...doorThing('bottle', 'mustard', 'left', 0, 16, 'Mustard', { w: 6.5, h: 15 }),
  ...doorThing('bottle', 'mayo', 'left', 1, 5, 'Mayonnaise', { w: 7.5, h: 22 }),
  ...doorThing('bottle', 'hot-sauce', 'left', 2, 26, 'Hot sauce', { w: 5, h: 17 }),
  ...doorThing('carton', 'juice', 'right', 0, 6, 'Orange juice', { w: 7, h: 24 }),
  ...doorThing('bottle', 'dressing', 'right', 1, 22, 'Salad dressing', { w: 6.5, h: 21 }),
  ...doorThing('jar', 'jam', 'right', 2, 12, 'Jam', { w: 9, h: 11 }),
]);

/**
 * A living room for the household ([plan](../../../docs/plans/people-and-pets.md)):
 * a table with a chair either side, a bookshelf and a plant. The
 * demo puts its people and pets in it (`addDemoHousehold`).
 */
const homeScene = rotateGroup(
  rotateGroup(
    compose('home', 'Home', { w: 10, d: 8 }, [
      ['wall', 'wall-back', 0, 0, 0, { size: { w: 10, d: 0.2 }, label: 'Back wall' }],
      ['wall', 'wall-left', 0, 0.2, 0, { size: { w: 0.2, d: 7.8 }, label: 'Left wall' }],
      // A 120 × 80 cm table, a chair on the room's side of it and one by the wall.
      ['table', 'table', 3, 3, 0, { size: { w: cm(120), d: cm(80) } }],
      ['lamp', 'lamp', 5.9, 3.3, cm(75), { label: 'Table lamp' }],
      ['chair', 'chair', 3.9, 5.7, 0],
      ['chair', 'chair-back', 3.9, 0.7, 0],
      ['shelf', 'shelf', 7.1, 0.2, 0],
      ['plant', 'plant', 0.35, 6.1, 0],
    ]),
    'chair-back',
  ),
  'chair-back',
);

export const ISO_PRESETS: Record<IsoSceneKind, IsoScene> = {
  office: officeScene,
  desk: deskScene,
  fridge: fridgeScene,
  home: homeScene,
};
/** Presets that are a close view of part of another: the office desk is in the office. */
export const ISO_SCENE_PARENT: Partial<Record<IsoSceneKind, IsoSceneKind>> = { desk: 'office' };
/**
 * Whether a pin places objects in a scene: its own scene, or a room and its
 * close view when both have the pinned surface. A pin maps the frame onto the
 * unit square, so the office desk's top pinned once shows in the office too.
 */
export function pinFits(
  pin: Pick<SurfacePin, 'scene' | 'surfaceId'>,
  kind: IsoSceneKind | 'custom',
): boolean {
  if (pin.scene === kind) return true;
  if (pin.scene === 'custom' || kind === 'custom') return false;
  const room = (k: IsoSceneKind) => ISO_SCENE_PARENT[k] ?? k;
  return (
    room(pin.scene) === room(kind) && ISO_PRESETS[kind].surfaces.some((s) => s.id === pin.surfaceId)
  );
}
/** A surface of a preset, or of the person's own scene when `kind` is `custom`. */
export function isoSurface(
  kind: IsoSceneKind | 'custom',
  surfaceId: string,
  custom?: IsoScene | null,
): IsoSurface | undefined {
  const scene = kind === 'custom' ? custom : ISO_PRESETS[kind];
  return scene?.surfaces.find((s) => s.id === surfaceId);
}
const OPTIONAL_PROPS = [
  ...new Set(
    Object.values(ISO_PRESETS).flatMap((s) =>
      s.props.filter((p) => p.optional).map((p) => p.group),
    ),
  ),
] as [string, ...string[]];
/** What Spark may say about a photo: which preset fits and which optional props it sees. */
export const sceneGuessSchema = z
  .object({
    kind: z.enum(['office', 'desk', 'fridge']),
    visibleProps: z.array(z.enum(OPTIONAL_PROPS)).max(OPTIONAL_PROPS.length),
    summary: z.string().max(200),
  })
  .strict();
export type SceneGuess = z.infer<typeof sceneGuessSchema>;
/** The preset as Spark saw it: optional props it didn't name are left out. */
export function guessedScene(guess: Pick<SceneGuess, 'kind' | 'visibleProps'>): IsoScene {
  const preset = ISO_PRESETS[guess.kind];
  const seen = new Set<string>(guess.visibleProps);
  const props = preset.props.filter((p) => !p.optional || seen.has(p.group));
  const kept = new Set(props.map((p) => p.id));
  return { ...preset, props, surfaces: preset.surfaces.filter((s) => kept.has(s.propId)) };
}
/** One line per preset for the Spark prompt, naming the optional props it can choose. */
export function presetCatalog(): string {
  // Home is the demo household's room, not a scene a photo is guessed as (`sceneGuessSchema`).
  return Object.values(ISO_PRESETS)
    .filter((s) => (sceneGuessSchema.shape.kind.options as readonly string[]).includes(s.kind))
    .map(
      (s) =>
        `${s.kind}: ${[
          ...new Map(
            s.props.filter((p) => p.optional && p.id === p.group).map((p) => [p.group, p.label]),
          ),
        ]
          .map(([g, label]) => `${g} (${label.toLowerCase()})`)
          .join(', ')}`,
    )
    .join('\n');
}
