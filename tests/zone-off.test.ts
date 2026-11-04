import { describe, expect, it } from 'bun:test';
import {
  DEMO_SURFACE,
  MAIN_RULE,
  surfaceMap,
  zoneFromSurface,
  type DeskMemory,
  type EvidenceRun,
  type PlacementDecision,
} from '@livinglayer/domain';
import { testApp } from './lib/app.js';

/** The demo with its mug followed and a main zone round the desk's middle, where the mug is. */
async function setup() {
  const { app, post } = await testApp({ name: 'zone-off' });
  await post('desk/surface', { pin: DEMO_SURFACE });
  const seen = async () => (await post('segment', { concept: 'mug' })).json<{ id: string }>();
  const picked = (
    await post('desk/select', { segmentRunId: (await seen()).id, detectionId: '7' })
  ).json<DeskMemory>();
  const mug = picked.fixtures!.find((f) => f.track)!;
  const a = { x: 0.6, y: 0.2 };
  const b = { x: 0.78, y: 0.65 };
  const rect = zoneFromSurface(
    a,
    b,
    DEMO_SURFACE.frame,
    surfaceMap(DEMO_SURFACE, DEMO_SURFACE.frame)!.toFrame,
  )!;
  const draw = () =>
    post('desk/zone', {
      observationId: mug.track!.observation.id,
      rect,
      onSurface: { scene: 'office', surfaceId: 'desk:top', a, b },
    });
  expect((await draw()).statusCode).toBe(200);
  const turn = async (off: boolean) => {
    const res = await post('desk/rules/options', { ruleId: MAIN_RULE, off });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<DeskMemory>().rules!.find((r) => r.id === MAIN_RULE)!;
  };
  const verify = async () =>
    (await post('desk/rules/verify', {}))
      .json<{ events: EvidenceRun<PlacementDecision>[] }>()
      .events.find((e) => e.output.ruleId === MAIN_RULE);
  const track = async () =>
    (await post('desk/track', { segmentRunId: (await seen()).id })).json<{
      event: EvidenceRun<PlacementDecision>;
    }>().event;
  return { app, draw, turn, verify, track };
}

describe('turning a zone off', () => {
  it('stops judging it until it is turned on, then fills again', async () => {
    const s = await setup();
    expect((await s.verify())?.output).toMatchObject({ decision: 'inside' });

    const off = await s.turn(true);
    expect(off).toMatchObject({ off: true, placement: null, inside: [] });
    expect(await s.verify()).toBeUndefined();
    // Nor does a new sighting switch anything.
    expect((await s.track()).output).toMatchObject({ decision: 'blocked', action: 'none' });

    const on = await s.turn(false);
    expect(on).not.toHaveProperty('off');
    // A new story: the mug already in it enters it on its next sighting, so its steps run.
    expect((await s.track()).output).toMatchObject({ decision: 'inside', transition: 'entered' });
    await s.app.close();
  });
  it('keeps an off zone off when it is drawn again', async () => {
    const s = await setup();
    await s.turn(true);
    const redrawn = (await s.draw()).json<DeskMemory>().rules!.find((r) => r.id === MAIN_RULE)!;
    expect(redrawn.off).toBe(true);
    await s.app.close();
  });
});
