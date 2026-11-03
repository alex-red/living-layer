/**
 * What the server process is doing while it watches: how late its timers
 * run (anything blocking the event loop shows here), its CPU and that of the
 * ffmpeg decoding the camera, each as % of one core. Sampled on a timer, never
 * per frame.
 */

const TICK_MS = 500;
/** Drift is the worst of the last few ticks, so one slow tick is seen for a while. */
const DRIFT_TICKS = 10;
/** ffmpeg's CPU is read with `ps`, every few ticks. */
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

export class ProcessLoad {
  private timer: ReturnType<typeof setInterval> | null = null;
  private drifts: number[] = [];
  private cpu: number | null = null;
  private ffmpegCpu: number | null = null;
  private lastTick = 0;
  private lastUsage = process.cpuUsage();
  private ticks = 0;
  private ffmpegFrom: { pid: number; cpu: number; at: number } | null = null;
  constructor(
    /** The decoding process, when there is one. */
    private pid: () => number | null | undefined,
    private onTick: () => void,
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
    this.ffmpegCpu = null;
    this.ffmpegFrom = null;
    this.ticks = 0;
  }
  read() {
    return {
      driftMs: this.drifts.length ? Math.round(Math.max(...this.drifts)) : null,
      cpu: this.cpu,
      ffmpegCpu: this.ffmpegCpu,
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
    if (this.ticks++ % FFMPEG_EVERY === 0) void this.readFfmpeg(at);
    this.onTick();
  }
  private async readFfmpeg(at: number) {
    const pid = this.pid();
    if (!pid) return void (this.ffmpegCpu = null);
    const cpu = await processCpu(pid);
    if (cpu === null || !this.timer) return;
    const from = this.ffmpegFrom;
    if (from?.pid === pid && at > from.at)
      this.ffmpegCpu = Math.round(((cpu - from.cpu) * 1000 * 100) / (at - from.at));
    this.ffmpegFrom = { pid, cpu, at };
  }
}
