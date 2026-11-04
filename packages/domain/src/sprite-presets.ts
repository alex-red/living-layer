import type { ItemPart } from './iso-item.js';
/**
 * The sizes a Thing's model is drawn at, by where it is shown: `scale` tiles
 * per item unit and `resolution` voxels along its longest side (more for a
 * tall, thin model: `detailResolution`). The web's sprites and `bun run model
 * --preset` both read these, so a script's picture is the app's. In the room the scale is the thing's own size in the scene,
 * so `room` names only the resolution.
 */
export const ITEM_SPRITES = {
  /** A thing standing in the room. */
  room: { resolution: 32 },
  /** A state's tab in the studio. */
  thumb: { scale: 1.5, resolution: 32 },
  /** A starter in the catalogue. */
  card: { scale: 1.8, resolution: 32 },
  /** The brush's review of a model it built. */
  brush: { scale: 2.4, resolution: 40 },
  /** A drafted model in review, before it is placed. */
  review: { scale: 3, resolution: 48 },
  /** The model editor and a state's preview. */
  editor: { scale: 3, resolution: 64 },
} as const;
export type ItemSpritePreset = keyof typeof ITEM_SPRITES;

/** The most a thin model's resolution is raised: a floor lamp stays well under the voxel cap. */
const THIN_DETAIL_MAX = 3;
/** How wide, deep and tall a model's parts reach, in item units. */
function extent(parts: readonly ItemPart[]): { w: number; d: number; h: number } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const { at, size } of parts) {
    const from = [at.x, at.y, at.z];
    const span = [size.w, size.d, size.h];
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, from[k]!);
      hi[k] = Math.max(hi[k]!, from[k]! + span[k]!);
    }
  }
  return parts.length
    ? { w: hi[0]! - lo[0]!, d: hi[1]! - lo[1]!, h: hi[2]! - lo[2]! }
    : { w: 1, d: 1, h: 1 };
}
/**
 * Voxels along a model's longest side for a preset's `resolution`, raised for
 * a tall, thin model so its footprint gets as many voxels as a squat one's:
 * at 64 along a floor lamp's height its base is six voxels across and draws
 * as a hexagon, and a change to its edge moves no voxel at all.
 */
export function detailResolution(parts: readonly ItemPart[], resolution: number): number {
  const { w, d, h } = extent(parts);
  const thin = Math.max(w, d, h) / Math.max(w, d, 1e-3);
  return Math.round(resolution * Math.min(THIN_DETAIL_MAX, Math.max(1, thin)));
}
/** About how many voxels the editor draws a model with, across its footprint and up its height. */
export function editorVoxels(parts: readonly ItemPart[]): { across: number; tall: number } {
  const { w, d, h } = extent(parts);
  const voxel = Math.max(w, d, h) / detailResolution(parts, ITEM_SPRITES.editor.resolution);
  return { across: Math.round(Math.max(w, d) / voxel), tall: Math.round(h / voxel) };
}
