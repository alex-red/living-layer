import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Scene, LampResult } from '@livinglayer/domain';
import { PROJECT_ROOT } from './config.js';
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
export async function fixtureSegmentation(concept: string) {
  const fixture = JSON.parse(
    readFileSync(resolve(PROJECT_ROOT, 'fixtures/sam-mug.json'), 'utf8'),
  ) as { width: number; height: number; wire: string };
  return decodeSegmentation(
    syntheticStream(/^(mug|cream mug|cup)$/i.test(concept) ? fixture.wire : ''),
    concept,
    fixture.width,
    fixture.height,
  );
}
export const fixtureLamp: LampResult = {
  entityId: 'light.fixture_desk',
  accepted: true,
  stateConfirmed: true,
  physicalEffectVerified: false,
  state: 'on',
  desired: { brightness_pct: 85, color_temp_kelvin: 2700 },
  explanation:
    'Virtual adapter only. No Home Assistant request was sent and no physical effect was verified.',
};
