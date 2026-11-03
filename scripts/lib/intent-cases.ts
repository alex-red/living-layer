/**
 * Requests typed beside a selection, and what reading them must give: the
 * ops in order, each matched by the fields given (others may be anything),
 * and the product. Shared by `tests/intent.test.ts` (the demo's reader) and
 * `bun run bench:intent` (the demo's, or Spark's with `--live`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  fixtureRecipeSchema,
  selectParts,
  type FactNeed,
  type IntentContext,
  type IntentOp,
  type PartSelector,
} from '@livinglayer/domain';

export const ALEX = fixtureRecipeSchema.parse(
  JSON.parse(
    readFileSync(resolve(import.meta.dir, '../../testdata/recipes/alex-desk.json'), 'utf8'),
  ),
);
const desk: IntentContext = {
  target: { kind: 'prop', id: 'desk', label: 'Desk' },
  recipe: null,
  entities: ['light.study'],
};
const fixture: IntentContext = {
  target: { kind: 'fixture', id: 'f1', label: 'IKEA Alex desk' },
  recipe: ALEX,
  entities: ['light.study'],
};
const nothing: IntentContext = { target: null, recipe: null, entities: [] };
const catTree = { kind: 'prop' as const, id: 'cat-tree', label: 'Cat tree' };
const cat = { kind: 'fixture' as const, id: 'cat', label: 'Cat' };
/** The cat selected, asleep on the tree's top platform. */
const catOnTree: IntentContext = {
  target: cat,
  recipe: null,
  entities: [],
  related: [{ target: catTree, relation: 'holds', surfaceId: 'cat-tree:platform-2' }],
};
/** The tree selected, with nothing on it. */
const bareTree: IntentContext = { target: catTree, recipe: null, entities: [] };

export interface IntentCase {
  name: string;
  sentence: string;
  ctx: IntentContext;
  ops: (Partial<IntentOp> & Pick<IntentOp, 'op'>)[];
  /** Words the product named must contain, or null for none. */
  product?: string[] | null;
  /** Expected fact needs, if judged. */
  needs?: FactNeed[];
}

function hasSelector(s: PartSelector | undefined): boolean {
  if (!s) return false;
  return Boolean(
    (s.names && s.names.length > 0) ||
    (s.roles && s.roles.length > 0) ||
    (s.materials && s.materials.length > 0) ||
    s.except,
  );
}

/** Checks each case against its context offline: selectors must match parts of the context's recipe. */
export function checkIntentCase(c: IntentCase): string[] {
  const problems: string[] = [];
  for (const o of c.ops) {
    const parts = (o as { parts?: PartSelector }).parts;
    if (!hasSelector(parts) || !parts) continue;
    if (!c.ctx.recipe) {
      problems.push(`op ${o.op} selector ${JSON.stringify(parts)} has no recipe in context`);
    } else {
      const matched = selectParts(c.ctx.recipe, parts);
      if (matched.length === 0) {
        problems.push(
          `op ${o.op} selector ${JSON.stringify(parts)} matches no part of recipe "${c.ctx.recipe.label}"`,
        );
      }
    }
  }
  return problems;
}
/**
 * Ops the demo's reader can't produce, so no case here can check them
 * offline. Each needs a reason; one that gets a case leaves this list
 * (`tests/op-coverage.test.ts` holds both to it).
 */
export const DEMO_GAPS: Partial<Record<IntentOp['op'], string>> = {
  add_part:
    'Spark measures the part to add from the crop; the demo has no pattern for sizes and places.',
  remove_part: 'Naming which part to remove needs the model’s parts; no demo pattern yet.',
  rebase: 'Read live only: “it is a table, not a desk” has no demo pattern yet.',
  match_photo: 'Shaping from the photo is live only (Spark reads the picture).',
};
export const INTENT_CASES: IntentCase[] = [
  {
    name: 'own fixture from a product',
    sentence: 'Turn this into its own office desk furniture/fixture - its an Ikea Alex Office Desk',
    ctx: desk,
    ops: [{ op: 'create', form: 'desk' }],
    product: ['ikea', 'alex'],
    needs: ['size', 'parts', 'colors'],
  },
  {
    name: 'own fixture, then green',
    sentence: 'Turn it into its own fixture and make it green',
    ctx: nothing,
    ops: [{ op: 'create' }, { op: 'recolor' }],
    product: null,
  },
  {
    name: 'whole model green',
    sentence: 'make this fixture green',
    ctx: fixture,
    ops: [{ op: 'recolor', parts: {} }],
  },
  {
    name: 'drawers, not handles',
    sentence: 'Make the drawers white but not the handles',
    ctx: fixture,
    ops: [{ op: 'recolor', parts: { roles: ['drawer'], except: { roles: ['handle'] } } }],
  },
  {
    name: 'two sizes',
    sentence: "It's 140 cm wide and 72 cm tall",
    ctx: fixture,
    ops: [{ op: 'resize', sizeCm: { w: 140, h: 72 } }],
    product: null,
  },
  {
    name: 'size in metres',
    sentence: 'it is 1.4 m wide',
    ctx: fixture,
    ops: [{ op: 'resize', sizeCm: { w: 140 } }],
  },
  {
    // The Alex stands on a side panel and its drawer unit, with no legs to name.
    name: 'metal side panel',
    sentence: 'the side panel is metal',
    ctx: fixture,
    ops: [{ op: 'rematerial', parts: { roles: ['panel'] }, material: 'metal' }],
  },
  {
    name: 'rename',
    sentence: 'call it the standing desk',
    ctx: fixture,
    ops: [{ op: 'rename', label: 'standing desk' }],
  },
  {
    name: 'a light',
    sentence: 'this is a light, light.study',
    ctx: fixture,
    ops: [{ op: 'set_control', control: { kind: 'light', entityId: 'light.study' } }],
    product: null,
  },
  {
    name: 'a light not configured',
    sentence: 'this is a light, light.kitchen',
    ctx: fixture,
    ops: [{ op: 'clarify' }],
  },
  {
    name: 'edit with no model yet',
    sentence: 'make it green',
    ctx: desk,
    ops: [{ op: 'clarify' }],
  },
  {
    name: 'occupied variant of what the cat is on',
    sentence: "let's make a variant of the tree that's occupied",
    ctx: catOnTree,
    ops: [{ op: 'add_state', subject: catTree, occupant: cat, state: 'occupied' }],
    product: null,
  },
  {
    name: 'taken, said another way',
    sentence: 'show the tree taken when the cat sleeps on it',
    ctx: catOnTree,
    ops: [{ op: 'add_state', subject: catTree, state: 'occupied' }],
  },
  {
    name: 'occupied with nothing on it',
    sentence: 'make a variant of the tree that is occupied',
    ctx: bareTree,
    ops: [{ op: 'clarify' }],
  },
  {
    name: 'off topic',
    sentence: "what's the weather like",
    ctx: fixture,
    ops: [{ op: 'clarify' }],
  },
];
