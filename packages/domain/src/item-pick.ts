import type { IsoScreen } from './iso.js';
import type { IsoItem } from './iso-item.js';
import { renderSprite, voxelize } from './iso-voxel.js';
import { detailResolution, ITEM_SPRITES } from './sprite-presets.js';

/** Fewest of a part's pixels a stroke covers to count, unless it covers most of a small part. */
const MIN_COVERED_PX = 4;

/** How far a point is from a stroke's line, in its own units. */
function distanceToStroke(stroke: readonly IsoScreen[], sx: number, sy: number): number {
  let best = Infinity;
  for (let i = 0; i < stroke.length; i++) {
    const a = stroke[i]!;
    const b = stroke[Math.min(i + 1, stroke.length - 1)]!;
    const dx = b.sx - a.sx;
    const dy = b.sy - a.sy;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((sx - a.sx) * dx + (sy - a.sy) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(sx - (a.sx + t * dx), sy - (a.sy + t * dy)));
  }
  return best;
}

/**
 * The parts a brush stroke covers on a model as the editor draws it (item
 * space at the origin, `scale` tiles per unit), most covered first. The
 * stroke is in iso pixels, `radius` wide either side. Only what shows counts:
 * a part hidden behind another isn't picked through it.
 */
export function partsUnder(
  item: IsoItem,
  stroke: readonly IsoScreen[],
  radius: number,
  {
    scale = ITEM_SPRITES.editor.scale,
    resolution = ITEM_SPRITES.editor.resolution,
  }: { scale?: number; resolution?: number } = {},
): string[] {
  if (!stroke.length || !item.parts.length) return [];
  const s = renderSprite(
    voxelize(item.parts, { resolution: detailResolution(item.parts, resolution) }),
    { scale, finish: 'clean', shadow: false },
  );
  const shown = new Array<number>(item.parts.length).fill(0);
  const covered = new Array<number>(item.parts.length).fill(0);
  const xs = stroke.map((p) => p.sx);
  const ys = stroke.map((p) => p.sy);
  const toPx = (v: number, from: number) => (v - from) / s.pixel;
  const x0 = Math.max(0, Math.floor(toPx(Math.min(...xs) - radius, s.x)));
  const x1 = Math.min(s.width - 1, Math.ceil(toPx(Math.max(...xs) + radius, s.x)));
  const y0 = Math.max(0, Math.floor(toPx(Math.min(...ys) - radius, s.y)));
  const y1 = Math.min(s.height - 1, Math.ceil(toPx(Math.max(...ys) + radius, s.y)));
  for (let p = 0; p < s.owner.length; p++) if (s.owner[p]! >= 0) shown[s.owner[p]!]!++;
  for (let py = y0; py <= y1; py++)
    for (let px = x0; px <= x1; px++) {
      const part = s.owner[px + py * s.width]!;
      if (part < 0) continue;
      const sx = s.x + (px + 0.5) * s.pixel;
      const sy = s.y + (py + 0.5) * s.pixel;
      if (distanceToStroke(stroke, sx, sy) <= radius) covered[part]!++;
    }
  return item.parts
    .map((p, i) => ({ id: p.id, covered: covered[i]!, shown: shown[i]! }))
    .filter((p) => p.covered >= Math.min(MIN_COVERED_PX, Math.ceil(p.shown / 2)) && p.covered > 0)
    .sort((a, b) => b.covered - a.covered)
    .map((p) => p.id);
}
