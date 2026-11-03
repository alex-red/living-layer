import type { EvidenceRun, LampResult, RunKind, Scene, Segmentation } from './api.js';
import type { AssistDraft } from './assist.js';
import type { FixtureDraft } from './fixture.js';
import type { FixtureScan, MappedThing } from './fixture-scan.js';
import type { PictureFind } from './illustration.js';
import type { IsoScene } from './iso.js';
import type { SavedItem } from './iso-item.js';
import type { SceneGuess } from './iso-presets.js';
import type { SceneDraft } from './iso-templates.js';
import type { PlacementDecision } from './memory.js';
import type { PhotoDraft } from './photo-scene.js';

/** A fixture run that scanned the room for things: what it mapped. */
export interface FixtureScanOutput {
  scan: FixtureScan;
  mapped: MappedThing[];
}
/** A fixture run where the AI modelled one: the model's size and how well its outline matches. */
export interface FixtureSculptOutput {
  sculpted: string;
  label: string;
  parts: number;
  iou: number;
  note?: string;
  product?: string | null;
}
/** A fixture run that fused another photo into the model. */
export interface FixtureFuseOutput {
  model: SavedItem;
  views: number;
  iou: number;
}
/** A fixture run where SAM 3D reshaped it. */
export interface FixtureRefineOutput {
  item: SavedItem;
  shaped: unknown;
  kept: boolean;
  iou: number;
}
/**
 * What a `fixture` run holds, by the field that tells them apart: a draft has
 * none of `scan`, `found`, `sculpted`, `views` or `shaped`, so `in` narrows.
 */
export type FixtureRunOutput =
  | FixtureDraft
  | FixtureScanOutput
  | PictureFind
  | FixtureSculptOutput
  | FixtureFuseOutput
  | FixtureRefineOutput;

/**
 * What a run's `output` holds, by its kind. A kind not listed has no single
 * shape worth naming (its output stays `unknown`).
 */
export interface RunOutputs {
  discover: Scene;
  segment: Segmentation;
  scene: SceneGuess;
  layout: { draft: SceneDraft; scene: IsoScene };
  photo: PhotoDraft;
  item: SavedItem;
  fixture: FixtureRunOutput;
  assist: AssistDraft;
  lamp: LampResult;
  placement: PlacementDecision;
}

/** A run of one kind, with its output typed. */
export type RunOf<K extends keyof RunOutputs> = EvidenceRun<RunOutputs[K]> & { kind: K };

/** Whether the run is of this kind; narrows its output to the kind's type. */
export function isRun<K extends keyof RunOutputs>(
  run: EvidenceRun | null | undefined,
  kind: K,
): run is RunOf<K> {
  return run?.kind === (kind satisfies RunKind);
}

/** The run's output if it is of this kind, else undefined. */
export function runOutput<K extends keyof RunOutputs>(
  run: EvidenceRun | null | undefined,
  kind: K,
): RunOutputs[K] | undefined {
  return isRun(run, kind) ? run.output : undefined;
}
