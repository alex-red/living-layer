import { z } from 'zod';
import type { DemoPosition } from './demo-room.js';

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
/** Two usages summed; either may be missing. */
export function addUsage(a: Usage | null, b: Usage | null | undefined): Usage | null {
  if (!b) return a;
  if (!a) return b;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
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
  | 'assist'
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
  /**
   * Home Assistant, for switching: `connected` once `.env` has its URL and a
   * token or someone signed in from the lab, `enabled` unless switching is off. `fromEnv` are the devices
   * `.env` names, `chosen` the ones ticked in the lab, `overMqtt` the
   * `MQTT_DEVICES` (switched without Home Assistant).
   */
  ha: {
    connected: boolean;
    url: string;
    /** How it's connected: `.env`'s token, a sign-in from the lab, or not at all. */
    via: 'env' | 'login' | null;
    /** The Home Assistant user signed in from the lab. */
    user: string;
    enabled: boolean;
    fromEnv: string[];
    chosen: string[];
    overMqtt: string[];
  };
  /** The MQTT broker entities are published to. `state` never carries credentials. */
  mqtt: Readiness & { state: 'off' | 'connecting' | 'connected' | 'error' };
  liveEvidence: { text: boolean; discover: boolean; segment: boolean; lamp: boolean };
  /** Where SAM 3D runs for refining a fixture's shape (experimental), or null when it can't. */
  sam3d: 'local' | 'fal' | null;
}

export const MAX_IMAGE_PIXELS = 4_000_000;
export const MAX_MASK_PIXELS = 4_000_000;
const DEMO_ID = 'corner-office-v1';
/** Each demo position is its own source image, as a new photo would be. */
export function demoSourceKey(position: DemoPosition = 'centre'): string {
  return position === 'centre' ? DEMO_ID : `${DEMO_ID}@${position}`;
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
