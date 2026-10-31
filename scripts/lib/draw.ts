/** Props drawn into one RGBA picture, as the scene places their sprites. */
import { propModel, renderPropSprite, toIso, type IsoProp } from '@livinglayer/domain';

export interface Picture {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** Model parts drawn, a rough measure of a model's cost. */
  parts: number;
}
/** Props in draw order (back to front), each sprite at its iso position. */
export function drawProps(props: IsoProp[]): Picture {
  const placed = props.map((p) => {
    const s = renderPropSprite(p, false);
    const at = toIso(p.at);
    return { s, x: Math.round(at.sx + s.x), y: Math.round(at.sy + s.y) };
  });
  const x0 = Math.min(...placed.map((p) => p.x)) - 2;
  const y0 = Math.min(...placed.map((p) => p.y)) - 2;
  const width = Math.max(...placed.map((p) => p.x + p.s.width)) - x0 + 2;
  const height = Math.max(...placed.map((p) => p.y + p.s.height)) - y0 + 2;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (const { s, x, y } of placed)
    for (let j = 0; j < s.height; j++)
      for (let i = 0; i < s.width; i++) {
        const from = (j * s.width + i) * 4;
        const a = s.rgba[from + 3]! / 255;
        if (!a) continue;
        const to = ((y - y0 + j) * width + (x - x0 + i)) * 4;
        for (let k = 0; k < 3; k++) rgba[to + k] = s.rgba[from + k]! * a + rgba[to + k]! * (1 - a);
        rgba[to + 3] = Math.max(rgba[to + 3]!, s.rgba[from + 3]!);
      }
  const parts = props.reduce((n, p) => n + (propModel(p)?.length ?? 1), 0);
  return { width, height, rgba, parts };
}
