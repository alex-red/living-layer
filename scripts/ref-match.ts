/**
 * Match the room's tones to a reference picture. A reference is a picture
 * in design/reference/ with a JSON file naming regions of it: which tone each
 * shows and which face (lit top, lit side, or shade). For every region this
 * reads its light, middle and dark colours (percentiles of lightness, so a
 * box that clips an edge doesn't skew it), works out the tone that would
 * draw that face through the kernel's own ramp (`unrampLab`), and compares
 * it with PROP_TONES. It also writes the picture with the regions drawn on,
 * to check that every box sits where it should.
 *
 *   bun run ref office                 → table, and out/ref-office-regions.png
 *   bun run ref office --json out/ref-office.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  PROP_TONES,
  deltaE,
  hexLab,
  labHex,
  rgbLab,
  unrampLab,
  type IsoTone,
  type Lab,
} from '@livinglayer/domain';
import { flag, parseArgs } from './lib/args.js';

interface Reference {
  image: string;
  regions: Record<string, { box: [number, number, number, number]; tone: IsoTone; face: Face }>;
}
type Face = 'top' | 'side' | 'shade';
/** The ramp step a face is drawn with: see `rampLab`. */
const STEP: Record<Face, number> = { top: 3, side: 2, shade: 0 };

const args = parseArgs();
const name = args.positional[0] ?? 'office';
const dir = resolve(import.meta.dir, '..', 'design', 'reference');
const ref = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as Reference;
const { data, info } = await sharp(join(dir, ref.image))
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

/** Light, middle and dark of a region: lightness percentiles 85, 50 and 15. */
function readRegion([x0, y0, x1, y1]: Reference['regions'][string]['box']) {
  const px: Lab[] = [];
  for (let y = Math.floor(y0 * info.height); y < Math.ceil(y1 * info.height); y++)
    for (let x = Math.floor(x0 * info.width); x < Math.ceil(x1 * info.width); x++) {
      const i = (y * info.width + x) * info.channels;
      px.push(rgbLab([data[i]!, data[i + 1]!, data[i + 2]!]));
    }
  if (!px.length) throw new Error(`Empty region ${[x0, y0, x1, y1].join(', ')}`);
  px.sort((a, b) => a[0] - b[0]);
  const at = (q: number) => px[Math.min(px.length - 1, Math.floor(q * px.length))]!;
  return { light: at(0.85), mid: at(0.5), dark: at(0.15), pixels: px.length };
}

const rows = Object.entries(ref.regions).map(([region, r]) => {
  const read = readRegion(r.box);
  // A top is judged by its light end, a side by its middle, a shade by its dark end.
  const target = r.face === 'top' ? read.light : r.face === 'shade' ? read.dark : read.mid;
  const suggested = labHex(unrampLab(target, STEP[r.face]));
  const current = PROP_TONES[r.tone];
  return {
    region,
    tone: r.tone,
    face: r.face,
    light: labHex(read.light),
    mid: labHex(read.mid),
    dark: labHex(read.dark),
    current,
    suggested,
    off: deltaE(hexLab(current), hexLab(suggested)),
  };
});

console.log('region          tone        face   light    mid      dark     current  suggested  ΔE');
for (const r of rows)
  console.log(
    [
      r.region.padEnd(15),
      r.tone.padEnd(11),
      r.face.padEnd(6),
      r.light,
      ' ',
      r.mid,
      ' ',
      r.dark,
      ' ',
      r.current,
      ' ',
      r.suggested,
      '  ',
      r.off.toFixed(1),
      r.off > 6 ? ' ← differs' : '',
    ].join(''),
  );
console.log('\n(ΔE: how far the tone in use is from the one the picture asks for; over 6 shows)');
// Where the same tone is read twice, the regions should agree; a suggestion per tone:
const byTone = new Map<string, string[]>();
for (const r of rows) byTone.set(r.tone, [...(byTone.get(r.tone) ?? []), r.suggested]);
console.log('\nSuggested PROP_TONES entries:');
for (const [tone, hexes] of byTone)
  console.log(
    `  ${tone}: '${hexes[0]}',${hexes.length > 1 ? ` // also ${hexes.slice(1).join(', ')}` : ''}`,
  );

// The picture with every region boxed and named, to check the boxes.
const outDir = resolve(import.meta.dir, '..', 'out');
mkdirSync(outDir, { recursive: true });
const boxes = Object.entries(ref.regions)
  .map(
    ([
      region,
      {
        box: [x0, y0, x1, y1],
      },
    ]) => {
      const [x, y, w, h] = [
        x0 * info.width,
        y0 * info.height,
        (x1 - x0) * info.width,
        (y1 - y0) * info.height,
      ];
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#e68cc4" stroke-width="2"/><text x="${x}" y="${y - 4}" font-family="monospace" font-size="13" fill="#e68cc4">${region}</text>`;
    },
  )
  .join('');
const marked = join(outDir, `ref-${name}-regions.png`);
await sharp(join(dir, ref.image))
  .composite([
    {
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}">${boxes}</svg>`,
      ),
    },
  ])
  .png()
  .toFile(marked);
console.log(`\n→ ${marked}`);
const json = flag(args, 'json');
if (json) {
  writeFileSync(json, JSON.stringify(rows, null, 2));
  console.log(`→ ${json}`);
}
