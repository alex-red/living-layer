import type { Segmentation } from './api.js';
import type { MergedFacts, sizeDisagreement } from './facts.js';
import type { EditIntent } from './intent.js';
import type { RecipeCheck, RecipePlace } from './recipe-build.js';
import type { RecipeOp } from './recipe-ops.js';
import type { IsoItem } from './iso-item.js';
import type { FixtureRecipe } from './recipe.js';
import type { RelatedThing, Resolved, SelectionShape, SelectionTarget } from './selection.js';

/**
 * What the AI brush's routes answer, shared by the server and the page
 * ([plan](../../../docs/plans/ai-brush.md)).
 */

/** `POST /api/select/resolve`: what a selection points at, read against this frame. */
export interface SelectResolve extends Resolved {
  frame: Segmentation['frame'];
  /** The target already has a model to edit (a saved recipe), so edits make sense from the start. */
  hasModel: boolean;
  /** What the target stands on and what stands on it. */
  related: RelatedThing[];
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
  /**
   * Set when the request makes a variant of a thing (`add_state`): its model
   * with the occupant drawn in, kept as one of the thing's states, not in the
   * room in its place. `recipe` and `place` stay unset.
   */
  variant?: {
    subject: SelectionTarget;
    state: string;
    occupant: SelectionTarget | null;
    /** The variant's model, in the thing's own frame before its turns. */
    model: IsoItem;
    /** Its footprint and height in tiles before turning, as `Fixture.size`. */
    size: { w: number; d: number; h: number };
    /** The subject is furniture of the layout, made a thing when this is kept (`promoteGroup`). */
    promotes: boolean;
    /** Shown while the thing's occupied stat is on, which keeping it turns on. */
    follows: boolean;
  } | null;
}
