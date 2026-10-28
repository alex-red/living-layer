import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FIXTURE_POSITIONS,
  FIXTURE_LIGHTS,
  isMugConcept,
  type FixturePosition,
  type Scene,
  type SceneGuess,
  type SceneDraft,
  type LampResult,
  type Detection,
  type PhotoCheck,
  type PhotoInventory,
  type Segmentation,
} from '@livinglayer/domain';
import { PROJECT_ROOT } from './config.js';
import { LabError } from './errors.js';
import { decodeSegmentation, syntheticStream } from './sam.js';

export const fixtureScene: Scene = {
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
export const fixtureSceneGuess: SceneGuess = {
  kind: 'desk',
  visibleProps: ['book', 'bottle'],
  summary: 'An illustrated desk seen from above, with a book and a bottle.',
};
/** What a Spark layout of the illustrated desk could look like, with no model call. */
export const fixtureSceneDraft: SceneDraft = {
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
export const fixturePhotoInventory: PhotoInventory = {
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
export const fixturePhotoCheck: PhotoCheck = {
  missing: [],
  extra: [],
  note: 'Fixture: the drawn desk matches the illustration.',
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
export async function fixturePhotoSegmentation(): Promise<Segmentation> {
  const mug = (await fixtureSegmentation('mug')).output.detections[0]!;
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
export async function fixtureSegmentation(concept: string, position: FixturePosition = 'centre') {
  const fixture = JSON.parse(
    readFileSync(resolve(PROJECT_ROOT, 'fixtures/sam-mug.json'), 'utf8'),
  ) as { width: number; height: number; wire: string };
  const result = await decodeSegmentation(
    syntheticStream(isMugConcept(concept) ? fixture.wire : ''),
    concept,
    fixture.width,
    fixture.height,
  );
  const { dx, dy } = FIXTURE_POSITIONS[position];
  for (const d of result.output.detections) d.box = { ...d.box, x: d.box.x + dx, y: d.box.y + dy };
  return result;
}
export const fixtureLamp: LampResult = {
  entityId: FIXTURE_LIGHTS[0]!,
  accepted: true,
  stateConfirmed: true,
  physicalEffectVerified: false,
  state: 'on',
  desired: { brightness_pct: 85, color_temp_kelvin: 2700 },
  explanation:
    'Virtual adapter only. No Home Assistant request was sent and no physical effect was verified.',
};
/** The virtual adapter for any fixture light. */
export function fixtureLampFor(entityId: string): LampResult {
  if (!FIXTURE_LIGHTS.includes(entityId))
    throw new LabError('lamp_unknown', 'That light is not one of the fixture lights.', 409);
  return { ...fixtureLamp, entityId };
}
