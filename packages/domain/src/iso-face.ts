import type { IsoProp } from './iso.js';

/*
 * Where a saved face texture lies on a prop. Scenes drafted before the room
 * had a calibrated camera carry textures painted from their photo; nothing
 * paints new ones, since the room is drawn from its templates.
 */

/** The three faces the iso view draws of a prism: its top, its +y face and its +x face. */
export type PropFace = 'top' | 'front' | 'side';
export const PROP_FACES: readonly PropFace[] = ['top', 'front', 'side'];

type Vec3 = [number, number, number];

/**
 * A face as an origin and two edges in scene coordinates: texel (i, j) of a
 * texture `cols` × `rows` is the point origin + u·(i + ½)/cols + v·(j + ½)/rows.
 * The orientation matches how the iso view lays a texture on the face.
 */
export function faceFrame(prop: Pick<IsoProp, 'at' | 'size'>, face: PropFace) {
  const { x, y, z } = prop.at;
  const { w, d, h } = prop.size;
  switch (face) {
    case 'top':
      return { origin: [x, y, z + h] as Vec3, u: [w, 0, 0] as Vec3, v: [0, d, 0] as Vec3 };
    case 'front':
      return { origin: [x, y + d, z + h] as Vec3, u: [w, 0, 0] as Vec3, v: [0, 0, -h] as Vec3 };
    case 'side':
      return { origin: [x + w, y, z + h] as Vec3, u: [0, d, 0] as Vec3, v: [0, 0, -h] as Vec3 };
  }
}
