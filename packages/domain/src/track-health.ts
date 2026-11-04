/**
 * How a tracker is keeping up: the server's watcher and the browser's local
 * follow both measure each frame's arrival and the time spent on it, and
 * read a verdict from the last few seconds of them. Times are passed in, so
 * the same meter runs on the server, in a tab and in tests.
 */

/** Where the verdicts change. Work is judged against the frame interval, `1000 / wantFps`. */
export const TRACK_HEALTH = {
  /** Frames judged: about 5 s at 10 a second. */
  windowFrames: 50,
  /** The most recent frames' work kept for the bar's sparkline. */
  recentFrames: 30,
  /** Fewer frames than this say nothing about the rate. */
  minFrames: 5,
  /** p95 work over this share of the interval: strained. Over all of it: lagging. */
  strainedWork: 0.5,
  /** Frame rate under this share of the wanted one: strained, and under `slowFps` lagging. */
  thinFps: 0.9,
  slowFps: 0.7,
  /** No frame for this long while frames are wanted: stalled. */
  stalledMs: 2000,
  /** A frame this soon after the last, as a share of the interval, came queued behind it. */
  burstGap: 0.2,
  /** This share of frames queued: behind the camera. */
  queuedShare: 0.3,
  /** Timers this late, ms: the process is busy (strained), or starved (lagging). */
  driftMs: 50,
  driftLagMs: 200,
} as const;

type HealthVerdict = 'waiting' | 'healthy' | 'strained' | 'lagging' | 'stalled';

export interface TrackHealth {
  verdict: HealthVerdict;
  /** Why, in a few words: the worst thing found, or the rate and work when healthy. */
  reason: string;
  /** Frames a second over the window, or null when frames come one move at a time (the demo). */
  fps: number | null;
  wantFps: number;
  /** Work per frame, ms. */
  workP50: number | null;
  workP95: number | null;
  /** The frame interval: work over it can't keep up. */
  budgetMs: number;
  /** Share of the window's time spent on frames: the tracker's own load. */
  busy: number | null;
  /** Since the last frame, ms. */
  staleMs: number | null;
  /** Share of the window's frames that came queued behind another. */
  queued: number;
  /** How late timers ran lately, ms, when measured. */
  driftMs: number | null;
  /** The process's CPU, and ffmpeg's, as % of one core, when measured. */
  cpu: number | null;
  ffmpegCpu: number | null;
  /** Apple Vision's helper's CPU, % of one core, while it steers. */
  visionCpu?: number | null;
  /** Things being looked for again (SAM or a whole-frame search), and things lost. */
  looking: number;
  lost: number;
  things: number;
  /** The latest frames' work, ms, oldest first. */
  recent: number[];
}

/** What a tracker knows beyond its frames. */
type HealthExtra = Partial<
  Pick<TrackHealth, 'driftMs' | 'cpu' | 'ffmpegCpu' | 'visionCpu' | 'looking' | 'lost' | 'things'>
>;

const round1 = (n: number) => Math.round(n * 10) / 10;
function quantile(sorted: number[], q: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** The worst of what the numbers show, as a verdict and its reason. */
function healthVerdict(
  h: Omit<TrackHealth, 'verdict' | 'reason' | 'recent'>,
  paced: boolean,
): { verdict: HealthVerdict; reason: string } {
  const T = TRACK_HEALTH;
  if (h.staleMs === null) return { verdict: 'waiting', reason: 'waiting for the first frame' };
  if (paced && h.staleMs > T.stalledMs)
    return { verdict: 'stalled', reason: `no frame for ${(h.staleMs / 1000).toFixed(1)} s` };
  const work = h.workP95 ?? 0;
  const fps = h.fps ?? h.wantFps;
  const ms = (n: number) => `${Math.round(n)} ms`;
  if (work > h.budgetMs)
    return { verdict: 'lagging', reason: `frame work ${ms(work)} of ${ms(h.budgetMs)}` };
  if (paced && h.fps !== null && fps < h.wantFps * T.slowFps)
    return { verdict: 'lagging', reason: `${fps.toFixed(1)} fps of ${h.wantFps}` };
  if (paced && h.queued > T.queuedShare)
    return { verdict: 'lagging', reason: 'frames queuing: behind the camera' };
  if ((h.driftMs ?? 0) > T.driftLagMs)
    return { verdict: 'lagging', reason: `process starved: timers ${ms(h.driftMs!)} late` };
  if (work > h.budgetMs * T.strainedWork)
    return { verdict: 'strained', reason: `frame work ${ms(work)} of ${ms(h.budgetMs)}` };
  if (paced && h.fps !== null && fps < h.wantFps * T.thinFps)
    return { verdict: 'strained', reason: `${fps.toFixed(1)} fps of ${h.wantFps}` };
  if ((h.driftMs ?? 0) > T.driftMs)
    return { verdict: 'strained', reason: `process busy: timers ${ms(h.driftMs!)} late` };
  if (h.lost)
    return {
      verdict: 'strained',
      reason: `${h.lost} of ${h.things} ${h.things === 1 ? 'thing' : 'things'} lost`,
    };
  return {
    verdict: 'healthy',
    reason: `${h.fps === null ? '' : `${h.fps.toFixed(1)} fps · `}${h.workP50 === null ? '' : `${h.workP50 < 1 ? '<1' : Math.round(h.workP50)} ms a frame`}`,
  };
}

/**
 * The last few seconds of a tracker's frames. `paced` trackers want frames
 * at `wantFps` (a camera); unpaced ones get one per deliberate move (the
 * demo), so only their work is judged.
 */
export class HealthMeter {
  private at: number[] = [];
  private work: number[] = [];
  constructor(
    private wantFps: number,
    private paced = true,
  ) {}
  /** One frame: when it arrived and how long it took, ms. */
  frame(at: number, workMs: number) {
    this.at.push(at);
    this.work.push(workMs);
    if (this.at.length > TRACK_HEALTH.windowFrames) {
      this.at.shift();
      this.work.shift();
    }
  }
  reset() {
    this.at = [];
    this.work = [];
  }
  read(now: number, extra: HealthExtra = {}): TrackHealth {
    const T = TRACK_HEALTH;
    const budgetMs = 1000 / this.wantFps;
    const n = this.at.length;
    const sorted = [...this.work].sort((a, b) => a - b);
    const span = n > 1 ? this.at[n - 1]! - this.at[0]! : 0;
    let queued = 0;
    for (let i = 1; i < n; i++) if (this.at[i]! - this.at[i - 1]! < budgetMs * T.burstGap) queued++;
    const total = this.work.reduce((a, b) => a + b, 0);
    const numbers = {
      fps: this.paced && n >= T.minFrames && span > 0 ? round1(((n - 1) * 1000) / span) : null,
      wantFps: this.wantFps,
      workP50: n ? round1(quantile(sorted, 0.5)) : null,
      workP95: n ? round1(quantile(sorted, 0.95)) : null,
      budgetMs: round1(budgetMs),
      busy:
        this.paced && n >= T.minFrames && span > 0 ? Math.round((total / span) * 100) / 100 : null,
      staleMs: n ? Math.max(0, Math.round(now - this.at[n - 1]!)) : null,
      queued: this.paced && n > 1 ? Math.round((queued / (n - 1)) * 100) / 100 : 0,
      driftMs: extra.driftMs ?? null,
      cpu: extra.cpu ?? null,
      ffmpegCpu: extra.ffmpegCpu ?? null,
      ...(extra.visionCpu != null ? { visionCpu: extra.visionCpu } : {}),
      looking: extra.looking ?? 0,
      lost: extra.lost ?? 0,
      things: extra.things ?? 0,
    };
    return {
      ...healthVerdict(numbers, this.paced),
      ...numbers,
      recent: this.work.slice(-T.recentFrames).map(round1),
    };
  }
}
