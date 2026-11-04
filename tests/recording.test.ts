import { describe, expect, test } from 'bun:test';
import {
  formatElapsed,
  isRecordKey,
  pickRecordingType,
  recordingBitrate,
  recordingFileName,
} from '../apps/web/src/recording';

const key = (over: Partial<KeyboardEvent> = {}) => ({
  key: 'E',
  metaKey: false,
  ctrlKey: false,
  shiftKey: true,
  altKey: false,
  ...over,
});

describe('recording this tab', () => {
  test('prefers an MP4 when the browser can write one', () => {
    expect(pickRecordingType(() => true)).toBe('video/mp4;codecs=avc1.640033');
  });

  test('falls back to WebM when MP4 is not supported', () => {
    expect(pickRecordingType((t) => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9');
  });

  test('has no type when the browser can write none', () => {
    expect(pickRecordingType(() => false)).toBeNull();
  });

  test('names the file by when the take started, with its type', () => {
    const at = new Date(2026, 10, 3, 14, 5, 9);
    expect(recordingFileName(at, 'video/mp4;codecs=avc1')).toBe(
      'living-layer-2026-11-03_14-05-09.mp4',
    );
    expect(recordingFileName(at, 'video/webm;codecs=vp9')).toBe(
      'living-layer-2026-11-03_14-05-09.webm',
    );
  });

  test('shows minutes and seconds, and hours once past one', () => {
    expect(formatElapsed(7_400)).toBe('0:07');
    expect(formatElapsed(750_000)).toBe('12:30');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
  });

  test('keeps the bitrate between 6 and 40 Mbit/s', () => {
    expect(recordingBitrate(640, 400, 30)).toBe(6e6);
    expect(recordingBitrate(2880, 1800, 30)).toBe(15_552_000);
    expect(recordingBitrate(7680, 4320, 60)).toBe(40e6);
  });

  test('starts or stops on Cmd+Shift+E on a Mac and Ctrl+Shift+E elsewhere', () => {
    expect(isRecordKey(key({ metaKey: true }), true)).toBe(true);
    expect(isRecordKey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isRecordKey(key({ ctrlKey: true }), true)).toBe(false);
    expect(isRecordKey(key({ metaKey: true, shiftKey: false }), true)).toBe(false);
  });
});
