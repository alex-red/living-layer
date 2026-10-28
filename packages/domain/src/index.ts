import { z } from 'zod';

export const modeSchema = z.enum(['fixture', 'live']);
export type Mode = z.infer<typeof modeSchema>;
export const sceneSchema = z
  .object({
    summary: z.string().max(400),
    objects: z
      .array(
        z
          .object({
            label: z.string().min(1).max(80),
            category: z.string().min(1).max(60),
            appearance: z.string().max(160),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();
export type Scene = z.infer<typeof sceneSchema>;

export const imageRequestSchema = z
  .object({
    mode: modeSchema,
    imageDataUrl: z.string().max(7_000_000).optional(),
  })
  .strict();
/**
 * Where the fixture mug sits. The illustrated desk is redrawn with the mug
 * offset by this many frame pixels, and the synthetic mask moves with it, so
 * the tracking loop can be tested without a camera or any model call.
 */
export const FIXTURE_POSITIONS = {
  centre: { label: 'Centre', dx: 0, dy: 0 },
  right: { label: 'Right', dx: 100, dy: -20 },
  front: { label: 'Front left', dx: -50, dy: 110 },
} as const;
export type FixturePosition = keyof typeof FIXTURE_POSITIONS;
export const fixturePositionSchema = z.enum(['centre', 'right', 'front']);
export const segmentRequestSchema = imageRequestSchema
  .extend({
    concept: z.string().trim().min(1).max(80),
    fixturePosition: fixturePositionSchema.optional(),
  })
  .strict();

export interface Detection {
  objectId: string;
  confidence: number | null;
  box: { x: number; y: number; width: number; height: number };
  mask: { width: number; height: number; foregroundPixels: number; svgPath: string };
}
export interface Segmentation {
  sourceKey?: string;
  concept: string;
  frame: { width: number; height: number };
  detections: Detection[];
}
export interface LampResult {
  entityId: string;
  accepted: boolean;
  stateConfirmed: boolean;
  physicalEffectVerified: false;
  state: string;
  desired: { brightness_pct?: number; color_temp_kelvin?: number };
  explanation: string;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export type RunKind =
  'text' | 'discover' | 'segment' | 'lamp' | 'observation' | 'zone' | 'placement';
export interface EvidenceRun<T = unknown> {
  id: string;
  kind: RunKind;
  mode: Mode;
  status: 'completed' | 'no_match' | 'unconfirmed' | 'failed';
  createdAt: string;
  durationMs: number;
  model: string | null;
  requestId: string | null;
  promptVersion: string;
  usage: Usage | null;
  output: T;
  assets: string[];
}
export interface Readiness {
  configured: boolean;
  enabled: boolean;
  note: string;
}
export type BilledKind = 'text' | 'discover' | 'segment';
export interface CostEstimate {
  usd: number;
  /** `history`: median of past live runs. `list`: a flat list price. `guess`: no live runs yet. */
  basis: 'history' | 'list' | 'guess';
  samples: number;
}
export interface LabStatus {
  meta: Readiness & {
    usedToday: number;
    requestLimit: number;
    sparkModel: string;
    samModel: string;
    /** What one more call of each kind is likely to cost. */
    estimates: Record<BilledKind, CostEstimate>;
    /** Estimated spend on today's live calls (UTC), from recorded usage. */
    spentToday: number;
  };
  lamp: Readiness;
  liveEvidence: { text: boolean; discover: boolean; segment: boolean; lamp: boolean };
}
export interface ApiFailure {
  error: { code: string; message: string; runId?: string };
}

export const MAX_IMAGE_PIXELS = 4_000_000;
export const MAX_MASK_PIXELS = 4_000_000;
export const FIXTURE_ID = 'illustrated-desk-v1';
/** Each fixture position is its own source image, as a new photo would be. */
export function fixtureSourceKey(position: FixturePosition = 'centre'): string {
  return position === 'centre' ? FIXTURE_ID : `${FIXTURE_ID}@${position}`;
}

/**
 * Meta's published list prices in USD, from dev.meta.ai/docs/pricing-rate-limits.
 * Every Standard Spark version costs the same; SAM bills per image, not per token.
 */
export const META_PRICES = {
  checked: '2026-10-27',
  sparkPerMillion: { input: 1.25, output: 4.25 },
  samPerImage: 0.0025,
} as const;
/**
 * Spark usage to assume before any live run exists. Meta doesn't publish how
 * many tokens an image costs, so the discover guess allows for a ~1280 px frame
 * plus reasoning output.
 */
const SPARK_GUESS = {
  text: { input: 40, output: 200 },
  discover: { input: 2_000, output: 1_500 },
};
/** Estimated cost of one run from its recorded usage, or null when it isn't a billed call. */
export function runCost(run: Pick<EvidenceRun, 'kind' | 'mode' | 'usage'>): number | null {
  if (run.mode !== 'live') return null;
  if (run.kind === 'segment') return META_PRICES.samPerImage;
  if ((run.kind !== 'text' && run.kind !== 'discover') || !run.usage) return null;
  const { input, output } = META_PRICES.sparkPerMillion;
  return (run.usage.inputTokens * input + run.usage.outputTokens * output) / 1_000_000;
}
/** Likely cost of the next call of a kind: the median of past live runs, else a guess. */
export function estimateCost(kind: BilledKind, history: EvidenceRun[]): CostEstimate {
  if (kind === 'segment') return { usd: META_PRICES.samPerImage, basis: 'list', samples: 0 };
  const costs = history
    .filter((r) => r.kind === kind)
    .map(runCost)
    .filter((c): c is number => c !== null)
    .sort((a, b) => a - b);
  if (!costs.length) {
    const { input, output } = META_PRICES.sparkPerMillion;
    const guess = SPARK_GUESS[kind];
    return {
      usd: (guess.input * input + guess.output * output) / 1_000_000,
      basis: 'guess',
      samples: 0,
    };
  }
  const mid = Math.floor(costs.length / 2);
  const usd = costs.length % 2 ? costs[mid]! : (costs[mid - 1]! + costs[mid]!) / 2;
  return { usd, basis: 'history', samples: costs.length };
}

export function isMugConcept(concept: string): boolean {
  return /^(mug|cream mug|cup)$/i.test(concept.trim());
}

export function validBox(box: Detection['box'], width: number, height: number): boolean {
  return (
    Object.values(box).every(Number.isFinite) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= width &&
    box.y + box.height <= height
  );
}

// Source-normalized rectangles; the entire detection box must fit inside the zone.
export const zoneRectSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().min(0.01).max(1),
    height: z.number().finite().min(0.01).max(1),
  })
  .strict()
  .refine((r) => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001);
export type ZoneRect = z.infer<typeof zoneRectSchema>;
export interface DeskObservation {
  id: string;
  objectId: string;
  segmentRunId: string;
  detectionId: string;
  observedAt: string;
  sourceKey: string;
  frame: Segmentation['frame'];
  box: Detection['box'];
  /** `manual`: a person picked the mask. `tracked`: matched to the previous observation. */
  identity: 'manual' | 'tracked';
  /** Overlap (IoU) with the previous observation's box, when there was one. */
  overlap?: number | null;
}
export interface DeskMemory {
  mode: Mode;
  object: { id: string; label: string; createdAt: string } | null;
  observation: DeskObservation | null;
  /** `frame` is the size of the image the zone was drawn on; older zones lack it. */
  zone: { id: string; sourceKey: string; rect: ZoneRect; frame?: Segmentation['frame'] } | null;
  lastDecision: EvidenceRun<PlacementDecision> | null;
  /**
   * Opt-in: the camera hasn't moved, so a zone carries over to any new frame of
   * the same size. Off, a zone only applies to the exact image it was drawn on.
   */
  fixedCamera?: boolean;
  /** Earlier observations of the object, newest first. */
  history?: DeskObservation[];
  /** The last inside/outside verdict, so the lamp fires only on entering the zone. */
  placement?: 'inside' | 'outside' | null;
}
export interface PlacementDecision {
  observationId: string | null;
  objectId: string | null;
  segmentRunId: string | null;
  zoneId: string | null;
  decision: 'inside' | 'outside' | 'blocked';
  reason: string;
  action: 'none' | 'pending' | 'confirmed' | 'unconfirmed' | 'failed';
  /** How this verdict compares with the previous one. Absent when blocked. */
  transition?: 'entered' | 'stayed_inside' | 'left' | 'stayed_outside';
  /** The zone was drawn on another frame and applied because the camera is marked fixed. */
  assumedFixedCamera?: boolean;
  lamp?: LampResult;
  error?: { code: string; message: string };
}
export const OBSERVATION_MAX_AGE_MS = 5 * 60 * 1000;
/** True when the whole box (in frame pixels) fits inside the normalized zone. */
export function boxInZone(
  b: Detection['box'],
  frame: Segmentation['frame'],
  zone: ZoneRect,
): boolean {
  return (
    b.x / frame.width >= zone.x &&
    b.y / frame.height >= zone.y &&
    (b.x + b.width) / frame.width <= zone.x + zone.width &&
    (b.y + b.height) / frame.height <= zone.y + zone.height
  );
}
export const HISTORY_LIMIT = 12;
const normalize = (b: Detection['box'], f: Segmentation['frame']) => ({
  x: b.x / f.width,
  y: b.y / f.height,
  width: b.width / f.width,
  height: b.height / f.height,
});
/** Intersection over union of two boxes, each measured against its own frame. */
export function boxOverlap(
  a: Detection['box'],
  aFrame: Segmentation['frame'],
  b: Detection['box'],
  bFrame: Segmentation['frame'],
): number {
  const p = normalize(a, aFrame);
  const q = normalize(b, bFrame);
  const w = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x);
  const h = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y);
  const inter = Math.max(0, w) * Math.max(0, h);
  const union = p.width * p.height + q.width * q.height - inter;
  return union > 0 ? inter / union : 0;
}
/**
 * Pick which detection is the remembered object: the one overlapping its last
 * box most, or the nearest when none overlap. With no previous box, only a
 * lone detection is safe to take; several mean a person has to choose.
 */
export function pickTracked(
  detections: Detection[],
  frame: Segmentation['frame'],
  previous?: { box: Detection['box']; frame: Segmentation['frame'] },
): { detection: Detection; overlap: number | null } | null {
  if (!detections.length) return null;
  if (!previous)
    return detections.length === 1 ? { detection: detections[0]!, overlap: null } : null;
  const last = normalize(previous.box, previous.frame);
  const scored = detections.map((d) => {
    const n = normalize(d.box, frame);
    const distance = Math.hypot(
      n.x + n.width / 2 - (last.x + last.width / 2),
      n.y + n.height / 2 - (last.y + last.height / 2),
    );
    return { d, overlap: boxOverlap(d.box, frame, previous.box, previous.frame), distance };
  });
  scored.sort((a, b) => b.overlap - a.overlap || a.distance - b.distance);
  return { detection: scored[0]!.d, overlap: scored[0]!.overlap };
}
/** Whether the saved zone applies to the current observation, and whether only by assumption. */
export function zoneApplies(memory: DeskMemory): { applies: boolean; carried: boolean } {
  const o = memory.observation;
  const z = memory.zone;
  if (!o || !z) return { applies: false, carried: false };
  if (z.sourceKey === o.sourceKey) return { applies: true, carried: false };
  const sameSize = z.frame?.width === o.frame.width && z.frame?.height === o.frame.height;
  return memory.fixedCamera && sameSize
    ? { applies: true, carried: true }
    : { applies: false, carried: false };
}
export function placementGate(
  memory: DeskMemory,
  now = Date.now(),
): Pick<PlacementDecision, 'decision' | 'reason' | 'assumedFixedCamera'> {
  const o = memory.observation;
  const z = memory.zone;
  if (!o || !memory.object || o.objectId !== memory.object.id)
    return { decision: 'blocked', reason: 'Select and manually confirm a mug mask first.' };
  const age = now - Date.parse(o.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > OBSERVATION_MAX_AGE_MS)
    return {
      decision: 'blocked',
      reason: 'Observation is stale. Segment a new frame and confirm the mug.',
    };
  const zone = zoneApplies(memory);
  if (!z || !zone.applies)
    return {
      decision: 'blocked',
      reason: memory.fixedCamera
        ? 'Draw and save a zone on a frame of this size.'
        : 'Draw and save a zone on this observation image, or mark the camera as fixed.',
    };
  const who = o.identity === 'tracked' ? 'tracked' : 'manually confirmed';
  const assumption = zone.carried ? ' (zone carried over: camera assumed fixed)' : '';
  return boxInZone(o.box, o.frame, z.rect)
    ? {
        decision: 'inside',
        reason: `The ${who} mug box is fully inside the saved zone${assumption}.`,
        assumedFixedCamera: zone.carried,
      }
    : {
        decision: 'outside',
        reason: `The mug box is outside or crosses the zone boundary${assumption}. No lamp action.`,
        assumedFixedCamera: zone.carried,
      };
}
