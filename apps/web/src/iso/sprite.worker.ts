import { draw, type Drawn, type SpriteRequest } from './sprite-draw';

/** Draws sprites off the main thread: a request in, a PNG blob out (`sprites.ts` is the other end). */
export interface WorkerReply {
  id: number;
  blob?: Blob;
  meta?: Omit<Drawn, 'rgba'>;
  error?: string;
}
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; request: SpriteRequest }>) => void) | null;
  postMessage(message: WorkerReply): void;
};

scope.onmessage = async (e) => {
  const { id, request } = e.data;
  try {
    const { rgba, ...meta } = draw(request);
    const canvas = new OffscreenCanvas(meta.width, meta.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), meta.width, meta.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    scope.postMessage({ id, blob, meta });
  } catch (err) {
    scope.postMessage({ id, error: String(err) });
  }
};
