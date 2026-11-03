import { demoFrame, type DemoPosition } from '@livinglayer/domain';

/** Renders the demo camera's frame off the main thread: a position in, a PNG blob out (`demoFrame.ts` is the other end). */
export interface DemoFrameReply {
  position: DemoPosition;
  blob?: Blob;
  error?: string;
}
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<DemoPosition>) => void) | null;
  postMessage(message: DemoFrameReply): void;
};

scope.onmessage = async (e) => {
  const position = e.data;
  try {
    const { width, height, rgba } = demoFrame(position);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    scope.postMessage({ position, blob: await canvas.convertToBlob({ type: 'image/png' }) });
  } catch (err) {
    scope.postMessage({ position, error: String(err) });
  }
};
