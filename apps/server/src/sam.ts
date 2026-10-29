import {
  parseImageStream,
  recordsOfKind,
  decodeMaskToRaster,
  decodeMaskToSVGPath,
} from '@meta-sam/parser';
import { MAX_MASK_PIXELS, validBox, type Segmentation } from '@livinglayer/domain';
import { LabError } from './errors.js';

export type SamEvent = { type: string; [key: string]: unknown };
export async function decodeSegmentation(
  source: AsyncIterable<SamEvent>,
  concept: string,
  width: number,
  height: number,
  maxMasks = 10,
) {
  const result = await parseImageStream(source).finalResult;
  if (result.outcome.status !== 'completed' || result.diagnostics.length) {
    throw new LabError(
      'invalid_segmentation',
      'SAM returned incomplete or malformed segmentation data.',
      502,
    );
  }
  for (const match of result.rawOutput.matchAll(/;w=(\d+);h=(\d+)/g)) {
    if (Number(match[1]) !== width || Number(match[2]) !== height) {
      throw new LabError(
        'frame_mismatch',
        'SAM frame dimensions do not match the submitted image.',
        502,
      );
    }
  }
  const masks = recordsOfKind(result.records, 'mask');
  if (masks.length > maxMasks)
    throw new LabError('mask_limit', 'SAM returned too many masks for this desk probe.', 502);
  // A box without a mask is not a verified segmentation or a successful no-match.
  if (recordsOfKind(result.records, 'box').length !== masks.length) {
    throw new LabError('missing_mask', 'SAM returned boxes without a usable mask.', 502);
  }
  if (!masks.length && result.rawOutput.trim()) {
    throw new LabError(
      'invalid_empty_result',
      'A SAM no-match must have an empty output lane.',
      502,
    );
  }
  const output: Segmentation = {
    concept,
    frame: { width, height },
    detections: masks.map((record) => {
      const { bounds, mask } = record;
      const box = {
        x: bounds.left,
        y: bounds.top,
        width: bounds.right - bounds.left,
        height: bounds.bottom - bounds.top,
      };
      if (
        !validBox(box, width, height) ||
        (record.frame && record.frame.frameIndex !== 0) ||
        !Number.isSafeInteger(mask.width * mask.height) ||
        mask.width * mask.height > MAX_MASK_PIXELS
      ) {
        throw new LabError(
          'invalid_geometry',
          'SAM returned invalid or oversized mask geometry.',
          502,
        );
      }
      const raster = decodeMaskToRaster(mask);
      const foregroundPixels = raster.reduce((sum, pixel) => sum + pixel, 0);
      if (!foregroundPixels)
        throw new LabError('empty_mask', 'SAM returned a mask without foreground pixels.', 502);
      return {
        objectId: record.objectId,
        confidence: record.confidence ?? null,
        box,
        mask: {
          width: mask.width,
          height: mask.height,
          foregroundPixels,
          svgPath: decodeMaskToSVGPath(mask),
        },
      };
    }),
  };
  return { output, raw: result.rawOutput };
}

export async function* syntheticStream(wire: string): AsyncGenerator<SamEvent> {
  // Deliberately split tokens across chunks to exercise the public streaming parser.
  for (let i = 0; i < wire.length; i += 17) {
    yield {
      type: 'response.output_text.delta',
      delta: wire.slice(i, i + 17),
      item_id: 'demo-item',
      output_index: 0,
      content_index: 0,
    };
  }
  yield {
    type: 'response.output_text.done',
    text: wire,
    item_id: 'demo-item',
    output_index: 0,
    content_index: 0,
  };
  yield { type: 'response.completed', response: { id: 'demo-response', status: 'completed' } };
}
