import { describe, expect, it } from 'bun:test';
import sharp from 'sharp';
import {
  blendUnder,
  cutSprite,
  fillLocally,
  keyBackground,
  outlineFits,
} from '../apps/server/src/layers.js';

/** A black picture with a grey frame drawn on it, black inside the frame like a screen. */
async function framed() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#000"/><rect x="10" y="10" width="20" height="20" fill="#000" stroke="#888" stroke-width="4"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
const alphaAt = async (png: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * 4 + 3]!;
};
const square = (x: number, y: number, size: number, fill = 1) => ({
  objectId: '1',
  confidence: null,
  box: { x, y, width: size, height: size },
  mask: {
    width: size,
    height: size,
    foregroundPixels: Math.round(size * size * fill),
    svgPath: `M0,0L${size},0L${size},${size}L0,${size}Z`,
  },
});

describe('a picture’s layers', () => {
  it('makes the background transparent from the edges in, and keeps black inside a thing', async () => {
    const keyed = await keyBackground(await framed());
    expect(await alphaAt(keyed, 2, 2)).toBe(0);
    expect(await alphaAt(keyed, 20, 20)).toBe(255);
    expect(await alphaAt(keyed, 10, 20)).toBe(255);
  });
  it('cuts a sprite that keeps the picture’s transparency', async () => {
    const keyed = await keyBackground(await framed());
    const cut = await cutSprite(keyed, square(4, 4, 32));
    expect([cut.left, cut.top, cut.width, cut.height]).toEqual([4, 4, 32, 32]);
    // Outside the frame is background even inside the outline; the frame itself is kept.
    expect(await alphaAt(cut.png, 1, 1)).toBe(0);
    expect(await alphaAt(cut.png, 8, 16)).toBe(255);
  });
  it('fills a hole beside the background with the background, not a dark rim', async () => {
    const keyed = await keyBackground(await framed());
    const mask = Buffer.alloc(40 * 40);
    for (let y = 6; y < 34; y++) for (let x = 6; x < 34; x++) mask[y * 40 + x] = 255;
    const filled = await fillLocally(keyed, mask, 40, 40);
    expect(await alphaAt(filled, 20, 20)).toBeLessThan(40);
    // Outside the mask the picture is as it was.
    expect(await alphaAt(filled, 2, 2)).toBe(0);
  });
  it('blends only through the mask', async () => {
    const under = await sharp({
      create: { width: 4, height: 1, channels: 4, background: '#000000ff' },
    })
      .png()
      .toBuffer();
    const over = await sharp({
      create: { width: 4, height: 1, channels: 4, background: '#ffffff00' },
    })
      .png()
      .toBuffer();
    const out = await blendUnder(under, over, Buffer.from([0, 255, 128, 0]), 4, 1);
    expect([await alphaAt(out, 0, 0), await alphaAt(out, 1, 0), await alphaAt(out, 3, 0)]).toEqual([
      255, 0, 255,
    ]);
  });
  it('lifts an outline only when it fills its box and sits where the thing was found', () => {
    const found = { x: 0, y: 0, width: 100, height: 100 };
    expect(outlineFits(square(10, 10, 50), found)).toBe(true);
    expect(outlineFits(square(10, 10, 50, 0.05), found)).toBe(false);
    expect(outlineFits(square(80, 80, 50), found)).toBe(false);
  });
});
