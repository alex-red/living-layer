import { hexLab, labHex, outlineLab, rampLab } from './color.js';
import type { IsoProp, IsoTone } from './iso.js';
import { propModel, type PropPart } from './iso-furniture.js';
import type { ItemMaterial, ItemPart } from './iso-item.js';
import { recipeKey } from './recipe.js';
import { renderSprite, voxelize, type Sprite, type VoxelGrid } from './iso-voxel.js';

/**
 * How a scene prop becomes a sprite: the room's tones, the palette props
 * snap to, and how finely each prop is sampled. Shared by the web scene and
 * the scripts that draw props outside it (`bun run sheet`), so both show the
 * same pixels.
 */

/**
 * Materials for the dark room, as the colour of a face lit side-on: a top
 * is a step lighter and a face turned from the light two steps darker (see
 * `rampLab`). Matched to the reference picture of the office.
 */
export const PROP_TONES: Record<IsoTone, string> = {
  floor: '#171b27',
  wall: '#1d273f',
  wood: '#7c583e',
  steel: '#5b6788',
  fabric: '#4f5876',
  paper: '#cbc5b9',
  book: '#34683e',
  glass: '#5f7c88',
  appliance: '#99a5c3',
  plant: '#3b8b3f',
  ceramic: '#c1b9a9',
  screen: '#2c3858',
  soil: '#57372b',
};
const TONE_MATERIAL: Partial<Record<IsoTone, ItemMaterial>> = {
  wood: 'wood',
  steel: 'metal',
  fabric: 'fabric',
  glass: 'glass',
  appliance: 'gloss',
  ceramic: 'gloss',
  screen: 'gloss',
};
/** Every colour a base colour can be drawn in: its four ramp steps and its outline. */
const rampOf = (hex: string) => {
  const lab = hexLab(hex);
  return [0, 1, 2, 3].map((l) => labHex(rampLab(lab, l))).concat(labHex(outlineLab(lab)));
};
/** Every colour a tone can be drawn in: its four ramp steps and its outline. */
export const TONE_PALETTE = Object.fromEntries(
  Object.entries(PROP_TONES).map(([tone, hex]) => [tone, rampOf(hex)]),
) as Record<IsoTone, string[]>;
/**
 * The room's palette: every tone's colours. Props snap to it, so the room
 * keeps the house style while items keep the colours of the photo they came from.
 */
const PROP_PALETTE = [...new Set(Object.values(TONE_PALETTE).flat())];
/** Voxels per tile for plain props: one density for the whole room. */
const PROP_DENSITY = 16;
/**
 * Furniture models get finer voxels the smaller they are, so a keyboard's
 * keys and a book's pages still show, up to about a pixel per voxel.
 */
const modelDensity = (size: IsoProp['size']) =>
  Math.max(PROP_DENSITY, Math.min(64, 128 / Math.max(size.w, size.d, size.h)));
const WARM = '#ffb866';
/** A plain prop as one part in its own space, so a moved prop reuses its sprite. */
function propPart(prop: IsoProp): ItemPart {
  const plant = prop.tone === 'plant' && prop.shape === 'cylinder';
  const base = {
    id: 'prop',
    at: { x: 0, y: 0, z: 0 },
    size: prop.size,
    color: PROP_TONES[prop.tone],
    taper: 1,
    material: TONE_MATERIAL[prop.tone] ?? 'matte',
  } as const;
  if (plant) return { ...base, shape: 'blob', rough: 0.6 };
  if (prop.shape === 'cylinder')
    return {
      ...base,
      shape: 'lathe',
      profile: [
        { r: 1, z: 0 },
        { r: 1, z: 1 },
      ],
    };
  return { ...base, shape: 'rbox', radius: 0.06 };
}
/** One part of a furniture model in the kernel's terms. */
const modelPart = (p: PropPart, i: number): ItemPart => {
  const { tone, ...rest } = p;
  return {
    id: `p${i}`,
    taper: 1,
    ...rest,
    color: p.color ?? PROP_TONES[tone],
    material: p.material ?? TONE_MATERIAL[tone] ?? 'matte',
  };
};
/** What a prop's sprite depends on, for caching it. */
export function propSpriteKey(prop: IsoProp, lit: boolean): string {
  const { w, d, h } = prop.size;
  const form = prop.recipe ? `recipe:${recipeKey(prop.recipe)}` : (prop.form ?? '');
  return `prop|${prop.shape}|${prop.tone}|${form}|${prop.turns ?? 0}|${w}|${d}|${h}|${lit}`;
}
/**
 * The room's palette, plus the ramp of any colour a model's parts bring
 * of their own (a recipe painted green), so those keep their colour.
 */
function paletteOf(model: PropPart[] | null): string[] {
  const own = [...new Set(model?.flatMap((p) => (p.color ? [p.color] : [])) ?? [])];
  return own.length ? [...PROP_PALETTE, ...own.flatMap(rampOf)] : PROP_PALETTE;
}
/** The last few props' grids, by what they were sampled from: a prop is drawn lit and unlit. */
const recent = new Map<string, VoxelGrid>();
const RECENT = 4;
/** A scene prop drawn by the kernel, relative to its own corner `prop.at`. */
export function renderPropSprite(prop: IsoProp, lit: boolean): Sprite {
  const model = propModel(prop);
  const parts = model ? model.map(modelPart) : [propPart(prop)];
  const voxel = 1 / (model ? modelDensity(prop.size) : PROP_DENSITY);
  const key = JSON.stringify([parts, voxel]);
  let grid = recent.get(key);
  if (!grid) {
    grid = voxelize(parts, { voxel });
    if (recent.size >= RECENT) recent.delete(recent.keys().next().value!);
    recent.set(key, grid);
  }
  return renderSprite(grid, {
    scale: 1,
    shadow: false,
    glow: lit ? WARM : null,
    palette: lit ? undefined : paletteOf(model),
  });
}
