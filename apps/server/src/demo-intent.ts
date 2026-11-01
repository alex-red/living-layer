import type {
  FactNeed,
  PropForm,
  RecipeRole,
  SparkIntent,
  SparkIntentOp,
} from '@livinglayer/domain';

/**
 * The demo's reading of a request, with no model call: a few patterns for
 * what the demo shows (make it its own fixture, change its colour, material
 * or size, rename it, tie it to a light), answered in the shape Spark would
 * give, so the demo goes through `readIntent` like a live request. Anything
 * else is a question back. Hand-written, not a model.
 */
const COLORS: Record<string, string> = {
  white: '#f2f0eb',
  black: '#1f1f22',
  green: '#3f8f4a',
  red: '#b23a3a',
  blue: '#3a5fb2',
  grey: '#8a8f98',
  gray: '#8a8f98',
  yellow: '#e0c040',
  orange: '#d9822b',
  pink: '#e091b0',
  purple: '#7a4fa0',
  brown: '#7c583e',
  oak: '#b8894f',
  walnut: '#5c3d2a',
  beige: '#d8c8a8',
  teal: '#3f9a96',
  turquoise: '#3f9a96',
};
const MATERIALS: Record<string, SparkIntentOp['material']> = {
  metal: 'metal',
  steel: 'metal',
  wood: 'wood',
  wooden: 'wood',
  glass: 'glass',
  fabric: 'fabric',
  glossy: 'gloss',
  shiny: 'gloss',
  matte: 'matte',
};
const ROLES: [RegExp, RecipeRole[]][] = [
  [/\bdrawers?\b/, ['drawer']],
  [/\blegs?\b/, ['leg']],
  [/\b(desk ?)?top\b/, ['top']],
  [/\bhandles?\b/, ['handle']],
  [/\bshel(f|ves)\b/, ['shelf']],
  [/\bdoors?\b/, ['door']],
  [/\bpanels?\b/, ['panel']],
  [/\bframe\b/, ['leg', 'rail', 'panel']],
  [/\bshade\b/, ['shade']],
];
const FORMS: [RegExp, PropForm][] = [
  [/\bdesk\b/, 'desk'],
  [/\btable\b/, 'table'],
  [/\bchair\b/, 'chair'],
  [/\b(book ?case|book ?shelf|shelf)\b/, 'bookcase'],
  [/\b(cabinet|drawers? unit|dresser)\b/, 'cabinet'],
  [/\bmonitor\b/, 'monitor'],
  [/\bkeyboard\b/, 'keyboard'],
];
const AXES: Record<string, 'w' | 'd' | 'h'> = {
  wide: 'w',
  long: 'w',
  deep: 'd',
  tall: 'h',
  high: 'h',
};
const UNITS: Record<string, number> = { mm: 0.1, cm: 1, m: 100 };

const op = (o: Partial<SparkIntentOp> & Pick<SparkIntentOp, 'op'>): SparkIntentOp => ({
  parts: null,
  color: null,
  material: null,
  sizeCm: null,
  part: null,
  label: null,
  form: null,
  as: null,
  control: null,
  question: null,
  ...o,
});
/** The parts a phrase names, and those after "but not". */
function partsOf(text: string): SparkIntentOp['parts'] {
  const [only, except = ''] = text.split(/\bbut not\b|\bexcept\b/);
  const rolesIn = (t: string) => ROLES.flatMap(([re, r]) => (re.test(t) ? r : []));
  const roles = rolesIn(only!);
  const exceptRoles = rolesIn(except);
  if (!roles.length && !exceptRoles.length) return null;
  return { names: [], roles, materials: [], exceptNames: [], exceptRoles };
}
export const DEMO_QUESTION =
  'In the demo I can make it its own fixture, change its colour, material or size, rename it, or tie it to a light. Which would you like?';

export function demoIntent(sentence: string): SparkIntent {
  const text = sentence.toLowerCase().replace(/[’']/g, "'");
  const ops: SparkIntentOp[] = [];
  let product: string | null = null;

  const entity = text.match(/\b(light|switch)\.[a-z0-9_]+/);
  const create =
    /\b(its own|a new|new)\s+(fixture|furniture|model|thing)\b|\bturn (this|it) into\b/.test(text);
  // "It's an IKEA Alex desk": a product, unless it names an entity.
  // "its an" too, as people type it.
  const named = text.match(/\b(?:it's|its|it is|this is)\s+an?\s+([a-z0-9 \-]+?)\s*(?:[.,;:!]|$)/);
  if (named && !entity && !/\b(light|switch|fixture)\b/.test(named[1]!))
    product = sentence
      .slice(named.index! + named[0].indexOf(named[1]!))
      .slice(0, named[1]!.length)
      .trim();
  if (create) {
    const as = /\bfurniture\b/.test(text)
      ? 'furniture'
      : /\bfixture\b/.test(text)
        ? 'fixture'
        : null;
    const form = FORMS.find(([re]) => re.test(product?.toLowerCase() ?? text))?.[1] ?? null;
    ops.push(op({ op: 'create', label: product, form, as }));
  }
  const rename = sentence.match(/\b(?:call|name) it\s+["“]?([^"”.!]+)["”]?/i);
  if (rename) ops.push(op({ op: 'rename', label: rename[1]!.trim() }));
  const colour =
    text.match(/#[0-9a-f]{6}\b/)?.[0] ??
    Object.entries(COLORS).find(([name]) => new RegExp(`\\b${name}\\b`).test(text))?.[1];
  if (colour && /\b(make|paint|colou?r|turn)\b/.test(text))
    ops.push(op({ op: 'recolor', parts: partsOf(text), color: colour }));
  const material = Object.entries(MATERIALS).find(([w]) => new RegExp(`\\b${w}\\b`).test(text));
  if (material && !(colour && material[1] === 'wood' && /\b(oak|walnut)\b/.test(text)))
    ops.push(op({ op: 'rematerial', parts: partsOf(text), material: material[1] }));
  const size: Record<'w' | 'd' | 'h', number | null> = { w: null, d: null, h: null };
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(mm|cm|m)\s+(wide|long|deep|tall|high)\b/g))
    size[AXES[m[3]!]!] = Number(m[1]) * UNITS[m[2]!]!;
  if (Object.values(size).some((v) => v !== null))
    ops.push(op({ op: 'resize', parts: partsOf(text), sizeCm: size }));
  if (entity) {
    const [id, kind] = [entity[0], entity[1] as 'light' | 'switch'];
    ops.push(op({ op: 'set_control', control: { kind, entityId: id } }));
  } else if (/\b(just a thing|switches nothing|not a light)\b/.test(text))
    ops.push(op({ op: 'set_control', control: { kind: 'none', entityId: null } }));

  if (!ops.length) ops.push(op({ op: 'clarify', question: DEMO_QUESTION }));
  const needs: FactNeed[] = create ? (product ? ['size', 'parts', 'colors'] : ['size']) : [];
  return { ops: ops.slice(0, 4), product, needs, targetDisagrees: null };
}
