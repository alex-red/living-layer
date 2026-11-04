import type { IsoItem, ItemPart, Paint } from './iso-item.js';
import { blob, buildModel, faceDecal, lathe, pixels, rbox, tube } from './item-build.js';

/**
 * The household's models ([plan](../../../docs/plans/people-and-pets.md)): a
 * person standing or sitting, and a dog standing or lying, built from a look
 * (a few colours) in real centimetres. Each is a little chunky, a head about
 * a sixth of an adult's height, so it still reads at the room's size.
 *
 * In the item's frame before its turns the room sees the +y side on the
 * left and the +x side on the right; one item unit is the model's box's
 * width. A person standing faces the corner between them, towards the camera.
 */
export interface PersonLook {
  skin: string;
  hair: string;
  hairStyle: 'short' | 'long' | 'bun';
  top: string;
  bottom: string;
  shoes: string;
}
export interface PetLook {
  body: string;
  accent: string;
  /** A dog's ears; a cat's are its body's colour. */
  ear: string;
}
type PersonPose = 'standing' | 'sitting';
type DogPose = 'standing' | 'lying';

/** A standing adult's box, cm: shoulders and arms, turned to face the corner. */
export const PERSON_CM = { w: 50, d: 50, h: 176 } as const;
/** A medium dog's box, cm, nose to tail along +x. */
export const DOG_CM = { w: 74, d: 30, h: 56 } as const;
/** A dog lying down, cm. */
export const DOG_LYING_CM = { w: 78, d: 30, h: 28 } as const;

type Look = { color: string; material?: 'fabric' | 'matte' | 'gloss' };
/** The way a figure faces and where it is centred, in cm of its frame. */
interface Frame {
  origin: { x: number; y: number };
  /** Unit vector it faces, on the floor. */
  facing: { x: number; y: number };
  /** Centimetres per item unit. */
  unit: number;
}
/** A point `a` cm ahead and `b` cm to its right of the frame's origin, in cm. */
function at(f: Frame, a: number, b: number) {
  // Its right, seen from above with z up: the facing turned a quarter clockwise.
  const r = { x: f.facing.y, y: -f.facing.x };
  return { x: f.origin.x + a * f.facing.x + b * r.x, y: f.origin.y + a * f.facing.y + b * r.y };
}
/** The box of `along` × `across` cm round a point, as the frame's axes put it. */
function footprint(f: Frame, a: number, b: number, along: number, across: number) {
  const c = at(f, a, b);
  // Square to an axis it is exact; on the diagonal, as round as it is long and wide on average.
  const fx = f.facing.x ** 2;
  const fy = f.facing.y ** 2;
  const w = fx * along + fy * across;
  const d = fy * along + fx * across;
  return { x: c.x - w / 2, y: c.y - d / 2, w, d };
}
const u = (f: Frame, cm: number) => Math.round((cm / f.unit) * 1000) / 1000;

/** A round part (`lathe`) `dia` cm across, from `z0` to `z1`. */
function round(
  f: Frame,
  id: string,
  a: number,
  b: number,
  dia: number,
  z0: number,
  z1: number,
  look: Look & { profile?: { r: number; z: number }[]; paint?: Paint[] },
): ItemPart {
  const box = footprint(f, a, b, dia, dia);
  return lathe(id, [u(f, box.x), u(f, box.y), u(f, z0)], [u(f, dia), u(f, dia), u(f, z1 - z0)], {
    material: 'fabric',
    ...look,
  });
}
/** A soft lump `along` × `across` cm round a point, from `z0` to `z1`. */
function lump(
  f: Frame,
  id: string,
  a: number,
  b: number,
  along: number,
  across: number,
  z0: number,
  z1: number,
  look: Look & { rough?: number; paint?: Paint[] },
): ItemPart {
  const box = footprint(f, a, b, along, across);
  return blob(id, [u(f, box.x), u(f, box.y), u(f, z0)], [u(f, box.w), u(f, box.d), u(f, z1 - z0)], {
    material: 'fabric',
    rough: 0.04,
    ...look,
  });
}
/** A rounded box `along` × `across` cm round a point, from `z0` to `z1`. */
function block(
  f: Frame,
  id: string,
  a: number,
  b: number,
  along: number,
  across: number,
  z0: number,
  z1: number,
  look: Look & { radius?: number; paint?: Paint[] },
): ItemPart {
  const box = footprint(f, a, b, along, across);
  return rbox(id, [u(f, box.x), u(f, box.y), u(f, z0)], [u(f, box.w), u(f, box.d), u(f, z1 - z0)], {
    material: 'fabric',
    radius: 0.35,
    ...look,
  });
}
/** A limb through 2 to 4 points, each `[ahead, right, z]` in cm, `radius` cm thick. */
function limb(
  f: Frame,
  id: string,
  points: [number, number, number][],
  radius: number,
  look: Look,
): ItemPart {
  const ps = points.map(([a, b, z]) => ({ ...at(f, a, b), z }));
  const lo = { x: Math.min(...ps.map((p) => p.x)), y: Math.min(...ps.map((p) => p.y)) };
  const hi = { x: Math.max(...ps.map((p) => p.x)), y: Math.max(...ps.map((p) => p.y)) };
  const z0 = Math.min(...ps.map((p) => p.z));
  const z1 = Math.max(...ps.map((p) => p.z));
  // A side with no length still needs a size: the path runs down its middle.
  const least = f.unit * 0.025;
  const side = (a: number, b: number) =>
    b - a >= least ? { from: a, size: b - a } : { from: (a + b) / 2 - least / 2, size: least };
  const [x, y, z] = [side(lo.x, hi.x), side(lo.y, hi.y), side(z0, z1)];
  const share = (v: number, s: { from: number; size: number }) =>
    Math.round(((v - s.from) / s.size) * 1000) / 1000;
  return tube(
    id,
    [u(f, x.from), u(f, y.from), u(f, z.from)],
    [u(f, x.size), u(f, y.size), u(f, z.size)],
    ps.map((p) => [share(p.x, x), share(p.y, y), share(p.z, z)]),
    { material: 'fabric', ...look, radius: u(f, radius) },
  );
}

/** Open eyes, rosy cheeks and a small smile, on the face the room sees. */
const PERSON_FACE = pixels(
  ['....e....e....', '....e....e....', '..............', '..c...mm...c..'],
  { e: '#2a1d1a', c: '#e79a8e', m: '#9c4a45' },
);
const DOG_FACE = pixels(['.e...e.', '.e...e.'], { e: '#1f1714' });

const TORSO = [
  { r: 0.84, z: 0 },
  { r: 0.92, z: 0.4 },
  { r: 1, z: 0.8 },
  { r: 0.72, z: 1 },
];
/** Hair over the top of the head: a dome. */
const DOME = [
  { r: 1, z: 0 },
  { r: 0.97, z: 0.45 },
  { r: 0.72, z: 0.85 },
  { r: 0.3, z: 1 },
];
const HIPS = [
  { r: 0.92, z: 0 },
  { r: 1, z: 0.5 },
  { r: 0.96, z: 1 },
];
const LEG = [
  { r: 0.85, z: 0 },
  { r: 1, z: 0.65 },
  { r: 1, z: 1 },
];

/** The head, neck and hair of a person whose shoulders top out at `z`, `a` cm ahead of its middle. */
function headParts(f: Frame, look: PersonLook, a: number, z: number, neck = true): ItemPart[] {
  const head = z + 4;
  const top = head + 30;
  const parts: ItemPart[] = [];
  if (neck) parts.push(round(f, 'neck', a, 0, 11, z - 4, head + 3, { color: look.skin }));
  parts.push(
    lump(f, 'head', a + 1, 0, 32, 32, head, top, {
      color: look.skin,
      material: 'matte',
      rough: 0.02,
      paint: [faceDecal('front', PERSON_FACE, { across: [0.1, 0.9], up: [0.3, 0.52] })],
    }),
    round(f, 'hair', a - 1, 0, 34, head + 19, top + 3, { color: look.hair, profile: DOME }),
  );
  // Behind the head, and behind the neck where it reaches lower, so it never shows under the chin.
  if (look.hairStyle === 'long')
    parts.push(
      lump(f, 'hair-back', a - 12, 0, 16, 28, head - 16, top - 4, {
        color: look.hair,
        rough: 0.06,
      }),
      lump(f, 'hair-r', a - 3, 13, 9, 9, head - 12, head + 22, { color: look.hair, rough: 0.05 }),
      lump(f, 'hair-l', a - 3, -13, 9, 9, head - 12, head + 22, { color: look.hair, rough: 0.05 }),
    );
  else
    parts.push(
      lump(f, 'hair-back', a - 8, 0, 20, 28, head + 6, top - 1, { color: look.hair, rough: 0.06 }),
    );
  if (look.hairStyle === 'bun')
    parts.push(lump(f, 'hair-bun', a - 9, 0, 13, 13, top - 2, top + 9, { color: look.hair }));
  return parts;
}

/**
 * A person's parts in a frame: standing in the middle of their box, or
 * sitting with their hips at the frame's origin on a seat `seatCm` high.
 */
function personParts(
  f: Frame,
  look: PersonLook,
  pose: PersonPose,
  seatCm = 46,
  full = true,
): ItemPart[] {
  const cloth = (color: string) => ({ color });
  if (pose === 'sitting') {
    const z = seatCm;
    const shoulder = z + 60;
    const shoes: Paint[] = [{ kind: 'band', from: 0, to: 0.16, color: look.shoes }];
    return [
      block(f, 'thigh-r', 16, 9, 46, 15, z, z + 15, cloth(look.bottom)),
      block(f, 'thigh-l', 16, -9, 46, 15, z, z + 15, cloth(look.bottom)),
      round(f, 'shin-r', 36, 9, 13, 0, z + 6, { ...cloth(look.bottom), paint: shoes }),
      round(f, 'shin-l', 36, -9, 13, 0, z + 6, { ...cloth(look.bottom), paint: shoes }),
      round(f, 'hips', -1, 0, 34, z, z + 16, { ...cloth(look.bottom), profile: HIPS }),
      round(f, 'torso', -2, 0, 38, z + 10, shoulder, { ...cloth(look.top), profile: TORSO }),
      limb(
        f,
        'arm-r',
        [
          [-2, 21, shoulder - 6],
          [6, 23, z + 30],
          [24, 15, z + 20],
        ],
        5.5,
        cloth(look.top),
      ),
      limb(
        f,
        'arm-l',
        [
          [-2, -21, shoulder - 6],
          [6, -23, z + 30],
          [24, -15, z + 20],
        ],
        5.5,
        cloth(look.top),
      ),
      ...headParts(f, look, -2, shoulder, full),
    ];
  }
  const shoulder = 140;
  const parts = [
    block(f, 'shoe-r', 3, 9, 15, 12, 0, 7, { color: look.shoes, material: 'matte', radius: 0.45 }),
    block(f, 'shoe-l', 3, -9, 15, 12, 0, 7, { color: look.shoes, material: 'matte', radius: 0.45 }),
    round(f, 'leg-r', 0, 9, 16, 5, 82, { ...cloth(look.bottom), profile: LEG }),
    round(f, 'leg-l', 0, -9, 16, 5, 82, { ...cloth(look.bottom), profile: LEG }),
    round(f, 'hips', 0, 0, 34, 76, 94, { ...cloth(look.bottom), profile: HIPS }),
    round(f, 'torso', 0, 0, 38, 90, shoulder, { ...cloth(look.top), profile: TORSO }),
    limb(
      f,
      'arm-r',
      [
        [0, 21, shoulder - 6],
        [1, 24, 112],
        [3, 24, 90],
      ],
      6,
      cloth(look.top),
    ),
    limb(
      f,
      'arm-l',
      [
        [0, -21, shoulder - 6],
        [1, -24, 112],
        [3, -24, 90],
      ],
      6,
      cloth(look.top),
    ),
    lump(f, 'hand-r', 3, 24, 10, 10, 78, 91, { color: look.skin, material: 'matte' }),
    lump(f, 'hand-l', 3, -24, 10, 10, 78, 91, { color: look.skin, material: 'matte' }),
    ...headParts(f, look, 0, shoulder),
  ];
  return parts;
}

/** A person standing, facing the room's camera, in a box of `PERSON_CM`. */
export function personItem(label: string, look: PersonLook): IsoItem {
  const f: Frame = {
    origin: { x: PERSON_CM.w / 2, y: PERSON_CM.d / 2 },
    facing: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
    unit: PERSON_CM.w,
  };
  return buildModel(label, personParts(f, look, 'standing'));
}

/**
 * A person sitting, in another thing's item frame (a chair's): hips at
 * `hip` (item units), facing `facing`, on a seat whose top is `seatZ` units
 * up, one unit being `unitCm`. `full` keeps the neck; without it the figure
 * is a part lighter, for a seat with many parts of its own.
 */
export function sittingParts(
  look: PersonLook,
  place: {
    hip: { x: number; y: number };
    facing: { x: number; y: number };
    seatZ: number;
    unitCm: number;
  },
  full = false,
): ItemPart[] {
  const f: Frame = {
    origin: { x: place.hip.x * place.unitCm, y: place.hip.y * place.unitCm },
    facing: place.facing,
    unit: place.unitCm,
  };
  return personParts(f, look, 'sitting', place.seatZ * place.unitCm, full);
}

/** A dog standing or lying along +x, its head to the room's right, in a box of `DOG_CM`. */
export function dogItem(label: string, look: PetLook, pose: DogPose = 'standing'): IsoItem {
  const L = pose === 'lying' ? DOG_LYING_CM : DOG_CM;
  // Ahead is +x, its right is -y: the room sees its left flank.
  const f: Frame = { origin: { x: 0, y: L.d / 2 }, facing: { x: 1, y: 0 }, unit: L.w };
  const fur = { color: look.body };
  const paws: Paint[] = [{ kind: 'band', from: 0, to: 0.22, color: look.accent }];
  const face = { paint: [faceDecal('right', DOG_FACE, { across: [0.15, 0.85], up: [0.5, 0.75] })] };
  if (pose === 'lying') {
    return buildModel(label, [
      lump(f, 'body', 32, 0, 50, 26, 0, 21, { ...fur, rough: 0.06 }),
      lump(f, 'chest', 50, 0, 18, 18, 0, 18, { color: look.accent }),
      block(f, 'paw-r', 62, 6, 20, 7, 0, 6, { color: look.accent, radius: 0.5 }),
      block(f, 'paw-l', 62, -6, 20, 7, 0, 6, { color: look.accent, radius: 0.5 }),
      lump(f, 'head', 60, 0, 18, 17, 6, 24, { ...fur, rough: 0.03, ...face }),
      block(f, 'snout', 69, 0, 11, 9, 7, 15, { color: look.accent, radius: 0.5 }),
      lump(f, 'nose', 75, 0, 4, 4, 11, 15, { color: '#1f1714', material: 'gloss' }),
      block(f, 'ear-r', 58, 8.5, 7, 2.5, 9, 22, { color: look.ear, radius: 0.5 }),
      block(f, 'ear-l', 58, -8.5, 7, 2.5, 9, 22, { color: look.ear, radius: 0.5 }),
      limb(
        f,
        'tail',
        [
          [8, -6, 4],
          [2, -9, 3],
          [-1, -12, 2],
        ],
        3,
        fur,
      ),
    ]);
  }
  return buildModel(label, [
    lump(f, 'body', 32, 0, 44, 22, 22, 46, { ...fur, rough: 0.06 }),
    lump(f, 'chest', 50, 0, 16, 18, 22, 44, { color: look.accent }),
    block(f, 'leg-fr', 50, 6, 8, 7, 0, 28, { ...fur, radius: 0.5, paint: paws }),
    block(f, 'leg-fl', 50, -6, 8, 7, 0, 28, { ...fur, radius: 0.5, paint: paws }),
    block(f, 'leg-br', 16, 6, 9, 7, 0, 30, { ...fur, radius: 0.5, paint: paws }),
    block(f, 'leg-bl', 16, -6, 9, 7, 0, 30, { ...fur, radius: 0.5, paint: paws }),
    lump(f, 'head', 58, 0, 18, 17, 36, 54, { ...fur, rough: 0.03, ...face }),
    block(f, 'snout', 67, 0, 11, 9, 37, 45, { color: look.accent, radius: 0.5 }),
    lump(f, 'nose', 72.5, 0, 4, 4, 41, 45, { color: '#1f1714', material: 'gloss' }),
    block(f, 'ear-r', 56, 8.5, 7, 2.5, 39, 52, { color: look.ear, radius: 0.5 }),
    block(f, 'ear-l', 56, -8.5, 7, 2.5, 39, 52, { color: look.ear, radius: 0.5 }),
    limb(
      f,
      'tail',
      [
        [12, 0, 40],
        [5, 0, 46],
        [2, 0, 55],
      ],
      3,
      fur,
    ),
  ]);
}
