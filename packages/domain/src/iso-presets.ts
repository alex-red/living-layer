import { z } from 'zod';
import type { IsoScene, IsoSceneKind, IsoSurface, SurfacePin } from './iso.js';
import { cm } from './iso-furniture.js';
import { placeTemplate } from './iso-templates.js';

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

const fridgeScene = compose('fridge', 'Fridge', { w: 7, d: 7 }, [
  ['fridge', 'fridge', 1.5, 1, 0],
  // The things the fridge camera can follow, in its photo's order, each forward
  // and left enough for the room's corner to see it through the open front:
  // on the crisper lid (66 + 40 cm) the pickles, the leftovers and the milk,
  // the butter on the middle shelf (+ 68), the eggs in the pantry drawer (+ 1.5).
  ['jar', 'jar', 2, 2.1, cm(66 + 40), { label: 'Pickle jar', optional: true }],
  ['tub', 'leftovers', 2.55, 2.8, cm(66 + 40), { label: 'Leftovers', optional: true }],
  ['carton', 'milk', 3.3, 3, cm(66 + 40), { label: 'Milk carton', optional: true }],
  ['butter', 'butter', 2.6, 2.7, cm(66 + 68), { optional: true }],
  ['eggs', 'eggs', 1.95, 2.7, cm(66 + 1.5), { optional: true }],
]);

export const ISO_PRESETS: Record<IsoSceneKind, IsoScene> = {
  office: officeScene,
  desk: deskScene,
  fridge: fridgeScene,
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
  return Object.values(ISO_PRESETS)
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
