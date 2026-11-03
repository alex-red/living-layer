import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEMO_FRAME,
  DEMO_LIGHTS,
  demoCloseUp,
  demoFrame,
  detectionFromBits,
  roomMask,
  DEMO_SWITCHES,
  isMugConcept,
  type DemoPosition,
  type Scene,
  type SceneGuess,
  type SceneDraft,
  type LampResult,
  type LightLook,
  WARM_KELVIN,
  type Detection,
  type PhotoCheck,
  type PhotoInventory,
  type Segmentation,
  type RoomPicture,
  type DemoReference,
  type FixtureClass,
  type FixtureScan,
  type Archetype,
  ARCHETYPES,
  archetypeOf,
} from '@livinglayer/domain';
import sharp from 'sharp';
import { PROJECT_ROOT } from './config.js';
import { LabError } from './errors.js';

export const demoScene: Scene = {
  summary: 'An office desk with a cream mug, a green book, and a sage bottle.',
  objects: [
    { label: 'cream mug', category: 'mug', appearance: 'Cream body with a handle on the right.' },
    {
      label: 'green book',
      category: 'book',
      appearance: 'Closed forest-green notebook on the left.',
    },
    { label: 'sage bottle', category: 'bottle', appearance: 'Tall sage bottle on the right.' },
  ],
};
export const demoSceneGuess: SceneGuess = {
  kind: 'desk',
  visibleProps: ['book', 'bottle'],
  summary: 'An office desk seen from its corner camera, with a book and a bottle.',
};
/** What a Spark layout of the demo office could look like, with no model call. */
export const demoSceneDraft: SceneDraft = {
  grid: { w: 10, d: 8 },
  items: [
    { template: 'wall', x: 0, y: 0, turns: 0 },
    { template: 'desk', x: 1, y: 1, turns: 0 },
    { template: 'book', x: 1.4, y: 1.6, turns: 0 },
    { template: 'lamp', x: 4.1, y: 1.3, turns: 0 },
    { template: 'bottle', x: 3.6, y: 2.4, turns: 0 },
    { template: 'chair', x: 2.2, y: 3.9, turns: 0 },
    { template: 'shelf', x: 7, y: 0.2, turns: 0 },
    { template: 'plant', x: 7.8, y: 5.6, turns: 0 },
    { template: 'rug', x: 4.5, y: 5.2, turns: 0 },
  ],
  summary: 'An office desk against a wall, with a lamp, a book, a bottle and a chair.',
};
/** The demo room's things a Spark inventory would list, by the render's ids. */
// Sizes as the office draws them: a 160 × 80 cm desk, its book and bottle, and the mug.
const DEMO_THINGS = [
  {
    id: 'desk',
    label: 'desk top',
    as: 'desk',
    role: 'surface',
    on: 'floor',
    sizeCm: { w: 160, d: 80, h: 72 },
    color: '#b98a5a',
    material: 'wood',
  },
  {
    id: 'mug',
    label: 'cream mug',
    as: 'mug',
    role: 'object',
    on: 'desk',
    sizeCm: { w: 9, d: 9, h: 10 },
    color: '#efe6d2',
    material: 'gloss',
  },
  {
    id: 'book',
    label: 'green book',
    as: 'book',
    role: 'object',
    on: 'desk',
    sizeCm: { w: 16, d: 23, h: 4 },
    color: '#4f7a52',
    material: 'matte',
  },
  {
    id: 'bottle',
    label: 'sage bottle',
    as: 'bottle',
    role: 'object',
    on: 'desk',
    sizeCm: { w: 8, d: 8, h: 26 },
    color: '#9fb39a',
    material: 'glass',
  },
] as const;
/** A thing's box in the demo frame, in thousandths, from its rendered pixels. */
function demoBox(id: string) {
  const d = demoDetection(id, 'centre', id)!;
  const { width, height } = DEMO_FRAME;
  return {
    x1: Math.round((d.box.x / width) * 1000),
    y1: Math.round((d.box.y / height) * 1000),
    x2: Math.round(((d.box.x + d.box.width) / width) * 1000),
    y2: Math.round(((d.box.y + d.box.height) / height) * 1000),
  };
}
/** What a Spark inventory of the demo room could look like, boxes in thousandths. */
export const demoPhotoInventory: PhotoInventory = {
  kind: 'desk',
  things: DEMO_THINGS.map((t) => ({ ...t, box: demoBox(t.id) })),
  summary:
    'An office seen from its corner, with a cream mug, a green book and a sage bottle on the desk.',
};
export const demoPhotoCheck: PhotoCheck = {
  missing: [],
  extra: [],
  note: 'Demo: the drawn desk matches the illustration.',
};
/** One thing of the demo frame as a SAM detection: its rendered pixels, nothing nearer over them. */
export function demoDetection(
  id: string,
  position: DemoPosition = 'centre',
  objectId = '1',
): Detection | null {
  return detectionFromBits(objectId, roomMask(demoFrame(position), id));
}
const pngs = new Map<string, Promise<Buffer>>();
const pngOf = (key: string, picture: () => RoomPicture) => {
  let png = pngs.get(key);
  if (!png) {
    const { width, height, rgba } = picture();
    png = sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    pngs.set(key, png);
  }
  return png;
};
/** The demo frame as a PNG, as the camera would send it. */
export const demoPng = (position: DemoPosition = 'centre') =>
  pngOf(`frame@${position}`, () => demoFrame(position));
/**
 * A close photo of the demo mug and its outline, for modelling it: across
 * the room it is too few pixels to fit a model to.
 */
export async function demoMugCloseUp(position: DemoPosition = 'centre') {
  const picture = demoCloseUp(position);
  return {
    png: await pngOf(`close@${position}`, () => picture),
    detection: detectionFromBits('7', roomMask(picture, 'mug'))!,
  };
}
/**
 * Box-prompted SAM on the demo room: each inventory thing's rendered
 * pixels. Ids follow the inventory's order, as box prompts would be numbered.
 */
export async function demoPhotoSegmentation(): Promise<Segmentation> {
  return {
    concept: 'photo scene',
    frame: { ...DEMO_FRAME },
    detections: DEMO_THINGS.flatMap((t, i) => demoDetection(t.id, 'centre', String(i + 1)) ?? []),
  };
}
/** Words a person might ask SAM for, and the demo room's things they name. */
const DEMO_CONCEPTS: [RegExp, (name: string) => boolean][] = [
  [/\b(desk|table)s?\b/, (n) => n === 'desk'],
  [/\b(book ?case|book ?shelf|shelf|shelves)\b/, (n) => n === 'shelf'],
  [/\b(monitor|screen|display)s?\b/, (n) => n === 'monitor'],
  [/\bkeyboards?\b/, (n) => n === 'keyboard'],
  [/\b(book|notebook)s?\b/, (n) => n === 'book'],
  [/\bbottles?\b/, (n) => n === 'bottle'],
  [/\bcoasters?\b/, (n) => n === 'coaster'],
  [/\blamps?\b/, (n) => n === 'lamp'],
  [/\bchairs?\b/, (n) => n === 'chair'],
  [/\b(plant|pot)s?\b/, (n) => n === 'plant'],
  [/\bfloor\b/, (n) => n === 'floor'],
  [/\bwalls?\b/, (n) => n.startsWith('wall')],
];
/**
 * SAM on the demo frame, with no model call: the rendered pixels of every
 * thing the concept names, the mug where `position` puts it.
 */
export async function demoSegmentation(concept: string, position: DemoPosition = 'centre') {
  const picture = demoFrame(position);
  const c = concept.toLowerCase();
  const names = isMugConcept(concept)
    ? ['mug']
    : picture.names.filter((n) => DEMO_CONCEPTS.some(([re, is]) => re.test(c) && is(n)));
  // SAM numbers objects sparsely; the mug keeps the id it always had, 7.
  const detections = names.flatMap(
    (n, i) => demoDetection(n, position, n === 'mug' ? '7' : String(i + 1)) ?? [],
  );
  const output: Segmentation = { concept, frame: { ...DEMO_FRAME }, detections };
  return {
    output,
    raw: `Synthetic: ${detections.length} mask(s) read off the demo room's render for "${concept}". Not a model response.`,
  };
}
export const demoLamp: LampResult = {
  entityId: DEMO_LIGHTS[0]!,
  action: 'on',
  accepted: true,
  stateConfirmed: true,
  physicalEffectVerified: false,
  state: 'on',
  desired: { brightness_pct: 85, color_temp_kelvin: 2700 },
  explanation:
    'Virtual adapter only. No Home Assistant request was sent and no physical effect was verified.',
};
/** The virtual adapter for any demo light or switch; demo lights show any look. */
export function demoLampFor(
  entityId: string,
  action: 'on' | 'off' = 'on',
  look?: LightLook,
): LampResult {
  if (![...DEMO_LIGHTS, ...DEMO_SWITCHES].includes(entityId))
    throw new LabError(
      'lamp_unknown',
      'That entity is not one of the demo lights or switches.',
      409,
    );
  const shows = entityId.startsWith('light.') && action === 'on' && look && look.kind !== 'keep';
  const desired: LampResult['desired'] = !shows
    ? {}
    : look.kind === 'warm'
      ? { brightness_pct: look.brightness, color_temp_kelvin: WARM_KELVIN }
      : { brightness_pct: look.brightness, rgb_color: look.rgb };
  return { ...demoLamp, entityId, action, state: action, desired };
}

/** What a Spark class of each demo reference picture could look like, with no model call. */
export const demoFixtureClass: Record<DemoReference, FixtureClass> = {
  mouse: {
    label: 'Computer mouse',
    archetype: 'device',
    material: 'matte',
    control: 'none',
    description:
      'A graphite computer mouse with a scroll wheel, seen from above, cable at the back.',
    box: { x1: 344, y1: 233, x2: 656, y2: 856 },
    sizeCm: { w: 6.5, d: 11.5, h: 4 },
  },
  lamp: {
    label: 'Desk lamp',
    archetype: 'lamp',
    material: 'fabric',
    control: 'light',
    description: 'A brass desk lamp with a cream fabric shade, seen from the side.',
    box: { x1: 302, y1: 167, x2: 698, y2: 833 },
    sizeCm: { w: 25, d: 25, h: 45 },
  },
  monitor: {
    label: 'Monitor',
    archetype: 'box',
    material: 'matte',
    control: 'switch',
    description: 'A widescreen desktop monitor on a dark stand.',
    box: { x1: 208, y1: 167, x2: 792, y2: 828 },
    sizeCm: { w: 54, d: 18, h: 40 },
  },
  cat: {
    label: 'Cat',
    archetype: 'cat',
    material: 'fabric',
    control: 'none',
    description: 'An orange tabby cat with a cream chest patch.',
    box: { x1: 342, y1: 189, x2: 742, y2: 828 },
    sizeCm: { w: 26, d: 28, h: 32 },
  },
};
const references = new Map<DemoReference, { png: Buffer; detection: Detection }>();
/**
 * A demo reference picture, rasterized as a camera would see it, and the
 * thing's mask: the outline of the SVG's own `<name>-body` polygon, so the
 * mask matches the drawing exactly. No codec or model is involved.
 */
export async function demoReference(
  name: DemoReference,
): Promise<{ png: Buffer; detection: Detection }> {
  const cached = references.get(name);
  if (cached) return cached;
  const svg = readFileSync(resolve(PROJECT_ROOT, `apps/web/public/${name}.svg`), 'utf8');
  const points = svg
    .match(new RegExp(`id="${name}-body" points="([^"]+)"`))?.[1]
    ?.trim()
    .split(/\s+/)
    .map((p) => p.split(',').map(Number) as [number, number]);
  if (!points?.length) throw new LabError('demo_reference', `The ${name} picture has no outline.`);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x = Math.floor(Math.min(...xs));
  const y = Math.floor(Math.min(...ys));
  const width = Math.ceil(Math.max(...xs)) - x;
  const height = Math.ceil(Math.max(...ys)) - y;
  const path = points.map(([px, py], i) => `${i ? 'L' : 'M'}${px - x} ${py - y}`).join('') + 'Z';
  const area =
    Math.abs(
      points.reduce((sum, [ax, ay], i) => {
        const [bx, by] = points[(i + 1) % points.length]!;
        return sum + ax * by - bx * ay;
      }, 0),
    ) / 2;
  const reference = {
    png: await sharp(Buffer.from(svg)).png().toBuffer(),
    detection: {
      objectId: name,
      confidence: null,
      box: { x, y, width, height },
      mask: { width, height, foregroundPixels: Math.round(area), svgPath: path },
    },
  };
  references.set(name, reference);
  return reference;
}

/** Usual sizes of the demo desk's things, as Spark would give them. */
const DEMO_DESK_SIZES: Record<string, FixtureClass['sizeCm']> = {
  mug: { w: 9, d: 9, h: 10 },
  book: { w: 15, d: 22, h: 3 },
  bottle: { w: 7, d: 7, h: 24 },
};
/**
 * The demo desk's thing under a box drawn on it, as a fixture class,
 * with its outline: the one the box overlaps most, if it overlaps one at all.
 * The desk itself is a surface, not a fixture. No model is called.
 */
export async function demoDeskThing(box: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): Promise<{ png: Buffer; detection: Detection; cls: FixtureClass } | null> {
  const segmentation = await demoPhotoSegmentation();
  const overlap = (d: Detection) => {
    const w = Math.min(box.right, d.box.x + d.box.width) - Math.max(box.left, d.box.x);
    const h = Math.min(box.bottom, d.box.y + d.box.height) - Math.max(box.top, d.box.y);
    const inter = Math.max(0, w) * Math.max(0, h);
    const union =
      (box.right - box.left) * (box.bottom - box.top) + d.box.width * d.box.height - inter;
    return union > 0 ? inter / union : 0;
  };
  const best = segmentation.detections
    .map((d) => ({ d, thing: demoPhotoInventory.things[Number(d.objectId) - 1], iou: overlap(d) }))
    .filter((x) => x.thing && x.thing.role !== 'surface')
    .sort((a, b) => b.iou - a.iou)[0];
  if (!best || best.iou < 0.2) return null;
  const thing = best.thing!;
  const archetype = (ARCHETYPES as readonly string[]).includes(thing.as)
    ? (thing.as as Archetype)
    : archetypeOf(thing.label);
  return {
    png: await demoPng(),
    detection: best.d,
    cls: {
      label: thing.label.charAt(0).toUpperCase() + thing.label.slice(1),
      archetype,
      material: archetype === 'mug' ? 'gloss' : 'matte',
      control: 'none',
      description: `The ${thing.label} on the demo desk.`,
      box: thing.box,
      sizeCm: DEMO_DESK_SIZES[thing.id] ?? { w: 10, d: 10, h: 10 },
    },
  };
}

/**
 * What a Spark scan of the demo desk could look like: the book and
 * the bottle stay put; the mug moves, so the camera follows it as an object.
 */
export const demoFixtureScan: FixtureScan = {
  things: [
    {
      label: 'green book',
      archetype: 'book',
      material: 'matte',
      control: 'none',
      color: '#5f8a5a',
      box: demoPhotoInventory.things.find((t) => t.id === 'book')!.box,
      sizeCm: DEMO_DESK_SIZES.book!,
    },
    {
      label: 'sage bottle',
      archetype: 'bottle',
      material: 'matte',
      control: 'none',
      color: '#9cb59a',
      box: demoPhotoInventory.things.find((t) => t.id === 'bottle')!.box,
      sizeCm: DEMO_DESK_SIZES.bottle!,
    },
  ],
  moving: [{ label: 'mug', box: demoPhotoInventory.things.find((t) => t.id === 'mug')!.box }],
};
