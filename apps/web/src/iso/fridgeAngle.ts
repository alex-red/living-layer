import {
  cutAway,
  fridgeDoor,
  rotateItem,
  rotateScene,
  type IsoScene,
  type Point,
} from '@livinglayer/domain';
import type { IsoFixture, IsoObject, IsoZone } from './IsoScene';

/**
 * The ways the fridge is looked at. The room is always drawn from a front
 * corner, and from either one the near door folds across that side of the
 * shelves: from the right the left door's bins show, from the left the right
 * door's, and cut away its top, right side and doors are left out, all but
 * the bins of a door that holds something.
 */
export const FRIDGE_ANGLES = {
  right: { label: 'Right', hint: 'From the front-right corner: the left door’s bins' },
  left: { label: 'Left', hint: 'From the front-left corner: the right door’s bins' },
  cut: {
    label: 'Cut away',
    hint: 'Without its top, right side and doors: every shelf, and the door bins things are in',
  },
} as const;
export type FridgeAngle = keyof typeof FRIDGE_ANGLES;

interface Shown {
  scene: IsoScene;
  objects: IsoObject[];
  fixtures: IsoFixture[];
  zones: IsoZone[];
  trail: Point[];
}
interface Seen extends Shown {
  /** Props drawn see-through: the door nearest the corner, which folds across the shelves. */
  seeThrough: ReadonlySet<string>;
}
/**
 * The room as seen from an angle. From the left it is turned three quarters,
 * so the front (+y) faces +x: a box at (x, y) goes to (y, W − x − w), and a
 * point on a surface (u, v) to (v, 1 − u), as `rotateScene` turns surfaces.
 * From either corner the near door is see-through.
 */
export function fromAngle(angle: FridgeAngle, shown: Shown): Seen {
  if (angle === 'cut') {
    const also = [...shown.fixtures, ...shown.objects].map((f) => f.box);
    return { ...shown, scene: cutAway(shown.scene, also), seeThrough: new Set() };
  }
  if (angle === 'right') return { ...shown, seeThrough: fridgeDoor(shown.scene, 'right') };
  const { w: W } = shown.scene.grid;
  const box = <B extends IsoObject['box']>(b: B): B => ({
    ...b,
    at: { ...b.at, x: b.at.y, y: W - b.at.x - b.size.w },
    size: { ...b.size, w: b.size.d, d: b.size.w },
  });
  const uv = (p: Point): Point => ({ x: p.y, y: 1 - p.x });
  return {
    scene: rotateScene(rotateScene(rotateScene(shown.scene))),
    objects: shown.objects.map((o) => ({
      ...o,
      box: box(o.box),
      ...(o.item ? { item: rotateItem(o.item, 3) } : {}),
    })),
    fixtures: shown.fixtures.map((f) => ({ ...f, box: box(f.box), item: rotateItem(f.item, 3) })),
    zones: shown.zones.map((z) => ({ ...z, quad: z.quad.map(uv) as IsoZone['quad'] })),
    trail: shown.trail.map(uv),
    seeThrough: fridgeDoor(shown.scene, 'left'),
  };
}
