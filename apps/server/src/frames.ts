import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  DEMO_FRAME,
  type CameraCrop,
  type DemoPosition,
  type LumaFrame,
} from '@livinglayer/domain';

/** The watcher's grey frames are this wide; local matching runs on them. */
export const LUMA_WIDTH = 320;
/** How many grey frames a second a live camera is read at. */
export const LUMA_FPS = 10;
/** Snapshots for SAM are scaled to fit this, like a frame the lab captures. */
const SNAPSHOT_SIDE = 1280;
/** How often the running ffmpeg keeps a full picture, and how old one may be to stand in for now. */
const STILL_FPS = 2;
const STILL_FRESH_MS = 1500;

/**
 * Where the watcher's frames come from. Grey frames arrive continuously for
 * local matching; a full-size colour snapshot is taken only when SAM or the
 * feature model needs one.
 */
export interface FrameSource {
  /** Starts the frames; `onEnd` is called once if they stop by themselves. */
  start(onFrame: (frame: LumaFrame) => void, onEnd: (error?: Error) => void): Promise<void>;
  stop(): void;
  /** The current picture as a PNG at most 1280 px on its longer side. */
  snapshot(): Promise<{ png: Buffer; width: number; height: number }>;
}

/** The height of the grey frames from a picture this size: even, as ffmpeg's scaler gives it. */
export const lumaHeight = (width: number, height: number) =>
  Math.max(2, Math.round((LUMA_WIDTH * height) / width / 2) * 2);

/**
 * A grey frame at the size the watcher works at, from any image: the size a
 * camera of the image's shape gives, unless `height` is given. Frames compared
 * with each other (the camera-moved check) must agree to the pixel.
 */
export async function lumaOf(image: Buffer, height?: number): Promise<LumaFrame> {
  const own = height ? null : await sharp(image).metadata();
  const h = height ?? lumaHeight(own!.width!, own!.height!);
  const { data, info } = await sharp(image)
    .resize(LUMA_WIDTH, h, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

/**
 * A camera read through ffmpeg: anything ffmpeg can open, in practice an
 * RTSP URL (`scripts/share-camera.sh` serves one) or a saved camera's
 * RTSP(S) or HTTP stream. One process decodes the camera once, in hardware
 * where it can, and writes raw grey frames to a pipe and a full picture to a
 * file twice a second, so a snapshot is a file read rather than a new
 * connection (about 2 s over RTSP, which is what it costs when no process
 * runs). Spawned with an argument list, never a shell, and ended with SIGKILL:
 * on a polite signal ffmpeg can wait on the camera, and nothing it writes
 * needs finishing.
 */
export class FfmpegSource implements FrameSource {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private stopped = false;
  /** Where the running process keeps its latest full picture. */
  private stills: string | null = null;
  constructor(
    private url: string,
    private ffmpeg = 'ffmpeg',
    /** The camera's zoomed view: every frame read is cut to it first. */
    private crop: CameraCrop | null = null,
  ) {}
  /** The filter that cuts a frame to the crop, ahead of the rest. */
  private cut() {
    const c = this.crop;
    return c ? `crop=iw*${c.w}:ih*${c.h}:iw*${c.x}:ih*${c.y},` : '';
  }
  private input() {
    // `auto` decodes on the GPU where there is one (VideoToolbox on a Mac) and falls back.
    return /^rtsps?:\/\//.test(this.url)
      ? ['-hwaccel', 'auto', '-rtsp_transport', 'tcp', '-i', this.url]
      : ['-hwaccel', 'auto', '-i', this.url];
  }
  private get stillPath() {
    return this.stills && join(this.stills, 'still.jpg');
  }
  /** The stream's frame size, from ffprobe. */
  private async size(): Promise<{ width: number; height: number }> {
    const probe = Bun.spawn(
      [
        this.ffmpeg.replace(/ffmpeg$/, 'ffprobe'),
        '-v',
        'error',
        ...(/^rtsps?:\/\//.test(this.url) ? ['-rtsp_transport', 'tcp'] : []),
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=p=0',
        this.url,
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
    );
    const timer = setTimeout(() => probe.kill('SIGKILL'), 10_000);
    const text = await new Response(probe.stdout).text();
    clearTimeout(timer);
    const [width, height] = text.trim().split(',').map(Number);
    if (!width || !height) throw new Error('The camera stream could not be opened.');
    const c = this.crop;
    return c ? { width: width * c.w, height: height * c.h } : { width, height };
  }
  async start(onFrame: (frame: LumaFrame) => void, onEnd: (error?: Error) => void) {
    this.stopped = false;
    const { width, height } = await this.size();
    // Even, so the raw frames have the size ffmpeg's scaler gives them.
    const h = lumaHeight(width, height);
    this.stills = mkdtempSync(join(tmpdir(), 'livinglayer-still-'));
    const proc = Bun.spawn(
      [
        this.ffmpeg,
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        ...this.input(),
        '-an',
        '-filter_complex',
        `[0:v]${this.cut().slice(0, -1) || 'null'},split=2[a][b];` +
          `[a]fps=${LUMA_FPS},scale=${LUMA_WIDTH}:${h},format=gray[luma];` +
          `[b]fps=${STILL_FPS},scale='min(${SNAPSHOT_SIDE},iw)':-2[still]`,
        '-map',
        '[luma]',
        '-f',
        'rawvideo',
        'pipe:1',
        // A pipe and a file, not two pipes: two pipes hang under Bun.
        '-map',
        '[still]',
        '-f',
        'image2',
        '-update',
        '1',
        '-atomic_writing',
        '1',
        '-q:v',
        '2',
        '-y',
        this.stillPath!,
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
    );
    this.proc = proc;
    const size = LUMA_WIDTH * h;
    void (async () => {
      let pending = new Uint8Array(0);
      const reader = proc.stdout.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const joined = new Uint8Array(pending.length + value.length);
          joined.set(pending);
          joined.set(value, pending.length);
          let at = 0;
          for (; at + size <= joined.length; at += size)
            onFrame({ width: LUMA_WIDTH, height: h, data: joined.slice(at, at + size) });
          pending = joined.slice(at);
        }
        await proc.exited;
        if (!this.stopped) onEnd(new Error('The camera stream ended.'));
      } catch (error) {
        if (!this.stopped) onEnd(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  }
  stop() {
    this.stopped = true;
    this.proc?.kill('SIGKILL');
    this.proc = null;
    if (this.stills) rmSync(this.stills, { recursive: true, force: true });
    this.stills = null;
  }
  async snapshot() {
    // The running process's latest picture, when it is fresh; a JPEG, given as a PNG like the rest.
    const kept = this.stillPath;
    if (kept && this.proc)
      try {
        if (Date.now() - statSync(kept).mtimeMs < STILL_FRESH_MS) {
          const { data, info } = await sharp(kept).png().toBuffer({ resolveWithObject: true });
          return { png: data, width: info.width, height: info.height };
        }
      } catch {
        // Not written yet, or gone between the check and the read: take one the slow way.
      }
    const proc = Bun.spawn(
      [
        this.ffmpeg,
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        ...this.input(),
        '-an',
        '-frames:v',
        '1',
        '-vf',
        `${this.cut()}scale='min(${SNAPSHOT_SIDE},iw)':-2`,
        '-f',
        'image2pipe',
        '-c:v',
        'png',
        'pipe:1',
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
    );
    const timer = setTimeout(() => proc.kill('SIGKILL'), 15_000);
    const png = Buffer.from(await new Response(proc.stdout).arrayBuffer());
    clearTimeout(timer);
    if (!png.length) throw new Error('The camera gave no picture.');
    const { width = 0, height = 0 } = await sharp(png).metadata();
    return { png, width, height };
  }
  /**
   * The stream as MJPEG (`multipart/x-mixed-replace`, boundary `ffmpeg`), so a
   * tab can show a camera it can't open itself. `stop` ends the process.
   */
  preview(fps = 10) {
    const proc = Bun.spawn(
      [
        this.ffmpeg,
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        ...this.input(),
        '-an',
        '-vf',
        `${this.cut()}fps=${fps},scale='min(${SNAPSHOT_SIDE},iw)':-2`,
        '-q:v',
        '5',
        '-f',
        'mpjpeg',
        'pipe:1',
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
    );
    return { stream: proc.stdout, stop: () => proc.kill('SIGKILL') };
  }
}

/**
 * The demo room as a camera: the office rendered from its corner, a frame
 * whenever the mug is moved, so the demo runs the real watcher with no camera
 * and no model calls.
 */
export class DemoSource implements FrameSource {
  private onFrame: ((frame: LumaFrame) => void) | null = null;
  position: DemoPosition = 'centre';
  private async picture(position: DemoPosition) {
    // Imported here: the demo module renders, which the live path never needs.
    const { demoPng } = await import('./demo.js');
    return demoPng(position);
  }
  async start(onFrame: (frame: LumaFrame) => void) {
    this.onFrame = onFrame;
    onFrame(await lumaOf(await this.picture(this.position)));
  }
  stop() {
    this.onFrame = null;
  }
  /** Moving the mug is a new frame, sent several times as a camera would while it stays there. */
  async show(position: DemoPosition, repeat = 1) {
    this.position = position;
    const frame = await lumaOf(await this.picture(position));
    for (let i = 0; i < repeat; i++) this.onFrame?.(frame);
  }
  async snapshot() {
    return { png: await this.picture(this.position), ...DEMO_FRAME };
  }
}
