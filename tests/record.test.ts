import { describe, expect, test } from 'bun:test';
import { ffmpegArgs, framesDue, parseSize, recordingName } from '../scripts/lib/record.js';

describe('record', () => {
  test('reads a WIDTHxHEIGHT size', () => {
    expect(parseSize('1440x900')).toEqual({ width: 1440, height: 900 });
  });

  test('refuses a size it cannot read', () => {
    expect(() => parseSize('1440*900')).toThrow('WIDTHxHEIGHT');
  });

  test('writes the first frame as soon as one arrives', () => {
    expect(framesDue(0, 0, 30)).toBe(1);
  });

  test('repeats the last frame to keep time on a still page', () => {
    // One second at 30 fps holds frames 0…30; 10 were written, so 21 are due.
    expect(framesDue(1000, 10, 30)).toBe(21);
  });

  test('writes nothing when already ahead', () => {
    expect(framesDue(100, 10, 30)).toBe(0);
  });

  test('encodes stdin to an even-sided H.264 file', () => {
    const a = ffmpegArgs('out/x.mp4', 30);
    expect(a.slice(a.indexOf('-i'), a.indexOf('-i') + 2)).toEqual(['-i', '-']);
    expect(a).toContain('libx264');
    expect(a.at(-1)).toBe('out/x.mp4');
  });

  test('names a recording by when it started', () => {
    expect(recordingName(new Date(2026, 10, 3, 14, 5, 9))).toBe('2026-11-03_14-05-09.mp4');
  });
});
