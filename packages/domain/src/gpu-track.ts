import type { TrackHealth } from './track-health.js';
import { boxIoU, LOCAL_TRACK, matchTemplate, type LumaFrame, type UnitBox } from './tracker.js';
import { WATCH, type GpuTrackerView, type WatchThing } from './watch.js';

/**
 * The GPU tracker (`services/gpu-tracker/`) follows the same things on
 * another machine with SAM 2.1's video predictor. Its boxes never judge a
 * zone: they correct the local track, which does. Each of its results is
 * read against what the watcher follows now, both ways:
 *
 * - a thing the GPU sees surely and steadily where the local match lost it,
 *   or far from where the local match put it, starts again there (`refound`);
 * - a thing the local match follows, at rest, that the GPU has lost is
 *   handed back to the GPU at the local box.
 */
export const GPU_TRACK = {
  /** The GPU's score a box needs to correct the local track. */
  sureScore: 0.8,
  /** Overlap with its previous GPU box for it to count as steady, not mid-carry. */
  steadyIoU: 0.7,
  /** Overlap with the local box below which the two disagree. */
  disagreeIoU: 0.3,
  /** How long before the same thing is handed back to the GPU again, ms. */
  reseedGapMs: 10_000,
  /** Without a result for this long the GPU tracker is behind, ms: it sends one a second even on a still desk. */
  staleMs: 5000,
  /** How long a sure GPU box stands in for the local match, ms: just over the node's one a second. */
  freshMs: 1500,
  /** How often each thing's GPU box is checked against its own look on this machine, ms. */
  verifyMs: 1000,
} as const;

/** One thing in a GPU tracker result, as the node sends it. */
export interface GpuSeen {
  id: string;
  seen: boolean;
  score: number;
  box?: UnitBox;
}

interface GpuCorrections {
  /** Local tracks to start again at the GPU's box. */
  local: { id: string; box: UnitBox }[];
  /** Things to hand back to the GPU at the local box. */
  reseed: { id: string; box: UnitBox }[];
}

/**
 * What one GPU result changes. `previous` is the GPU's last box for each
 * thing, `held` the things being looked for by SAM or the whole-frame search
 * (left alone meanwhile), `reseededAt` when each was last handed back.
 */
export function gpuCorrections(
  things: WatchThing[],
  seen: GpuSeen[],
  previous: ReadonlyMap<string, UnitBox>,
  held: ReadonlySet<string>,
  reseededAt: ReadonlyMap<string, number>,
  now: number,
): GpuCorrections {
  const byId = new Map(seen.map((s) => [s.id, s]));
  const local: GpuCorrections['local'] = [];
  const reseed: GpuCorrections['reseed'] = [];
  for (const thing of things) {
    const id = thing.subject.id;
    if (held.has(id)) continue;
    const gpu = byId.get(id);
    const before = previous.get(id);
    if (gpu?.seen && gpu.box && gpu.score >= GPU_TRACK.sureScore) {
      const steady = before !== undefined && boxIoU(before, gpu.box) >= GPU_TRACK.steadyIoU;
      if (!steady) continue;
      const lost = thing.status !== 'following' || thing.track.lostSteps > 0;
      if (lost || boxIoU(thing.track.box, gpu.box) < GPU_TRACK.disagreeIoU)
        local.push({ id, box: gpu.box });
      continue;
    }
    const resting =
      thing.status === 'following' &&
      !thing.track.lostSteps &&
      thing.track.stillSteps >= WATCH.quietSteps;
    if (resting && now - (reseededAt.get(id) ?? -Infinity) >= GPU_TRACK.reseedGapMs)
      reseed.push({ id, box: thing.track.box });
  }
  // Two corrections onto one place: neither is trusted.
  const clear = local.filter(
    (a) => !local.some((b) => b !== a && boxIoU(a.box, b.box) >= LOCAL_TRACK.claimIoU),
  );
  return { local: clear, reseed };
}

/**
 * Where the GPU tracker sees things now, for the local match to take as they
 * are (`watchFrame`'s `given`): its sure boxes no older than `freshMs`. A thing
 * missing here is matched on this machine as before.
 */
export function gpuGiven(
  seen: ReadonlyMap<string, { box: UnitBox; at: number }>,
  now: number,
): Map<string, UnitBox> {
  const given = new Map<string, UnitBox>();
  for (const [id, { box, at }] of seen) if (now - at <= GPU_TRACK.freshMs) given.set(id, box);
  return given;
}

/**
 * Where this machine sees a thing, when that is clearly not where the GPU
 * tracker says: the thing's own template (cut from its SAM-confirmed look)
 * found surely around the GPU's box, and away from it. Its mask's own score
 * can't say this: SAM 2 is as sure of a mug's shadow as of the mug. Null when
 * they agree, or when the template isn't sure (a turned mug): the GPU stands.
 */
export function gpuOverruled(thing: WatchThing, frame: LumaFrame, given: UnitBox): UnitBox | null {
  const match = matchTemplate(frame, thing.track.template, given);
  if (!match || match.score < LOCAL_TRACK.lostScore || match.lead < LOCAL_TRACK.minLead)
    return null;
  return boxIoU(match.box, given) < GPU_TRACK.disagreeIoU ? match.box : null;
}

/**
 * The watcher's health with the GPU tracker as its backend. Its own numbers
 * stay this machine's (the local match still runs on every frame), but the
 * verdict says what the GPU tracker is doing: connecting, unavailable, or
 * behind. This machine's own stall comes first: no camera frames is the cause.
 */
export function gpuHealth(health: TrackHealth, gpu: GpuTrackerView): TrackHealth {
  if (health.verdict === 'stalled') return health;
  if (gpu.state === 'connecting')
    return { ...health, verdict: 'waiting', reason: 'GPU tracker connecting' };
  if (gpu.state === 'error')
    return {
      ...health,
      verdict: 'stalled',
      reason: `GPU tracker unavailable, following on this machine: ${gpu.note}`,
    };
  if (gpu.sinceMs !== null && gpu.sinceMs > GPU_TRACK.staleMs)
    return {
      ...health,
      verdict: 'lagging',
      reason: `No GPU result for ${Math.round(gpu.sinceMs / 1000)} s`,
    };
  return health;
}

/** The GPU tracker in the lab's watch summary: whether it follows, how fast, and what it fixed. */
export function gpuTrackerLine(gpu: GpuTrackerView): string {
  if (gpu.state === 'connecting') return 'GPU tracker connecting';
  if (gpu.state === 'error') return `GPU tracker unavailable: ${gpu.note}`;
  const speed = gpu.ms === null ? '' : ` ${Math.round(gpu.ms)} ms, ${gpu.rate}/s`;
  return `GPU tracker${speed} · ${gpu.fixes} fixed by GPU`;
}
