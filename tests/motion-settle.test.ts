import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOTION_ZONE, type LumaFrame, type PlacementRule } from '@livinglayer/domain';
import type { DeskTracking } from '../apps/server/src/desk.js';
import type { FrameSource } from '../apps/server/src/frames.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { Watcher } from '../apps/server/src/watcher.js';

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const W = 64;
const H = 48;
/** The zone beside the bulb: a tenth of the picture, too little to read as a lighting change. */
const RECT = { x: 0.6, y: 0.6, width: 0.3, height: 0.3 };

/** A grey room, the zone's pixels at `zone` brightness. */
function frame(zone: number): LumaFrame {
  const data = new Uint8Array(W * H).fill(120);
  for (let y = Math.floor(RECT.y * H); y < Math.floor((RECT.y + RECT.height) * H); y++)
    for (let x = Math.floor(RECT.x * W); x < Math.floor((RECT.x + RECT.width) * W); x++)
      data[y * W + x] = zone;
  return { width: W, height: H, data };
}

/** A watcher on one motion zone that lights a bulb, and the motion it reports. */
async function watched() {
  const dir = mkdtempSync(join(tmpdir(), 'livinglayer-settle-'));
  dirs.push(dir);
  const store = new EvidenceStore(dir);
  const zone: PlacementRule = {
    id: 'blue',
    label: 'Blue plushie',
    objects: 'any',
    entityId: null,
    motion: { share: MOTION_ZONE.share, quietS: MOTION_ZONE.quietS },
    actions: {
      onEnter: [{ kind: 'switch', entityId: 'light.bulb', to: 'on' }],
      onLeave: [],
    },
    zone: { sourceKey: 'cam', rect: RECT, frame: { width: W, height: H } },
  };
  store.saveMemory({
    ...store.memory('live'),
    rules: [zone],
    watch: { on: true, camera: { id: 'cam:a', name: 'Desk', url: 'rtsp://cam/a' } },
  });
  let now = 10_000;
  let push: (f: LumaFrame) => void = () => {};
  const source: FrameSource = {
    start: async (onFrame) => {
      push = onFrame;
    },
    stop: () => {},
    snapshot: async () => ({ png: Buffer.alloc(0), width: 0, height: 0 }),
  };
  const started: string[] = [];
  const watcher = new Watcher({
    mode: 'live',
    store,
    tracking: {
      motionZone: async (_mode: string, id: string, change: string) => {
        if (change === 'started') started.push(id);
        return true;
      },
    } as unknown as DeskTracking,
    segment: async () => {
      throw new Error('not asked');
    },
    photoOf: async () => null,
    appearance: async () => null,
    source: () => source,
    now: () => now,
  });
  await watcher.start();
  const show = (zoneLuma: number) => {
    now += 200;
    push(frame(zoneLuma));
  };
  return { watcher, started, show };
}

describe('motion zones after a light is switched', () => {
  it('a zone darkening as the bulb goes off does not start, once the switch is told', async () => {
    const { watcher, started, show } = await watched();
    show(200);
    show(200);
    // Another zone emptied and switched the bulb off: the plushie's corner goes dark.
    watcher.lightSwitched();
    show(150);
    show(100);
    show(60);
    show(60);
    expect(started).toEqual([]);
    watcher.stop();
  });

  it('the same change with no switch told is motion', async () => {
    const { watcher, started, show } = await watched();
    show(200);
    show(200);
    show(150);
    show(100);
    show(60);
    expect(started).toEqual(['blue']);
    watcher.stop();
  });
});
