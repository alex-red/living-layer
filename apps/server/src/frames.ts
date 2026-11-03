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
/**
 * How often the running ffmpeg keeps a full picture, and how old one may be to
 * stand in for now. Five a second keeps SAM's picture newer than the watcher's
 * quiet wait (`WATCH.quietSteps`), so a hand just gone isn't in it.
 */
const STILL_FPS = 5;
const STILL_FRESH_MS = 1000;
/** How long a camera may take to give its first frame: connecting, then waiting for a keyframe. */
const OPEN_TIMEOUT_MS = 20_000;

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

/** The camera's ffmpeg ended before a first frame: it may open with other options. */
class EarlyExit extends Error {}

const fail = () => {
  throw new Error('The camera gave no picture.');
};

/** Sources with a camera open now, by what they read, so a still can come from one. */
const running = new Map<string, FfmpegSource>();

/**
 * Grey frames out of a YUV4MPEG stream as it arrives in chunks: the stream's
 * header line gives the size (`W320 H180 … Cmono`), then each frame is a
 * `FRAME` line and its pixels.
 */
export class Y4mReader {
  private pending = new Uint8Array(0);
  private width = 0;
  private height = 0;
  constructor(private onFrame: (frame: LumaFrame) => void) {}
  /** Whether a frame has come out yet. */
  started = false;
  push(chunk: Uint8Array) {
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);
    let at = 0;
    for (;;) {
      const end = joined.indexOf(0x0a, at);
      if (end < 0) break;
      const line = new TextDecoder().decode(joined.subarray(at, end));
      if (!this.width) {
        if (!line.startsWith('YUV4MPEG2 ')) throw new Error('Not a YUV4MPEG stream.');
        const field = (key: string) => Number(line.match(new RegExp(` ${key}(\\d+)`))?.[1]);
        this.width = field('W');
        this.height = field('H');
        if (!this.width || !this.height || !/ Cmono/.test(line))
          throw new Error('Expected grey YUV4MPEG frames.');
        at = end + 1;
        continue;
      }
      const size = this.width * this.height;
      if (end + 1 + size > joined.length) break;
      this.started = true;
      this.onFrame({
        width: this.width,
        height: this.height,
        data: joined.slice(end + 1, end + 1 + size),
      });
      at = end + 1 + size;
    }
    this.pending = joined.slice(at);
  }
}

/**
 * A camera read through ffmpeg: anything ffmpeg can open, in practice an
 * RTSP URL (`scripts/share-camera.sh` serves one) or a saved camera's
 * RTSP(S) or HTTP stream. One process decodes the camera once, in hardware
 * where it can, and writes grey frames to a pipe as YUV4MPEG (whose header
 * says their size, so the camera isn't opened a second time to ask) and a
 * full picture to a file several times a second, so a snapshot is a file read rather than a new
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
  private get rtsp() {
    return /^rtsps?:\/\//.test(this.url);
  }
  /**
   * How ffmpeg opens the camera. `fast` skips probing the stream, which costs
   * about 0.7 s before the first frame: an RTSP camera's description already
   * gives its codec and size, unless it leaves out the H.264 parameters, when
   * ffmpeg gives up at once and the caller opens it again without `fast`.
   * Frames are handed on as they are decoded, not buffered: on the office
   * camera that put each about 0.5 s sooner (its printed clock read both ways).
   */
  private input(fast = false) {
    // `auto` decodes on the GPU where there is one (VideoToolbox on a Mac) and falls back.
    return this.rtsp
      ? [
          '-hwaccel',
          'auto',
          ...(fast ? ['-analyzeduration', '0', '-probesize', '32'] : []),
          '-fflags',
          'nobuffer',
          '-flags',
          'low_delay',
          '-rtsp_transport',
          'tcp',
          '-i',
          this.url,
        ]
      : ['-hwaccel', 'auto', '-i', this.url];
  }
  /** Sources that read the same picture share their stills. */
  private get key() {
    return `${this.url}#${JSON.stringify(this.crop)}`;
  }
  private get stillPath() {
    return this.stills && join(this.stills, 'still.jpg');
  }
  async start(onFrame: (frame: LumaFrame) => void, onEnd: (error?: Error) => void) {
    this.stopped = false;
    this.stills = mkdtempSync(join(tmpdir(), 'livinglayer-still-'));
    try {
      await this.open(onFrame, onEnd, this.rtsp);
    } catch (error) {
      if (!(error instanceof EarlyExit) || !this.rtsp || this.stopped) throw error;
      await this.open(onFrame, onEnd, false);
    }
    running.set(this.key, this);
  }
  /** One ffmpeg, resolved at its first frame; an `EarlyExit` if it ended before one. */
  private async open(
    onFrame: (frame: LumaFrame) => void,
    onEnd: (error?: Error) => void,
    fast: boolean,
  ) {
    const proc = Bun.spawn(
      [
        this.ffmpeg,
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        ...this.input(fast),
        '-an',
        '-filter_complex',
        `[0:v]${this.cut().slice(0, -1) || 'null'},split=2[a][b];` +
          // Even, as `lumaHeight` gives it; the size comes back in the stream's own header.
          `[a]fps=${LUMA_FPS},scale=${LUMA_WIDTH}:-2,format=gray[luma];` +
          `[b]fps=${STILL_FPS},scale='min(${SNAPSHOT_SIDE},iw)':-2[still]`,
        '-map',
        '[luma]',
        '-f',
        'yuv4mpegpipe',
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
    // Started once the first frame's size is known, so a camera that can't be opened
    // fails the start, as it did when a separate ffprobe looked first.
    let opened: (error?: Error) => void = () => {};
    const open = new Promise<void>((resolve, reject) => {
      opened = (error) => (error ? reject(error) : resolve());
    });
    const timer = setTimeout(() => {
      opened(new Error('The camera stream could not be opened.'));
      proc.kill('SIGKILL');
    }, OPEN_TIMEOUT_MS);
    void (async () => {
      const frames = new Y4mReader((frame) => {
        clearTimeout(timer);
        opened();
        onFrame(frame);
      });
      const reader = proc.stdout.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          frames.push(value);
        }
        await proc.exited;
        clearTimeout(timer);
        opened(new EarlyExit('The camera stream could not be opened.'));
        if (!this.stopped && frames.started) onEnd(new Error('The camera stream ended.'));
      } catch (error) {
        clearTimeout(timer);
        const failure = error instanceof Error ? error : new Error(String(error));
        opened(failure);
        if (!this.stopped && frames.started) onEnd(failure);
      }
    })();
    await open;
  }
  stop() {
    this.stopped = true;
    if (running.get(this.key) === this) running.delete(this.key);
    this.proc?.kill('SIGKILL');
    this.proc = null;
    if (this.stills) rmSync(this.stills, { recursive: true, force: true });
    this.stills = null;
  }
  async snapshot(): Promise<{ png: Buffer; width: number; height: number }> {
    // A source reading the same camera already keeps its picture: the watcher's, for a still
    // asked for on its own, which would otherwise open the camera and wait for a keyframe.
    const other = running.get(this.key);
    if (!this.proc && other?.proc) return other.snapshot();
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
    return (await this.still(this.rtsp)) ?? (this.rtsp ? await this.still(false) : null) ?? fail();
  }
  /** One picture from a new connection, or null when ffmpeg gave none. */
  private async still(fast: boolean) {
    const proc = Bun.spawn(
      [
        this.ffmpeg,
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        ...this.input(fast),
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
    if (!png.length) return null;
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
