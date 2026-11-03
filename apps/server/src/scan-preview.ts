import sharp from 'sharp';
import type { Detection, MappedThing } from '@livinglayer/domain';

/**
 * Pictures of a scan as it goes, for the page's step-by-step dialog: what
 * Spark listed, what SAM outlined, and where each thing was placed, each
 * drawn over the photo the scan looked at.
 */
type Frame = { width: number; height: number };

const COLORS = ['#6fd3e0', '#e68cc4', '#86d9aa', '#ffb866', '#ae9bf5', '#f27c83'];
const colorOf = (i: number) => COLORS[i % COLORS.length]!;
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function over(png: Buffer, frame: Frame, shapes: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}">${shapes}</svg>`;
  return sharp(png)
    .resize(frame.width, frame.height, { fit: 'fill' })
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
}
/** Sizes that read the same on any frame. */
function scaleOf(frame: Frame) {
  const k = Math.max(frame.width, frame.height) / 640;
  return {
    stroke: Math.max(2, Math.round(2 * k)),
    font: Math.round(13 * k),
    pad: Math.round(4 * k),
  };
}
function tag(x: number, y: number, text: string, color: string, frame: Frame) {
  const { font, pad } = scaleOf(frame);
  const w = Math.round(text.length * font * 0.62) + pad * 2;
  const h = font + pad * 2;
  const left = Math.max(0, Math.min(x, frame.width - w));
  const top = Math.max(0, Math.min(y - h, frame.height - h));
  return (
    `<rect x="${left}" y="${top}" width="${w}" height="${h}" rx="${pad / 2}" fill="rgb(10 12 18 / 0.78)"/>` +
    `<text x="${left + pad}" y="${top + pad + font * 0.85}" font-family="Menlo, monospace" font-size="${font}" fill="${color}">${escape(text)}</text>`
  );
}

/** Spark's loose boxes, with what it called each thing. */
type Listed = { label: string; box: { x1: number; y1: number; x2: number; y2: number } };
export function listedPreview(png: Buffer, frame: Frame, things: Listed[]) {
  const { stroke } = scaleOf(frame);
  const shapes = things
    .map((t, i) => {
      const x = (Math.min(t.box.x1, t.box.x2) / 1000) * frame.width;
      const y = (Math.min(t.box.y1, t.box.y2) / 1000) * frame.height;
      const w = (Math.abs(t.box.x2 - t.box.x1) / 1000) * frame.width;
      const h = (Math.abs(t.box.y2 - t.box.y1) / 1000) * frame.height;
      const c = colorOf(i);
      return (
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${c}" stroke-width="${stroke}" stroke-dasharray="${stroke * 4} ${stroke * 3}"/>` +
        tag(x, y, t.label, c, frame)
      );
    })
    .join('');
  return over(png, frame, shapes);
}

/** SAM's outlines, filled, each in its thing's colour; a thing it missed has none. */
export function outlinedPreview(
  png: Buffer,
  frame: Frame,
  labels: string[],
  outlined: (Detection | null)[],
) {
  const { stroke } = scaleOf(frame);
  const shapes = outlined
    .map((d, i) => {
      if (!d) return '';
      const c = colorOf(i);
      const sx = d.box.width / d.mask.width;
      const sy = d.box.height / d.mask.height;
      return (
        `<path transform="translate(${d.box.x} ${d.box.y}) scale(${sx} ${sy})" d="${d.mask.svgPath}" fill="${c}" fill-opacity="0.38" stroke="${c}" stroke-width="${stroke / Math.max(sx, sy)}" fill-rule="evenodd"/>` +
        tag(d.box.x, d.box.y, labels[i] ?? '', c, frame)
      );
    })
    .join('');
  return over(png, frame, shapes);
}

const MATCH_COLOR: Record<MappedThing['match'], string> = {
  existing: '#6fd3e0',
  library: '#ae9bf5',
  fitted: '#86d9aa',
  placeholder: '#ffb866',
  dismissed: '#7c8299',
  new: '#7c8299',
};
/** Where each thing touched down, marked with how it was mapped. */
export function placedPreview(png: Buffer, frame: Frame, mapped: MappedThing[]) {
  const { stroke, font } = scaleOf(frame);
  const r = Math.round(font * 0.55);
  const shapes = mapped
    .map((m) => {
      if (!m.seen) return '';
      const x = m.seen.foot.x * frame.width;
      const y = m.seen.foot.y * frame.height;
      const c = MATCH_COLOR[m.match];
      const skipped = !m.fixture && !m.moveTo && m.match !== 'existing';
      return (
        `<circle cx="${x}" cy="${y}" r="${r}" fill="${skipped ? 'none' : c}" stroke="${c}" stroke-width="${stroke}"/>` +
        tag(x + r * 1.6, y + font * 0.6, m.label, c, frame)
      );
    })
    .join('');
  return over(png, frame, shapes);
}
