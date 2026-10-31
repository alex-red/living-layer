import type { IsoBox, IsoProp, IsoSize, IsoTone, IsoVec } from './iso.js';
import type { ItemMaterial } from './iso-item.js';

/**
 * Furniture models: what a prop looks like inside its box. A prop stays a
 * box in the scene (for placing, picking and depth order), and its `form`
 * names a model built here from the box's size, so a desk has legs and a
 * chair a five-star base. Models are drawn by the voxel kernel as one
 * sprite, so their parts hide each other correctly.
 *
 * Sizes are real: one tile is 30 cm, so a desk top stands at 72 cm (2.4)
 * and a book is 15 × 22 cm. Every model is built facing +y (toward the
 * viewer, or away from the wall), then turned by the prop's `turns`.
 */
export const ISO_TILE_CM = 30;
/** Centimetres in tiles. */
export const cm = (n: number) => n / ISO_TILE_CM;

export const PROP_FORMS = [
  'desk',
  'table',
  'chair',
  'bookcase',
  'cabinet',
  'pot',
  'foliage',
  'lamp-stand',
  'lamp-shade',
  'monitor',
  'keyboard',
  'book',
  'bottle',
  'jar',
  'carton',
] as const;
export type PropForm = (typeof PROP_FORMS)[number];

/** One part of a model, in tiles, relative to the prop's corner. */
export interface PropPart {
  shape: 'rbox' | 'lathe' | 'tube' | 'blob';
  at: IsoVec;
  size: IsoSize;
  tone: IsoTone;
  material?: ItemMaterial;
  /** Lathe: (radius, height) as shares of the box, bottom to top. */
  profile?: { r: number; z: number }[];
  /** Tube: its curve as shares of the box. */
  path?: { x: number; y: number; z: number }[];
  /** Tube radius in tiles; an rbox's corner radius as a share of its smallest side. */
  radius?: number;
  /** Blob: how lumpy, 0 to 1. */
  rough?: number;
}

type Opts = Partial<Pick<PropPart, 'material' | 'radius' | 'profile' | 'rough'>>;
const box = (
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  h: number,
  tone: IsoTone,
  o: Opts = {},
): PropPart => ({
  shape: 'rbox',
  at: { x, y, z },
  size: { w, d, h },
  tone,
  radius: 0.08,
  ...o,
});
/** A turned part standing in a box: legs, pots, bottles, shades. */
const turned = (
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  h: number,
  tone: IsoTone,
  profile: PropPart['profile'],
  o: Opts = {},
): PropPart => ({ shape: 'lathe', at: { x, y, z }, size: { w, d, h }, tone, profile, ...o });
/** A round rod through 2 to 4 points: chair spokes, lamp poles, arm posts. */
function tube(
  points: [number, number, number][],
  r: number,
  tone: IsoTone,
  o: Opts = {},
): PropPart {
  const lo = [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k]!)));
  const hi = [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k]!)));
  const span = hi.map((h, k) => Math.max(h - lo[k]!, 1e-3));
  return {
    shape: 'tube',
    at: { x: lo[0]!, y: lo[1]!, z: lo[2]! },
    size: { w: span[0]!, d: span[1]!, h: span[2]! },
    tone,
    path: points.map((p) => ({
      x: (p[0] - lo[0]!) / span[0]!,
      y: (p[1] - lo[1]!) / span[1]!,
      z: (p[2] - lo[2]!) / span[2]!,
    })),
    radius: r,
    ...o,
  };
}
const CYLINDER = [
  { r: 1, z: 0 },
  { r: 1, z: 1 },
];
/** Repeatable numbers in [0, 1), so a bookcase always holds the same books. */
function seeded(seed: number) {
  let s = seed * 2654435761;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Every model's measurements, in centimetres. `heightCm` is the height its
 * template stands at. Builders read these instead of literals, so a sweep
 * (`bun run bench:scene --set desk.topCm=3,4,5`) or a test can try other
 * proportions with `withFurniture`, without editing this file.
 */
export const FURNITURE_SPECS = {
  desk: { heightCm: 72, topCm: 5, legCm: 5, insetCm: 5, railCm: 5, frontRail: false },
  table: { heightCm: 75, topCm: 5, legCm: 6, insetCm: 5, railCm: 5, frontRail: false },
  chair: {
    heightCm: 98,
    /** The width the parts below are drawn for; a wider box scales them. */
    footprintCm: 66,
    seatCm: 40,
    seatWCm: 50,
    seatDCm: 48,
    cushionCm: 7,
    reachCm: 30,
    backWCm: 44,
    backGapCm: 16,
    armCm: 21,
    arms: true,
  },
  bookcase: { heightCm: 120, boardCm: 1.8, plinthCm: 7, shelfPitchCm: 36 },
  cabinet: { heightCm: 72, plinthCm: 6, drawerCm: 20 },
  pot: { heightCm: 28, widthCm: 30 },
  foliage: { heightCm: 56 },
  'lamp-stand': { heightCm: 36, baseCm: 16 },
  'lamp-shade': { heightCm: 14 },
  monitor: { heightCm: 47, liftCm: 11, panelCm: 1.8, neckCm: 5, footWCm: 24, footDCm: 18 },
  keyboard: { heightCm: 3, rows: 5, cols: 15, marginCm: 1.2, gapCm: 0.35 },
  book: { heightCm: 3.5, coverCm: 0.4 },
  bottle: { heightCm: 26 },
  jar: { heightCm: 12 },
  carton: { heightCm: 24 },
} satisfies Record<PropForm, { heightCm: number } & Record<string, number | boolean>>;
export type FurnitureSpecs = typeof FURNITURE_SPECS;
export type FurnitureOverrides = { [F in PropForm]?: Partial<FurnitureSpecs[F]> };

let overrides: FurnitureOverrides = {};
/** A form's measurements, with any overrides `withFurniture` has in force. */
export function furnitureSpec<F extends PropForm>(form: F): FurnitureSpecs[F] {
  return { ...FURNITURE_SPECS[form], ...overrides[form] };
}
/**
 * Run `fn` with some measurements changed, for sweeps and tests. Templates
 * and models built inside it use them; nothing outside it does. Sprites the
 * web has cached aren't keyed by them, so this is for scripts, not the app.
 */
export function withFurniture<T>(changes: FurnitureOverrides, fn: () => T): T {
  const before = overrides;
  overrides = { ...before };
  for (const [form, values] of Object.entries(changes) as [PropForm, object][])
    overrides = { ...overrides, [form]: { ...overrides[form], ...values } };
  try {
    return fn();
  } finally {
    overrides = before;
  }
}

/**
 * Builds a model in a `w × d × h` box from its measurements. `outline` asks
 * for the coarse shape a camera's mask shows instead (a chair's base as a
 * disc), so matching a model to a photo isn't thrown by parts thinner than
 * the mask's pixels.
 */
type Build<F extends PropForm> = (
  w: number,
  d: number,
  h: number,
  o: { outline: boolean; spec: FurnitureSpecs[F] },
) => PropPart[];

/** A slab on four legs with rails under it, its top at `h`. */
function legged(legTone: IsoTone, round: boolean): Build<'desk' | 'table'> {
  return (w, d, h, { spec }) => {
    const top = cm(spec.topCm);
    const leg = cm(spec.legCm);
    const inset = cm(spec.insetCm);
    const rail = cm(spec.railCm);
    const under = h - top;
    const span = w - 2 * (inset + leg);
    const corners = [
      [inset, inset],
      [w - inset - leg, inset],
      [inset, d - inset - leg],
      [w - inset - leg, d - inset - leg],
    ] as const;
    return [
      ...corners.map(([x, y]) =>
        round
          ? turned(x, y, 0, leg, leg, under, legTone, [
              { r: 0.7, z: 0 },
              { r: 1, z: 1 },
            ])
          : box(x, y, 0, leg, leg, under, legTone, { radius: 0.2, material: 'metal' }),
      ),
      // Rails hold the legs at the back and sides; the front can stay open for knees.
      box(inset + leg, inset, under - rail, span, cm(2), rail, legTone),
      ...(spec.frontRail
        ? [box(inset + leg, d - inset - cm(2), under - rail, span, cm(2), rail, legTone)]
        : []),
      box(inset, inset + leg, under - rail, cm(2), d - 2 * (inset + leg), rail, legTone),
      box(
        w - inset - cm(2),
        inset + leg,
        under - rail,
        cm(2),
        d - 2 * (inset + leg),
        rail,
        legTone,
      ),
      box(0, 0, under, w, d, top, 'wood', { radius: 0.3, material: 'wood' }),
    ];
  };
}

/** An office chair facing -y (toward the desk), its back toward +y. */
const chair: Build<'chair'> = (w, d, h, { outline, spec }) => {
  const cx = w / 2;
  const cy = d / 2;
  const s = Math.min(w, d) / cm(spec.footprintCm);
  const reach = cm(spec.reachCm) * s;
  const parts: PropPart[] = [];
  // The base's footprint, casters included, for a camera's outline.
  const foot = reach + cm(2.6);
  if (outline)
    parts.push(turned(cx - foot, cy - foot, 0, foot * 2, foot * 2, cm(10), 'steel', CYLINDER));
  // Five spokes from the hub, each on a caster.
  for (let i = 0; i < (outline ? 0 : 5); i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 2;
    const ex = cx + Math.cos(a) * reach;
    const ey = cy + Math.sin(a) * reach;
    parts.push(
      tube(
        [
          [cx, cy, cm(10)],
          [ex, ey, cm(7)],
        ],
        cm(1.8),
        'steel',
        { material: 'metal' },
      ),
      turned(ex - cm(2.6), ey - cm(2.6), 0, cm(5.2), cm(5.2), cm(5.5), 'floor', CYLINDER),
    );
  }
  const seatZ = cm(spec.seatCm);
  const seatW = cm(spec.seatWCm) * s;
  const seatD = cm(spec.seatDCm) * s;
  const backZ = seatZ + cm(spec.backGapCm);
  parts.push(
    turned(cx - cm(4), cy - cm(4), cm(7), cm(8), cm(8), cm(6), 'steel', CYLINDER, {
      material: 'metal',
    }),
    // The gas lift in its shroud.
    turned(cx - cm(3), cy - cm(3), cm(12), cm(6), cm(6), cm(12), 'floor', CYLINDER),
    turned(cx - cm(2), cy - cm(2), cm(24), cm(4), cm(4), seatZ - cm(24), 'steel', CYLINDER, {
      material: 'metal',
    }),
    box(cx - cm(10), cy - cm(10), seatZ - cm(2), cm(20), cm(20), cm(3), 'floor'),
    box(cx - seatW / 2, cy - seatW / 2, seatZ, seatW, seatD, cm(spec.cushionCm), 'fabric', {
      radius: 0.45,
      material: 'fabric',
    }),
    // The back, on a bent spine from under the seat.
    tube(
      [
        [cx, cy + cm(14) * s, seatZ + cm(1)],
        [cx, cy + cm(27) * s, seatZ + cm(2)],
        [cx, cy + cm(27) * s, backZ + cm(2)],
      ],
      cm(2),
      'floor',
    ),
    box(
      cx - (cm(spec.backWCm) * s) / 2,
      cy + cm(23) * s,
      backZ,
      cm(spec.backWCm) * s,
      cm(6),
      h - backZ,
      'fabric',
      { radius: 0.45, material: 'fabric' },
    ),
  );
  // Armrests: a post on each side and a pad on top.
  for (const side of outline || !spec.arms ? [] : [-1, 1]) {
    const ax = cx + side * (seatW / 2 - cm(1));
    const armZ = seatZ + cm(spec.armCm);
    parts.push(
      tube(
        [
          [ax, cy + cm(6) * s, seatZ + cm(3)],
          [ax + side * cm(2), cy + cm(6) * s, armZ],
        ],
        cm(1.5),
        'floor',
      ),
      box(ax + side * cm(2) - cm(3), cy - cm(10) * s, armZ, cm(6), cm(24) * s, cm(2.5), 'floor', {
        radius: 0.4,
      }),
    );
  }
  return parts;
};

/** An open bookcase against a wall at -y, its shelves full of books. */
const bookcase: Build<'bookcase'> = (w, d, h, { spec }) => {
  const board = cm(spec.boardCm);
  const plinth = cm(spec.plinthCm);
  const parts: PropPart[] = [
    box(0, 0, 0, board, d, h, 'wood', { radius: 0.15, material: 'wood' }),
    box(w - board, 0, 0, board, d, h, 'wood', { radius: 0.15, material: 'wood' }),
    box(board, 0, h - board, w - 2 * board, d, board, 'wood', { material: 'wood' }),
    box(board, cm(2), 0, w - 2 * board, d - cm(2), plinth, 'wood', { material: 'wood' }),
    box(board, 0, plinth, w - 2 * board, cm(1), h - board - plinth, 'wall'),
  ];
  const rows = Math.max(1, Math.round((h - plinth) / cm(spec.shelfPitchCm)));
  const pitch = (h - board - plinth) / rows;
  const spines: IsoTone[] = ['book', 'paper', 'fabric', 'ceramic', 'plant', 'appliance', 'steel'];
  for (let r = 0; r < rows; r++) {
    const floor = plinth + r * pitch + (r ? board : 0);
    if (r) parts.push(box(board, cm(1), floor - board, w - 2 * board, d - cm(1.5), board, 'wood'));
    const room = pitch - (r ? board : 0) - cm(2);
    const rand = seeded(r + 1);
    let x = board + cm(1);
    const end = w - board - cm(1);
    // One shelf in three holds a stack lying flat and a little pot.
    const flat = r % 3 === 1;
    const stop = flat ? x + (end - x) * 0.55 : end - cm(3);
    while (x < stop) {
      const thick = cm(2 + rand() * 3);
      if (x + thick > stop) break;
      const tall = Math.min(room, cm(19 + rand() * 9));
      const deep = Math.min(d - cm(3), cm(14 + rand() * 8));
      const tone = spines[Math.floor(rand() * spines.length)]!;
      parts.push(box(x, cm(1.5), floor, thick, deep, tall, tone, { radius: 0.15 }));
      x += thick + (rand() < 0.15 ? cm(1.5) : 0);
    }
    if (flat) {
      let z = floor;
      for (let i = 0; i < 3; i++) {
        const thick = cm(2.5 + rand() * 1.5);
        const len = cm(22 - i * 2);
        parts.push(box(x + cm(3) + i * cm(1), cm(2), z, len, cm(15), thick, spines[(r + i) % 7]!));
        z += thick;
      }
      const px = end - cm(10);
      if (px > x + cm(28))
        parts.push(
          turned(px, d / 2 - cm(5), floor, cm(10), cm(10), cm(11), 'ceramic', [
            { r: 0.7, z: 0 },
            { r: 1, z: 1 },
          ]),
          {
            shape: 'blob',
            at: { x: px - cm(2), y: d / 2 - cm(7), z: floor + cm(9) },
            size: { w: cm(14), d: cm(14), h: cm(12) },
            tone: 'plant',
            rough: 0.7,
          },
        );
    }
  }
  return parts;
};

/** A low chest of drawers, fronts facing +y. */
const cabinet: Build<'cabinet'> = (w, d, h, { spec }) => {
  const plinth = cm(spec.plinthCm);
  const parts: PropPart[] = [
    box(cm(1), cm(1), 0, w - cm(2), d - cm(5), plinth, 'floor'),
    box(0, 0, plinth, w, d - cm(3.5), h - plinth, 'wood', { radius: 0.06, material: 'wood' }),
  ];
  const drawers = Math.max(1, Math.round((h - plinth) / cm(spec.drawerCm)));
  const gap = cm(0.8);
  const each = (h - plinth - cm(2) - gap * (drawers - 1)) / drawers;
  for (let i = 0; i < drawers; i++) {
    const z = plinth + cm(1) + i * (each + gap);
    parts.push(
      box(cm(1.5), d - cm(3.5), z, w - cm(3), cm(2), each, 'wood', {
        radius: 0.15,
        material: 'wood',
      }),
      box(w / 2 - cm(8), d - cm(1.5), z + each / 2 - cm(1), cm(16), cm(1.5), cm(2), 'steel', {
        radius: 0.4,
        material: 'metal',
      }),
    );
  }
  return parts;
};

/** A monitor on a stand, screen facing +y. */
const monitor: Build<'monitor'> = (w, d, h, { spec }) => {
  const panelZ = cm(spec.liftCm);
  const panelH = h - panelZ;
  const panelY = d / 2 + cm(1);
  const panel = cm(spec.panelCm);
  const neckW = cm(spec.neckCm);
  return [
    box(
      w / 2 - cm(spec.footWCm) / 2,
      d / 2 - cm(8),
      0,
      cm(spec.footWCm),
      cm(spec.footDCm),
      cm(1.5),
      'steel',
      {
        radius: 0.5,
        material: 'metal',
      },
    ),
    box(
      w / 2 - neckW / 2,
      d / 2 - cm(5),
      cm(1.5),
      neckW,
      cm(2.5),
      panelZ + panelH * 0.55,
      'steel',
      {
        radius: 0.3,
        material: 'metal',
      },
    ),
    // The housing bulges out of the panel's back.
    box(w * 0.2, panelY - cm(3), panelZ + panelH * 0.12, w * 0.6, cm(3.5), panelH * 0.7, 'floor', {
      radius: 0.3,
    }),
    box(0, panelY, panelZ, w, panel, panelH, 'floor', { radius: 0.12 }),
    // The screen, behind a thin bezel.
    box(
      cm(0.8),
      panelY + panel - cm(0.2),
      panelZ + cm(1.8),
      w - cm(1.6),
      cm(0.6),
      panelH - cm(2.6),
      'glass',
      {
        radius: 0.02,
        material: 'glass',
      },
    ),
  ];
};

/** A full-size keyboard, its keys in rows. */
const keyboard: Build<'keyboard'> = (w, d, h, { spec }) => {
  const parts: PropPart[] = [box(0, 0, 0, w, d, h * 0.6, 'steel', { radius: 0.3 })];
  const margin = cm(spec.marginCm);
  const gap = cm(spec.gapCm);
  const { rows, cols } = spec;
  const key = (w - 2 * margin - gap * (cols - 1)) / cols;
  const depth = (d - 2 * margin - gap * (rows - 1)) / rows;
  for (let r = 0; r < rows; r++) {
    const y = margin + r * (depth + gap);
    // The bottom row: four keys either side of a space bar as wide as the rest.
    const side = [1, 1, 1, 1.5];
    const widths =
      r === rows - 1 ? [...side, cols - 2 * 4.5, ...[...side].reverse()] : Array(cols).fill(1);
    let x = margin;
    for (const span of widths) {
      const kw = key * span + gap * (span - 1);
      parts.push(box(x, y, h * 0.6, kw, depth, h * 0.4, 'appliance', { radius: 0.35 }));
      x += kw + gap;
    }
  }
  return parts;
};

/** A hardback lying flat, its spine at -x. */
const book: Build<'book'> = (w, d, h, { spec }) => {
  const cover = Math.min(cm(spec.coverCm), h / 4);
  const edge = cm(0.4);
  return [
    box(0, 0, 0, w, d, cover, 'book', { radius: 0.2 }),
    box(0, 0, h - cover, w, d, cover, 'book', { radius: 0.2 }),
    box(0, 0, 0, cover * 2, d, h, 'book', { radius: 0.3 }),
    box(cover, edge, cover, w - cover - edge, d - 2 * edge, h - 2 * cover, 'paper', {
      radius: 0.05,
    }),
  ];
};

const BUILDS: { [F in PropForm]: Build<F> } = {
  desk: legged('steel', false),
  table: legged('wood', true),
  chair,
  bookcase,
  cabinet,
  pot: (w, d, h) => [
    turned(0, 0, 0, w, d, h * 0.92, 'ceramic', [
      { r: 0.72, z: 0 },
      { r: 0.8, z: 0.08 },
      { r: 0.94, z: 1 },
    ]),
    turned(0, 0, h * 0.88, w, d, h * 0.12, 'ceramic', [
      { r: 1, z: 0 },
      { r: 1, z: 1 },
    ]),
  ],
  foliage: (w, d, h) => {
    const rand = seeded(7);
    const parts: PropPart[] = [
      {
        shape: 'blob',
        at: { x: w * 0.2, y: d * 0.2, z: 0 },
        size: { w: w * 0.6, d: d * 0.6, h: h * 0.55 },
        tone: 'plant',
        rough: 0.7,
      },
    ];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + rand();
      const r = 0.18 + rand() * 0.06;
      const s = 0.36 + rand() * 0.12;
      parts.push({
        shape: 'blob',
        at: {
          x: w * (0.5 + Math.cos(a) * r - s / 2),
          y: d * (0.5 + Math.sin(a) * r - s / 2),
          z: h * (0.15 + rand() * 0.45),
        },
        size: { w: w * s, d: d * s, h: h * 0.4 },
        tone: 'plant',
        rough: 0.8,
      });
    }
    return parts;
  },
  'lamp-stand': (w, d, h) => [
    turned(
      0,
      0,
      0,
      w,
      d,
      cm(2.5),
      'steel',
      [
        { r: 1, z: 0 },
        { r: 1, z: 0.5 },
        { r: 0.8, z: 1 },
      ],
      { material: 'metal' },
    ),
    tube(
      [
        [w / 2, d / 2, cm(2.5)],
        [w / 2, d / 2, h],
      ],
      cm(0.9),
      'steel',
      { material: 'metal' },
    ),
  ],
  'lamp-shade': (w, d, h) => [
    turned(0, 0, 0, w, d, h, 'steel', [
      { r: 1, z: 0 },
      { r: 0.96, z: 0.15 },
      { r: 0.72, z: 0.6 },
      { r: 0.3, z: 0.9 },
      { r: 0.18, z: 1 },
    ]),
  ],
  monitor,
  keyboard,
  book,
  bottle: (w, d, h) => [
    turned(
      0,
      0,
      0,
      w,
      d,
      h * 0.86,
      'plant',
      [
        { r: 0.92, z: 0 },
        { r: 1, z: 0.04 },
        { r: 1, z: 0.88 },
        { r: 0.86, z: 0.96 },
        { r: 0.74, z: 1 },
      ],
      { material: 'gloss' },
    ),
    turned(w * 0.14, d * 0.14, h * 0.86, w * 0.72, d * 0.72, h * 0.14, 'book', CYLINDER),
  ],
  jar: (w, d, h) => [
    turned(
      0,
      0,
      0,
      w,
      d,
      h * 0.82,
      'glass',
      [
        { r: 0.94, z: 0 },
        { r: 1, z: 0.08 },
        { r: 1, z: 0.85 },
        { r: 0.86, z: 1 },
      ],
      { material: 'glass' },
    ),
    turned(w * 0.08, d * 0.08, h * 0.82, w * 0.84, d * 0.84, h * 0.18, 'steel', CYLINDER, {
      material: 'metal',
    }),
  ],
  carton: (w, d, h) => [
    box(0, 0, 0, w, d, h * 0.84, 'paper', { radius: 0.06 }),
    // The gable top, as a ridge with its seam.
    box(w * 0.04, d * 0.2, h * 0.84, w * 0.92, d * 0.6, h * 0.1, 'paper', { radius: 0.3 }),
    box(0, d * 0.44, h * 0.9, w, d * 0.12, h * 0.1, 'paper', { radius: 0.2 }),
  ],
};

/** A part turned a quarter clockwise (seen from above) in a `w × d` frame. */
function turnPart(p: PropPart, d: number): PropPart {
  return {
    ...p,
    at: { x: d - p.at.y - p.size.d, y: p.at.x, z: p.at.z },
    size: { w: p.size.d, d: p.size.w, h: p.size.h },
    ...(p.path ? { path: p.path.map((q) => ({ x: 1 - q.y, y: q.x, z: q.z })) } : {}),
  };
}
/** The model a prop is drawn with, relative to its corner, or null for a plain box. */
export function propModel(
  prop: Pick<IsoProp, 'form' | 'size' | 'turns'>,
  outline = false,
): PropPart[] | null {
  if (!prop.form) return null;
  const turns = (((prop.turns ?? 0) % 4) + 4) % 4;
  // Build in the unturned frame, then turn it into the prop's box.
  let w = turns % 2 ? prop.size.d : prop.size.w;
  let d = turns % 2 ? prop.size.w : prop.size.d;
  const build = BUILDS[prop.form] as Build<PropForm>;
  let parts = build(w, d, prop.size.h, { outline, spec: furnitureSpec(prop.form) });
  for (let i = 0; i < turns; i++) {
    parts = parts.map((p) => turnPart(p, d));
    [w, d] = [d, w];
  }
  return parts;
}
/**
 * The solids a prop shows a camera: its model's outline parts as boxes
 * and cylinders in scene space (a desk's legs and top, not one block), or
 * the prop itself when it has no model.
 */
export function propSolids(
  prop: IsoProp,
): { box: IsoBox; shape: IsoProp['shape']; tone: IsoTone }[] {
  const model = propModel(prop, true);
  if (!model) return [{ box: prop, shape: prop.shape, tone: prop.tone }];
  return model.map((q) => ({
    box: {
      at: { x: prop.at.x + q.at.x, y: prop.at.y + q.at.y, z: prop.at.z + q.at.z },
      size: q.size,
    },
    shape: q.shape === 'lathe' ? 'cylinder' : 'prism',
    tone: q.tone,
  }));
}
