import { describe, expect, it } from 'bun:test';
import { stageForZone, zoneDrawnOn } from '../apps/web/src/workspace/zoneDraw.js';

describe('where a zone is drawn', () => {
  it('draws a new zone on the camera picture while there is a live view', () => {
    expect(zoneDrawnOn({}, true)).toBe('picture');
    expect(stageForZone({}, true, 'iso')).toBe('split');
    expect(stageForZone({}, true, 'photo')).toBe('photo');
  });
  it('falls back to the room without a live view', () => {
    expect(zoneDrawnOn({}, false)).toBe('room');
    expect(stageForZone({}, false, 'photo')).toBe('iso');
    expect(stageForZone({}, false, 'split')).toBe('split');
  });
  it('draws a motion zone on the picture even without a live view', () => {
    expect(zoneDrawnOn({ motion: {} }, false)).toBe('picture');
    expect(stageForZone({ motion: {} }, false, 'iso')).toBe('split');
  });
  it('drags nothing for a zone that is a thing, shown in the room', () => {
    expect(zoneDrawnOn({ anchor: {} }, true)).toBe('thing');
    expect(stageForZone({ anchor: {} }, true, 'photo')).toBe('iso');
  });
});
