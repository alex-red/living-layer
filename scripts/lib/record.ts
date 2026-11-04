/**
 * The pure parts of `bun run record`: reading its size flag, pacing a
 * screencast (which only sends a frame when the page changes) into a video at
 * a constant rate, and the ffmpeg command that encodes it. The pointer marks
 * are the app's own (`apps/web/src/pointer-marks.ts`).
 */

export interface Size {
  width: number;
  height: number;
}

/** `1440x900` → { width: 1440, height: 900 }. */
export function parseSize(text: string): Size {
  const m = /^(\d+)x(\d+)$/.exec(text.trim());
  if (!m) throw new Error(`--size ${text}: expected WIDTHxHEIGHT, e.g. 1440x900`);
  const size = { width: Number(m[1]), height: Number(m[2]) };
  if (size.width < 200 || size.height < 200) throw new Error(`--size ${text}: at least 200x200`);
  return size;
}

/**
 * How many copies of the latest frame to write now so that, after
 * `elapsedMs` of recording, the video holds one frame per `1000 / fps` ms.
 * A still page sends no frames, so the last one is repeated to keep time.
 */
export function framesDue(elapsedMs: number, written: number, fps: number): number {
  return Math.max(0, Math.floor((elapsedMs * fps) / 1000) + 1 - written);
}

/** ffmpeg reading JPEG frames on stdin at `fps` and writing an H.264 MP4 any player opens. */
export function ffmpegArgs(out: string, fps: number, crf = 18): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'image2pipe',
    '-framerate',
    String(fps),
    '-c:v',
    'mjpeg',
    '-i',
    '-',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(crf),
    // yuv420p needs even sides; frames can come out a pixel odd at some scales.
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    out,
  ];
}

/** `out/recordings/2026-11-03_14-05-09.mp4` style name for a recording started at `at`. */
export function recordingName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}_${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}.mp4`;
}
