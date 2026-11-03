import {
  propSpriteKey,
  renderPropSprite,
  renderSprite,
  renderView,
  voxelize,
  type IsoItem,
  type IsoProp,
} from '@livinglayer/domain';

/**
 * What a sprite is drawn from, and the pure step that draws it. The worker
 * (`sprite.worker.ts`) and the main-thread fallback (`sprites.ts`) both run
 * `draw`, so they can't disagree about a pixel.
 */
export type SpriteRequest =
  | {
      kind: 'item';
      item: IsoItem;
      scale: number;
      resolution: number;
      select?: number;
      glow?: boolean;
    }
  | { kind: 'prop'; prop: IsoProp; lit: boolean }
  | { kind: 'view'; item: IsoItem; elevation: number; ppu: number };

/** Pixels plus where they sit, before they become an image. */
export interface Drawn {
  rgba: Uint8ClampedArray;
  /** Pixel size of `rgba`. */
  width: number;
  height: number;
  /** Top-left corner and displayed size in iso pixels. */
  x: number;
  y: number;
  shownWidth: number;
  shownHeight: number;
}

/** A short, deterministic name for a model's parts: two 32-bit hashes of their JSON and its length. */
function hashText(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}.${text.length.toString(36)}`;
}
/**
 * Parts are never changed in place (a change makes a new array), so each
 * array is stringified once however often its sprite renders.
 */
const partsKeys = new WeakMap<IsoItem['parts'], string>();
function partsKey(parts: IsoItem['parts']): string {
  let k = partsKeys.get(parts);
  if (k === undefined) {
    k = hashText(JSON.stringify(parts));
    partsKeys.set(parts, k);
  }
  return k;
}
const propKeys = new WeakMap<IsoProp, [string | undefined, string | undefined]>();

export function spriteKey(r: SpriteRequest): string {
  switch (r.kind) {
    case 'item':
      return `item|${r.resolution}|${r.scale.toFixed(3)}|${r.select ?? -1}|${r.glow ? 1 : 0}|${partsKey(r.item.parts)}`;
    case 'prop': {
      let ks = propKeys.get(r.prop);
      if (!ks) propKeys.set(r.prop, (ks = [undefined, undefined]));
      const i = r.lit ? 1 : 0;
      return (ks[i] ??= propSpriteKey(r.prop, r.lit));
    }
    case 'view':
      return `view|${r.elevation}|${r.ppu}|${partsKey(r.item.parts)}`;
  }
}

export function draw(r: SpriteRequest): Drawn {
  if (r.kind === 'view') {
    const v = renderView(voxelize(r.item.parts, { resolution: 48 }), {
      elevation: r.elevation,
      ppu: r.ppu,
    });
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
    return {
      rgba,
      width: v.width,
      height: v.height,
      x: 0,
      y: 0,
      shownWidth: v.width,
      shownHeight: v.height,
    };
  }
  const s =
    r.kind === 'prop'
      ? renderPropSprite(r.prop, r.lit)
      : renderSprite(voxelize(r.item.parts, { resolution: r.resolution }), {
          scale: r.scale,
          // A thing is drawn as pixel art is, its prints lettered per pixel; props keep the room's dither.
          finish: 'clean',
          ...(r.select !== undefined ? { select: r.select } : {}),
          ...(r.glow ? { glow: '#ffb866' } : {}),
        });
  return {
    rgba: s.rgba,
    width: s.width,
    height: s.height,
    x: s.x,
    y: s.y,
    shownWidth: s.width * s.pixel,
    shownHeight: s.height * s.pixel,
  };
}
