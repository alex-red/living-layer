/**
 * The pure parts of recording this tab (`Recorder.tsx`): which file type the
 * browser can write, the file's name, the clock's text and the shortcut.
 */

/** Best first: an MP4 plays everywhere; WebM is what older Chrome can write. */
const RECORDING_TYPES = [
  'video/mp4;codecs=avc1.640033',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

/** The first type `supported` accepts (`MediaRecorder.isTypeSupported`), or null when none. */
export function pickRecordingType(supported: (type: string) => boolean): string | null {
  return RECORDING_TYPES.find((t) => supported(t)) ?? null;
}

/** `living-layer-2026-11-03_14-05-09.mp4`, by when the take started and what it holds. */
export function recordingFileName(at: Date, type: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
  return `living-layer-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}_${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}.${ext}`;
}

/** `0:07`, `12:30`, `1:02:03`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Bits per second for a take of `width` × `height` pixels: enough that text
 * and thin lines stay sharp, clamped so a long take stays a sensible size.
 */
export function recordingBitrate(width: number, height: number, fps: number): number {
  return Math.round(Math.min(40e6, Math.max(6e6, width * height * fps * 0.1)));
}

/** ⌘⇧E on a Mac, Ctrl+Shift+E elsewhere: start or stop recording, on every page. */
export function isRecordKey(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  mac: boolean,
): boolean {
  return e.key.toLowerCase() === 'e' && e.shiftKey && !e.altKey && (mac ? e.metaKey : e.ctrlKey);
}
