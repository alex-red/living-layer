/// <reference lib="webworker" />
import { fitItem, renderRoom, type RoomPicture } from '@livinglayer/domain';
import type { ComputeJob } from './compute.js';

/** Runs one of domain's pure, slow functions off the server's event loop. */
declare const self: Worker;
self.onmessage = (event: MessageEvent<{ id: number; job: ComputeJob }>) => {
  const { id, job } = event.data;
  try {
    if (job.op === 'fit') {
      self.postMessage({ id, result: fitItem(job.input) });
    } else {
      const picture: RoomPicture = renderRoom(job.camera, job.solids, job.options);
      // The pixels, ids and depths move to the server without a copy.
      self.postMessage({ id, result: picture }, [
        picture.rgba.buffer as ArrayBuffer,
        picture.ids.buffer as ArrayBuffer,
        picture.depth.buffer as ArrayBuffer,
      ]);
    }
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
