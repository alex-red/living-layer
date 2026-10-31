import { demoFrame, type DemoPosition } from '@livinglayer/domain';

const urls = new Map<DemoPosition, string>();
/**
 * The demo camera's frame as an image URL: the office rendered from its
 * corner with the mug at `position`, the same picture the server's demo
 * camera and synthetic SAM use.
 */
export function demoFrameUrl(position: DemoPosition = 'centre'): string {
  let url = urls.get(position);
  if (!url) {
    const { width, height, rgba } = demoFrame(position);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    url = canvas.toDataURL('image/png');
    urls.set(position, url);
  }
  return url;
}
