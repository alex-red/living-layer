/**
 * What the server process is doing while it watches: how late its timers
 * run (anything blocking the event loop shows here), its CPU and that of the
 * ffmpeg decoding the camera and Apple Vision's helper, each as % of one core. Sampled on a timer, never
 * per frame.
 */

const TICK_MS = 500;
/** Drift is the worst of the last few ticks, so one slow tick is seen for a while. */
const DRIFT_TICKS = 10;
/** ffmpeg's and the helper's CPU are read with `ps`, every few ticks. */
const FFMPEG_EVERY = 10;

/** `ps -o time=`: `[[dd-]hh:]mm:ss[.ss]`, in seconds; null when it isn't one. */
export function cpuSeconds(text: string): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const [, d = '0', h = '0', min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

async function processCpu(pid: number): Promise<number | null> {
  try {
    const ps = Bun.spawn(['ps', '-o', 'time=', '-p', String(pid)], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const text = await new Response(ps.stdout).text();
    await ps.exited;
    return cpuSeconds(text);
  } catch {
    return null;
  }
}

/** Another process's CPU, from `ps` read now and then: the change between two reads. */
class ChildCpu {
  value: number | null = null;
  private from: { pid: number; cpu: number; at: number } | null = null;
  reset() {
    this.value = null;
    this.from = null;
  }
  async read(pid: number | null | undefined, at: number, running: () => boolean) {
    if (!pid) return this.reset();
    const cpu = await processCpu(pid);
    if (cpu === null || !running()) return;
    const from = this.from;
    if (from?.pid === pid && at > from.at)
      this.value = Math.round(((cpu - from.cpu) * 1000 * 100) / (at - from.at));
    this.from = { pid, cpu, at };
  }
}

export class ProcessLoad {
  private timer: ReturnType<typeof setInterval> | null = null;
  private drifts: number[] = [];
  private cpu: number | null = null;
  private ffmpeg = new ChildCpu();
  private vision = new ChildCpu();
  private lastTick = 0;
  private lastUsage = process.cpuUsage();
  private ticks = 0;
  constructor(
    /** The decoding process, when there is one. */
    private pid: () => number | null | undefined,
    private onTick: () => void,
    /** Apple Vision's helper, while it steers. */
    private helper: () => number | null | undefined = () => null,
  ) {}
  start() {
    this.stop();
    this.lastTick = performance.now();
    this.lastUsage = process.cpuUsage();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Watching never keeps the process alive by itself.
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.drifts = [];
    this.cpu = null;
    this.ffmpeg.reset();
    this.vision.reset();
    this.ticks = 0;
  }
  read() {
    return {
      driftMs: this.drifts.length ? Math.round(Math.max(...this.drifts)) : null,
      cpu: this.cpu,
      ffmpegCpu: this.ffmpeg.value,
      visionCpu: this.vision.value,
    };
  }
  private tick() {
    const at = performance.now();
    const wall = at - this.lastTick;
    this.drifts.push(Math.max(0, wall - TICK_MS));
    if (this.drifts.length > DRIFT_TICKS) this.drifts.shift();
    const usage = process.cpuUsage(this.lastUsage);
    this.lastUsage = process.cpuUsage();
    this.lastTick = at;
    this.cpu = Math.round(((usage.user + usage.system) / 1000 / wall) * 100);
    if (this.ticks++ % FFMPEG_EVERY === 0) {
      const running = () => this.timer !== null;
      void this.ffmpeg.read(this.pid(), at, running);
      void this.vision.read(this.helper(), at, running);
    }
    this.onTick();
  }
}
