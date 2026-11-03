import { describe, expect, it } from 'bun:test';
import { pictureShare, zoneAt } from '../apps/web/src/workspace/zoneHover.js';

// The demo frame's size, fitted into a wider stage on the camera.
const frame = { width: 960, height: 640 };
const stage = { x: 100, y: 50, width: 1200, height: 640 };

describe('pictureShare', () => {
  it('reads a photo stage as the picture itself', () => {
    expect(pictureShare({ x: 700, y: 370 }, stage, null)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('fits the camera picture inside the stage like object-fit: contain', () => {
    // 960 × 640 in 1200 × 640 leaves 120 px either side.
    expect(pictureShare({ x: 220, y: 50 }, stage, frame)).toEqual({ x: 0, y: 0 });
    expect(pictureShare({ x: 1180, y: 690 }, stage, frame)).toEqual({ x: 1, y: 1 });
  });

  it('is null in the bars beside the fitted picture', () => {
    expect(pictureShare({ x: 150, y: 370 }, stage, frame)).toBeNull();
  });
});

describe('zoneAt', () => {
  const desk = { id: 'desk', rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } };
  const coaster = { id: 'coaster', rect: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 } };

  it('names the innermost of two zones that overlap', () => {
    expect(zoneAt([desk, coaster], { x: 0.45, y: 0.45 })?.id).toBe('coaster');
  });

  it('names the outer zone outside the inner one', () => {
    expect(zoneAt([desk, coaster], { x: 0.2, y: 0.2 })?.id).toBe('desk');
  });

  it('names nothing off every zone, or off the picture', () => {
    expect(zoneAt([desk, coaster], { x: 0.05, y: 0.05 })).toBeNull();
    expect(zoneAt([desk, coaster], null)).toBeNull();
  });
});
