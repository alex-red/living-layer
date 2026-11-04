import type { EvidenceRun, LampResult, RunFailure, RunKind, Scene, Segmentation } from './api.js';
import type { AssistDraft } from './assist.js';
import type { RoomAnswer } from './room-ask.js';
import type { CoachCheck } from './room-coach.js';
import type { FixtureDraft, FixtureInput } from './fixture.js';
import type { FixtureScan, MappedThing } from './fixture-scan.js';
import type { PictureFind } from './illustration.js';
import type { IsoScene } from './iso.js';
import type { LatheFit } from './iso-archetypes.js';
import type { IsoItem, SavedItem } from './iso-item.js';
import type { SceneGuess } from './iso-presets.js';
import type { SceneDraft } from './iso-templates.js';
import type { PlacementDecision } from './memory.js';
import type { PhotoDraft } from './photo-scene.js';

/** A fixture run that scanned the room for things: what it mapped. */
interface FixtureScanOutput {
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
  /** The model itself, and the size in tiles it was given when a product was looked up. */
  item: IsoItem;
  size?: FixtureInput['size'];
  asked?: string;
  product?: string | null;
}
/** A fixture run where Spark changed its model as the person asked: a draft, not saved. */
export interface FixtureEditOutput {
  edited: string;
  label: string;
  prompt: string;
  note: string;
  parts: number;
  item: IsoItem;
}
/** A fixture run that fused another photo into the model. */
interface FixtureFuseOutput {
  fixtureId: string;
  model: SavedItem;
  views: number;
  iou: number;
}
/** A fixture run where SAM 3D reshaped it. */
interface FixtureRefineOutput {
  item: IsoItem;
  shaped: LatheFit;
  kept: boolean;
  iou: number;
  deltaE: number;
}
/**
 * What a `fixture` run holds, by the field that tells them apart: a draft has
 * none of `scan`, `found`, `sculpted`, `edited`, `views` or `shaped`, so `in` narrows.
 */
type FixtureRunOutput =
  | FixtureDraft
  | FixtureScanOutput
  | PictureFind
  | FixtureSculptOutput
  | FixtureEditOutput
  | FixtureFuseOutput
  | FixtureRefineOutput;

/** An illustration run: the drawn picture, or the base and sprites cut from it. */
type IllustrationRunOutput =
  | { asset: string }
  | { base: string; sprites: number; skipped: string[] };

/**
 * What a run's `output` holds, by its kind. A kind not listed has no single
 * shape worth naming (its output stays `unknown`).
 */
interface RunOutputs {
  discover: Scene;
  segment: Segmentation;
  scene: SceneGuess;
  layout: { draft: SceneDraft; scene: IsoScene };
  photo: PhotoDraft;
  illustration: IllustrationRunOutput;
  item: SavedItem;
  fixture: FixtureRunOutput;
  assist: AssistDraft;
  ask: RoomAnswer;
  coach: CoachCheck;
  lamp: LampResult;
  placement: PlacementDecision;
}

/** What a run of this kind outputs: its named shape, else `unknown`. */
export type RunKindOutput<K extends RunKind> = K extends keyof RunOutputs ? RunOutputs[K] : unknown;

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

/** What a fixture run kept, narrowed by the field that tells the shapes apart. */
export const fixtureOutput = {
  draft(run: EvidenceRun | null | undefined): FixtureDraft | undefined {
    const o = runOutput(run, 'fixture');
    return o &&
      !(
        'scan' in o ||
        'found' in o ||
        'sculpted' in o ||
        'edited' in o ||
        'views' in o ||
        'shaped' in o
      )
      ? o
      : undefined;
  },
  scan(run: EvidenceRun | null | undefined): FixtureScanOutput | undefined {
    const o = runOutput(run, 'fixture');
    return o && 'scan' in o ? o : undefined;
  },
  sculpt(run: EvidenceRun | null | undefined): FixtureSculptOutput | undefined {
    const o = runOutput(run, 'fixture');
    return o && 'sculpted' in o ? o : undefined;
  },
  edit(run: EvidenceRun | null | undefined): FixtureEditOutput | undefined {
    const o = runOutput(run, 'fixture');
    return o && 'edited' in o ? o : undefined;
  },
  fuse(run: EvidenceRun | null | undefined): FixtureFuseOutput | undefined {
    const o = runOutput(run, 'fixture');
    return o && 'views' in o && 'model' in o ? o : undefined;
  },
  refine(run: EvidenceRun | null | undefined): FixtureRefineOutput | undefined {
    const o = runOutput(run, 'fixture');
    return o && 'shaped' in o ? o : undefined;
  },
};

/** Why a failed run failed: the error the runner stored as its output. */
export function runFailure(run: EvidenceRun | null | undefined): RunFailure['error'] | undefined {
  const out = run?.status === 'failed' ? run.output : null;
  if (typeof out !== 'object' || out === null || !('error' in out)) return undefined;
  // A failed run's output is a `RunFailure` by construction (createRunner), whatever its kind.
  return out.error as RunFailure['error'];
}
