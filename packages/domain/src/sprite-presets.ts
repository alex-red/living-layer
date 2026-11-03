/**
 * The sizes a Thing's model is drawn at, by where it is shown: `scale` tiles
 * per item unit and `resolution` voxels along its longest side. The web's
 * sprites and `bun run model --preset` both read these, so a script's picture
 * is the app's. In the room the scale is the thing's own size in the scene,
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
