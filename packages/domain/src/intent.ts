import { z } from 'zod';
import { FACT_NEEDS, type FactNeed } from './facts.js';
import { fixtureControlSchema, type FixtureControl } from './fixture.js';
import { PROP_FORMS, type PropForm } from './iso-furniture.js';
import { hexColorSchema, ITEM_MATERIALS } from './iso-item.js';
import { RECIPE_OPS, recipeOpSchema, type RecipeOp } from './recipe-ops.js';
import { RECIPE_ROLES, recipePartSchema, type FixtureRecipe } from './recipe.js';
import { sameThing, thingRef, type RelatedThing, type SelectionTarget } from './selection.js';

/**
 * What a sentence typed beside a selection asks for
 * ([plan](../../../docs/plans/ai-brush.md#4-intent-what-the-sentence-asks-for)):
 * a short list of ops, the product named (to look up), and what facts that
 * needs. Recipe ops change a model (recipe-ops.ts); intent ops make one,
 * change a fixture, or ask back. Spark answers in `sparkIntentSchema`, flat
 * so a strict schema holds it, and `readIntent` turns that into typed ops,
 * keeping only what can be done and saying why the rest can't.
 */
export const INTENT_KINDS = [
  'create',
  'rebase',
  'match_photo',
  'set_control',
  'add_state',
  'clarify',
] as const;
type IntentKind = (typeof INTENT_KINDS)[number];
const MAX_INTENT_OPS = 4;

/** What each intent op is for, beside the recipe ops' own lines, for the parser's prompt. */
const INTENT_ABOUT: Record<IntentKind, string> = {
  create:
    'Make the selection its own model: a fixture or a piece of furniture (label; form: the built-in form it is closest to, if any; as: fixture or furniture).',
  rebase: 'Build the model again from another built-in form ("it is a table, not a desk").',
  match_photo:
    'Rebuild the model’s parts and colours from the camera’s picture of it, keeping its size, when the request is about how it looks overall ("make it look like the photo", "it is an open shelf with white shelves"). What the person describes is passed on with it, so use it instead of many small ops.',
  set_control:
    'Say what the fixture switches: none, or a light or switch entity from the list (control).',
  add_state:
    'Make a variant of a thing, kept as one of its states beside its own model and shown when it is in that state ("a variant of the tree that is occupied", the cat on it selected). Furniture is made a thing first. subject: the thing, by its ref from the list; occupant: what stands on it to draw into the variant where the camera sees it now, by ref, or null; state: the variant’s name, one or two words ("occupied").',
  clarify: 'Ask one short question back when the request is unclear. Never guess instead.',
};
/** A variant's name: lowercase words joined by -, as a fixture's states are named. */
const STATE_NAME = /^[a-z0-9-]{1,24}$/;
/** States a thing switches by its entity, not by a variant. */
const RESERVED = new Set(['on', 'off']);

export type IntentOp =
  | RecipeOp
  | { op: 'create'; label: string; form: PropForm | null; as: 'fixture' | 'furniture' | null }
  | { op: 'rebase'; form: PropForm }
  | { op: 'match_photo' }
  | { op: 'set_control'; control: FixtureControl }
  | {
      op: 'add_state';
      /** The thing that gets the variant; furniture is made a thing when it is kept. */
      subject: SelectionTarget;
      state: string;
      /** What stands on it, drawn into the variant where the camera sees it now. */
      occupant: SelectionTarget | null;
    }
  | { op: 'clarify'; question: string };

export interface EditIntent {
  ops: IntentOp[];
  /** A product to look up when one is named: "IKEA Alex desk". */
  product: string | null;
  needs: FactNeed[];
  /** Spark's own reading of the selection, when it isn't the target the camera found. */
  targetDisagrees: string | null;
}

const names = z.array(z.string().min(1).max(24)).max(24);
const roles = z.array(z.enum(RECIPE_ROLES)).max(RECIPE_ROLES.length);
const materials = z.array(z.enum(ITEM_MATERIALS)).max(ITEM_MATERIALS.length);
const cmOrNull = z.number().min(0.5).max(600).nullable();
/** One op as Spark writes it: every field present, null or empty when it doesn't apply. */
const sparkIntentOpSchema = z
  .object({
    op: z.enum([...(Object.keys(RECIPE_OPS) as RecipeOp['op'][]), ...INTENT_KINDS]),
    parts: z
      .object({ names, roles, materials, exceptNames: names, exceptRoles: roles })
      .strict()
      .nullable(),
    color: hexColorSchema.nullable(),
    material: z.enum(ITEM_MATERIALS).nullable(),
    sizeCm: z.object({ w: cmOrNull, d: cmOrNull, h: cmOrNull }).strict().nullable(),
    part: z
      .object({
        name: z.string().min(1).max(24),
        role: z.enum(RECIPE_ROLES).nullable(),
        atCm: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict(),
        sizeCm: z.object({ w: z.number(), d: z.number(), h: z.number() }).strict(),
        color: hexColorSchema.nullable(),
      })
      .strict()
      .nullable(),
    label: z.string().min(1).max(60).nullable(),
    form: z.enum(PROP_FORMS).nullable(),
    as: z.enum(['fixture', 'furniture']).nullable(),
    control: z
      .object({
        kind: z.enum(['none', 'light', 'switch']),
        entityId: z.string().max(80).nullable(),
      })
      .strict()
      .nullable(),
    question: z.string().min(1).max(200).nullable(),
    /** add_state: the things it is about, by ref (`prop:cat-tree`, `fixture:<id>`), and its name. */
    subject: z.string().min(1).max(80).nullable(),
    occupant: z.string().min(1).max(80).nullable(),
    state: z.string().min(1).max(24).nullable(),
  })
  .strict();
export type SparkIntentOp = z.infer<typeof sparkIntentOpSchema>;
export const sparkIntentSchema = z
  .object({
    ops: z.array(sparkIntentOpSchema).min(1).max(MAX_INTENT_OPS),
    product: z.string().min(1).max(120).nullable(),
    needs: z.array(z.enum(FACT_NEEDS)).max(FACT_NEEDS.length),
    targetDisagrees: z.string().min(1).max(120).nullable(),
  })
  .strict();
export type SparkIntent = z.infer<typeof sparkIntentSchema>;

/** What the parser knows about the selection, and what may be switched. */
export interface IntentContext {
  target: SelectionTarget | null;
  /** The target's model, when it has one to edit. */
  recipe: FixtureRecipe | null;
  /** Light and switch entities a fixture may be tied to. */
  entities: string[];
  /** What the target stands on and what stands on it (`relatedTargets`). */
  related?: RelatedThing[];
}

/**
 * A flat op as a typed one, or why it can't be done. `creating`: the same
 * request makes the model first, so its edits apply to that.
 */
function readOp(o: SparkIntentOp, ctx: IntentContext, creating: boolean): IntentOp | string {
  const selector = o.parts
    ? {
        ...(o.parts.names.length ? { names: o.parts.names } : {}),
        ...(o.parts.roles.length ? { roles: o.parts.roles } : {}),
        ...(o.parts.materials.length ? { materials: o.parts.materials } : {}),
        ...(o.parts.exceptNames.length || o.parts.exceptRoles.length
          ? {
              except: {
                ...(o.parts.exceptNames.length ? { names: o.parts.exceptNames } : {}),
                ...(o.parts.exceptRoles.length ? { roles: o.parts.exceptRoles } : {}),
              },
            }
          : {}),
      }
    : {};
  const size = o.sizeCm
    ? Object.fromEntries(Object.entries(o.sizeCm).filter(([, v]) => v !== null))
    : {};
  const recipeOp = (op: object): IntentOp | string => {
    if (!ctx.recipe && !creating && o.op !== 'rename')
      return 'There is no model to change yet: make it its own fixture first.';
    const checked = recipeOpSchema.safeParse(op);
    return checked.success
      ? checked.data
      : `The ${o.op} was incomplete: ${checked.error.issues[0]?.message ?? 'bad shape'}.`;
  };
  switch (o.op) {
    case 'recolor':
      return recipeOp({ op: 'recolor', parts: selector, color: o.color });
    case 'rematerial':
      return recipeOp({ op: 'rematerial', parts: selector, material: o.material });
    case 'resize':
      return recipeOp({ op: 'resize', ...(o.parts ? { parts: selector } : {}), sizeCm: size });
    case 'remove_part':
      return recipeOp({ op: 'remove_part', parts: selector });
    case 'rename':
      return o.label ? { op: 'rename', label: nameOf(o.label) } : 'A new name was missing.';
    case 'add_part': {
      if (!o.part) return 'The part to add was missing.';
      const { role, color, ...rest } = o.part;
      const part = recipePartSchema.safeParse({
        ...rest,
        shape: 'rbox',
        tone: 'wood',
        ...(role ? { role } : {}),
        ...(color ? { color } : {}),
      });
      return part.success
        ? recipeOp({ op: 'add_part', part: part.data })
        : `The part to add was incomplete: ${part.error.issues[0]?.message}.`;
    }
    case 'create':
      return {
        op: 'create',
        label: o.label ? nameOf(o.label) : (ctx.target?.label ?? 'New fixture'),
        form: o.form,
        as: o.as,
      };
    case 'rebase':
      return o.form ? { op: 'rebase', form: o.form } : 'The form to build from was missing.';
    case 'match_photo':
      return ctx.recipe || creating
        ? { op: 'match_photo' }
        : 'There is no model to change yet: make it its own fixture first.';
    case 'set_control': {
      if (!o.control) return 'What it switches was missing.';
      const control =
        o.control.kind === 'none'
          ? { kind: 'none' }
          : { kind: o.control.kind, entityId: o.control.entityId };
      const checked = fixtureControlSchema.safeParse(control);
      if (!checked.success)
        return `${o.control.entityId ?? 'That'} isn't a ${o.control.kind} entity.`;
      if (checked.data.kind !== 'none' && !ctx.entities.includes(checked.data.entityId))
        return `${checked.data.entityId} isn't one of the configured entities.`;
      if (ctx.target?.kind !== 'fixture' && !creating)
        return 'Only a fixture can switch something.';
      return { op: 'set_control', control: checked.data };
    }
    case 'add_state':
      return readAddState(o, ctx);
    case 'clarify':
      return { op: 'clarify', question: o.question ?? 'What would you like it to do?' };
  }
}

/**
 * A variant as a typed op, or why it can't be made. With no subject named it
 * is what the target stands on, else the target; with no occupant named it
 * is the target when that stands on the subject. The occupant must stand on
 * the subject, by the room's surfaces, not by where it looks to be.
 */
function readAddState(o: SparkIntentOp, ctx: IntentContext): IntentOp | string {
  const related = ctx.related ?? [];
  const known = [...(ctx.target ? [ctx.target] : []), ...related.map((r) => r.target)];
  const find = (ref: string) => known.find((t) => thingRef(t) === ref) ?? null;
  const same = sameThing;
  const holder = related.find((r) => r.relation === 'holds')?.target ?? null;
  const subject = o.subject ? find(o.subject) : (holder ?? ctx.target);
  if (!subject)
    return o.subject
      ? `${o.subject} isn't the selection or anything on or under it.`
      : 'There is nothing selected to make a variant of.';
  const occupant = o.occupant
    ? find(o.occupant)
    : ctx.target && !same(ctx.target, subject)
      ? ctx.target
      : null;
  if (o.occupant && !occupant)
    return `${o.occupant} isn't the selection or anything on or under it.`;
  if (
    occupant &&
    !(
      (same(subject, ctx.target) &&
        related.some((r) => r.relation === 'on' && same(r.target, occupant))) ||
      (same(occupant, ctx.target) &&
        related.some((r) => r.relation === 'holds' && same(r.target, subject)))
    )
  )
    return `The ${occupant.label} isn't on the ${subject.label}.`;
  const state = (o.state ?? (occupant ? 'occupied' : ''))
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!STATE_NAME.test(state)) return 'The variant’s name was missing.';
  if (RESERVED.has(state))
    return `"${state}" is what the ${subject.label} switches: call the variant something else.`;
  if (state === 'occupied' && !occupant)
    return `Nothing stands on the ${subject.label} to show it occupied: select what sits on it.`;
  return { op: 'add_state', subject, state, occupant };
}

/** A name as a label: "the standing desk" is the standing desk's name without its article. */
const nameOf = (label: string) => label.trim().replace(/^(the|a|an)\s+(?=\S)/i, '');

/**
 * Spark's answer as typed ops. Ops that can't be done are left out and
 * their reasons returned; a clarify stands alone, since the rest waits on
 * its answer; nothing doable at all becomes a clarify with the reasons.
 */
export function readIntent(
  raw: SparkIntent,
  ctx: IntentContext,
): EditIntent & { dropped: string[] } {
  const dropped: string[] = [];
  let ops: IntentOp[] = [];
  const creating = raw.ops.some((o) => o.op === 'create');
  // A variant is a thing's model, not a recipe: its edits are made on its card once it is kept.
  const variant = raw.ops.some((o) => o.op === 'add_state');
  for (const o of raw.ops) {
    const read =
      variant && o.op in RECIPE_OPS
        ? `Change the variant on its card once it is kept: the ${o.op} was left out.`
        : readOp(o, ctx, creating);
    if (typeof read === 'string') dropped.push(read);
    else ops.push(read);
  }
  const question = ops.find((o) => o.op === 'clarify');
  if (question) ops = [question];
  if (!ops.length)
    ops = [{ op: 'clarify', question: dropped.join(' ') || 'What would you like it to do?' }];
  const creates = ops.some((o) => o.op === 'create' || o.op === 'rebase');
  return {
    ops,
    // Nothing to look up unless a model is being made: a product named in an
    // edit ("make the Alex green") only says what it is.
    product: creates ? raw.product : null,
    needs: creates ? raw.needs : [],
    targetDisagrees: raw.targetDisagrees,
    dropped,
  };
}

/** The selection and its model in a few lines, for the parser's prompt. */
export function describeContext(ctx: IntentContext): string {
  const lines = [
    ctx.target
      ? `The selection is the room's ${ctx.target.kind} "${ctx.target.label}" (ref ${thingRef(ctx.target)}).`
      : 'The selection is of something the room has no model of yet.',
  ];
  for (const r of ctx.related ?? [])
    lines.push(
      r.relation === 'holds'
        ? `It stands on the ${r.target.kind} "${r.target.label}" (ref ${thingRef(r.target)}).`
        : `The ${r.target.kind} "${r.target.label}" (ref ${thingRef(r.target)}) stands on it.`,
    );
  if (ctx.recipe) {
    const { w, d, h } = ctx.recipe.sizeCm;
    lines.push(`Its model "${ctx.recipe.label}" is ${w} × ${d} × ${h} cm, with parts:`);
    for (const p of ctx.recipe.parts)
      lines.push(
        `- ${p.name}${p.role ? ` (${p.role})` : ''}: ${p.sizeCm.w} × ${p.sizeCm.d} × ${p.sizeCm.h} cm at ${p.atCm.x}, ${p.atCm.y}, ${p.atCm.z}${p.color ? `, ${p.color}` : ''}${p.material ? `, ${p.material}` : ''}`,
      );
  } else lines.push('It has no model to edit yet.');
  lines.push(
    ctx.entities.length
      ? `Entities it may switch: ${ctx.entities.join(', ')}.`
      : 'No light or switch entities are configured.',
  );
  return lines.join('\n');
}
/** Every op, one line each, from the registries, for the parser's prompt. */
export function opCatalog(): string {
  return [
    ...Object.entries(RECIPE_OPS).map(([k, v]) => `- ${k}: ${v.about}`),
    ...Object.entries(INTENT_ABOUT).map(([k, v]) => `- ${k}: ${v}`),
  ].join('\n');
}
