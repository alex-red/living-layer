import sharp from 'sharp';
import { join } from 'node:path';

// logo.svg is the source. Regenerate the browser and home-screen assets after editing it.
const publicDir = join(import.meta.dir, '../apps/web/public');
const source = await Bun.file(join(publicDir, 'logo.svg')).text();
const tile = source.replace(
  /(<svg[^>]*>)/,
  '$1<rect width="64" height="64" rx="14" fill="#11141d"/>',
);
await Bun.write(join(publicDir, 'favicon.svg'), tile);
await Bun.write(
  join(publicDir, 'logo-wordmark.svg'),
  source
    .replace('viewBox="0 0 64 64"', 'viewBox="0 0 308 64"')
    .replace(
      '</svg>',
      '<text x="78" y="41" fill="#ece9f2" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="34" font-weight="600" letter-spacing="-1">Living Layer</text></svg>',
    ),
);

for (const [name, size] of [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
] as const) {
  // A full bleed dark background lets each OS supply its own icon shape.
  await sharp(Buffer.from(source))
    .resize(size, size)
    .flatten({ background: '#11141d' })
    .png()
    .toFile(join(publicDir, name));
}

// ICO wraps PNG entries, supported by modern browsers and Windows shortcuts.
const sizes = [16, 32, 48];
const entries = await Promise.all(
  sizes.map((size) => sharp(Buffer.from(tile)).resize(size, size).png().toBuffer()),
);
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [i, png] of entries.entries()) {
  const entry = 6 + i * 16;
  header[entry] = sizes[i]!;
  header[entry + 1] = sizes[i]!;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
await Bun.write(join(publicDir, 'favicon.ico'), Buffer.concat([header, ...entries]));
console.log('Updated logo wordmark, favicon and home-screen icons from logo.svg.');
