import { describe, expect, test } from 'bun:test';
import { followDraw } from '../apps/web/src/workspace/followLayers.js';

const at = { camera: false, tracking: false, follow: false, watching: false, picture: false };

describe('followDraw', () => {
  test('the camera with the Tracking layer on draws the tracking layer', () => {
    expect(followDraw({ ...at, camera: true, tracking: true, follow: true, watching: true })).toBe(
      'tracking',
    );
  });

  test('the camera with the Tracking layer off draws no follow or watch boxes', () => {
    expect(followDraw({ ...at, camera: true, follow: true })).toBeNull();
    expect(followDraw({ ...at, camera: true, watching: true, picture: true })).toBeNull();
  });

  test('a photo draws the follower over the watcher', () => {
    expect(followDraw({ ...at, follow: true, watching: true, picture: true })).toBe('follow');
  });

  test('a photo being watched draws the watcher’s boxes', () => {
    expect(followDraw({ ...at, watching: true, picture: true })).toBe('watch');
  });

  test('the watcher’s boxes need a picture under them', () => {
    expect(followDraw({ ...at, watching: true })).toBeNull();
  });
});
