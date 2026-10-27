import sharp from 'sharp';
import { MAX_IMAGE_PIXELS } from '@livinglayer/domain';
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
