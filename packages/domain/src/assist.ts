import type { Segmentation } from './index.js';
import type { MergedFacts, sizeDisagreement } from './facts.js';
import type { EditIntent } from './intent.js';
import type { RecipeCheck, RecipePlace } from './recipe-build.js';
import type { RecipeOp } from './recipe-ops.js';
import type { FixtureRecipe } from './recipe.js';
import type { Resolved, SelectionShape } from './selection.js';

/**
 * What the AI brush's routes answer, shared by the server and the page
 * ([plan](../../../docs/plans/ai-brush.md)).
 */

/** `POST /api/select/resolve`: what a selection points at, read against this frame. */
export interface SelectResolve extends Resolved {
  frame: Segmentation['frame'];
  /** The target already has a model to edit (a saved recipe), so edits make sense from the start. */
  hasModel: boolean;
}

/** `POST /api/assist`: an `assist` run's output, a draft for the person to review. */
export interface AssistDraft {
  shape: SelectionShape;
  prompt: string;
  /** The run this one followed, when it was a follow-up. */
  previous: string | null;
  frame: Segmentation['frame'];
  target: Resolved['target'];
  candidates: Resolved['candidates'];
  ambiguous: boolean;
  intent: EditIntent & { dropped: string[] };
  /** Set when the request needs answering before anything is done. */
  question: string | null;
  facts: MergedFacts | null;
  /** The camera's own estimate of the thing, when it stands on the floor. */
  photo: {
    sizeCm: { w: number; d: number; h: number } | null;
    color: string | null;
  };
  /** Axes where the facts and the camera disagree by more than a quarter. */
  disagreement: ReturnType<typeof sizeDisagreement>;
  recipe: FixtureRecipe | null;
  place: RecipePlace | null;
  /**
   * How the place was fitted to SAM's whole outline through the camera, when
   * a new model took an old one's place: IoU before and after, how far its
   * middle moved in centimetres, whether it was turned half way round (older
   * runs) and whether it was mirrored left for right.
   * Absent or null when it stands where the old one did.
   */
  fit?: {
    from: number;
    iou: number;
    movedCm: { x: number; y: number };
    turned: boolean;
    mirrored?: boolean;
  } | null;
  check: RecipeCheck | null;
  /** Refinement rounds after the first check, and the ops each applied. */
  rounds: RecipeOp[][];
}
