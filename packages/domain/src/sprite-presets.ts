import { SCULPT_PARTS, type ItemPart } from './iso-item.js';
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
/** How much finer the room draws a detailed model: one with more parts than Spark sculpts as a rule. */
const DETAILED_FINER = 2;
/** The most voxels along a room thing's longest side when zoomed in, before `DETAILED_FINER`. */
const ROOM_MAX_RESOLUTION = 64;
/** The widest a room thing is drawn, in sprite pixels, however far the view zooms. */
const MAX_ROOM_SPRITE_PX = 512;
/**
 * How a thing in the room is drawn: voxels along its longest side and iso
 * pixels per sprite pixel. It is drawn finer as the view zooms in, so its
 * pixels stay about the size they are at fit, and a detailed model (a cat
 * with its face painted on, asleep on its tree) twice as fine again, the
 * same size with smaller pixels, so its small parts and prints still read.
 * `width` is one item unit's width in iso pixels.
 */
export function roomSpriteLook(
  parts: readonly ItemPart[],
  width: number,
  zoom: number,
): { resolution: number; pixel?: number } {
  const fine = parts.length > SCULPT_PARTS ? DETAILED_FINER : 1;
  let step = 1;
  while (step < zoom && width * step * fine * 2 <= MAX_ROOM_SPRITE_PX) step *= 2;
  const k = step * fine;
  return {
    resolution: Math.min(ROOM_MAX_RESOLUTION * fine, ITEM_SPRITES.room.resolution * k),
    ...(k > 1 ? { pixel: 1 / k } : {}),
  };
}
/** About how many voxels the editor draws a model with, across its footprint and up its height. */
export function editorVoxels(parts: readonly ItemPart[]): { across: number; tall: number } {
  const { w, d, h } = extent(parts);
  const voxel = Math.max(w, d, h) / detailResolution(parts, ITEM_SPRITES.editor.resolution);
  return { across: Math.round(Math.max(w, d) / voxel), tall: Math.round(h / voxel) };
}
