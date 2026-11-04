import { hexRgb, rgbHex } from './color.js';
import type { IsoItem, ItemPart } from './iso-item.js';
import { faceDecal, lathe, pixels, rbox, tube } from './item-build.js';

type P = [number, number, number];

/** A colour darkened (or lightened) by `k`: 0.9 is a tenth darker. */
function dim(hex: string, k: number): string {
  const [r, g, b] = hexRgb(hex);
  return rgbHex([r * k, g * k, b * k]);
}

// The loop's centreline: two straight sides joined by half circles (cubic
// Béziers, their controls 4/3 of the radius out), top and bottom.
const LEFT = 0.12;
const RIGHT = 0.88;
const R = (RIGHT - LEFT) / 2;
const SIDE_LOW = 1.6;
const SIDE_HIGH = 3.18;
/** The loop's half thickness, across. */
const T = 0.08;
/** The arcs' tubes, back to front: close enough that they don't show as ribs in the room. */
const DEPTH = [0.37, 0.435, 0.5, 0.565, 0.63];
/** The loop's front face. */
const FRONT = 0.71;
/** How far in from the loop's outer edge its air slot runs. */
const SLOT_IN = T - 0.035;

/** A tube along control points (x, z) at depth y, its box padded by its radius. */
function curve(
  id: string,
  points: [number, number][],
  y: number,
  r: number,
  color: string,
  material?: 'gloss',
): ItemPart {
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  const x0 = Math.min(...xs) - r;
  const z0 = Math.min(...zs) - r;
  const w = Math.max(...xs) + r - x0;
  const h = Math.max(...zs) + r - z0;
  const path: P[] = points.map(([x, z]) => [(x - x0) / w, 0.5, (z - z0) / h]);
  return tube(id, [x0, y - r, z0], [w, 2 * r, h], path, {
    color,
    radius: r,
    ...(material ? { material } : {}),
  });
}

/** A half circle of the loop: up from the sides' tops, or down from their bottoms. */
const arc = (z: number, up: 1 | -1, inset = 0): [number, number][] => {
  const k = (4 / 3) * (R + inset);
  return [
    [LEFT - inset, z],
    [LEFT - inset, z + up * k],
    [RIGHT + inset, z + up * k],
    [RIGHT + inset, z],
  ];
};

/** The round sensor on the collar's front. */
const SENSOR = pixels(['.eee.', 'eeeee', 'ee#ee', 'eeeee', '.eee.'], {
  e: '#25252b',
  '#': '#5a5a66',
});

/**
 * A Dyson-style bladeless tower fan, about 28 × 28 × 102 cm: a perforated
 * base on a darker plinth, a collar with its round sensor in front, and an
 * open loop above, deep front to back, with a dark air slot round its front
 * face. One unit is its width. The loop lies across x, so its face looks
 * along +y, the side the room sees on its left. `colors` are the loop, then
 * the base.
 */
export function dysonFanItem(label = 'Dyson Fan', colors: string[] = []): IsoItem {
  const loop = colors[0] ?? '#e9e8ec';
  const silver = colors[1] ?? '#aeaeb6';
  const loopShade = dim(loop, 0.91);
  const slot = '#2b2b31';
  const metal = { material: 'metal' as const };
  const gloss = { material: 'gloss' as const };
  const side = (id: string, x: number, color: string) =>
    rbox(id, [x - T, 0.29, SIDE_LOW], [2 * T, 0.42, SIDE_HIGH - SIDE_LOW], {
      ...gloss,
      color,
      radius: 0.5,
    });
  const slotSide = (id: string, x: number) =>
    rbox(id, [x, FRONT - 0.02, SIDE_LOW], [0.05, 0.035, SIDE_HIGH - SIDE_LOW], { color: slot });
  // The front tube catches the light; those behind it are a shade darker.
  const tone = (i: number) => (i === DEPTH.length - 1 ? loop : loopShade);
  return {
    label,
    parts: [
      lathe('plinth', [0.08, 0.08, 0], [0.84, 0.84, 0.1], { ...metal, color: dim(silver, 0.68) }),
      lathe('body', [0.09, 0.09, 0.1], [0.82, 0.82, 0.76], {
        ...metal,
        color: silver,
        paint: [{ kind: 'dots', count: 18, rows: 9, size: 0.35, color: dim(silver, 0.8) }],
      }),
      lathe('collar', [0.1, 0.1, 0.86], [0.8, 0.8, 0.16], {
        ...metal,
        color: dim(silver, 1.12),
        profile: [
          { r: 1, z: 0 },
          { r: 0.97, z: 0.6 },
          { r: 0.86, z: 1 },
        ],
        paint: [faceDecal('left', SENSOR, { across: [0.38, 0.62], up: [0.15, 0.85] })],
      }),
      lathe('neck', [0.25, 0.3, 1.0], [0.5, 0.4, 0.22], {
        ...gloss,
        color: loopShade,
        profile: [
          { r: 1, z: 0 },
          { r: 0.7, z: 1 },
        ],
      }),
      side('side-left', LEFT, loopShade),
      side('side-right', RIGHT, loop),
      ...DEPTH.map((y, i) => curve(`top-${i}`, arc(SIDE_HIGH, 1), y, T, tone(i), 'gloss')),
      ...DEPTH.map((y, i) => curve(`bottom-${i}`, arc(SIDE_LOW, -1), y, T, tone(i), 'gloss')),
      slotSide('slot-left', LEFT - T + 0.01),
      slotSide('slot-right', RIGHT + T - 0.06),
      curve('slot-top', arc(SIDE_HIGH, 1, SLOT_IN), FRONT, 0.025, slot),
      curve('slot-bottom', arc(SIDE_LOW, -1, SLOT_IN), FRONT, 0.025, slot),
    ],
  };
}
