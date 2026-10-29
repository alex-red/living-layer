import { describe, expect, it } from 'bun:test';
import type { DeskMemory, EvidenceRun, SurfacePin } from '@livinglayer/domain';
import { emptyDesk } from '../apps/web/src/session.js';
import { controlLabel, lightStates } from '../apps/web/src/workspace/labels.js';
import {
  parseSelection,
  sceneProgress,
  selectionForStep,
  selectionHash,
  type Selection,
} from '../apps/web/src/workspace/progress.js';

const states = (p: ReturnType<typeof sceneProgress>) =>
  Object.fromEntries(p.steps.map((s) => [s.id, s.state]));
const deskPin: SurfacePin = {
  scene: 'desk',
  surfaceId: 'desk:top',
  corners: [
    { x: 10, y: 10 },
    { x: 600, y: 20 },
    { x: 620, y: 400 },
    { x: 0, y: 380 },
  ],
  frame: { width: 640, height: 480 },
};

describe('scene progress', () => {
  it('starts on the office and locks the desk until a room is chosen', () => {
    const p = sceneProgress({ mode: 'live', workScene: null, memory: emptyDesk('live') });
    expect(p.next).toBe('office');
    expect(states(p)).toEqual({
      office: 'current',
      desk: 'locked',
      objects: 'todo',
      rule: 'todo',
      run: 'todo',
    });
    expect(p.steps[1]!.detail).toBe('Set up the office first.');
  });

  it('asks for the office desk next in live mode, which has no pin yet', () => {
    const p = sceneProgress({ mode: 'live', workScene: 'office', memory: emptyDesk('live') });
    expect(p.room).toBe('office');
    expect(p.view).toBe('desk');
    expect(p.next).toBe('desk');
    expect(p.steps[1]!.label).toBe('Office desk');
  });

  it('counts the demo desk as pinned, and a desk pin for the office too', () => {
    const demo = sceneProgress({
      mode: 'demo',
      workScene: 'office',
      memory: emptyDesk('demo'),
    });
    expect(demo.pinned).toBe(true);
    expect(demo.next).toBe('objects');
    const live = sceneProgress({
      mode: 'live',
      workScene: 'desk',
      memory: { ...emptyDesk('live'), surface: deskPin },
    });
    expect(live.room).toBe('office');
    expect(live.pinned).toBe(true);
  });

  it('walks through objects, the zone and a run', () => {
    const memory = {
      ...emptyDesk('demo'),
      object: { id: 'm', label: 'My desk mug' },
    } as unknown as DeskMemory;
    expect(sceneProgress({ mode: 'demo', workScene: 'desk', memory }).next).toBe('rule');
    const zoned = { ...memory, zone: { id: 'z' } } as unknown as DeskMemory;
    expect(sceneProgress({ mode: 'demo', workScene: 'desk', memory: zoned }).next).toBe('run');
    const ran = { ...zoned, lastDecision: { id: 'd' } } as unknown as DeskMemory;
    const p = sceneProgress({ mode: 'demo', workScene: 'desk', memory: ran });
    expect(p.next).toBeNull();
    expect(p.steps.every((s) => s.state === 'done')).toBe(true);
  });

  it('pins a custom room only on its own surfaces', () => {
    const memory = {
      ...emptyDesk('live'),
      surface: deskPin,
      scene: { kind: 'custom', label: 'Den', grid: { w: 4, d: 4 }, props: [], surfaces: [] },
    } as unknown as DeskMemory;
    const p = sceneProgress({ mode: 'live', workScene: 'custom', memory });
    expect(p.view).toBeNull();
    expect(p.pinned).toBe(false);
    expect(p.steps[1]!.label).toBe('Main surface');
    const own = { ...memory, surface: { ...deskPin, scene: 'custom' as const } };
    expect(sceneProgress({ mode: 'live', workScene: 'custom', memory: own }).pinned).toBe(true);
  });
});

describe('selection', () => {
  it('round-trips through the URL hash', () => {
    const all: Selection[] = [
      { kind: 'room' },
      { kind: 'view' },
      { kind: 'surface', id: 'desk:top' },
      { kind: 'object', id: 'main' },
      { kind: 'suggested', index: 2 },
      { kind: 'add' },
      { kind: 'rule', id: 'r 1' },
      { kind: 'new-rule' },
      { kind: 'fixture', id: 'f/1' },
      { kind: 'new-fixture' },
    ];
    for (const s of all) expect(parseSelection(selectionHash(s))).toEqual(s);
    expect(parseSelection('')).toBeNull();
    expect(parseSelection('#object')).toBeNull();
    expect(parseSelection('#suggested/-1')).toBeNull();
    expect(parseSelection('#fixture')).toBeNull();
  });
  it('takes each light’s newest confirmed state from switches and rules', () => {
    const run = (at: string, out: object, mode = 'demo') =>
      ({ kind: 'lamp', mode, createdAt: at, output: out }) as unknown as EvidenceRun;
    const memory = {
      ...emptyDesk('demo'),
      rules: [
        {
          entityId: 'light.shelf',
          lastDecision: {
            createdAt: '2026-10-28T10:05:00Z',
            output: {
              action: 'confirmed',
              lamp: { entityId: 'light.shelf', stateConfirmed: true },
            },
          },
        },
      ],
    } as unknown as DeskMemory;
    const states = lightStates(memory, [
      run('2026-10-28T10:00:00Z', { entityId: 'light.desk', stateConfirmed: true }),
      run('2026-10-28T10:01:00Z', { entityId: 'light.desk', action: 'off', stateConfirmed: true }),
      run('2026-10-28T10:02:00Z', { entityId: 'switch.fan', action: 'on', stateConfirmed: false }),
      run('2026-10-28T10:03:00Z', { entityId: 'light.shelf', action: 'off', stateConfirmed: true }),
      run('2026-10-28T10:09:00Z', { entityId: 'light.desk', stateConfirmed: true }, 'live'),
    ]);
    expect(Object.fromEntries(states)).toEqual({ 'light.desk': 'off', 'light.shelf': 'on' });
  });
  it('says what a fixture is and how it was last left', () => {
    expect(controlLabel({ control: { kind: 'none' } })).toBe('just a thing');
    expect(controlLabel({ control: { kind: 'switch', entityId: 'switch.fan' }, state: 'on' })).toBe(
      'switch · on',
    );
    expect(controlLabel({ control: { kind: 'light', entityId: 'light.desk' } })).toBe(
      'light · unknown',
    );
  });

  it('points each step at where it is worked on', () => {
    expect(selectionForStep('objects', emptyDesk('demo'))).toEqual({ kind: 'add' });
    expect(selectionForStep('run')).toEqual({ kind: 'rule', id: 'main' });
  });
});
