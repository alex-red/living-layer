import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEMO_POSITIONS,
  DEMO_LIGHTS,
  DEMO_SWITCHES,
  isMugConcept,
  type DemoPosition,
  type Scene,
  type SceneGuess,
  type SceneDraft,
  type LampResult,
  type Detection,
  type PhotoCheck,
  type PhotoInventory,
  type Segmentation,
  type DemoReference,
  type FixtureClass,
  type FixtureScan,
  type Archetype,
  ARCHETYPES,
  archetypeOf,
} from '@livinglayer/domain';
import sharp from 'sharp';
import { PROJECT_ROOT } from './config.js';
import { demoPhoto } from './item.js';
import { LabError } from './errors.js';
import { decodeSegmentation, syntheticStream } from './sam.js';

export const demoScene: Scene = {
  summary: 'An illustrated desk with a cream mug, a green book, and a sage bottle.',
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
  summary: 'An illustrated desk seen from above, with a book and a bottle.',
};
/** What a Spark layout of the illustrated desk could look like, with no model call. */
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
    { template: 'rug', x: 3, y: 5.2, turns: 0 },
  ],
  summary: 'An illustrated desk against a wall, with a lamp, a book, a bottle and a chair.',
};
/** What a Spark inventory of the illustrated desk could look like, boxes in thousandths. */
export const demoPhotoInventory: PhotoInventory = {
  kind: 'desk',
  things: [
    {
      id: 'desk',
      label: 'desk top',
      as: 'desk',
      role: 'surface',
      on: 'floor',
      box: { x1: 0, y1: 0, x2: 1000, y2: 1000 },
    },
    {
      id: 'mug',
      label: 'cream mug',
      as: 'mug',
      role: 'object',
      on: 'desk',
      box: { x1: 360, y1: 270, x2: 640, y2: 730 },
    },
    {
      id: 'book',
      label: 'green book',
      as: 'book',
      role: 'object',
      on: 'desk',
      box: { x1: 80, y1: 300, x2: 300, y2: 760 },
    },
    {
      id: 'bottle',
      label: 'sage bottle',
      as: 'bottle',
      role: 'object',
      on: 'desk',
      box: { x1: 750, y1: 210, x2: 850, y2: 700 },
    },
  ],
  summary: 'An illustrated desk seen from above, with a cream mug, a green book and a sage bottle.',
};
export const demoPhotoCheck: PhotoCheck = {
  missing: [],
  extra: [],
  note: 'Demo: the drawn desk matches the illustration.',
};
/** A polygon in frame pixels as a detection: box around it, the path in the box's own pixels. */
function polygonDetection(objectId: string, points: [number, number][]): Detection {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.floor(Math.min(...xs));
  const y = Math.floor(Math.min(...ys));
  const width = Math.ceil(Math.max(...xs)) - x;
  const height = Math.ceil(Math.max(...ys)) - y;
  const local = points.map(([px, py]) => [px - x, py - y] as const);
  const area =
    Math.abs(
      local.reduce((s, [ax, ay], i) => {
        const [bx, by] = local[(i + 1) % local.length]!;
        return s + ax * by - bx * ay;
      }, 0),
    ) / 2;
  return {
    objectId,
    confidence: 0.97,
    box: { x, y, width, height },
    mask: {
      width,
      height,
      foregroundPixels: Math.round(area),
      svgPath: `M${local.map(([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`).join('L')}Z`,
    },
  };
}
/**
 * Box-prompted SAM on the illustrated desk: the desktop, the book and the
 * bottle drawn from the SVG's own shapes, and the mug's synthetic mask. Ids
 * follow the inventory's order, as box prompts would be numbered.
 */
export async function demoPhotoSegmentation(): Promise<Segmentation> {
  const mug = (await demoSegmentation('mug')).output.detections[0]!;
  const turn = (x: number, y: number): [number, number] => {
    const a = (-9 * Math.PI) / 180;
    const [dx, dy] = [x - 180, y - 340];
    return [180 + dx * Math.cos(a) - dy * Math.sin(a), 340 + dx * Math.sin(a) + dy * Math.cos(a)];
  };
  return {
    concept: 'photo scene',
    frame: { width: 960, height: 640 },
    detections: [
      polygonDetection('1', [
        [0, 0],
        [960, 0],
        [960, 640],
        [0, 640],
      ]),
      { ...mug, objectId: '2' },
      polygonDetection('3', [turn(85, 210), turn(270, 210), turn(270, 470), turn(85, 470)]),
      polygonDetection('4', [
        [748, 140],
        [795, 140],
        [795, 170],
        [812, 170],
        [812, 440],
        [730, 440],
        [730, 170],
        [748, 170],
      ]),
    ],
  };
}
/** The synthetic mug mask, moved to `position` the same way the web redraws the desk. */
export async function demoSegmentation(concept: string, position: DemoPosition = 'centre') {
  const demo = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'testdata/sam-mug.json'), 'utf8')) as {
    width: number;
    height: number;
    wire: string;
  };
  const result = await decodeSegmentation(
    syntheticStream(isMugConcept(concept) ? demo.wire : ''),
    concept,
    demo.width,
    demo.height,
  );
  const { dx, dy } = DEMO_POSITIONS[position];
  for (const d of result.output.detections) d.box = { ...d.box, x: d.box.x + dx, y: d.box.y + dy };
  return result;
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
/** The virtual adapter for any demo light or switch. */
export function demoLampFor(entityId: string, action: 'on' | 'off' = 'on'): LampResult {
  if (![...DEMO_LIGHTS, ...DEMO_SWITCHES].includes(entityId))
    throw new LabError(
      'lamp_unknown',
      'That entity is not one of the demo lights or switches.',
      409,
    );
  const dims = entityId.startsWith('light.') && action === 'on';
  return { ...demoLamp, entityId, action, state: action, desired: dims ? demoLamp.desired : {} };
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

/** Usual sizes of the illustrated desk's things, as Spark would give them. */
const DEMO_DESK_SIZES: Record<string, FixtureClass['sizeCm']> = {
  mug: { w: 9, d: 9, h: 10 },
  book: { w: 15, d: 22, h: 3 },
  bottle: { w: 7, d: 7, h: 24 },
};
/**
 * The illustrated desk's thing under a box drawn on it, as a fixture class,
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
    png: await demoPhoto(),
    detection: best.d,
    cls: {
      label: thing.label.charAt(0).toUpperCase() + thing.label.slice(1),
      archetype,
      material: archetype === 'mug' ? 'gloss' : 'matte',
      control: 'none',
      description: `The ${thing.label} on the illustrated desk.`,
      box: thing.box,
      sizeCm: DEMO_DESK_SIZES[thing.id] ?? { w: 10, d: 10, h: 10 },
    },
  };
}

/**
 * What a Spark scan of the illustrated desk could look like: the book and
 * the bottle stay put; the mug is the object the camera follows.
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
};
