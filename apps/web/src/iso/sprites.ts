import {
  hexLab,
  labHex,
  outlineLab,
  propModel,
  rampLab,
  renderSprite,
  renderView,
  voxelize,
  type IsoItem,
  type IsoProp,
  type IsoTone,
  type ItemMaterial,
  type ItemPart,
  type PropPart,
  type Sprite,
} from '@livinglayer/domain';

/**
 * Sprites drawn by the model kernel, turned into image URLs once and kept by
 * what they depend on, so dragging or re-rendering never draws them again.
 */
export interface SpriteImage {
  url: string;
  /** Top-left corner and size in iso pixels, relative to the model's origin. */
  x: number;
  y: number;
  width: number;
  height: number;
}
const cache = new Map<string, SpriteImage>();
const LIMIT = 400;
function toUrl(rgba: Uint8ClampedArray, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return canvas.toDataURL('image/png');
}
function cached(key: string, draw: () => Sprite): SpriteImage {
  const hit = cache.get(key);
  if (hit) return hit;
  const s = draw();
  const image = {
    url: toUrl(s.rgba, s.width, s.height),
    x: s.x,
    y: s.y,
    width: s.width * s.pixel,
    height: s.height * s.pixel,
  };
  if (cache.size >= LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, image);
  return image;
}

/** An item model as it stands in a scene or the editor, `scale` tiles per item unit. */
export function itemSprite(
  item: IsoItem,
  { scale, resolution = 32, select }: { scale: number; resolution?: number; select?: number },
): SpriteImage {
  const key = `item|${resolution}|${scale.toFixed(3)}|${select ?? -1}|${JSON.stringify(item.parts)}`;
  return cached(key, () =>
    renderSprite(voxelize(item.parts, { resolution }), {
      scale,
      ...(select !== undefined ? { select } : {}),
    }),
  );
}

/** Muted materials for the dark room. The signal colours stay for the overlay. */
export const TONES: Record<IsoTone, string> = {
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
    Object.values(TONES).flatMap((hex) => {
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
    color: TONES[prop.tone],
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
  color: TONES[p.tone],
  material: p.material ?? TONE_MATERIAL[p.tone] ?? 'matte',
});
/** A scene prop drawn by the kernel, relative to its own corner `prop.at`. */
export function propSprite(prop: IsoProp, lit: boolean): SpriteImage {
  const { w, d, h } = prop.size;
  const key = `prop|${prop.shape}|${prop.tone}|${prop.form ?? ''}|${prop.turns ?? 0}|${w}|${d}|${h}|${lit}`;
  return cached(key, () => {
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
  });
}

/**
 * The model as the photo's camera saw it, as a translucent silhouette with an
 * outline, to lay over the crop. `ppu` is crop pixels per item unit.
 */
export function viewOverlay(item: IsoItem, elevation: number, ppu: number): SpriteImage {
  const key = `view|${elevation}|${ppu}|${JSON.stringify(item.parts)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const v = renderView(voxelize(item.parts, { resolution: 48 }), { elevation, ppu });
  const rgba = new Uint8ClampedArray(v.width * v.height * 4);
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < v.width && y < v.height && v.mask[x + y * v.width];
  for (let y = 0; y < v.height; y++)
    for (let x = 0; x < v.width; x++) {
      if (!on(x, y)) continue;
      const edge = !on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1);
      // Magenta, the colour of what a person chose: the outline solid, the fill a wash.
      rgba.set([230, 140, 196, edge ? 255 : 70], (x + y * v.width) * 4);
    }
  const image = {
    url: toUrl(rgba, v.width, v.height),
    x: 0,
    y: 0,
    width: v.width,
    height: v.height,
  };
  cache.set(key, image);
  return image;
}
