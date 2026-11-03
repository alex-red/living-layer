import sharp, { type Sharp } from 'sharp';
import { MAX_IMAGE_PIXELS, type Detection } from '@livinglayer/domain';
import { LabError } from './errors.js';

export interface ValidatedImage {
  /** The frame as stored and as sent to Spark: lossless WebP (PNG when `FRAME_FORMAT=png`). */
  dataUrl: string;
  bytes: Buffer;
  width: number;
  height: number;
  /** The extension `bytes` should be stored under. */
  ext: FrameExt;
}

export type FrameExt = 'webp' | 'png';
/**
 * How stored frames are encoded. Lossless WebP keeps every decoded pixel (SAM
 * and the fitter see what they saw as PNG) in about 30% fewer bytes; effort 1
 * is the knee (effort 4 is as small but slower).
 */
export const frameExt = (): FrameExt => (process.env.FRAME_FORMAT === 'png' ? 'png' : 'webp');
export function encodeFrame(image: Sharp, ext: FrameExt = frameExt()) {
  return (ext === 'png' ? image.png() : image.webp({ lossless: true, effort: 1 })).toBuffer({
    resolveWithObject: true,
  });
}
/** The media type of image bytes, from their signature (old evidence is PNG). */
export function mediaTypeOf(bytes: Buffer): 'image/webp' | 'image/png' | 'image/jpeg' {
  if (bytes.length > 12 && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/png';
}
export const toDataUrl = (bytes: Buffer) =>
  `data:${mediaTypeOf(bytes)};base64,${bytes.toString('base64')}`;
/**
 * The frame as a PNG data URL, for SAM. Meta documents WebP for image input
 * but says nothing of SAM's, so SAM still gets PNG, converted at send time.
 */
export async function samDataUrl(image: Pick<ValidatedImage, 'bytes'>): Promise<string> {
  const png =
    mediaTypeOf(image.bytes) === 'image/png'
      ? image.bytes
      : await sharp(image.bytes).png().toBuffer();
  return toDataUrl(png);
}
/**
 * Refuse, with 409 `not_calibrated`, a frame that isn't the size the room's
 * camera was calibrated on. `message` replaces the usual wording.
 */
export function requireFrame(
  image: { width: number; height: number },
  frame: { width: number; height: number },
  message?: string,
) {
  if (image.width !== frame.width || image.height !== frame.height)
    throw new LabError(
      'not_calibrated',
      message ??
        `This frame is ${image.width} × ${image.height}, but the room’s camera was calibrated on ${frame.width} × ${frame.height} frames.`,
      409,
    );
}
/**
 * The size of a PNG that SAM can take just as it came: one page, nothing to
 * orient, so its pixels are the ones `validateImage` stores. Null for anything
 * else, which goes through `samDataUrl`. Reads only the header.
 */
export async function samReadyPng(
  dataUrl: string | undefined,
): Promise<{ width: number; height: number } | null> {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl ?? '');
  if (!match) return null;
  try {
    const meta = await sharp(Buffer.from(match[1]!, 'base64')).metadata();
    const { width, height } = meta;
    return meta.format === 'png' &&
      (meta.pages ?? 1) === 1 &&
      (meta.orientation ?? 1) === 1 &&
      width &&
      height &&
      width * height <= MAX_IMAGE_PIXELS
      ? { width, height }
      : null;
  } catch {
    return null;
  }
}
/** The stored source photo among a run's assets: `source.webp`, or `source.png` on older runs. */
export const findSource = (assets: string[]) => assets.find((a) => /\/source\.(webp|png)$/.test(a));

export async function validateImage(dataUrl?: string): Promise<ValidatedImage> {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl ?? '');
  if (!match)
    throw new LabError(
      'image_required',
      'Capture or upload a PNG/JPEG/WebP image before making a live request.',
    );
  const input = Buffer.from(match[2]!, 'base64');
  if (input.length > 5_000_000 || input.length < 12)
    throw new LabError('image_size', 'Use an image smaller than 5 MB.');
  try {
    const image = sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' });
    const meta = await image.metadata();
    if (
      !meta.width ||
      !meta.height ||
      (meta.pages ?? 1) !== 1 ||
      !['png', 'jpeg', 'webp'].includes(meta.format ?? '')
    )
      throw new Error('Unsupported image');
    // Decode, orient, and strip metadata once so model and overlay see identical source pixels.
    const ext = frameExt();
    const { data: bytes, info } = await encodeFrame(image.rotate(), ext);
    return { bytes, width: info.width, height: info.height, ext, dataUrl: toDataUrl(bytes) };
  } catch {
    throw new LabError(
      'invalid_image',
      'The image could not be decoded. Use a single PNG/JPEG with at most four million pixels.',
    );
  }
}

/**
 * The detection's pixels only: the source cropped to its box, with SAM's mask
 * as alpha. Returns the raw RGBA for colour sampling and a PNG to show a model.
 */
export async function maskedCrop(source: Buffer, detection: Detection) {
  const meta = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  const left = Math.max(0, Math.floor(detection.box.x));
  const top = Math.max(0, Math.floor(detection.box.y));
  const width = Math.min(meta.width! - left, Math.ceil(detection.box.width));
  const height = Math.min(meta.height! - top, Math.ceil(detection.box.height));
  if (width < 2 || height < 2)
    throw new LabError('item_crop', 'The detection is too small to sample.');
  const { mask } = detection;
  const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${mask.width} ${mask.height}" preserveAspectRatio="none"><path d="${mask.svgPath.replace(/[^MLHVZmlhvz0-9.,\s-]/g, '')}" fill="#fff" fill-rule="evenodd"/></svg>`;
  const alpha = await sharp(Buffer.from(maskSvg)).extractChannel('alpha').raw().toBuffer();
  // Cut the RGB first: sharp would otherwise apply removeAlpha after the join.
  const rgb = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS })
    .extract({ left, top, width, height })
    .removeAlpha()
    .raw()
    .toBuffer();
  const crop = sharp(rgb, { raw: { width, height, channels: 3 } }).joinChannel(alpha, {
    raw: { width, height, channels: 1 },
  });
  const rgba = await crop.clone().raw().toBuffer();
  const png = await crop.png().toBuffer();
  return { rgba, png, width, height };
}

/**
 * SAM detections on a crop as one 0/1 mask of the crop's size: each
 * detection's path is drawn into its box. Used for part masks (a handle, a
 * liquid) that guide the item fitter.
 */
export async function detectionBits(
  detections: Detection[],
  width: number,
  height: number,
): Promise<Uint8Array | null> {
  if (!detections.length) return null;
  const clean = (d: string) => d.replace(/[^MLHVZmlhvz0-9.,\s-]/g, '');
  const shapes = detections
    .map(
      ({ box, mask }) =>
        `<g transform="translate(${box.x} ${box.y}) scale(${box.width / mask.width} ${box.height / mask.height})"><path d="${clean(mask.svgPath)}" fill="#fff" fill-rule="evenodd"/></g>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${shapes}</svg>`;
  const alpha = await sharp(Buffer.from(svg)).extractChannel('alpha').raw().toBuffer();
  const bits = new Uint8Array(width * height);
  for (let i = 0; i < bits.length; i++) bits[i] = alpha[i]! >= 128 ? 1 : 0;
  return bits;
}
