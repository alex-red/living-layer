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
  type Swatch,
  type LampResult,
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
/** The illustrated mug's own colours: its cream body and the coffee in it. */
export const fixtureSwatches: Swatch[] = [
  { hex: '#ece5d0', share: 0.82 },
  { hex: '#73604c', share: 0.18 },
];
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
