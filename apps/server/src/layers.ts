import sharp from 'sharp';
import { convexHull, type Detection, type Point } from '@livinglayer/domain';
import { detectionBits, maskedCrop, toDataUrl } from './images.js';

/**
 * A fixture's outline when SAM has none: the silhouette of its box as the
 * picture draws it, the hull of its eight corners. Good enough to lift a
 * fixture the demo's picture shows where its box is.
 */
export function hullDetection(points: Point[], id: string): Detection | null {
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  const xs = hull.map((p) => p.x);
  const ys = hull.map((p) => p.y);
  const x = Math.floor(Math.min(...xs));
  const y = Math.floor(Math.min(...ys));
  const width = Math.ceil(Math.max(...xs)) - x;
  const height = Math.ceil(Math.max(...ys)) - y;
  if (width < 2 || height < 2) return null;
  const path = `M${hull.map((p) => `${(p.x - x).toFixed(1)},${(p.y - y).toFixed(1)}`).join('L')}Z`;
  return {
    objectId: id,
    confidence: null,
    box: { x, y, width, height },
    mask: { width, height, foregroundPixels: Math.round(width * height * 0.6), svgPath: path },
  };
}
/**
 * Where the lifted fixtures were, as an alpha mask the size of the picture:
 * their outlines, grown so their outer strokes and shadows go too, and
 * softened so the fill blends in.
 */
export async function liftedMask(
  detections: Detection[],
  width: number,
  height: number,
): Promise<Buffer> {
  const bits = (await detectionBits(detections, width, height)) ?? new Uint8Array(width * height);
  return spreadMask(fillHoles(bits, width, height), width, height);
}

/**
 * An outline with what it encloses: SAM outlines a ring-shaped fan as the
 * ring, but the hole inside it is drawn as part of the fan and has to go
 * from the base with it. Whatever the edges can't reach is inside.
 */
export function fillHoles(bits: Uint8Array, width: number, height: number): Uint8Array {
  const outside = new Uint8Array(width * height);
  const queue: number[] = [];
  const seed = (i: number) => {
    if (!outside[i] && !bits[i]) {
      outside[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    const x = i % width;
    if (x > 0) seed(i - 1);
    if (x < width - 1) seed(i + 1);
    if (i >= width) seed(i - width);
    if (i < width * (height - 1)) seed(i + width);
  }
  return outside.map((o) => (o ? 0 : 1));
}

/** Lifted places as an alpha mask: grown so the outer strokes go too, and softened. */
export async function spreadMask(bits: Uint8Array, width: number, height: number) {
  const grow = Math.max(3, Math.round(Math.max(width, height) * 0.012));
  const raw = Buffer.from(bits.map((b) => (b ? 255 : 0)));
  // A dilation is a max filter: a blur, then anything touched counts.
  const spread = await sharp(raw, { raw: { width, height, channels: 1 } })
    .blur(grow)
    .threshold(8)
    .extractChannel(0)
    .raw()
    .toBuffer();
  return sharp(spread, { raw: { width, height, channels: 1 } })
    .blur(Math.max(1, grow / 2))
    .extractChannel(0)
    .raw()
    .toBuffer();
}

/**
 * The picture with the masked places filled from around them, without a
 * model: each hole is grown inward from its edge on a small copy, where every
 * empty pixel takes the mean of its filled neighbours, then scaled back up
 * and blended in under the mask. Flat line art fills well this way. Colours
 * are averaged weighted by how opaque they are, so a hole beside the
 * transparent background fades out rather than taking a dark rim.
 */
export async function fillLocally(picture: Buffer, mask: Buffer, width: number, height: number) {
  const scale = Math.min(1, 320 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const rgba = await sharp(picture).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer();
  const small = await sharp(mask, { raw: { width, height, channels: 1 } })
    .resize(w, h, { fit: 'fill' })
    .extractChannel(0)
    .raw()
    .toBuffer();
  const known = new Uint8Array(w * h);
  for (let i = 0; i < known.length; i++) known[i] = small[i]! < 24 ? 1 : 0;
  const px = Float32Array.from(rgba);
  let holes: number[] = [];
  for (let i = 0; i < known.length; i++) if (!known[i]) holes.push(i);
  while (holes.length) {
    const next: [number, number, number, number, number][] = [];
    for (const i of holes) {
      const x = i % w;
      const y = (i - x) / w;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!known[j]) continue;
          const o = px[j * 4 + 3]!;
          r += px[j * 4]! * o;
          g += px[j * 4 + 1]! * o;
          b += px[j * 4 + 2]! * o;
          a += o;
          n++;
        }
      if (n) next.push(a ? [i, r / a, g / a, b / a, a / n] : [i, 0, 0, 0, 0]);
    }
    // A picture with nothing known left around a hole can't fill it.
    if (!next.length) break;
    for (const [i, r, g, b, a] of next) {
      px[i * 4] = r;
      px[i * 4 + 1] = g;
      px[i * 4 + 2] = b;
      px[i * 4 + 3] = a;
      known[i] = 1;
    }
    holes = holes.filter((i) => !known[i]);
  }
  const filled = await sharp(Buffer.from(Uint8Array.from(px)), {
    raw: { width: w, height: h, channels: 4 },
  })
    .resize(width, height, { fit: 'fill' })
    .blur(1.2)
    .png()
    .toBuffer();
  return blendUnder(picture, filled, mask, width, height);
}

/**
 * The picture with `fill` shown through the mask, transparency and all: only
 * the lifted places change, so the rest of the base stays the picture it
 * was, pixel for pixel.
 */
export async function blendUnder(
  picture: Buffer,
  fill: Buffer,
  mask: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const [under, over] = await Promise.all([
    sharp(picture).ensureAlpha().raw().toBuffer(),
    sharp(fill).ensureAlpha().resize(width, height, { fit: 'fill' }).raw().toBuffer(),
  ]);
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const m = mask[i]! / 255;
    for (let c = 0; c < 4; c++)
      out[i * 4 + c] = Math.round(under[i * 4 + c]! * (1 - m) + over[i * 4 + c]! * m);
  }
  return sharp(out, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * A drawing's plain background made transparent: the near-black the image
 * model is asked to draw beyond the furniture, flooded in from the edges, so
 * a black screen or a dark gap inside a thing stays. The flood's rim is
 * softened a pixel so outlines keep their antialiasing.
 */
export async function keyBackground(png: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const dark = (i: number) =>
    data[i * 4 + 3]! < 16 ||
    Math.max(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!) <= BACKGROUND_LEVEL;
  const clear = new Uint8Array(width * height);
  const queue: number[] = [];
  const seed = (i: number) => {
    if (!clear[i] && dark(i)) {
      clear[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    const x = i % width;
    if (x > 0) seed(i - 1);
    if (x < width - 1) seed(i + 1);
    if (i >= width) seed(i - width);
    if (i < width * (height - 1)) seed(i + width);
  }
  const keep = await sharp(Buffer.from(clear.map((c) => (c ? 0 : 255))), {
    raw: { width, height, channels: 1 },
  })
    .blur(0.8)
    .extractChannel(0)
    .raw()
    .toBuffer();
  for (let i = 0; i < width * height; i++)
    data[i * 4 + 3] = Math.min(data[i * 4 + 3]!, clear[i] ? 0 : keep[i]!);
  return sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}
/** How dark a pixel may be and still count as the plain background. */
const BACKGROUND_LEVEL = 24;

/** A picture with its transparency laid on the black it was drawn on, for the models that read it. */
export async function onBlack(png: Buffer): Promise<string> {
  const flat = await sharp(png).flatten({ background: '#000000' }).png().toBuffer();
  return toDataUrl(flat);
}

/**
 * A fixture cut out of the picture by its outline, keeping the picture's own
 * transparency, so the background inside the outline stays see-through.
 */
export async function cutSprite(picture: Buffer, outline: Detection) {
  const crop = await maskedCrop(picture, outline);
  const left = Math.max(0, Math.floor(outline.box.x));
  const top = Math.max(0, Math.floor(outline.box.y));
  const own = await sharp(picture)
    .ensureAlpha()
    .extractChannel(3)
    .extract({ left, top, width: crop.width, height: crop.height })
    .raw()
    .toBuffer();
  const rgba = Buffer.from(crop.rgba);
  for (let i = 0; i < crop.width * crop.height; i++)
    rgba[i * 4 + 3] = Math.round((rgba[i * 4 + 3]! * own[i]!) / 255);
  const png = await sharp(rgba, { raw: { width: crop.width, height: crop.height, channels: 4 } })
    .png()
    .toBuffer();
  return { png, width: crop.width, height: crop.height, left, top };
}

/**
 * Whether an outline is the thing it was asked for: it fills a fair share of
 * its own box, and its box sits mostly over where the thing was found. A
 * fixture whose outline isn't stays painted into the base rather than
 * lifting off as scraps.
 */
export function outlineFits(
  outline: Detection,
  expected: { x: number; y: number; width: number; height: number },
): boolean {
  const fill = outline.mask.foregroundPixels / (outline.mask.width * outline.mask.height);
  const b = outline.box;
  const w = Math.min(b.x + b.width, expected.x + expected.width) - Math.max(b.x, expected.x);
  const h = Math.min(b.y + b.height, expected.y + expected.height) - Math.max(b.y, expected.y);
  const inside = (Math.max(0, w) * Math.max(0, h)) / (b.width * b.height);
  return fill >= MIN_FILL && inside >= MIN_INSIDE;
}
const MIN_FILL = 0.18;
const MIN_INSIDE = 0.6;

/**
 * What the image model is asked for: the same picture with only its core
 * furniture, every fixture and small thing taken away, so the fixtures can
 * be drawn over it wherever they are moved.
 */
export function basePrompt(labels: string[]): string {
  return (
    'Redraw this exact illustration with only the core furniture: the desk, chairs, shelves, ' +
    'drawers, cabinets and other large furniture, all bare and empty. Remove every object on or ' +
    `around them, including ${labels.map((l) => `the ${l.toLowerCase()}`).join(', ')}, and every ` +
    'other small thing, and continue the surfaces they stood on plainly. Keep the furniture ' +
    'exactly where it is, with the same shapes, sizes, colours, line style, viewpoint and framing. ' +
    'Plain black background, no text, no labels.'
  );
}
