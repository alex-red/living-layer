import { describe, expect, it } from 'bun:test';
import { testApp } from './lib/app.js';
import { demoIntent } from '../apps/server/src/demo-intent.js';
import {
  catItem,
  DEMO_CAMERA,
  DEMO_FRAME,
  fixtureBox,
  followState,
  groupLabels,
  itemHeight,
  ISO_PRESETS,
  MAX_ITEM_PARTS,
  projectRoom,
  readIntent,
  relatedTargets,
  rotateItem,
  sightingBox,
  standsOn,
  starterFixtureDraft,
  variantItem,
  type AssistDraft,
  type DeskMemory,
  type EvidenceRun,
  type Fixture,
  type IntentContext,
  type IsoBox,
  type RoomThing,
  type SelectResolve,
} from '@livinglayer/domain';

const office = ISO_PRESETS.office;
const top = office.surfaces.find((s) => s.id === 'desk:top')!;
const desk = { kind: 'prop' as const, id: 'desk', label: 'Desk' };
const tree = { kind: 'fixture' as const, id: 'tree-1', label: 'Cat tree' };
const cat = { kind: 'object' as const, id: 'cat-1', label: 'Cat' };
const treeBox: IsoBox = { at: { x: 1, y: 4, z: 0 }, size: { w: 1.67, d: 1.67, h: 4 } };
/** The cat asleep on the tree's top, in tiles. */
const catOnTree: IsoBox = { at: { x: 1.4, y: 4.4, z: 4 }, size: { w: 0.93, d: 0.87, h: 0.6 } };
const SENTENCE = "let's make a variant of the tree that's occupied";

describe('what a Thing stands on', () => {
  const labels = groupLabels(office);
  it('is the layout’s surface it names, or the thing whose top it is on', () => {
    const things: RoomThing[] = [
      { target: tree, box: treeBox, surfaceId: null },
      { target: cat, box: catOnTree, surfaceId: null },
      {
        target: { kind: 'fixture', id: 'mug', label: 'Mug' },
        box: { at: { x: 4.4, y: 2.2, z: top.z }, size: { w: 0.3, d: 0.3, h: 0.3 } },
        surfaceId: 'desk:top',
      },
    ];
    expect(relatedTargets(office, things, cat, labels)).toEqual([
      { target: tree, relation: 'holds', surfaceId: null },
    ]);
    expect(relatedTargets(office, things, tree, labels)).toEqual([
      { target: cat, relation: 'on', surfaceId: null },
    ]);
    // A thing on the layout stands on its prop; furniture lists what stands on it.
    expect(relatedTargets(office, things, things[2]!.target, labels)).toEqual([
      { target: desk, relation: 'holds', surfaceId: 'desk:top' },
    ]);
    expect(relatedTargets(office, things, desk, labels)).toContainEqual({
      target: things[2]!.target,
      relation: 'on',
      surfaceId: 'desk:top',
    });
    // The picture's `object` and memory's fixture are the same Thing.
    expect(relatedTargets(office, things, { ...cat, kind: 'fixture' }, labels)).toHaveLength(1);
    expect(standsOn(treeBox, catOnTree)).toBe(false);
  });

  it('is where the camera sees a sighted thing’s foot touch down', () => {
    const foot = projectRoom(DEMO_CAMERA, { x: 1.8, y: 4.8, z: 4 })!;
    const onTree = sightingBox(DEMO_CAMERA, office, [treeBox], foot, catOnTree.size)!;
    expect(onTree.surfaceId).toBeNull();
    expect(onTree.box.at.z).toBe(4);
    expect(onTree.box.at.x + onTree.box.size.w / 2).toBeCloseTo(1.8, 6);
    const onDesk = projectRoom(DEMO_CAMERA, { x: 4.5, y: 2.3, z: top.z })!;
    expect(sightingBox(DEMO_CAMERA, office, [], onDesk, catOnTree.size)!.surfaceId).toBe(
      'desk:top',
    );
  });
});

describe('reading a variant', () => {
  const ctx: IntentContext = {
    target: cat,
    recipe: null,
    entities: [],
    related: [{ target: tree, relation: 'holds', surfaceId: null }],
  };
  it('makes it on what the selection stands on, whatever kind of Thing', () => {
    expect(readIntent(demoIntent(SENTENCE), ctx).ops).toEqual([
      { op: 'add_state', subject: tree, state: 'occupied', occupant: cat },
    ]);
  });
  it('says why when it can’t, and leaves out model edits beside it', () => {
    const bare = readIntent(demoIntent(SENTENCE), { target: tree, recipe: null, entities: [] });
    expect(bare.dropped[0]).toMatch(/Nothing stands on the Cat tree/);
    const raw = demoIntent('make a variant of the tree that is on');
    raw.ops[0] = { ...raw.ops[0]!, state: 'on' };
    expect(readIntent(raw, ctx).dropped[0]).toMatch(/what the Cat tree switches/);
    const green = demoIntent(`${SENTENCE} and make it green`);
    const both = readIntent(green, ctx);
    expect(both.ops.map((o) => o.op)).toEqual(['add_state']);
    expect(both.dropped[0]).toMatch(/on its card/);
  });
});

describe('a variant’s model', () => {
  const treeModel = starterFixtureDraft('cat-tree').model;
  const catModel = catItem('Cat', 'sleeping', ['#d9822b', '#f2f0eb']);
  for (const turns of [0, 1])
    it(`draws the occupant where it lies, the thing turned ${turns}`, () => {
      const made = variantItem(
        {
          label: 'Cat tree',
          box: treeBox,
          turns,
          model: treeModel,
          size: { w: 1.67, d: 1.67, h: 4 },
        },
        { label: 'Cat', box: catOnTree, turns: 0, model: catModel },
        'Cat tree (occupied)',
      );
      if ('reason' in made) throw new Error(made.reason);
      expect(made.model.parts.length).toBeLessThanOrEqual(MAX_ITEM_PARTS);
      const theirs = made.model.parts.filter((p) => p.id.startsWith('on-'));
      expect(theirs.length).toBeGreaterThanOrEqual(2);
      // Drawn as the room draws the tree (turned, one unit to its box's width), the cat is where it was.
      const drawn = rotateItem(made.model, turns).parts.filter((p) => p.id.startsWith('on-'));
      const s = treeBox.size.w;
      // It settles onto the top of the tree's part under its middle, not the top of the tree's box.
      const lowest = Math.min(...drawn.map((p) => treeBox.at.z + p.at.z * s));
      const mid = {
        x: catOnTree.at.x + catOnTree.size.w / 2,
        y: catOnTree.at.y + catOnTree.size.d / 2,
      };
      const under = rotateItem(treeModel, turns)
        .parts.filter(
          (p) =>
            mid.x >= treeBox.at.x + p.at.x * s &&
            mid.x <= treeBox.at.x + (p.at.x + p.size.w) * s &&
            mid.y >= treeBox.at.y + p.at.y * s &&
            mid.y <= treeBox.at.y + (p.at.y + p.size.d) * s,
        )
        .map((p) => treeBox.at.z + (p.at.z + p.size.h) * s);
      expect(lowest).toBeCloseTo(Math.max(...under), 1);
      expect(lowest).toBeLessThanOrEqual(catOnTree.at.z);
      const x0 = Math.min(...drawn.map((p) => treeBox.at.x + p.at.x * s));
      const x1 = Math.max(...drawn.map((p) => treeBox.at.x + (p.at.x + p.size.w) * s));
      expect(x0).toBeGreaterThanOrEqual(catOnTree.at.x - 0.05);
      expect(x1).toBeLessThanOrEqual(catOnTree.at.x + catOnTree.size.w + 0.05);
      // Never shorter than its own box; taller only by what lies above it.
      expect(made.size.h).toBeCloseTo(
        Math.max(4, lowest + itemHeight(catModel) * catOnTree.size.w),
        6,
      );
    });

  it('keeps every part of the thing and of what lies on it when they fit', () => {
    const made = variantItem(
      { label: 'Cat tree', box: treeBox, turns: 0, model: treeModel, size: treeBox.size },
      { label: 'Cat', box: catOnTree, turns: 0, model: catModel },
      'Cat tree (occupied)',
    );
    if ('reason' in made) throw new Error(made.reason);
    expect(treeModel.parts.length + catModel.parts.length).toBeGreaterThan(12);
    const ids = made.model.parts.map((p) => p.id);
    expect(ids.filter((id) => !id.startsWith('on-')).toSorted()).toEqual(
      treeModel.parts.map((p) => p.id).toSorted(),
    );
    expect(ids.filter((id) => id.startsWith('on-'))).toHaveLength(catModel.parts.length);
  });

  it('shows a state named for the stat it follows, whatever it is called', () => {
    const things = [
      { id: 'tower', state: null, states: { sleeping: { follows: 'occupied' } } },
      { id: 'tv', state: null, states: { playing: { follows: 'power' } } },
    ] as unknown as Fixture[];
    const sat = followState(things, 'occupied', () => true);
    expect(sat.map((f) => f.state)).toEqual(['sleeping', null]);
    expect(followState(sat, 'occupied', () => false).map((f) => f.state)).toEqual([null, null]);
    expect(followState(things, 'power', () => true).map((f) => f.state)).toEqual([null, 'playing']);
  });

  it('lets a state named occupied that follows another stat go its own way', () => {
    const things = [
      { id: 'a', state: null, states: { occupied: { follows: 'power' } } },
    ] as unknown as Fixture[];
    expect(followState(things, 'occupied', () => true)).toBe(things);
  });

  it('shows the occupied state while the stat is on, and only switches that one off', () => {
    const things = [
      { id: 'a', state: null, states: { occupied: {} } },
      { id: 'b', state: 'on', states: { occupied: {} } },
      { id: 'c', state: null },
    ] as unknown as Fixture[];
    const on = followState(things, 'occupied', () => true);
    expect(on.map((f) => f.state)).toEqual(['occupied', 'occupied', null]);
    expect(followState(on, 'occupied', () => null)).toBe(on);
    const off = followState(on, 'occupied', (id) => (id === 'a' ? false : null));
    expect(off.map((f) => f.state)).toEqual([null, 'occupied', null]);
    expect(followState(things, 'occupied', () => false)).toBe(things);
  });
});

describe('the brush making a variant of a Thing in the demo', () => {
  async function room() {
    const s = await testApp({ name: 'brush-variant' });
    const draft = starterFixtureDraft('cat-tree');
    const saved = await s.post('fixtures/save', {
      fixture: {
        label: 'Cat tree',
        scene: 'office',
        surfaceId: null,
        at: { x: treeBox.at.x, y: treeBox.at.y },
        turns: 0,
        size: treeBox.size,
        model: { label: draft.model.label, parts: draft.model.parts },
        reference: null,
        control: { kind: 'none' },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    return { s, memory: saved.json<DeskMemory>() };
  }

  it('selects the cat the camera sees on its tree, and keeps the tree’s occupied state', async () => {
    const { s, memory } = await room();
    const treeId = memory.fixtures!.find((f) => f.label === 'Cat tree')!.id;
    const b = fixtureBox(
      memory.fixtures!.find((f) => f.id === treeId)!,
      memory.scene,
    );
    const foot = projectRoom(DEMO_CAMERA, {
      x: b.at.x + b.size.w / 2,
      y: b.at.y + b.size.d / 2,
      z: b.at.z + b.size.h,
    })!;
    const box = { x: foot.x - 20, y: foot.y - 28, width: 40, height: 28 };
    const observation = {
      id: 'obs-1',
      objectId: 'cat-1',
      segmentRunId: 'run-1',
      detectionId: 'd1',
      observedAt: new Date().toISOString(),
      sourceKey: 'demo',
      frame: { ...DEMO_FRAME },
      box,
      identity: 'manual' as const,
    };
    const now = new Date().toISOString();
    const sightedCat = {
      id: crypto.randomUUID(),
      label: 'Cat',
      scene: 'office',
      surfaceId: null,
      at: { x: 0, y: 0 },
      turns: 0,
      size: catOnTree.size,
      model: {
        ...catItem('Cat', 'sleeping', ['#d9822b', '#f2f0eb']),
        source: 'demo',
        segmentRunId: null,
        swatches: [],
        updatedAt: now,
      },
      reference: null,
      control: { kind: 'none' },
      place: 'sightings',
      track: { concept: 'cat', observation, history: [], status: 'seen' },
      createdAt: now,
      updatedAt: now,
    };
    const restored = await s.post('desk/restore', {
      memory: { ...memory, fixtures: [...memory.fixtures!, sightedCat] },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const per = (v: number, of: number) => Math.round((v / of) * 1000);
    const shape = {
      kind: 'rect',
      box: {
        x1: per(box.x - 2, DEMO_FRAME.width),
        y1: per(box.y - 2, DEMO_FRAME.height),
        x2: per(box.x + box.width + 2, DEMO_FRAME.width),
        y2: per(box.y + box.height + 2, DEMO_FRAME.height),
      },
    };

    const resolved = (await s.post('select/resolve', { shape })).json<SelectResolve>();
    expect(resolved.target).toMatchObject({ kind: 'object', id: sightedCat.id });
    expect(resolved.related).toEqual([
      {
        target: { kind: 'fixture', id: treeId, label: 'Cat tree' },
        relation: 'holds',
        surfaceId: null,
      },
    ]);

    const res = await s.post('assist', { shape, prompt: SENTENCE, jobId: crypto.randomUUID() });
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json<EvidenceRun<AssistDraft>>();
    const v = run.output.variant!;
    expect(v).toMatchObject({
      subject: { kind: 'fixture', id: treeId },
      state: 'occupied',
      promotes: false,
      follows: true,
    });
    expect(v.model.parts.some((p) => p.id.startsWith('on-'))).toBe(true);
    expect(run.output.recipe).toBeNull();

    const kept = await s.post('assist/save', { runId: run.id });
    expect(kept.statusCode, kept.body).toBe(200);
    const after = kept.json<{ memory: DeskMemory; thing: string }>();
    expect(after.thing).toBe(treeId);
    const thing = after.memory.fixtures!.find((f) => f.id === treeId)!;
    expect(Object.keys(thing.states ?? {})).toContain('occupied');
    expect(thing.states!.occupied!.size!.h).toBeGreaterThan(treeBox.size.h);
    // Still showing its own model until the stat says otherwise.
    expect(thing.state ?? null).toBeNull();
    expect(after.memory.thingStats?.[treeId]).toEqual([{ key: 'occupied', concept: 'cat' }]);
    // The layout carries none of it.
    expect(after.memory.scene?.props.some((p) => 'states' in p) ?? false).toBe(false);
  });

  it('won’t make furniture a thing when what was put on it by hand would fall off', async () => {
    const { s } = await room();
    const saved = await s.post('fixtures/save', {
      fixture: {
        label: 'Cat',
        scene: 'office',
        surfaceId: 'desk:top',
        at: { x: 4.4, y: 2.2 },
        turns: 0,
        size: catOnTree.size,
        model: { label: 'Cat', parts: catItem('Cat', 'sleeping').parts },
        reference: null,
        control: { kind: 'none' },
      },
    });
    const id = saved.json<DeskMemory>().fixtures!.find((f) => f.label === 'Cat')!.id;
    const resolved = await s.post('select/resolve', {
      shape: { kind: 'rect', box: { x1: 0, y1: 0, x2: 1000, y2: 1000 } },
    });
    expect(resolved.statusCode).toBe(200);
    const res = await s.post('assist', {
      shape: { kind: 'rect', box: { x1: 0, y1: 0, x2: 1000, y2: 1000 } },
      prompt: `make a variant of the desk that's occupied`,
    });
    // The whole frame is nothing in particular: asked back, not guessed.
    expect(res.json<EvidenceRun<AssistDraft>>().output.question).toBeTruthy();
    // Selecting the cat itself names the desk under it, and is refused with why.
    const { shapeOf } = await import('../scripts/lib/brush.js');
    const { selectionRoom } = await import('../apps/server/src/select.js');
    const memory = await s.memory();
    const shape = shapeOf({ around: `fixture:${id}` }, selectionRoom(memory));
    const refused = await s.post('assist', {
      shape,
      prompt: "make a variant of the desk that's occupied",
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toMatch(/would leave the Cat on it/);
  });
});
