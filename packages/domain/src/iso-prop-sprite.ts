import { hexLab, labHex, outlineLab, rampLab } from './color.js';
import type { IsoProp, IsoTone } from './iso.js';
import { propModel, type PropPart } from './iso-furniture.js';
import type { ItemMaterial, ItemPart } from './iso-item.js';
import { renderSprite, voxelize, type Sprite } from './iso-voxel.js';

/**
 * How a scene prop becomes a sprite: the room's tones, the palette props
 * snap to, and how finely each prop is sampled. Shared by the web scene and
 * the scripts that draw props outside it (`bun run sheet`), so both show the
 * same pixels.
 */

/** Muted materials for the dark room. The signal colours stay for the overlay. */
export const PROP_TONES: Record<IsoTone, string> = {
  floor: '#171b27',
  wall: '#202535',
  wood: '#5b4c3f',
  steel: '#4a5164',
  fabric: '#3a4659',
  paper: '#c9c3b5',
  book: '#3c554a',
  glass: '#5f7c88',
  appliance: '#8d93a1',
  plant: '#4d6a54',
  ceramic: '#b3a796',
};
const TONE_MATERIAL: Partial<Record<IsoTone, ItemMaterial>> = {
  wood: 'wood',
  steel: 'metal',
  fabric: 'fabric',
  glass: 'glass',
  appliance: 'gloss',
  ceramic: 'gloss',
};
/**
 * The room's palette: four ramp steps and an outline for every tone. Props
 * snap to it, so the room keeps the house style while items keep the
 * colours of the photo they came from.
 */
const PROP_PALETTE = [
  ...new Set(
    Object.values(PROP_TONES).flatMap((hex) => {
      const lab = hexLab(hex);
      return [0, 1, 2, 3].map((l) => labHex(rampLab(lab, l))).concat(labHex(outlineLab(lab)));
    }),
  ),
];
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
  return {
    id: 'prop',
    shape: plant ? 'blob' : prop.shape === 'cylinder' ? 'lathe' : 'rbox',
    at: { x: 0, y: 0, z: 0 },
    size: prop.size,
    color: PROP_TONES[prop.tone],
    taper: 1,
    ...(prop.shape === 'cylinder' && !plant
      ? {
          profile: [
            { r: 1, z: 0 },
            { r: 1, z: 1 },
          ],
        }
      : {}),
    ...(plant ? { rough: 0.6 } : { radius: 0.06 }),
    material: TONE_MATERIAL[prop.tone] ?? 'matte',
  };
}
/** One part of a furniture model in the kernel's terms. */
const modelPart = (p: PropPart, i: number): ItemPart => ({
  id: `p${i}`,
  taper: 1,
  ...p,
  color: PROP_TONES[p.tone],
  material: p.material ?? TONE_MATERIAL[p.tone] ?? 'matte',
});
/** What a prop's sprite depends on, for caching it. */
export function propSpriteKey(prop: IsoProp, lit: boolean): string {
  const { w, d, h } = prop.size;
  return `prop|${prop.shape}|${prop.tone}|${prop.form ?? ''}|${prop.turns ?? 0}|${w}|${d}|${h}|${lit}`;
}
/** A scene prop drawn by the kernel, relative to its own corner `prop.at`. */
export function renderPropSprite(prop: IsoProp, lit: boolean): Sprite {
  const model = propModel(prop);
  const grid = model
    ? voxelize(model.map(modelPart), { voxel: 1 / modelDensity(prop.size) })
    : voxelize([propPart(prop)], { voxel: 1 / PROP_DENSITY });
  return renderSprite(grid, {
    scale: 1,
    shadow: false,
    glow: lit ? WARM : null,
    palette: lit ? undefined : PROP_PALETTE,
  });
}
