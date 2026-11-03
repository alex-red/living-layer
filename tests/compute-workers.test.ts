import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import {
  DEMO_CAMERA,
  DEMO_ROOM,
  fitItem,
  floorSolid,
  renderRoom,
  sceneSolids,
} from '@livinglayer/domain';
import { demoMugCloseUp } from '../apps/server/src/demo.js';
import { maskedCrop } from '../apps/server/src/images.js';
import { closeCompute, fitItemAsync, renderRoomAsync } from '../apps/server/src/workers/compute.js';

setDefaultTimeout(60_000);
afterAll(() => {
  closeCompute();
  delete process.env.COMPUTE_WORKERS;
});

describe('fitting and rendering in workers', () => {
  it('gives the same fit and the same picture as running them in place', async () => {
    const close = await demoMugCloseUp();
    const crop = await maskedCrop(close.png, close.detection);
    const input = {
      rgba: new Uint8Array(crop.rgba),
      width: crop.width,
      height: crop.height,
      label: 'mug',
    };
    const solids = [floorSolid(DEMO_ROOM.grid), ...sceneSolids(DEMO_ROOM)];
    const direct = fitItem(input);
    const picture = renderRoom(DEMO_CAMERA, solids, { labels: true });

    process.env.COMPUTE_WORKERS = '2';
    const [fitted, drawn] = await Promise.all([
      fitItemAsync(input),
      renderRoomAsync(DEMO_CAMERA, solids, { labels: true }),
    ]);
    expect(JSON.stringify(fitted)).toBe(JSON.stringify(direct));
    expect(Buffer.compare(Buffer.from(drawn.rgba), Buffer.from(picture.rgba))).toBe(0);
    expect(Buffer.compare(Buffer.from(drawn.ids.buffer), Buffer.from(picture.ids.buffer))).toBe(0);
    expect(drawn.names).toEqual(picture.names);
    // The input is still ours after it was sent.
    expect(input.rgba.length).toBe(crop.rgba.length);
  });

  it('runs in place when workers are off', async () => {
    process.env.COMPUTE_WORKERS = '0';
    const solids = [floorSolid(DEMO_ROOM.grid)];
    const drawn = await renderRoomAsync(DEMO_CAMERA, solids);
    expect(drawn.width).toBe(DEMO_CAMERA.frame.width);
  });
});
