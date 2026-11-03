import type { IsoItem, ItemPart } from './iso-item.js';

/** A panel is this thin against its width and height, at most. */
const THIN = 0.2;
/** Panels this near the biggest one's size are the same screen's layers: bezel, glass. */
const LAYER = 0.6;

/**
 * Which part of a model is its screen: one named `screen`, else the
 * frontmost of its biggest thin upright panels, front being away from the
 * rest of it (the stand and the housing behind). A model Spark drew names
 * its parts as it likes. Null when it has no such panel.
 */
export function screenPart(item: Pick<IsoItem, 'parts'>): string | null {
  if (item.parts.some((p) => p.id === 'screen')) return 'screen';
  const panels = item.parts.flatMap((p): { p: ItemPart; axis: 'x' | 'y'; area: number }[] => {
    const { w, d, h } = p.size;
    // Thin along x, it faces along x; thin along y, along y.
    if (w <= THIN * Math.min(d, h)) return [{ p, axis: 'x', area: d * h }];
    if (d <= THIN * Math.min(w, h)) return [{ p, axis: 'y', area: w * h }];
    return [];
  });
  const biggest = panels.sort((a, b) => b.area - a.area)[0];
  if (!biggest) return null;
  const { axis } = biggest;
  const layers = panels.filter((x) => x.axis === axis && x.area >= biggest.area * LAYER);
  const ids = new Set(layers.map((x) => x.p.id));
  const middle = (p: ItemPart) => (axis === 'x' ? p.at.x + p.size.w / 2 : p.at.y + p.size.d / 2);
  const rest = item.parts.filter((p) => !ids.has(p.id));
  const volume = (p: ItemPart) => p.size.w * p.size.d * p.size.h;
  const weight = rest.reduce((s, p) => s + volume(p), 0);
  const behind = weight ? rest.reduce((s, p) => s + middle(p) * volume(p), 0) / weight : 0;
  // With nothing behind it, its own side toward +x or +y is the front, as a model faces.
  const front = !weight || middle(biggest.p) >= behind ? 1 : -1;
  return layers.sort((a, b) => front * (middle(b.p) - middle(a.p)))[0]!.p.id;
}
