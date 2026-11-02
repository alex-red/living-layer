import {
  PROP_TONES,
  propSpriteKey,
  renderPropSprite,
  renderSprite,
  renderView,
  voxelize,
  type IsoItem,
  type IsoProp,
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
  {
    scale,
    resolution = 32,
    select,
    glow,
  }: { scale: number; resolution?: number; select?: number; glow?: boolean },
): SpriteImage {
  const key = `item|${resolution}|${scale.toFixed(3)}|${select ?? -1}|${glow ? 1 : 0}|${JSON.stringify(item.parts)}`;
  return cached(key, () =>
    renderSprite(voxelize(item.parts, { resolution }), {
      scale,
      ...(select !== undefined ? { select } : {}),
      ...(glow ? { glow: '#ffb866' } : {}),
    }),
  );
}

/** The room's tones, shared with the kernel's prop sprites. */
export const TONES = PROP_TONES;
/** A scene prop drawn by the kernel, relative to its own corner `prop.at`. */
export function propSprite(prop: IsoProp, lit: boolean): SpriteImage {
  return cached(propSpriteKey(prop, lit), () => renderPropSprite(prop, lit));
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
