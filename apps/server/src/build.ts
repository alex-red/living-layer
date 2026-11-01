import { readIntent, RECIPE_OPS, type RecipeOp, type Refiner } from '@livinglayer/domain';
import type { MetaAdapter } from './meta.js';

/**
 * Spark as a recipe's refiner (`refineRecipe` in the domain): one billed
 * call per round, keeping only ops that change the recipe, as `readIntent`
 * checks them. Anything else Spark answers (a question, a new model) is
 * left out, and an empty list ends the rounds.
 */
export function sparkRefiner(
  meta: MetaAdapter,
  cropDataUrl?: string,
  signal?: AbortSignal,
): Refiner {
  return async (recipe, check) => {
    const raw = (await meta.refineRecipe(recipe, check, cropDataUrl, signal)).output;
    const { ops } = readIntent(raw, {
      target: { kind: 'fixture', id: 'draft', label: recipe.label },
      recipe,
      entities: [],
    });
    return ops.filter((o): o is RecipeOp => o.op in RECIPE_OPS);
  };
}
