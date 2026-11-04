import { describe, expect, it } from 'bun:test';
import { stageSize } from '../apps/web/src/workspace/stage-size.js';

const photo = { width: 960, height: 640 };
const camera = { width: 1030, height: 772 };

describe('stageSize', () => {
  it('takes the running camera’s shape, so a held frame does not reshape the stage', () => {
    expect(stageSize(true, camera, photo)).toEqual(camera);
  });

  it('keeps the photo’s size until the camera’s is known', () => {
    expect(stageSize(true, null, photo)).toEqual(photo);
  });

  it('keeps the photo’s size with no camera running', () => {
    expect(stageSize(false, camera, photo)).toEqual(photo);
  });
});
