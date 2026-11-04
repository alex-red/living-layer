import type { IsoItem, ItemMaterial, ItemPart, Paint } from './iso-item.js';
import { blob, buildModel, faceDecal, lathe, pixels, rbox, tube } from './item-build.js';

/**
 * The household's models ([plan](../../../docs/plans/people-and-pets.md)): a
 * person standing or sitting, a dog standing or lying and a cat sitting up or
 * asleep, built from a look (a few colours) in centimetres. They are chibi:
 * a big round head (a third of a person's height), a short round body and
 * stubby limbs, so a face reads across a room, and so a person stands about
 * 150 cm, shorter than life, to keep that head in proportion.
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

/** A standing person's box, cm: head and arms, turned to face the corner. */
export const PERSON_CM = { w: 42, d: 42, h: 136 } as const;
/** A medium dog's box, cm, nose to tail along +x. */
export const DOG_CM = { w: 68, d: 34, h: 56 } as const;
/** A dog lying down, cm. */
export const DOG_LYING_CM = { w: 68, d: 34, h: 30 } as const;

type Look = { color: string; material?: ItemMaterial };
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
  // A side shorter than the tube is thick is as thick as it, the path down its middle.
  const least = Math.max(2 * radius, f.unit * 0.025);
  const side = (a: number, b: number) =>
    b - a >= least ? { from: a, size: b - a } : { from: (a + b) / 2 - least / 2, size: least };
  const [x, y] = [side(lo.x, hi.x), side(lo.y, hi.y)];
  // Nothing goes under the floor.
  const up = side(z0, z1);
  const z = { from: Math.max(0, up.from), size: up.size };
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

/** Big dark eyes with a glint, rosy cheeks and a small smile, on the face the room sees. */
const PERSON_FACE = pixels(
  [
    '....we....we....',
    '....ee....ee....',
    '....ee....ee....',
    '................',
    '.cc....mm....cc.',
  ],
  { w: '#ffffff', e: '#1d1514', c: '#f2a1a1', m: '#b0504c' },
);
const DOG_FACE = pixels(['.we...we.', '.ee...ee.'], { w: '#ffffff', e: '#1d1514' });

/** A round little body, widest at the chest. */
const BODY = [
  { r: 0.9, z: 0 },
  { r: 1, z: 0.35 },
  { r: 0.95, z: 0.75 },
  { r: 0.7, z: 1 },
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
  { r: 0.9, z: 0 },
  { r: 1, z: 0.5 },
  { r: 1, z: 1 },
];

/** How big a head is: a third of a person's height, so a face reads across a room. */
const HEAD = { w: 38, h: 40 };

/** The head and hair of a person whose body tops out at `z`, `a` cm ahead of its middle. */
function headParts(f: Frame, look: PersonLook, a: number, z: number): ItemPart[] {
  const head = z - 4;
  const top = head + HEAD.h;
  const hair = { color: look.hair };
  const parts: ItemPart[] = [
    lump(f, 'head', a + 1, 0, HEAD.w, HEAD.w, head, top, {
      color: look.skin,
      material: 'matte',
      rough: 0.02,
      paint: [faceDecal('front', PERSON_FACE, { across: [0.12, 0.88], up: [0.3, 0.52] })],
    }),
    // A fringe just over the eyes, and the crown above it.
    round(f, 'hair', a - 1, 0, HEAD.w + 3, head + 23, top + 4, { ...hair, profile: DOME }),
  ];
  // Behind the head, never under the chin.
  if (look.hairStyle === 'long')
    parts.push(
      lump(f, 'hair-back', a - 10, 0, 22, HEAD.w - 2, head - 6, top - 5, { ...hair, rough: 0.05 }),
      lump(f, 'hair-r', a - 2, 17, 10, 10, head - 2, head + 26, { ...hair, rough: 0.04 }),
      lump(f, 'hair-l', a - 2, -17, 10, 10, head - 2, head + 26, { ...hair, rough: 0.04 }),
    );
  else
    parts.push(
      lump(f, 'hair-back', a - 8, 0, 24, HEAD.w - 2, head + 6, top - 2, { ...hair, rough: 0.05 }),
    );
  if (look.hairStyle === 'bun')
    parts.push(lump(f, 'hair-bun', a - 10, 0, 15, 15, top - 3, top + 11, hair));
  return parts;
}

/**
 * A person's parts in a frame: standing in the middle of their box, or
 * sitting with their hips at the frame's origin on a seat `seatCm` high.
 * Chibi: a big head, a short round body, stubby arms and big shoes.
 */
function personParts(f: Frame, look: PersonLook, pose: PersonPose, seatCm = 46): ItemPart[] {
  const cloth = (color: string) => ({ color });
  const arm = (id: string, side: 1 | -1, points: [number, number, number][]) =>
    limb(
      f,
      id,
      points.map(([a, b, z]) => [a, b * side, z] as [number, number, number]),
      5,
      cloth(look.top),
    );
  if (pose === 'sitting') {
    const z = seatCm;
    const top = z + 46;
    const shoes: Paint[] = [{ kind: 'band', from: 0, to: 0.2, color: look.shoes }];
    return [
      block(f, 'thigh-r', 12, 6.5, 28, 13, z, z + 13, cloth(look.bottom)),
      block(f, 'thigh-l', 12, -6.5, 28, 13, z, z + 13, cloth(look.bottom)),
      round(f, 'shin-r', 22, 6.5, 12, 0, z + 5, { ...cloth(look.bottom), paint: shoes }),
      round(f, 'shin-l', 22, -6.5, 12, 0, z + 5, { ...cloth(look.bottom), paint: shoes }),
      round(f, 'hips', -2, 0, 28, z, z + 15, { ...cloth(look.bottom), profile: HIPS }),
      round(f, 'torso', -3, 0, 30, z + 10, top, { ...cloth(look.top), profile: BODY }),
      arm('arm-r', 1, [
        [-3, 16, top - 5],
        [5, 18, z + 24],
        [14, 12, z + 17],
      ]),
      arm('arm-l', -1, [
        [-3, 16, top - 5],
        [5, 18, z + 24],
        [14, 12, z + 17],
      ]),
      ...headParts(f, look, -2, top),
    ];
  }
  const top = 94;
  const shoe = { color: look.shoes, material: 'matte' as const, radius: 0.5 };
  return [
    block(f, 'shoe-r', 3, 7, 15, 11, 0, 8, shoe),
    block(f, 'shoe-l', 3, -7, 15, 11, 0, 8, shoe),
    round(f, 'leg-r', 0, 6.5, 13, 6, 50, { ...cloth(look.bottom), profile: LEG }),
    round(f, 'leg-l', 0, -6.5, 13, 6, 50, { ...cloth(look.bottom), profile: LEG }),
    round(f, 'hips', 0, 0, 28, 44, 62, { ...cloth(look.bottom), profile: HIPS }),
    round(f, 'torso', 0, 0, 30, 56, top, { ...cloth(look.top), profile: BODY }),
    arm('arm-r', 1, [
      [0, 16, top - 5],
      [1, 19, 76],
      [2, 19, 65],
    ]),
    arm('arm-l', -1, [
      [0, 16, top - 5],
      [1, 19, 76],
      [2, 19, 65],
    ]),
    lump(f, 'hand-r', 2, 19, 9, 9, 56, 66, { color: look.skin, material: 'matte' }),
    lump(f, 'hand-l', 2, -19, 9, 9, 56, 66, { color: look.skin, material: 'matte' }),
    ...headParts(f, look, 0, top),
  ];
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
 * up, one unit being `unitCm`.
 */
export function sittingParts(
  look: PersonLook,
  place: {
    hip: { x: number; y: number };
    facing: { x: number; y: number };
    seatZ: number;
    unitCm: number;
  },
): ItemPart[] {
  const f: Frame = {
    origin: { x: place.hip.x * place.unitCm, y: place.hip.y * place.unitCm },
    facing: place.facing,
    unit: place.unitCm,
  };
  return personParts(f, look, 'sitting', place.seatZ * place.unitCm);
}

/** A dog standing or lying along +x, its head to the room's right, in a box of `DOG_CM`. */
export function dogItem(label: string, look: PetLook, pose: DogPose = 'standing'): IsoItem {
  const L = pose === 'lying' ? DOG_LYING_CM : DOG_CM;
  // Ahead is +x, its right is -y: the room sees its left flank.
  const f: Frame = { origin: { x: 0, y: L.d / 2 }, facing: { x: 1, y: 0 }, unit: L.w };
  const fur = { color: look.body };
  const accent = { color: look.accent };
  const ear = { color: look.ear, radius: 0.5 };
  const nose = { color: '#1f1714', material: 'gloss' as const };
  const paws: Paint[] = [{ kind: 'band', from: 0, to: 0.3, color: look.accent }];
  const face = { paint: [faceDecal('right', DOG_FACE, { across: [0.1, 0.9], up: [0.46, 0.7] })] };
  if (pose === 'lying')
    return buildModel(label, [
      lump(f, 'body', 26, 0, 40, 28, 0, 20, { ...fur, rough: 0.05 }),
      lump(f, 'chest', 40, 0, 16, 20, 0, 18, accent),
      block(f, 'paw-r', 52, 7, 18, 9, 0, 7, { ...accent, radius: 0.5 }),
      block(f, 'paw-l', 52, -7, 18, 9, 0, 7, { ...accent, radius: 0.5 }),
      lump(f, 'head', 50, 0, 24, 24, 6, 30, { ...fur, rough: 0.02, ...face }),
      block(f, 'snout', 61, 0, 10, 12, 8, 17, { ...accent, radius: 0.5 }),
      lump(f, 'nose', 66, 0, 5, 5, 12, 17, nose),
      block(f, 'ear-r', 48, 12.5, 9, 4, 6, 24, ear),
      block(f, 'ear-l', 48, -12.5, 9, 4, 6, 24, ear),
      limb(
        f,
        'tail',
        [
          [8, -6, 5],
          [1, -10, 4],
          [-1, -14, 3],
        ],
        3.5,
        fur,
      ),
    ]);
  return buildModel(label, [
    lump(f, 'body', 28, 0, 36, 26, 16, 40, { ...fur, rough: 0.05 }),
    lump(f, 'chest', 40, 0, 16, 20, 16, 38, accent),
    block(f, 'leg-fr', 40, 7, 10, 9, 0, 24, { ...fur, radius: 0.5, paint: paws }),
    block(f, 'leg-fl', 40, -7, 10, 9, 0, 24, { ...fur, radius: 0.5, paint: paws }),
    block(f, 'leg-br', 16, 7, 10, 9, 0, 24, { ...fur, radius: 0.5, paint: paws }),
    block(f, 'leg-bl', 16, -7, 10, 9, 0, 24, { ...fur, radius: 0.5, paint: paws }),
    lump(f, 'head', 50, 0, 26, 26, 30, 56, { ...fur, rough: 0.02, ...face }),
    block(f, 'snout', 61, 0, 10, 12, 33, 42, { ...accent, radius: 0.5 }),
    lump(f, 'nose', 66, 0, 5, 5, 38, 43, nose),
    block(f, 'ear-r', 47, 12.5, 9, 4, 32, 51, ear),
    block(f, 'ear-l', 47, -12.5, 9, 4, 32, 51, ear),
    limb(
      f,
      'tail',
      [
        [9, 0, 32],
        [2, 0, 38],
        [4, 0, 47],
      ],
      3.5,
      fur,
    ),
  ]);
}

/** A cat sitting up, cm, facing the room's camera. */
export const CAT_CM = { w: 30, d: 30, h: 36 } as const;
/** A cat curled up asleep, cm. */
export const CAT_SLEEPING_CM = { w: 34, d: 34, h: 18 } as const;
const CAT_FACE = pixels(['.we...we.', '.ee...ee.', '....n....', '...m.m...'], {
  w: '#ffffff',
  e: '#1d1514',
  n: '#ec7f86',
  m: '#3d2219',
});
const CAT_ASLEEP = pixels(['.ee...ee.', '.........', '....n....'], {
  e: '#3d2219',
  n: '#ec7f86',
});
const EAR_INSIDE = pixels(['..p..', '.ppp.', '.ppp.', 'ppppp'], { p: '#f2a3a3' });
const EAR = [
  { r: 1, z: 0 },
  { r: 0.8, z: 0.4 },
  { r: 0.12, z: 1 },
];

/**
 * A cat's parts, `body` and `accent` its two colours: sitting up with its
 * face to the room (`idle`), or curled up asleep with its tail round it.
 * Chibi like the people: a big head, a round body, little paws.
 */
export function catParts(
  body: string,
  accent: string,
  pose: 'idle' | 'sleeping',
  material: ItemMaterial = 'fabric',
): ItemPart[] {
  const box = pose === 'sleeping' ? CAT_SLEEPING_CM : CAT_CM;
  const f: Frame = {
    origin: { x: box.w / 2, y: box.d / 2 },
    facing: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
    unit: box.w,
  };
  const fur: Look = { color: body, material };
  const ear = (id: string, a: number, b: number, z: number, size = 7) =>
    round(f, id, a, b, size, z, z + size + 1, {
      ...fur,
      profile: EAR,
      paint: [faceDecal('front', EAR_INSIDE, { across: [0.25, 0.75], up: [0.05, 0.7] })],
    });
  if (pose === 'sleeping')
    return [
      lump(f, 'body', -4, 0, 24, 22, 0, 12, { ...fur, rough: 0.04 }),
      lump(f, 'head', 9, 1, 15, 15, 0, 13, {
        ...fur,
        rough: 0.02,
        paint: [faceDecal('front', CAT_ASLEEP, { across: [0.12, 0.88], up: [0.3, 0.6] })],
      }),
      ear('ear-l', 8, -3, 10, 5),
      ear('ear-r', 8, 5, 10, 5),
      limb(
        f,
        'tail',
        [
          [-12, -6, 2],
          [0, -13, 2],
          [10, -8, 2],
        ],
        2.6,
        fur,
      ),
    ];
  return [
    lump(f, 'body', -2, 0, 22, 22, 0, 20, { ...fur, rough: 0.04 }),
    lump(f, 'chest', 4, 0, 12, 12, 3, 17, { color: accent, material }),
    lump(f, 'paw-r', 7, 4, 6, 6, 0, 5, { color: accent, material }),
    lump(f, 'paw-l', 7, -4, 6, 6, 0, 5, { color: accent, material }),
    lump(f, 'head', 2, 0, 22, 22, 15, 33, {
      ...fur,
      rough: 0.02,
      paint: [faceDecal('front', CAT_FACE, { across: [0.12, 0.88], up: [0.22, 0.6] })],
    }),
    ear('ear-r', 0, 6.5, 29),
    ear('ear-l', 0, -6.5, 29),
    limb(
      f,
      'tail',
      [
        [-10, 4, 2],
        [-12, 10, 6],
        [-7, 13, 15],
      ],
      2.4,
      fur,
    ),
  ];
}
