import { testApp } from './app.js';
import type { Fetcher } from '../../apps/server/src/config.js';
import {
  mugItem,
  type DeskMemory,
  type EvidenceRun,
  type Fixture,
  type MappedThing,
  type MovingThing,
  type ScannedThing,
  type SurfacePin,
} from '@livinglayer/domain';

/** A pin that fills the frame with the office desk's top, to test the mapping on. */
export const DEMO_SURFACE: SurfacePin = {
  scene: 'desk',
  surfaceId: 'desk:top',
  corners: [
    { x: 0, y: 0 },
    { x: 960, y: 0 },
    { x: 960, y: 640 },
    { x: 0, y: 640 },
  ],
  frame: { width: 960, height: 640 },
};

export function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    id: crypto.randomUUID(),
    label: 'Desk lamp',
    scene: 'office',
    surfaceId: null,
    at: { x: 1, y: 1 },
    turns: 0,
    size: { w: 0.5, d: 0.5, h: 1.2 },
    model: { ...mugItem(), source: 'demo', segmentRunId: null, swatches: [], updatedAt: '' },
    reference: null,
    control: { kind: 'light', entityId: 'light.demo_shelf' },
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    ...over,
  };
}

export const thing = (over: Partial<ScannedThing> = {}): ScannedThing => ({
  label: 'green book',
  archetype: 'book',
  material: 'matte',
  control: 'none',
  color: '#5f8a5a',
  box: { x1: 80, y1: 300, x2: 300, y2: 760 },
  sizeCm: { w: 15, d: 22, h: 3 },
  ...over,
});

export async function setup(
  env: Record<string, string> = {},
  fetcher?: Fetcher,
  /** A data folder to start from, copied: the store as an earlier test left it. */
  from?: string,
) {
  const { app, post, dataDir } = await testApp({
    name: 'scan',
    env,
    ...(fetcher ? { fetcher } : {}),
    ...(from ? { from } : {}),
  });
  return { app, post, dataDir };
}

export type Scanned = {
  run: EvidenceRun;
  mapped: MappedThing[];
  memory: DeskMemory;
  moving: MovingThing[];
};
