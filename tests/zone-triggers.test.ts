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

/** The demo with its mug in a main zone round the desk's middle, and a book it follows too. */
async function setup() {
  const { app, post } = await testApp({ name: 'zone-triggers' });
  await post('desk/surface', { pin: DEMO_SURFACE });
  const seen = async (concept: string) =>
    (await post('segment', { concept })).json<{ id: string }>();
  const mugRun = await seen('mug');
  const picked = (
    await post('desk/select', { segmentRunId: mugRun.id, detectionId: '7' })
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
  const zoned = await post('desk/zone', {
    observationId: mug.track!.observation.id,
    rect,
    onSurface: { scene: 'office', surfaceId: 'desk:top', a, b },
  });
  expect(zoned.statusCode, zoned.body).toBe(200);
  const bookRun = await seen('book');
  const { memory } = (
    await post('desk/objects/select', { segmentRunId: bookRun.id, detectionId: '1', label: 'Book' })
  ).json<{ memory: DeskMemory }>();
  const book = memory.fixtures!.find((f) => f.label === 'Book')!;
  const triggers = (t: object) => post('desk/rules/options', { ruleId: MAIN_RULE, triggers: t });
  const verify = async () =>
    (await post('desk/rules/verify', {})).json<{
      memory: DeskMemory;
      events: EvidenceRun<PlacementDecision>[];
    }>();
  const track = async () => post('desk/track', { segmentRunId: (await seen('mug')).id });
  const redraw = async () =>
    post('desk/zone', {
      observationId: mug.track!.observation.id,
      rect,
      onSurface: { scene: 'office', surfaceId: 'desk:top', a, b },
    });
  const zone = zoned.json<DeskMemory>().rules!.find((r) => r.id === MAIN_RULE)!;
  return { app, mug: mug.id, book: book.id, zone, triggers, verify, track, redraw };
}

describe('what sets a zone off, changed in place', () => {
  it('starts the main zone counting anything seen, not only the mug', async () => {
    const s = await setup();
    expect(s.zone.objects).toBe('any');
    await s.app.close();
  });
  it('keeps what the main zone watches when it is drawn again', async () => {
    const s = await setup();
    expect((await s.triggers({ objects: [s.mug, s.book], match: 'all' })).statusCode).toBe(200);
    const redrawn = (await s.redraw()).json<DeskMemory>().rules!.find((r) => r.id === MAIN_RULE)!;
    expect(redrawn).toMatchObject({ objects: [s.mug, s.book], match: 'all' });
    await s.app.close();
  });
  it('lets the main zone watch another thing than the mug, or both together', async () => {
    const s = await setup();
    const main = async () => (await s.verify()).events.find((e) => e.output.ruleId === MAIN_RULE)!;
    expect((await main()).output).toMatchObject({ decision: 'inside', objectId: s.mug });

    const onlyBook = await s.triggers({ objects: [s.book] });
    expect(onlyBook.statusCode, onlyBook.body).toBe(200);
    const rule = onlyBook.json<DeskMemory>().rules!.find((r) => r.id === MAIN_RULE)!;
    // A new story: nothing carried over from when it watched the mug.
    expect(rule).toMatchObject({ objects: [s.book], placement: null, inside: [] });
    expect((await main()).output).toMatchObject({ decision: 'outside', objectId: s.book });

    const together = await s.triggers({ objects: [s.mug, s.book], match: 'all' });
    expect(together.statusCode, together.body).toBe(200);
    const waiting = (await main()).output;
    expect(waiting.decision).toBe('outside');
    expect(waiting.reason).toContain('Waiting for the Book');

    const any = await s.triggers({ objects: [s.mug, s.book] });
    const back = any.json<DeskMemory>().rules!.find((r) => r.id === MAIN_RULE)!;
    expect(back).not.toHaveProperty('match');
    // Each sighting switches a zone once: a new one of the mug fills it again.
    const tracked = (await s.track()).json<{ event: EvidenceRun<PlacementDecision> }>();
    expect(tracked.event.output).toMatchObject({ decision: 'inside', transition: 'entered' });
    await s.app.close();
  });
  it('refuses triggers it can’t judge', async () => {
    const s = await setup();
    // All of one thing isn't a choice.
    expect((await s.triggers({ objects: [s.mug], match: 'all' })).statusCode).toBe(400);
    // A thing never seen can't be waited for.
    const unseen = await s.triggers({ objects: ['44444444-4444-4444-8444-444444444444'] });
    expect(unseen.statusCode).toBe(409);
    expect((await s.triggers({ objects: 'any' })).statusCode).toBe(200);
    await s.app.close();
  });
});
