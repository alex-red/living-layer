import sharp from 'sharp';
import { MAX_IMAGE_PIXELS, type Detection } from '@livinglayer/domain';
import { LabError } from './errors.js';

export interface ValidatedImage {
  dataUrl: string;
  bytes: Buffer;
  width: number;
  height: number;
}

export async function validateImage(dataUrl?: string): Promise<ValidatedImage> {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl ?? '');
  if (!match)
    throw new LabError(
      'image_required',
      'Capture or upload a PNG/JPEG image before making a live request.',
    );
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.length > 5_000_000 || bytes.length < 12)
    throw new LabError('image_size', 'Use an image smaller than 5 MB.');
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' });
    const meta = await image.metadata();
    if (
      !meta.width ||
      !meta.height ||
      (meta.pages ?? 1) !== 1 ||
      !['png', 'jpeg'].includes(meta.format ?? '')
    )
      throw new Error('Unsupported image');
    // Decode, orient, and strip metadata once so model and overlay see identical source pixels.
    const result = await image.rotate().png().toBuffer({ resolveWithObject: true });
    return {
      bytes: result.data,
      width: result.info.width,
      height: result.info.height,
      dataUrl: `data:image/png;base64,${result.data.toString('base64')}`,
    };
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
