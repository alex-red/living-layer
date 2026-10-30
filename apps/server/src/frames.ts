import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { moveDemoMug, type DemoPosition, type LumaFrame } from '@livinglayer/domain';
import { PROJECT_ROOT } from './config.js';

/** The watcher's grey frames are this wide; local matching runs on them. */
export const LUMA_WIDTH = 320;
/** How many grey frames a second a live camera is read at. */
export const LUMA_FPS = 10;
/** Snapshots for SAM are scaled to fit this, like a frame the lab captures. */
const SNAPSHOT_SIDE = 1280;

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

/** A grey frame of the same size the watcher works at, from any image. */
export async function lumaOf(image: Buffer, height?: number): Promise<LumaFrame> {
  const { data, info } = await sharp(image)
    .resize(LUMA_WIDTH, height ?? null, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

/**
 * A camera read through ffmpeg: anything ffmpeg can open, in practice an
 * RTSP URL (`scripts/share-camera.sh` serves one) or a saved camera's
 * RTSP(S) or HTTP stream. One process writes raw
 * grey frames to a pipe; a snapshot is a second, short one. Spawned with an
 * argument list, never a shell.
 */
export class FfmpegSource implements FrameSource {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private stopped = false;
  constructor(
    private url: string,
    private ffmpeg = 'ffmpeg',
  ) {}
  private input() {
    return /^rtsps?:\/\//.test(this.url)
      ? ['-rtsp_transport', 'tcp', '-i', this.url]
      : ['-i', this.url];
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
    const timer = setTimeout(() => probe.kill(), 10_000);
    const text = await new Response(probe.stdout).text();
    clearTimeout(timer);
    const [width, height] = text.trim().split(',').map(Number);
    if (!width || !height) throw new Error('The camera stream could not be opened.');
    return { width, height };
  }
  async start(onFrame: (frame: LumaFrame) => void, onEnd: (error?: Error) => void) {
    this.stopped = false;
    const { width, height } = await this.size();
    // Even, so the raw frames have the size ffmpeg's scaler gives them.
    const h = Math.max(2, Math.round((LUMA_WIDTH * height) / width / 2) * 2);
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
        `fps=${LUMA_FPS},scale=${LUMA_WIDTH}:${h},format=gray`,
        '-f',
        'rawvideo',
        'pipe:1',
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
    this.proc?.kill();
    this.proc = null;
  }
  async snapshot() {
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
        `scale='min(${SNAPSHOT_SIDE},iw)':-2`,
        '-f',
        'image2pipe',
        '-c:v',
        'png',
        'pipe:1',
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
    );
    const timer = setTimeout(() => proc.kill(), 15_000);
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
        `fps=${fps},scale='min(${SNAPSHOT_SIDE},iw)':-2`,
        '-q:v',
        '5',
        '-f',
        'mpjpeg',
        'pipe:1',
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
    );
    return { stream: proc.stdout, stop: () => proc.kill() };
  }
}

let deskSvg: string | null = null;
/**
 * The illustrated desk as a camera: a frame whenever the mug is moved, so the
 * demo runs the real watcher with no camera and no model calls.
 */
export class DemoSource implements FrameSource {
  private onFrame: ((frame: LumaFrame) => void) | null = null;
  position: DemoPosition = 'centre';
  private async picture(position: DemoPosition) {
    deskSvg ??= readFileSync(resolve(PROJECT_ROOT, 'apps/web/public/desk.svg'), 'utf8');
    return sharp(Buffer.from(moveDemoMug(deskSvg, position)))
      .png()
      .toBuffer();
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
    return { png: await this.picture(this.position), width: 960, height: 640 };
  }
}
