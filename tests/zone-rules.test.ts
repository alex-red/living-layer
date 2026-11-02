import { describe, expect, it } from 'bun:test';
import {
  ruleGate,
  ruleWho,
  upgradeMemory,
  withoutThings,
  type DeskMemory,
  type DeskObservation,
  type PlacementRule,
} from '@livinglayer/domain';

const MUG = '11111111-1111-4111-8111-111111111111';
const BOOK = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-02T10:00:00Z');
const frame = { width: 100, height: 100 };
const sighting = (objectId: string, x: number, ageMs = 0): DeskObservation => ({
  id: `o-${objectId}`,
  objectId,
  segmentRunId: 'run',
  detectionId: '1',
  observedAt: new Date(NOW - ageMs).toISOString(),
  sourceKey: 'k',
  frame,
  box: { x, y: 10, width: 10, height: 10 },
  identity: 'tracked',
});
function memory(mugX: number, bookX: number, bookAge = 0): DeskMemory {
  return {
    mode: 'demo',
    object: { id: MUG, label: 'Mug', createdAt: '2026-11-02T09:00:00Z' },
    observation: sighting(MUG, mugX),
    others: [
      {
        id: BOOK,
        label: 'Book',
        concept: 'book',
        createdAt: '2026-11-02T09:00:00Z',
        observation: sighting(BOOK, bookX, bookAge),
      },
    ],
    zone: null,
    lastDecision: null,
    fixedCamera: true,
  };
}
// The left half of the frame.
const rule = (over: Partial<PlacementRule> = {}): PlacementRule => ({
  id: 'r',
  label: 'Tray',
  objects: 'any',
  entityId: 'light.demo_shelf',
  zone: { sourceKey: 'k', rect: { x: 0, y: 0, width: 0.5, height: 1 }, frame },
  ...over,
});

describe('zones that count any thing, or several', () => {
  it('is occupied while any thing it counts is fully inside', () => {
    expect(ruleGate(memory(10, 70), rule(), NOW)).toMatchObject({
      decision: 'inside',
      inside: [MUG],
      objectId: MUG,
    });
    expect(ruleGate(memory(70, 10), rule(), NOW)).toMatchObject({
      decision: 'inside',
      inside: [BOOK],
    });
    expect(ruleGate(memory(70, 70), rule(), NOW)).toMatchObject({
      decision: 'outside',
      inside: [],
    });
    // Both in: either keeps it occupied when the other leaves.
    const both = ruleGate(memory(10, 20), rule(), NOW);
    expect(both.inside).toEqual([MUG, BOOK]);
    expect(
      ruleGate(memory(70, 20), rule({ placement: 'inside', inside: [MUG, BOOK] }), NOW),
    ).toMatchObject({ decision: 'inside', inside: [BOOK], objectId: MUG });
  });
  it('counts only the things it names', () => {
    const books = rule({ objects: [BOOK] });
    expect(ruleGate(memory(10, 70), books, NOW)).toMatchObject({
      decision: 'outside',
      inside: [],
    });
    expect(ruleGate(memory(70, 10), books, NOW).decision).toBe('inside');
    expect(ruleWho(memory(0, 0), books)).toBe('the Book');
    expect(ruleWho(memory(0, 0), rule({ objects: [MUG, BOOK] }))).toBe('the Mug or the Book');
    expect(ruleWho(memory(0, 0), rule())).toBe('anything');
  });
  it('keeps a thing with a stale sighting where it was last seen', () => {
    const stale = memory(70, 10, 10 * 60 * 1000);
    // The book was inside; its old sighting neither empties the zone nor counts afresh.
    expect(ruleGate(stale, rule({ placement: 'inside', inside: [BOOK] }), NOW)).toMatchObject({
      decision: 'inside',
      inside: [BOOK],
    });
    expect(ruleGate(stale, rule({ placement: 'outside', inside: [] }), NOW)).toMatchObject({
      decision: 'outside',
      inside: [],
    });
    // Nothing fresh at all: no verdict.
    const old = { ...stale, observation: sighting(MUG, 70, 10 * 60 * 1000) };
    expect(ruleGate(old, rule(), NOW).decision).toBe('blocked');
  });
  it('never counts the fixture it switches', () => {
    const m = memory(70, 70);
    expect(ruleGate(m, rule({ objects: [MUG], fixtureId: MUG }), NOW).decision).toBe('blocked');
  });
  it('drops forgotten things, and rules left counting nothing', () => {
    const rules = [
      rule({ id: 'a', objects: [MUG, BOOK], inside: [MUG] }),
      rule({ id: 'b', objects: [MUG] }),
      rule({ id: 'c', inside: [MUG] }),
    ];
    const left = withoutThings(rules, [MUG]);
    expect(left.map((r) => [r.id, r.objects, r.inside])).toEqual([
      ['a', [BOOK], []],
      ['c', 'any', []],
    ]);
  });
  it('upgrades rules saved for one object', () => {
    const legacy = { ...rule(), objects: undefined, objectId: MUG, placement: 'inside' };
    const m = { ...memory(0, 0), rules: [legacy as unknown as PlacementRule] };
    const [upgraded] = upgradeMemory(m).rules!;
    expect(upgraded).toMatchObject({ objects: [MUG], inside: [MUG] });
    expect(upgraded).not.toHaveProperty('objectId');
  });
});
