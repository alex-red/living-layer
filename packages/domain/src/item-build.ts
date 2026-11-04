/**
 * Building a Thing's model in code: part builders, pixel art as decal paint,
 * and paint put on the face the room sees, so a model made by hand (a cat
 * asleep on its tree) looks as it was drawn. `bun run model <file>.ts` draws
 * a module whose default export is such a model; `bun run thing set` saves it.
 *
 * All in the item's own frame before its turns: the room sees its +y side on
 * the left, its +x side on the right, and the corner between them in front.
 */
import {
  DECAL_CHARS,
  isoItemSchema,
  MAX_ITEM_PARTS,
  type Decal,
  type IsoItem,
  type ItemMaterial,
  type ItemPart,
  type Paint,
} from './iso-item.js';

type Vec3 = readonly [number, number, number];
/** What every part shares: its colour, and optionally its material and paint. */
interface PartLook {
  color: string;
  material?: ItemMaterial;
  paint?: Paint[];
}
const STRAIGHT = [
  { r: 1, z: 0 },
  { r: 1, z: 1 },
];
function base(id: string, at: Vec3, size: Vec3, look: PartLook) {
  return {
    id,
    at: { x: at[0], y: at[1], z: at[2] },
    size: { w: size[0], d: size[1], h: size[2] },
    color: look.color,
    taper: 1,
    ...(look.material ? { material: look.material } : {}),
    ...(look.paint?.length ? { paint: look.paint } : {}),
  };
}

/** A box with rounded edges: `radius` is a share of its smallest side (0 to 0.5). */
export function rbox(
  id: string,
  at: Vec3,
  size: Vec3,
  look: PartLook & { radius?: number },
): ItemPart {
  return { ...base(id, at, size, look), shape: 'rbox', radius: look.radius ?? 0 };
}
/** A turned part: straight up by default (a post), or a side profile bottom to top. */
export function lathe(
  id: string,
  at: Vec3,
  size: Vec3,
  look: PartLook & {
    profile?: { r: number; z: number }[];
    /** An open top with walls this thick, as a share of the radius (a bed, a cup). */
    wall?: number;
  },
): ItemPart {
  return {
    ...base(id, at, size, look),
    shape: 'lathe',
    profile: look.profile ?? STRAIGHT,
    ...(look.wall !== undefined ? { wall: look.wall } : {}),
  };
}
/** A soft rounded lump: a cat's body or head, a cushion. */
export function blob(
  id: string,
  at: Vec3,
  size: Vec3,
  look: PartLook & { rough?: number },
): ItemPart {
  return {
    ...base(id, at, size, look),
    shape: 'blob',
    ...(look.rough !== undefined ? { rough: look.rough } : {}),
  };
}
/** A tube along a curve of 2 to 4 points, as shares of its box; `radius` in item units. */
export function tube(
  id: string,
  at: Vec3,
  size: Vec3,
  path: Vec3[],
  look: PartLook & { radius?: number },
): ItemPart {
  return {
    ...base(id, at, size, look),
    shape: 'tube',
    path: path.map(([x, y, z]) => ({ x, y, z })),
    ...(look.radius !== undefined ? { radius: look.radius } : {}),
  };
}

/** Pixel art as a decal's pixels: one row per string, top first, each character a colour of `legend`. */
export function pixels(
  rows: readonly string[],
  legend: Readonly<Record<string, string>>,
): Pick<Decal, 'w' | 'h' | 'colors' | 'data'> {
  const keys = Object.keys(legend);
  if (keys.length > DECAL_CHARS.length)
    throw new Error(`A decal has at most ${DECAL_CHARS.length} colours.`);
  const w = Math.max(...rows.map((r) => r.length));
  const data = rows
    .map((row) =>
      [...row.padEnd(w, '.')]
        .map((ch) => {
          if (ch === '.' || ch === ' ') return '.';
          const i = keys.indexOf(ch);
          if (i < 0) throw new Error(`"${ch}" is not in the legend (${keys.join(', ')}).`);
          return DECAL_CHARS[i];
        })
        .join(''),
    )
    .join('');
  return { w, h: rows.length, colors: keys.map((k) => legend[k]!), data };
}

/** The sides of a part the room sees: `front` spans both, the corner between them in its middle. */
export type Face = 'left' | 'right' | 'front';
/** Where each face runs around a part (`u`), from its edge on screen right to its edge on screen left. */
const FACE_U: Record<Face, [number, number]> = {
  right: [0.25, 0.5],
  left: [0.5, 0.75],
  front: [0.25, 0.75],
};
/**
 * Pixel art painted on a face the room sees, as it is drawn: its first
 * column on the screen's left, its first row at the top. `across` is the
 * share of the face's width it covers from its left edge on screen, `up`
 * the share of the part's height from its bottom. Around a part, decal
 * columns run right to left on screen, so the art is mirrored into them.
 */
export function faceDecal(
  face: Face,
  art: Pick<Decal, 'w' | 'h' | 'colors' | 'data'>,
  place: { across?: [number, number]; up?: [number, number] } = {},
): Decal {
  const [lo, hi] = FACE_U[face];
  const [a, b] = place.across ?? [0, 1];
  const [v0, v1] = place.up ?? [0, 1];
  let data = '';
  for (let r = 0; r < art.h; r++)
    data += [...art.data.slice(r * art.w, (r + 1) * art.w)].reverse().join('');
  return {
    kind: 'decal',
    face: 'around',
    u0: hi - b * (hi - lo),
    u1: hi - a * (hi - lo),
    v0,
    v1,
    turns: 0,
    w: art.w,
    h: art.h,
    colors: art.colors,
    data,
  };
}

/** The top of a part or of several, in item units. */
export function topOf(parts: ItemPart | readonly ItemPart[]): number {
  return Math.max(...(Array.isArray(parts) ? parts : [parts]).map((p) => p.at.z + p.size.h));
}
/** The parts moved up or down together so the lowest stands at `z`: a cat set into its bed. */
export function restOn(parts: readonly ItemPart[], z: number): ItemPart[] {
  const dz = z - Math.min(...parts.map((p) => p.at.z));
  return parts.map((p) => ({ ...p, at: { ...p.at, z: p.at.z + dz } }));
}
/** The parts grown or shrunk together by `k` about a point, which stays where it is. */
export function scaleAbout(
  parts: readonly ItemPart[],
  k: number,
  pivot: { x: number; y: number; z: number },
): ItemPart[] {
  return parts.map((p) => {
    const scaled = {
      ...p,
      at: {
        x: pivot.x + (p.at.x - pivot.x) * k,
        y: pivot.y + (p.at.y - pivot.y) * k,
        z: pivot.z + (p.at.z - pivot.z) * k,
      },
      size: { w: p.size.w * k, d: p.size.d * k, h: p.size.h * k },
    };
    return p.shape === 'tube' && p.radius !== undefined
      ? ({ ...scaled, radius: p.radius * k } as ItemPart)
      : (scaled as ItemPart);
  });
}
/** The parts as a checked model, or why not, by part. */
export function buildModel(label: string, parts: readonly ItemPart[]): IsoItem {
  if (parts.length > MAX_ITEM_PARTS)
    throw new Error(`${label} has ${parts.length} parts; a model holds ${MAX_ITEM_PARTS}.`);
  const ids = parts.map((p) => p.id).filter((id, i, all) => all.indexOf(id) !== i);
  if (ids.length) throw new Error(`${label} names more than one part ${ids[0]}.`);
  const checked = isoItemSchema.safeParse({ label, parts });
  if (!checked.success) {
    const issue = checked.error.issues[0]!;
    const at = issue.path[0] === 'parts' ? parts[Number(issue.path[1])]?.id : undefined;
    throw new Error(
      `${label}${at ? `, part ${at}` : ''}: ${issue.message} (${issue.path.join('.')})`,
    );
  }
  return checked.data;
}
