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
export const segmentRequestSchema = imageRequestSchema
  .extend({
    concept: z.string().trim().min(1).max(80),
  })
  .strict();

export interface Detection {
  objectId: string;
  confidence: number | null;
  box: { x: number; y: number; width: number; height: number };
  mask: { width: number; height: number; foregroundPixels: number; svgPath: string };
}
export interface Segmentation {
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
export type RunKind = 'text' | 'discover' | 'segment' | 'lamp';
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
export interface LabStatus {
  meta: Readiness & {
    creditsConfirmed: boolean;
    usedToday: number;
    requestLimit: number;
    sparkModel: string;
    samModel: string;
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
