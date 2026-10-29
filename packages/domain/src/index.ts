import { z } from 'zod';
import type { IsoScene, SurfacePin } from './iso.js';
import type { SceneIllustration } from './illustration.js';
import type { SavedItem } from './iso-item.js';
import { entityIdSchema, type Fixture } from './fixture.js';

export const modeSchema = z.enum(['demo', 'live']);
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
 * Where the demo mug sits. The illustrated desk is redrawn with the mug
 * offset by this many frame pixels, and the synthetic mask moves with it, so
 * the tracking loop can be tested without a camera or any model call.
 */
export const DEMO_POSITIONS = {
  centre: { label: 'Centre', dx: 0, dy: 0 },
  right: { label: 'Right', dx: 100, dy: -20 },
  front: { label: 'Front left', dx: -50, dy: 110 },
} as const;
export type DemoPosition = keyof typeof DEMO_POSITIONS;
export const demoPositionSchema = z.enum(['centre', 'right', 'front']);
export const segmentRequestSchema = imageRequestSchema
  .extend({
    concept: z.string().trim().min(1).max(80),
    demoPosition: demoPositionSchema.optional(),
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
  /** What was asked for; results from before switches could be turned off lack it. */
  action?: 'on' | 'off';
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
  | 'text'
  | 'discover'
  | 'segment'
  | 'scene'
  | 'layout'
  | 'photo'
  | 'illustration'
  | 'item'
  | 'fixture'
  | 'lamp'
  | 'observation'
  | 'zone'
  | 'placement';
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
/**
 * What went wrong in a call to an AI provider, as far as it is safe to show:
 * the stop reason, status and codes, never the provider's free text, keys or inputs.
 */
export interface ProviderFailure {
  provider: 'Spark' | 'SAM' | 'Meta';
  /** What the call was for, such as "photo inventory". */
  step?: string;
  model?: string | null;
  requestId?: string | null;
  /** The HTTP status, when the provider answered with an error. */
  httpStatus?: number;
  /** Why the response stopped: max_output_tokens, content_filter, failed… */
  reason?: string;
  /** The provider's error code or type, when it is an identifier. Free text is never kept. */
  providerCode?: string;
  usage?: Usage | null;
  /** The output-token limit the call was made with. */
  maxOutputTokens?: number;
}
/** A failed run's output. */
export interface RunFailure {
  error: { code: string; message: string; detail?: ProviderFailure };
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
    /** Outbound attempts today (UTC), failures included. Informational: spend is the cap. */
    usedToday: number;
    /** The most today's live calls may cost, in USD; a call that could pass it is refused. */
    spendLimit: number;
    /** The limit `.env` sets, which `spendLimit` overrides once someone changes it in the lab. */
    defaultSpendLimit: number;
    sparkModel: string;
    samModel: string;
    /** What one more call of each kind is likely to cost. */
    estimates: Record<BilledKind, CostEstimate>;
    /** Estimated spend on today's live calls (UTC), from each call's recorded usage. */
    spentToday: number;
  };
  /**
   * `lights`: every light entity rules may switch, the main one first.
   * `switches`: every switch entity fixtures and rules may turn on and off.
   */
  lamp: Readiness & { lights: string[]; switches: string[] };
  liveEvidence: { text: boolean; discover: boolean; segment: boolean; lamp: boolean };
}
export interface ApiFailure {
  error: { code: string; message: string; runId?: string };
}

export const MAX_IMAGE_PIXELS = 4_000_000;
export const MAX_MASK_PIXELS = 4_000_000;
export const DEMO_ID = 'illustrated-desk-v1';
/** Each demo position is its own source image, as a new photo would be. */
export function demoSourceKey(position: DemoPosition = 'centre'): string {
  return position === 'centre' ? DEMO_ID : `${DEMO_ID}@${position}`;
}

/**
 * Meta's published list prices in USD, from dev.meta.ai/docs/pricing-rate-limits.
 * Every Standard Spark version costs the same; SAM bills per image, not per token.
 */
export const META_PRICES = {
  checked: '2026-10-27',
  sparkPerMillion: { input: 1.25, output: 4.25 },
  samPerImage: 0.0025,
  /** Muse Image bills per image returned, whatever the reasoning or tools. */
  imagePerImage: 0.01,
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
/** What Spark usage costs at list price. */
export function sparkCost(usage: Usage | null | undefined): number {
  if (!usage) return 0;
  const { input, output } = META_PRICES.sparkPerMillion;
  return (usage.inputTokens * input + usage.outputTokens * output) / 1_000_000;
}
/** Input tokens to allow per image before a call; a ~1280 px photo has measured ~1.5k. */
const SPARK_IMAGE_TOKENS = 3_000;
/**
 * The most one Spark call can cost: every output token it is allowed, and
 * generous input for its images and prompt. The spend limit refuses a call
 * when this could pass it, so the limit holds even if the call runs long.
 */
export function sparkCeiling(maxOutputTokens: number, images: number): number {
  return sparkCost({
    inputTokens: images * SPARK_IMAGE_TOKENS + 2_000,
    outputTokens: maxOutputTokens,
    totalTokens: 0,
  });
}
/** Estimated cost of one run from its recorded usage, or null when it isn't a billed call. */
export function runCost(run: Pick<EvidenceRun, 'kind' | 'mode' | 'usage'>): number | null {
  if (run.mode !== 'live') return null;
  if (run.kind === 'segment') return META_PRICES.samPerImage;
  if (run.kind === 'illustration') return META_PRICES.imagePerImage;
  if (
    !['text', 'discover', 'scene', 'layout', 'item', 'photo', 'fixture'].includes(run.kind) ||
    !run.usage
  )
    return null;
  return sparkCost(run.usage);
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
  /** Corners that tie frames of one size to a surface of an isometric scene. */
  surface?: SurfacePin | null;
  /** Further remembered objects, each followed like the mug. */
  others?: TrackedObject[];
  /** Further zones, each tied to one object and one light or switch. */
  rules?: PlacementRule[];
  /** The person's own isometric scene, built from templates or drafted by Spark. */
  scene?: IsoScene | null;
  /** The photo that scene was drafted from, as an evidence asset (live only). */
  scenePhoto?: string | null;
  /** A clean isometric picture of that scene's room, drawn from its photo. */
  illustration?: SceneIllustration | null;
  /** The room's desk close up, redrawn from a close camera frame in the room picture's style. */
  deskIllustration?: SceneIllustration | null;
  /** A detailed model of the remembered object, drafted from its mask and editable. */
  item?: SavedItem | null;
  /** Things placed in a room by hand: lamps, switches, a mouse. Reset keeps them. */
  fixtures?: Fixture[];
  /** Names the person said aren't fixtures, so scans skip them. */
  dismissed?: string[];
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
  /** Set when an extra placement rule, not the main zone, made this decision. */
  ruleId?: string;
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
  return zoneAppliesTo(memory.observation, memory.zone, memory.fixedCamera);
}
/** Whether a zone applies to an observation: the same image, or by the fixed-camera assumption. */
export function zoneAppliesTo(
  o: DeskObservation | null | undefined,
  z: { sourceKey: string; frame?: Segmentation['frame'] } | null | undefined,
  fixedCamera = false,
): { applies: boolean; carried: boolean } {
  if (!o || !z) return { applies: false, carried: false };
  if (z.sourceKey === o.sourceKey) return { applies: true, carried: false };
  const sameSize = z.frame?.width === o.frame.width && z.frame?.height === o.frame.height;
  return fixedCamera && sameSize
    ? { applies: true, carried: true }
    : { applies: false, carried: false };
}

/** Another remembered object, beside the mug. Any concept SAM can segment. */
export interface TrackedObject {
  id: string;
  label: string;
  /** The SAM concept it was confirmed from; tracking only follows the same one. */
  concept: string;
  createdAt: string;
  observation: DeskObservation | null;
  history?: DeskObservation[];
  item?: SavedItem | null;
}
/** A zone beyond the main one: when `objectId` enters it, switch `entityId` on. */
export interface PlacementRule {
  id: string;
  label: string;
  objectId: string;
  /** A light or a switch. */
  entityId: string;
  /** The fixture the entity was picked as, when it was picked as one. */
  fixtureId?: string;
  zone: { sourceKey: string; rect: ZoneRect; frame: Segmentation['frame'] };
  placement?: 'inside' | 'outside' | null;
  lastDecision?: EvidenceRun<PlacementDecision> | null;
}
export const MAX_OTHER_OBJECTS = 4;
export const MAX_RULES = 8;
/** Virtual lights in demo mode. The first stands for the main desk lamp. */
export const DEMO_LIGHTS = ['light.demo_desk', 'light.demo_shelf', 'light.demo_fridge'];
/** Virtual switches in demo mode, for fixtures like a fan or a monitor. */
export const DEMO_SWITCHES = ['switch.demo_fan', 'switch.demo_monitor'];
export const ruleInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    label: z.string().trim().min(1).max(40),
    objectId: z.string().uuid(),
    entityId: entityIdSchema,
    fixtureId: z.string().uuid().optional(),
    rect: zoneRectSchema,
  })
  .strict();
/** The observation and name of the mug or another remembered object, by id. */
export function objectById(
  memory: DeskMemory,
  objectId: string,
): { label: string; concept: string; observation: DeskObservation | null } | null {
  if (memory.object?.id === objectId)
    return { label: memory.object.label, concept: 'mug', observation: memory.observation };
  const other = memory.others?.find((o) => o.id === objectId);
  return other
    ? { label: other.label, concept: other.concept, observation: other.observation }
    : null;
}
/** The mug (no id, or its id), another remembered object or a fixture, with its model. */
export function modelTarget(
  memory: DeskMemory,
  objectId?: string,
): {
  id: string;
  label: string;
  observation: DeskObservation | null;
  item: SavedItem | null;
  /** A fixture is never seen by the camera: its model comes from its reference photo. */
  fixture?: boolean;
} | null {
  if (!objectId || objectId === memory.object?.id)
    return memory.object
      ? {
          id: memory.object.id,
          label: memory.object.label,
          observation: memory.observation,
          item: memory.item ?? null,
        }
      : null;
  const other = memory.others?.find((o) => o.id === objectId);
  if (other)
    return {
      id: other.id,
      label: other.label,
      observation: other.observation,
      item: other.item ?? null,
    };
  const fixture = memory.fixtures?.find((f) => f.id === objectId);
  return fixture
    ? {
        id: fixture.id,
        label: fixture.label,
        observation: null,
        item: fixture.model,
        fixture: true,
      }
    : null;
}
/** Store a model on the mug, another remembered object, or a fixture (which always keeps one). */
export function setModel(memory: DeskMemory, objectId: string, item: SavedItem | null): void {
  if (objectId === memory.object?.id) memory.item = item;
  else {
    const other = memory.others?.find((o) => o.id === objectId);
    if (other) other.item = item;
    const fixture = memory.fixtures?.find((f) => f.id === objectId);
    if (fixture && item) {
      fixture.model = item;
      fixture.updatedAt = new Date().toISOString();
    }
  }
}
/** The placement rule for one extra zone; the same checks as the main one. */
export function ruleGate(
  memory: DeskMemory,
  rule: PlacementRule,
  now = Date.now(),
): Pick<PlacementDecision, 'decision' | 'reason' | 'assumedFixedCamera'> {
  const target = objectById(memory, rule.objectId);
  const o = target?.observation;
  if (!target || !o)
    return {
      decision: 'blocked',
      reason: `Confirm the ${target?.label ?? 'object'} in a segmentation first.`,
    };
  const age = now - Date.parse(o.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > OBSERVATION_MAX_AGE_MS)
    return {
      decision: 'blocked',
      reason: `The last sighting of the ${target.label} is stale. Track it in a new frame.`,
    };
  const zone = zoneAppliesTo(o, rule.zone, memory.fixedCamera);
  if (!zone.applies)
    return {
      decision: 'blocked',
      reason: memory.fixedCamera
        ? `The zone "${rule.label}" was drawn on a frame of another size.`
        : `The zone "${rule.label}" was drawn on another image. Mark the camera as fixed to carry it over.`,
    };
  const assumption = zone.carried ? ' (zone carried over: camera assumed fixed)' : '';
  return boxInZone(o.box, o.frame, rule.zone.rect)
    ? {
        decision: 'inside',
        reason: `The ${target.label} box is fully inside "${rule.label}"${assumption}.`,
        assumedFixedCamera: zone.carried,
      }
    : {
        decision: 'outside',
        reason: `The ${target.label} box is outside or crosses "${rule.label}"${assumption}.`,
        assumedFixedCamera: zone.carried,
      };
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
/**
 * Desk memory as saved by an earlier version: rules named only a light
 * (`lightId`) before they could target switches and fixtures.
 */
export function upgradeMemory(memory: DeskMemory): DeskMemory {
  if (!memory.rules?.some((r) => !r.entityId)) return memory;
  return {
    ...memory,
    rules: memory.rules.map((rule) => {
      if (rule.entityId) return rule;
      const { lightId, ...rest } = rule as PlacementRule & { lightId?: string };
      return { ...rest, entityId: lightId ?? '' };
    }),
  };
}
export * from './fixture.js';
export * from './tracker.js';
export * from './iso.js';
export * from './iso-item.js';
export * from './color.js';
export * from './iso-voxel.js';
export * from './iso-archetypes.js';
export * from './item-fit.js';
export * from './item-sculpt.js';
export * from './photo-scene.js';
export * from './photo-texture.js';
export * from './illustration.js';
export * from './fixture-scan.js';
