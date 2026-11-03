import { printKey, type Ink, type Print } from '@livinglayer/domain';
import sharp from 'sharp';

/**
 * Prints set in type, for the decals that draw them (`printDecal`). The
 * fonts are whatever this machine has, asked for by family with generic
 * fallbacks: the letters only need to read as the print's kind of lettering
 * at a few dozen pixels.
 */
const FAMILIES: Record<Print['style'], { family: string; weight: number; italic?: boolean }> = {
  script: {
    family: "'Brush Script MT', 'Snell Roundhand', 'Segoe Script', 'Dancing Script', cursive",
    weight: 700,
  },
  sans: { family: "'Helvetica Neue', Helvetica, Arial, 'DejaVu Sans', sans-serif", weight: 600 },
  serif: { family: "Georgia, 'Times New Roman', 'DejaVu Serif', serif", weight: 600 },
  bold: { family: "'Arial Black', 'Helvetica Neue', Arial, sans-serif", weight: 900 },
};
/** Pixels per line of type: much finer than any decal, which samples it down. */
const LINE_PX = 96;

const escape = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** One print's ink, cropped to its letters (and underline). */
async function inkOf(print: Pick<Print, 'text' | 'style' | 'underline'>): Promise<Ink | null> {
  const lines = print.text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!lines.length) return null;
  const font = FAMILIES[print.style];
  const longest = Math.max(...lines.map((l) => l.length));
  const width = Math.ceil(LINE_PX * 0.75 * longest + LINE_PX);
  const lineGap = LINE_PX * (print.style === 'script' ? 0.95 : 1.1);
  const height = Math.ceil(lineGap * lines.length + LINE_PX * (print.underline ? 1 : 0.6));
  // A script logo staggers its lines, each starting a little further right.
  const step = print.style === 'script' ? LINE_PX * 0.2 : 0;
  const text = lines
    .map(
      (l, i) =>
        `<text x="${LINE_PX * 0.3 + step * i}" y="${LINE_PX * 0.95 + lineGap * i}">${escape(l)}</text>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g font-family="${font.family}" font-size="${LINE_PX}" font-weight="${font.weight}" fill="#000">${text}</g></svg>`;
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .extractChannel(3)
    .trim({ threshold: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // An underline runs under the letters' right three quarters, rising a little.
  const below = print.underline ? Math.round(LINE_PX * 0.3) : 0;
  const w = info.width;
  const h = info.height + below;
  const coverage = new Float32Array(w * h);
  for (let i = 0; i < info.width * info.height; i++) coverage[i] = data[i]! / 255;
  if (below) {
    const thick = LINE_PX * 0.07;
    const [x0, x1] = [w * 0.3, w * 0.97];
    const [y0, y1] = [h - thick * 1.5, h - below * 0.75];
    for (let y = info.height; y < h; y++)
      for (let x = Math.floor(x0); x < x1; x++) {
        const lineY = y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
        coverage[y * w + x] = Math.max(0, Math.min(1, thick - Math.abs(y + 0.5 - lineY)));
      }
  }
  return { width: w, height: h, coverage };
}

/** Each print's ink, by `printKey`; a print that sets as nothing is left out. */
export async function inkPrints(prints: Iterable<Print>): Promise<Map<string, Ink>> {
  const inks = new Map<string, Ink>();
  for (const p of prints) {
    const key = printKey(p);
    if (inks.has(key)) continue;
    const ink = await inkOf(p).catch(() => null);
    if (ink) inks.set(key, ink);
  }
  return inks;
}
