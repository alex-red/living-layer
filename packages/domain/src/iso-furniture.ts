import { bezier, type Vec3 } from './math.js';
import type { IsoBox, IsoProp, IsoSize, IsoTone, IsoVec } from './iso.js';
import type { Decal, ItemMaterial } from './iso-item.js';
import type { FixtureRecipe } from './recipe.js';

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

/** Every tone a prop or a model's part can take (see `PROP_TONES` for their colours). */
export const ISO_TONES = [
  'floor',
  'wall',
  'wood',
  'steel',
  'fabric',
  'paper',
  'book',
  'glass',
  'appliance',
  'plant',
  'ceramic',
  'screen',
  'soil',
] as const satisfies readonly IsoTone[];

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
  'eggs',
  'butter',
  'tub',
  'greens',
  'litter-robot',
  'litter-mat',
] as const;
export type PropForm = (typeof PROP_FORMS)[number];

/** What every part of a model has. */
interface PropPartBase {
  at: IsoVec;
  size: IsoSize;
  tone: IsoTone;
  /** A colour of its own (a recipe's part); otherwise the tone's. */
  color?: string;
  material?: ItemMaterial;
  /** A recipe part's name (`top-shade`), so a thing made of it can find its shades. */
  name?: string;
  /** A recipe part's print on its top, read off a photo. */
  decal?: Decal;
}
/** One part of a model, in tiles, relative to the prop's corner; each shape has its own fields. */
export type PropPart = PropPartBase &
  (
    | {
        shape: 'rbox';
        /** An rbox's corner radius as a share of its smallest side. */
        radius?: number;
      }
    | {
        shape: 'lathe';
        /** (radius, height) as shares of the box, bottom to top. */
        profile: { r: number; z: number }[];
        /** An open top with walls this thick, as a share of the radius. */
        wall?: number;
      }
    | {
        shape: 'tube';
        /** Its curve as shares of the box. */
        path: { x: number; y: number; z: number }[];
        /** Radius in tiles. */
        radius?: number;
      }
    | {
        shape: 'blob';
        /** How lumpy, 0 to 1. */
        rough?: number;
      }
  );

type Opts = { material?: ItemMaterial; radius?: number; rough?: number; wall?: number };
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
  profile: { r: number; z: number }[],
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
 * (`bun run bench:room --set desk.topCm=3,4,5`) or a test can try other
 * proportions with `withFurniture`, without editing this file.
 */
export const FURNITURE_SPECS = {
  desk: { heightCm: 72, topCm: 6, legCm: 6, insetCm: 5, railCm: 0, frontRail: false },
  table: { heightCm: 75, topCm: 5, legCm: 6, insetCm: 5, railCm: 5, frontRail: false },
  chair: {
    heightCm: 98,
    /** The width the parts below are drawn for; a wider box scales them. */
    footprintCm: 66,
    seatCm: 40,
    seatWCm: 50,
    seatDCm: 48,
    cushionCm: 9,
    reachCm: 30,
    backWCm: 44,
    /** From the seat's underside to the back's lower edge. */
    backGapCm: 14,
    backCm: 7,
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
  /** A dozen in an open carton, 2 × 6; the carton's cups come this far up the eggs. */
  eggs: { heightCm: 7, rows: 2, cols: 6, cupCm: 3.5 },
  butter: { heightCm: 5 },
  /** A lidded tub of leftovers, filled this far. */
  tub: { heightCm: 9, lidCm: 1.5, fill: 0.6 },
  /** An open clamshell of salad leaves (spinach), its clear rim this share of the way up. */
  greens: { heightCm: 9, rim: 0.55 },
  /**
   * A self-cleaning litter box: a round white housing over a pedestal, its
   * globe's entry facing the room and a step under it, 56 × 69 cm and 75 tall.
   * The housing is a ball as wide as the box, the entry this wide across its
   * front; the step's tread stands this high, this deep and this thick.
   */
  'litter-robot': {
    heightCm: 75,
    housingCm: 56,
    entryCm: 36,
    pedestalWCm: 44,
    stepZCm: 22,
    stepDCm: 15,
    stepCm: 4,
  },
  /** A honeycomb mat that catches litter off paws, its raised border this wide. */
  'litter-mat': { heightCm: 1.2, borderCm: 2.5 },
} satisfies Record<PropForm, { heightCm: number } & Record<string, number | boolean>>;
type FurnitureSpecs = typeof FURNITURE_SPECS;
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

/** A slab on four legs, its top at `h`, with rails under it when `railCm` isn't 0. */
function legged(legTone: IsoTone, round: boolean): Build<'desk' | 'table'> {
  return (w, d, h, { spec }) => {
    const top = cm(spec.topCm);
    const leg = cm(spec.legCm);
    const inset = cm(spec.insetCm);
    const rail = cm(spec.railCm);
    const under = h - top;
    const span = w - 2 * (inset + leg);
    const side = d - 2 * (inset + leg);
    const corners = [
      [inset, inset],
      [w - inset - leg, inset],
      [inset, d - inset - leg],
      [w - inset - leg, d - inset - leg],
    ] as const;
    // Rails hold the legs at the back and sides; the front can stay open for knees.
    const rails = rail
      ? [
          box(inset + leg, inset, under - rail, span, cm(2), rail, legTone),
          ...(spec.frontRail
            ? [box(inset + leg, d - inset - cm(2), under - rail, span, cm(2), rail, legTone)]
            : []),
          box(inset, inset + leg, under - rail, cm(2), side, rail, legTone),
          box(w - inset - cm(2), inset + leg, under - rail, cm(2), side, rail, legTone),
        ]
      : [];
    return [
      ...corners.map(([x, y]) =>
        round
          ? turned(x, y, 0, leg, leg, under, legTone, [
              { r: 0.7, z: 0 },
              { r: 1, z: 1 },
            ])
          : box(x, y, 0, leg, leg, under, legTone, { radius: 0.15, material: 'matte' }),
      ),
      ...rails,
      box(0, 0, under, w, d, top, 'wood', { radius: 0.25, material: 'wood' }),
    ];
  };
}

/**
 * An office chair facing -y (toward the desk), its back toward +y: a thick
 * cushion, a slab back on a bracket, arms each side, five spokes on casters.
 */
const chair: Build<'chair'> = (w, d, h, { outline, spec }) => {
  const cx = w / 2;
  const cy = d / 2;
  const s = Math.min(w, d) / cm(spec.footprintCm);
  const reach = cm(spec.reachCm) * s;
  const wheel = cm(3);
  const parts: PropPart[] = [];
  // The base's footprint, casters included, for a camera's outline.
  const foot = reach + wheel;
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
          [ex, ey, cm(8)],
        ],
        cm(2.2),
        'steel',
        { material: 'matte' },
      ),
      turned(ex - wheel, ey - wheel, 0, wheel * 2, wheel * 2, cm(6), 'floor', CYLINDER),
    );
  }
  const seatZ = cm(spec.seatCm);
  const seatW = cm(spec.seatWCm) * s;
  const seatD = cm(spec.seatDCm) * s;
  const cushion = cm(spec.cushionCm);
  const backZ = seatZ + cm(spec.backGapCm);
  const backT = cm(spec.backCm);
  // The back stands at the seat's rear edge, a little behind it.
  const backY = cy - seatW / 2 + seatD - backT * 0.6;
  parts.push(
    turned(cx - cm(5), cy - cm(5), cm(6), cm(10), cm(10), cm(7), 'steel', CYLINDER, {
      material: 'matte',
    }),
    // The gas lift.
    turned(cx - cm(3), cy - cm(3), cm(12), cm(6), cm(6), seatZ - cm(14), 'floor', CYLINDER),
    box(cx - cm(11), cy - cm(11), seatZ - cm(3), cm(22), cm(22), cm(4), 'floor'),
    box(cx - seatW / 2, cy - seatW / 2, seatZ, seatW, seatD, cushion, 'fabric', {
      radius: 0.5,
      material: 'fabric',
    }),
    // The bracket that carries the back, behind the seat.
    box(
      cx - cm(6),
      backY - cm(1),
      seatZ - cm(2),
      cm(12),
      backT + cm(1),
      backZ - seatZ + cm(6),
      'floor',
    ),
    box(
      cx - (cm(spec.backWCm) * s) / 2,
      backY,
      backZ,
      cm(spec.backWCm) * s,
      backT,
      h - backZ,
      'fabric',
      {
        radius: 0.5,
        material: 'fabric',
      },
    ),
  );
  // Armrests: a post on each side and a pad on top.
  for (const side of outline || !spec.arms ? [] : [-1, 1]) {
    const ax = cx + side * (seatW / 2 + cm(1)) - cm(2);
    const armZ = seatZ + cm(spec.armCm);
    parts.push(
      box(ax, cy - cm(2) * s, seatZ + cm(2), cm(4), cm(5), armZ - seatZ - cm(2), 'floor'),
      box(ax - cm(1), cy - cm(12) * s, armZ, cm(6), cm(26) * s, cm(3), 'floor', { radius: 0.4 }),
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
  const spines: IsoTone[] = ['paper', 'book', 'fabric', 'paper', 'screen', 'book', 'appliance'];
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
      'screen',
      {
        radius: 0.02,
        material: 'gloss',
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

/** A ball's profile: (radius, height) as shares of its box, bottom to top. */
const BALL = Array.from({ length: 13 }, (_, i) => {
  const z = i / 12;
  return { r: Math.max(0.12, Math.sqrt(1 - (2 * z - 1) ** 2)), z };
});
/**
 * A ball pushed out through a ball housing (centre `c`, radius `r`) toward
 * `dir`, so it shows as a cap whose rim meets the housing in a circle of
 * radius `rim` and which stands `out` proud at its middle: an entry, a panel
 * or a window that follows the housing's curve. With k = r + out and the
 * rim's plane X from the centre, the cap's ball has radius ((k − X)² + rim²) / 2(k − X).
 */
function cap(
  c: IsoVec,
  r: number,
  dir: IsoVec,
  rim: number,
  out: number,
  tone: IsoTone,
  o: Opts = {},
): PropPart {
  const len = Math.hypot(dir.x, Math.hypot(dir.y, dir.z));
  const k = r + out;
  const X = Math.sqrt(Math.max(r * r - rim * rim, 0));
  const er = ((k - X) ** 2 + rim ** 2) / (2 * (k - X));
  const at = (v: number, d: number) => v + (d / len) * (k - er) - er;
  return turned(
    at(c.x, dir.x),
    at(c.y, dir.y),
    at(c.z, dir.z),
    2 * er,
    2 * er,
    2 * er,
    tone,
    BALL,
    o,
  );
}
/**
 * A self-cleaning litter box, facing +y, built for its real 56 cm width (a
 * wider or taller box scales it): a grey plinth and a white pedestal holding
 * the waste drawer, its seam and handle under the step; the round white
 * housing on it; on its front the entry, dark inside, with a raised white
 * bezel, the grey litter bed and the white bumper lip at its foot, the
 * sifting screen's panel and a row of vent holes over it; the control panel
 * and its display on top, a sensor window on the right side, and the step's
 * grooved tread in front. At most 24 parts, so it can be made a Thing.
 */
const litterRobot: Build<'litter-robot'> = (w, d, h, { spec, outline }) => {
  const sx = w / cm(56);
  const sz = h / cm(spec.heightCm);
  const ball = Math.min(cm(spec.housingCm) * sx, w);
  const r = ball / 2;
  const back = cm(2) * sx;
  const ballZ = h - ball;
  const pedW = cm(spec.pedestalWCm) * sx;
  const front = back + ball;
  const c = { x: w / 2, y: back + r, z: ballZ + r };
  const stepZ = cm(spec.stepZCm) * sz;
  const stepW = pedW * 0.9;
  const stepY = front - cm(4) * sx;
  const stepD = Math.min(d - stepY, cm(spec.stepDCm + 4) * sx);
  const tread = cm(spec.stepCm) * sz;
  const parts: PropPart[] = [
    box(
      (w - pedW) / 2 - cm(1) * sx,
      back + ball * 0.1,
      0,
      pedW + cm(2) * sx,
      ball * 0.84,
      cm(1.5) * sz,
      'steel',
      {
        radius: 0.3,
      },
    ),
    box((w - pedW) / 2, back + ball * 0.12, 0, pedW, ball * 0.8, ballZ + ball * 0.3, 'ceramic', {
      radius: 0.2,
      material: 'gloss',
    }),
    turned((w - ball) / 2, back, ballZ, ball, ball, ball, 'ceramic', BALL, { material: 'gloss' }),
    // The drawer under the step, its tread on top.
    box((w - stepW) / 2, stepY, 0, stepW, stepD, stepZ, 'ceramic', {
      radius: 0.18,
      material: 'gloss',
    }),
    box(
      (w - stepW * 0.96) / 2,
      stepY + cm(1) * sx,
      stepZ,
      stepW * 0.96,
      stepD - cm(1) * sx,
      tread,
      'screen',
      {
        radius: 0.3,
      },
    ),
  ];
  if (outline) return parts;
  const entry = Math.min((cm(spec.entryCm) * sx) / 2, r * 0.8);
  const ahead = { x: 0, y: 1, z: 0 };
  const groove = (share: number) =>
    box(
      (w - stepW * 0.8) / 2,
      stepY + stepD * share,
      stepZ + tread * 0.7,
      stepW * 0.8,
      cm(1.2) * sx,
      tread * 0.4,
      'fabric',
      {
        radius: 0.4,
      },
    );
  const vent = (dx: number) =>
    cap(c, r, { x: dx, y: 0.62, z: 0.78 }, cm(1.3) * sx, cm(0.6) * sx, 'screen');
  parts.push(
    groove(0.35),
    groove(0.65),
    // The drawer's seam across its front, and the handle's recess.
    box(
      (w - stepW) / 2 - cm(0.3) * sx,
      stepY + stepD - cm(0.8) * sx,
      stepZ * 0.9,
      stepW + cm(0.6) * sx,
      cm(0.8) * sx,
      cm(0.8) * sz,
      'steel',
      {
        radius: 0.3,
      },
    ),
    box(
      w / 2 - cm(5) * sx,
      stepY + stepD - cm(0.8) * sx,
      stepZ * 0.55,
      cm(10) * sx,
      cm(0.8) * sx,
      cm(2) * sz,
      'screen',
      {
        radius: 0.4,
      },
    ),
    // The entry: the raised bezel, the dark inside, the litter bed's grey and the bumper lip.
    cap(c, r, ahead, entry + cm(2.5) * sx, cm(1.6) * sx, 'ceramic', { material: 'gloss' }),
    cap(c, r, ahead, entry, cm(2.2) * sx, 'screen'),
    cap(c, r, { x: 0, y: 1, z: -0.45 }, entry * 0.7, cm(2.5) * sx, 'appliance'),
    cap(c, r, { x: -0.25, y: 1, z: 0.15 }, entry * 0.45, cm(2.4) * sx, 'steel', {
      material: 'metal',
    }),
    cap(c, r, { x: 0, y: 1, z: -0.95 }, entry * 0.62, cm(3) * sx, 'ceramic', { material: 'gloss' }),
    vent(-0.12),
    vent(0),
    vent(0.12),
    // The control panel on top toward the front, its display lit blue, and the side's sensor window.
    cap(c, r, { x: 0, y: 0.45, z: 1 }, cm(7) * sx, cm(1) * sx, 'screen'),
    cap(c, r, { x: 0.1, y: 0.45, z: 1 }, cm(3.5) * sx, cm(1.4) * sx, 'glass', {
      material: 'gloss',
    }),
    cap(c, r, { x: 1, y: 0.35, z: 0.1 }, cm(4) * sx, cm(0.8) * sx, 'screen'),
  );
  return parts;
};

const BUILDS: { [F in PropForm]: Build<F> } = {
  desk: legged('steel', false),
  table: legged('wood', true),
  chair,
  bookcase,
  cabinet,
  // A tapered pot with a rolled rim, open, with soil a little under the rim.
  pot: (w, d, h) => [
    turned(
      0,
      0,
      0,
      w,
      d,
      h,
      'ceramic',
      [
        { r: 0.74, z: 0 },
        { r: 0.8, z: 0.06 },
        { r: 0.92, z: 0.8 },
        { r: 1, z: 0.82 },
        { r: 1, z: 1 },
      ],
      { wall: 0.12 },
    ),
    turned(w * 0.1, d * 0.1, h * 0.75, w * 0.8, d * 0.8, h * 0.13, 'soil', CYLINDER),
  ],
  // A trunk out of the soil and a rounded crown of clumps.
  foliage: (w, d, h) => {
    const rand = seeded(7);
    const clump = (cx: number, cy: number, z: number, s: number): PropPart => ({
      shape: 'blob',
      at: { x: w * (cx - s / 2), y: d * (cy - s / 2), z: h * z },
      size: { w: w * s, d: d * s, h: h * s * 0.85 },
      tone: 'plant',
      rough: 0.35,
    });
    const parts: PropPart[] = [
      tube(
        [
          [w / 2, d / 2, 0],
          [w / 2, d / 2, h * 0.4],
        ],
        cm(1.2),
        'soil',
      ),
      clump(0.5, 0.5, 0.55, 0.42),
    ];
    for (const [ring, z, count, s] of [
      [0.24, 0.32, 6, 0.36],
      [0.16, 0.18, 4, 0.3],
    ] as const)
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + rand() * 0.6;
        parts.push(clump(0.5 + Math.cos(a) * ring, 0.5 + Math.sin(a) * ring, z + rand() * 0.08, s));
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
  // An open carton: its cups, an egg standing in each.
  eggs: (w, d, h, { spec }) => {
    const cup = Math.min(cm(spec.cupCm), h / 2);
    const cellW = w / spec.cols;
    const cellD = d / spec.rows;
    const parts: PropPart[] = [box(0, 0, 0, w, d, cup, 'paper', { radius: 0.15 })];
    for (let r = 0; r < spec.rows; r++)
      for (let c = 0; c < spec.cols; c++)
        parts.push(
          turned(
            c * cellW + cellW * 0.1,
            r * cellD + cellD * 0.1,
            cup * 0.4,
            cellW * 0.8,
            cellD * 0.8,
            h - cup * 0.4,
            'wood',
            [
              { r: 0.55, z: 0 },
              { r: 0.95, z: 0.25 },
              { r: 1, z: 0.45 },
              { r: 0.85, z: 0.7 },
              { r: 0.5, z: 0.92 },
              { r: 0.15, z: 1 },
            ],
          ),
        );
    return parts;
  },
  // A wrapped block, its fold along the top.
  butter: (w, d, h) => [
    box(0, 0, 0, w, d, h * 0.94, 'paper', { radius: 0.12 }),
    box(0, d * 0.4, h * 0.9, w, d * 0.2, h * 0.1, 'paper', { radius: 0.3 }),
  ],
  // A clear tub, the food showing through, under a coloured lid.
  tub: (w, d, h, { spec }) => {
    const lid = Math.min(cm(spec.lidCm), h / 4);
    const wall = cm(0.4);
    return [
      box(wall, wall, 0, w - 2 * wall, d - 2 * wall, h - lid, 'glass', { radius: 0.15 }),
      box(w * 0.1, d * 0.1, cm(0.3), w * 0.8, d * 0.8, (h - lid) * spec.fill, 'soil', {
        radius: 0.3,
      }),
      box(0, 0, h - lid, w, d, lid, 'fabric', { radius: 0.25 }),
    ];
  },
  // An open clamshell, the leaves heaped above its clear rim.
  greens: (w, d, h, { spec }) => [
    box(0, 0, 0, w, d, h * spec.rim, 'glass', { radius: 0.15 }),
    box(w * 0.06, d * 0.06, h * 0.2, w * 0.88, d * 0.88, h * 0.8, 'plant', { radius: 0.5 }),
  ],
  'litter-robot': litterRobot,
  // A black mat: its border a shade lighter round the dark honeycomb.
  'litter-mat': (w, d, h, { spec }) => {
    const border = Math.min(cm(spec.borderCm), w / 4, d / 4);
    return [
      box(0, 0, 0, w, d, h * 0.7, 'fabric', { radius: 0.05 }),
      box(border, border, h * 0.4, w - 2 * border, d - 2 * border, h * 0.6, 'screen', {
        radius: 0.05,
      }),
    ];
  },
};

/**
 * A recipe's parts in a `w × d × h` box, in tiles: each part scaled by how
 * much the box differs from the recipe's own size, so a desk drawn wider
 * keeps its drawer unit at the same share of it.
 */
export function recipeModel(recipe: FixtureRecipe, w: number, d: number, h: number): PropPart[] {
  const sx = w / cm(recipe.sizeCm.w);
  const sy = d / cm(recipe.sizeCm.d);
  const sz = h / cm(recipe.sizeCm.h);
  return recipe.parts.flatMap((p): PropPart[] => {
    const base = {
      at: { x: cm(p.atCm.x) * sx, y: cm(p.atCm.y) * sy, z: cm(p.atCm.z) * sz },
      size: { w: cm(p.sizeCm.w) * sx, d: cm(p.sizeCm.d) * sy, h: cm(p.sizeCm.h) * sz },
      tone: p.tone,
      ...(p.color ? { color: p.color } : {}),
      ...(p.material ? { material: p.material } : {}),
      ...(p.decal ? { decal: p.decal } : {}),
      name: p.name,
    };
    switch (p.shape) {
      case 'rbox':
        return [{ ...base, shape: 'rbox', radius: p.radius ?? 0.08 }];
      case 'lathe':
        // A recipe's schema gives every lathe a profile; a plain cylinder if one slipped by.
        return [
          {
            ...base,
            shape: 'lathe',
            profile: p.profile ?? CYLINDER,
            ...(p.wall !== undefined ? { wall: p.wall } : {}),
          },
        ];
      case 'tube':
        // Likewise every tube has a path, and a pathless one draws nothing.
        return p.path
          ? [
              {
                ...base,
                shape: 'tube',
                path: p.path,
                radius: cm(p.tubeCm!) * Math.min(sx, sy, sz),
              },
            ]
          : [];
      case 'blob':
        return [{ ...base, shape: 'blob', ...(p.rough !== undefined ? { rough: p.rough } : {}) }];
    }
  });
}
/** A part turned a quarter clockwise (seen from above) in a `w × d` frame. */
function turnPart(p: PropPart, d: number): PropPart {
  const turned = {
    ...p,
    at: { x: d - p.at.y - p.size.d, y: p.at.x, z: p.at.z },
    size: { w: p.size.d, d: p.size.w, h: p.size.h },
    // A top decal turns with its part: its `turns` undoes this turn when it is painted.
    ...(p.decal ? { decal: { ...p.decal, turns: (p.decal.turns + 1) % 4 } } : {}),
  };
  return p.shape === 'tube'
    ? { ...turned, shape: 'tube', path: p.path.map((q) => ({ x: 1 - q.y, y: q.x, z: q.z })) }
    : turned;
}
/** The model a prop is drawn with, relative to its corner, or null for a plain box. */
export function propModel(
  prop: Pick<IsoProp, 'form' | 'recipe' | 'size' | 'turns'>,
  outline = false,
): PropPart[] | null {
  if (!prop.form && !prop.recipe) return null;
  const turns = (((prop.turns ?? 0) % 4) + 4) % 4;
  // Build in the unturned frame, then turn it into the prop's box.
  let w = turns % 2 ? prop.size.d : prop.size.w;
  let d = turns % 2 ? prop.size.w : prop.size.d;
  let parts = prop.recipe
    ? recipeModel(prop.recipe, w, d, prop.size.h)
    : (BUILDS[prop.form!] as Build<PropForm>)(w, d, prop.size.h, {
        outline,
        spec: furnitureSpec(prop.form!),
      });
  for (let i = 0; i < turns; i++) {
    parts = parts.map((p) => turnPart(p, d));
    [w, d] = [d, w];
  }
  return parts;
}
/** A point on a Bézier curve of 2 to 4 control points. */
function bezierAt(p: IsoVec[], t: number): IsoVec {
  const [x, y, z] = bezier(
    p.map((q): Vec3 => [q.x, q.y, q.z]),
    t,
  );
  return { x, y, z };
}
/** Segments a tube is shown to a camera in: enough that a leaning post reads as a post. */
const TUBE_SEGMENTS = 8;
/**
 * The solids a prop shows a camera: its model's outline parts as boxes
 * and cylinders in scene space (a desk's legs and top, not one block), or
 * the prop itself when it has no model. A tube is a run of short boxes
 * along its curve, not its bounding box: a ladder's leaning rail is a rail,
 * not a slab.
 */
export function propSolids(
  prop: IsoProp,
): { box: IsoBox; shape: IsoProp['shape']; tone: IsoTone; color?: string; decal?: Decal }[] {
  const model = propModel(prop, true);
  if (!model) return [{ box: prop, shape: prop.shape, tone: prop.tone }];
  return model.flatMap((q) => {
    const at = { x: prop.at.x + q.at.x, y: prop.at.y + q.at.y, z: prop.at.z + q.at.z };
    // A recipe part's own colour, where it has one: a camera's picture shows it, not the tone.
    const look = { ...(q.color ? { color: q.color } : {}), tone: q.tone };
    // Its top's print, which a camera sees too; a tube's run of boxes has no top to print.
    const printed = q.decal ? { ...look, decal: q.decal } : look;
    if (q.shape === 'tube' && q.path && q.path.length >= 2 && q.radius) {
      const r = q.radius;
      const control = q.path.map((c) => ({
        x: at.x + c.x * q.size.w,
        y: at.y + c.y * q.size.d,
        z: at.z + c.z * q.size.h,
      }));
      const points = Array.from({ length: TUBE_SEGMENTS + 1 }, (_, i) =>
        bezierAt(control, i / TUBE_SEGMENTS),
      );
      return points.slice(1).map((b, i) => {
        const a = points[i]!;
        const lo = {
          x: Math.min(a.x, b.x) - r,
          y: Math.min(a.y, b.y) - r,
          z: Math.min(a.z, b.z) - r,
        };
        return {
          ...look,
          box: {
            at: { ...lo, z: Math.max(0, lo.z) },
            size: {
              w: Math.max(a.x, b.x) + r - lo.x,
              d: Math.max(a.y, b.y) + r - lo.y,
              h: Math.max(a.z, b.z) + r - Math.max(0, lo.z),
            },
          },
          shape: 'prism' as const,
        };
      });
    }
    return [
      {
        ...printed,
        box: { at, size: q.size },
        shape: q.shape === 'lathe' ? ('cylinder' as const) : ('prism' as const),
      },
    ];
  });
}
