import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import sharp from 'sharp';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { ControlAdapter } from '../apps/server/src/control.js';
import { syntheticStream } from '../apps/server/src/sam.js';
import { latheSplat, mugSplat } from './lib/splat.js';
import { demoPhotoInventory, demoPhotoSegmentation } from '../apps/server/src/demo.js';
import {
  STARTER_TEMPLATES,
  archetypeOf,
  defaultFixtureStates,
  starterFixtureDraft,
  buildItem,
  catItem,
  defaultFit,
  fixtureBox,
  fixtureControlSchema,
  fixtureEntity,
  fixtureInputSchema,
  fixtureModel,
  fixtureProblem,
  fixtureSize,
  fixtureStateNames,
  inRoomView,
  isoItemSchema,
  itemHeight,
  mugItem,
  placeTemplate,
  ruleInputSchema,
  settleFixtures,
  followSurfaces,
  rotateGroup,
  moveGroup,
  sizeInTiles,
  tileCm,
  upgradeMemory,
  type DeskMemory,
  type EvidenceRun,
  type Fixture,
  type FixtureClass,
  type FixtureDraft,
  type IsoScene,
  type Job,
  type LatheFit,
  type LampResult,
  type PlacementRule,
  type Segmentation,
} from '@livinglayer/domain';

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    id: crypto.randomUUID(),
    label: 'Desk lamp',
    scene: 'desk',
    surfaceId: 'desk:top',
    at: { x: 2, y: 2 },
    turns: 0,
    size: { w: 1, d: 0.5, h: 1.5 },
    model: { ...mugItem(), source: 'demo', segmentRunId: null, swatches: [], updatedAt: '' },
    reference: null,
    control: { kind: 'light', entityId: 'light.demo_shelf' },
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    ...over,
  };
}
function customDesk(): IsoScene {
  const desk = placeTemplate('desk', 'desk', 1, 1);
  return {
    kind: 'custom',
    label: 'Mine',
    grid: { w: 8, d: 8 },
    props: desk.props,
    surfaces: desk.surfaces,
  };
}

describe('fixtures', () => {
  it('ties lights to light entities and switches to switch entities', () => {
    expect(fixtureControlSchema.safeParse({ kind: 'light', entityId: 'light.desk' }).success).toBe(
      true,
    );
    expect(fixtureControlSchema.safeParse({ kind: 'switch', entityId: 'switch.fan' }).success).toBe(
      true,
    );
    expect(fixtureControlSchema.safeParse({ kind: 'light', entityId: 'switch.fan' }).success).toBe(
      false,
    );
    expect(fixtureControlSchema.safeParse({ kind: 'none', entityId: 'light.desk' }).success).toBe(
      false,
    );
    expect(fixtureEntity({ control: { kind: 'none' } })).toBeNull();
    expect(fixtureEntity(fixture())).toBe('light.demo_shelf');
  });
  it('accepts what a person sends to save one, and nothing more', () => {
    const { id: _id, createdAt: _c, updatedAt: _u, model, ...rest } = fixture();
    const input = { ...rest, model: { label: model.label, parts: model.parts } };
    expect(fixtureInputSchema.safeParse(input).success).toBe(true);
    expect(fixtureInputSchema.safeParse({ ...input, turns: 4 }).success).toBe(false);
    expect(fixtureInputSchema.safeParse({ ...input, state: 'on' }).success).toBe(false);
  });
  it('keeps its own place in the room’s view, checked like its other one', () => {
    const f = fixture({ room: { at: { x: 0.5, y: 5 }, surfaceId: null } });
    expect(inRoomView(f)).toMatchObject({ at: { x: 0.5, y: 5 }, surfaceId: null });
    expect(inRoomView(fixture()).at).toEqual(fixture().at);
    expect(fixtureProblem(f)).toBeNull();
    expect(fixtureProblem(fixture({ room: { at: { x: 7.5, y: 2 }, surfaceId: null } }))).toMatch(
      /inside the room/,
    );
  });
  it('stands on its surface, turned', () => {
    const box = fixtureBox(fixture({ turns: 1 }));
    expect(box.at).toEqual({ x: 2, y: 2, z: 2.4 });
    expect(box.size).toEqual({ w: 0.5, d: 1, h: 1.5 });
    expect(fixtureBox(fixture({ surfaceId: null })).at.z).toBe(0);
  });
  it('says why it can’t stand where it says', () => {
    expect(fixtureProblem(fixture())).toBeNull();
    expect(fixtureProblem(fixture({ at: { x: 7.5, y: 2 } }))).toMatch(/inside the room/);
    expect(fixtureProblem(fixture({ surfaceId: 'shelf:top' }))).toMatch(/no surface/);
    expect(fixtureProblem(fixture({ at: { x: 0.1, y: 5 } }))).toMatch(/stand on desktop/);
    expect(fixtureProblem(fixture({ scene: 'custom' }))).toMatch(/your own scene/);
    expect(
      fixtureProblem(fixture({ scene: 'custom', at: { x: 2, y: 2 } }), customDesk()),
    ).toBeNull();
  });
  it('settles onto the floor when its surface goes, and goes with its scene', () => {
    const preset = fixture();
    const mine = fixture({ scene: 'custom', at: { x: 7.8, y: 2 } });
    const bare: IsoScene = { ...customDesk(), props: customDesk().props, surfaces: [] };
    const [kept, settled] = settleFixtures([preset, mine], bare);
    expect(kept).toBe(preset);
    expect(settled).toMatchObject({ surfaceId: null, at: { x: 7, y: 2 } });
    expect(settleFixtures([preset, mine], null)).toEqual([preset]);
  });
  it('keeps a fixture where it stood on a desk that was turned, turned with it', () => {
    const before = customDesk();
    const lamp = fixture({ scene: 'custom', surfaceId: 'desk:top', at: { x: 1.4, y: 1.3 } });
    expect(fixtureProblem(lamp, before)).toBeNull();
    const after = rotateGroup(before, 'desk');
    const [moved] = followSurfaces([lamp], before, after);
    expect(moved!.turns).toBe(1);
    expect(fixtureProblem(moved!, after)).toBeNull();
    // Its offset from the desk's centre, turned a quarter clockwise.
    const centre = (f: Fixture, sc: IsoScene) => {
      const b = fixtureBox(f, sc);
      return { x: b.at.x + b.size.w / 2, y: b.at.y + b.size.d / 2 };
    };
    const top = (sc: IsoScene) => sc.surfaces.find((t) => t.id === 'desk:top')!.rect;
    const mid = (r: { x: number; y: number; w: number; d: number }) => ({
      x: r.x + r.w / 2,
      y: r.y + r.d / 2,
    });
    const a = centre(lamp, before);
    const b = centre(moved!, after);
    expect(b.x - mid(top(after)).x).toBeCloseTo(-(a.y - mid(top(before)).y));
    expect(b.y - mid(top(after)).y).toBeCloseTo(a.x - mid(top(before)).x);
    // A fixture on the floor, or on a surface that didn't move, stays put.
    const floor = fixture({ scene: 'custom', surfaceId: null, at: { x: 6, y: 6 } });
    expect(followSurfaces([floor], before, after)[0]).toBe(floor);
    expect(followSurfaces([lamp], before, before)[0]).toBe(lamp);
    // A desk dragged across the room takes the lamp along, unturned.
    const [carried] = followSurfaces([lamp], before, moveGroup(before, 'desk', 2, 1));
    expect(carried).toMatchObject({ turns: 0, at: { x: 3.4, y: 2.3 } });
  });
  it('lets rules target a switch or a fixture', () => {
    const rule = {
      label: 'Fan',
      objectId: crypto.randomUUID(),
      entityId: 'switch.fan',
      fixtureId: crypto.randomUUID(),
      rect: { x: 0, y: 0, width: 1, height: 1 },
    };
    expect(ruleInputSchema.safeParse(rule).success).toBe(true);
    expect(ruleInputSchema.safeParse({ ...rule, entityId: 'fan.desk' }).success).toBe(false);
  });
  it('upgrades rules saved with only a light', () => {
    const legacy = { id: 'r', lightId: 'light.desk' } as unknown as PlacementRule;
    const memory = { mode: 'demo', rules: [legacy] } as unknown as DeskMemory;
    const upgraded = upgradeMemory(memory);
    expect(upgraded.rules![0]).toEqual({ id: 'r', entityId: 'light.desk' } as PlacementRule);
    expect(upgradeMemory(upgraded)).toBe(upgraded);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function setup(env: Record<string, string> = {}, fetcher: Fetcher = mock<Fetcher>()) {
  const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-fixture-'));
  dirs.push(dataDir);
  const app = await buildApp(parseConfig({ DATA_DIR: dataDir, ...env }), {
    fetcher,
    serveWeb: false,
  });
  const post = (path: string, body: object = {}) =>
    app.inject({ method: 'POST', url: `/api/${path}`, payload: { mode: 'demo', ...body } });
  const memory = async () => (await app.inject('/api/desk/demo')).json<DeskMemory>();
  const restore = (next: DeskMemory) => post('desk/restore', { memory: next });
  return { app, post, memory, restore, dataDir };
}

describe('fixtures in desk memory', () => {
  it('survive a reset, and settle when the scene changes', async () => {
    const s = await setup();
    const lamp = fixture();
    const mine = fixture({ scene: 'custom', surfaceId: 'desk:top', at: { x: 2, y: 2 } });
    await s.post('scene/save', { scene: customDesk() });
    expect((await s.restore({ ...(await s.memory()), fixtures: [lamp, mine] })).statusCode).toBe(
      200,
    );
    const reset = (await s.post('desk/reset')).json<DeskMemory>();
    expect(reset.fixtures?.map((f) => f.id)).toEqual([lamp.id, mine.id]);
    const saved = (
      await s.post('scene/save', { scene: { ...customDesk(), surfaces: [] } })
    ).json<DeskMemory>();
    expect(saved.fixtures?.[1]?.surfaceId).toBeNull();
    const dropped = (await s.post('scene/save', { scene: null })).json<DeskMemory>();
    expect(dropped.fixtures?.map((f) => f.id)).toEqual([lamp.id]);
  });
  it('lets a rule target a fixture only for the entity it switches', async () => {
    const s = await setup();
    const segment = (await s.post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
    const picked = (
      await s.post('desk/select', { segmentRunId: segment.id, detectionId: '7' })
    ).json<DeskMemory>();
    const lamp = fixture();
    await s.restore({ ...picked, fixtures: [lamp] });
    const rule = {
      label: 'Desk',
      objectId: picked.object!.id,
      fixtureId: lamp.id,
      rect: { x: 0, y: 0, width: 1, height: 1 },
    };
    const wrong = await s.post('desk/rules/save', {
      rule: { ...rule, entityId: 'light.demo_fridge' },
    });
    expect(wrong.statusCode).toBe(400);
    const saved = (
      await s.post('desk/rules/save', { rule: { ...rule, entityId: 'light.demo_shelf' } })
    ).json<DeskMemory>();
    expect(saved.rules?.[0]).toMatchObject({ entityId: 'light.demo_shelf', fixtureId: lamp.id });
  });
  it('reads rules saved before they could target switches', async () => {
    const s = await setup();
    const store = new EvidenceStore(s.dataDir);
    const legacy = { id: 'r', label: 'Desk', lightId: 'light.demo_desk' };
    store.saveMemory({
      ...(await s.memory()),
      rules: [legacy as unknown as PlacementRule],
    });
    store.close();
    expect((await s.memory()).rules?.[0]).toMatchObject({ entityId: 'light.demo_desk' });
  });
});

/** A fake Home Assistant: every entity reports `state`, and every service call is kept. */
function fakeHa(state: () => string) {
  const calls: { path: string; body?: unknown }[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return new Response(
      JSON.stringify(
        path.includes('/services/')
          ? []
          : { state: state(), attributes: { supported_color_modes: ['color_temp'] } },
      ),
    );
  };
  return { fetcher, calls };
}
const ha = {
  HA_URL: 'http://ha.local:8123',
  HA_TOKEN: 't',
  HA_ENTITY_ID: 'light.desk',
  HA_SWITCH_ENTITY_IDS: 'switch.fan',
  HA_LIVE_ENABLED: 'true',
};

describe('lights and switches', () => {
  it('parses switch entities, and only switch entities', () => {
    expect(
      parseConfig({ HA_SWITCH_ENTITY_IDS: 'switch.fan, switch.fan,switch.tv' }).haSwitches,
    ).toEqual(['switch.fan', 'switch.tv']);
    expect(() => parseConfig({ HA_SWITCH_ENTITY_IDS: 'light.desk' })).toThrow();
  });
  it('turns a switch on with only its entity, and checks its state', async () => {
    const { fetcher, calls } = fakeHa(() => 'on');
    const result = await new ControlAdapter(parseConfig(ha), fetcher, async () => {}).turnOn(
      'switch.fan',
    );
    expect(calls[1]).toEqual({
      path: '/api/services/switch/turn_on',
      body: { entity_id: 'switch.fan' },
    });
    expect(result).toMatchObject({
      entityId: 'switch.fan',
      action: 'on',
      stateConfirmed: true,
      desired: {},
    });
    expect(result.physicalEffectVerified).toBe(false);
  });
  it('turns a light off without asking for brightness, and waits for off', async () => {
    let state = 'on';
    const { fetcher, calls } = fakeHa(() => state);
    const adapter = new ControlAdapter(parseConfig(ha), fetcher, async () => {
      state = 'off';
    });
    const result = await adapter.turnOff('light.desk');
    expect(calls[1]).toEqual({
      path: '/api/services/light/turn_off',
      body: { entity_id: 'light.desk' },
    });
    expect(result).toMatchObject({ action: 'off', state: 'off', stateConfirmed: true });
  });
  it('refuses entities that aren’t configured', async () => {
    const { fetcher, calls } = fakeHa(() => 'on');
    const adapter = new ControlAdapter(parseConfig(ha), fetcher, async () => {});
    await expect(adapter.turnOn('switch.heater')).rejects.toThrow(/configured/);
    expect(calls).toHaveLength(0);
  });
});

describe('fixture routes', () => {
  const input = () => {
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      model,
      ...rest
    } = fixture({
      control: { kind: 'switch', entityId: 'switch.demo_fan' },
      label: 'Fan',
    });
    return { ...rest, model: { label: model.label, parts: model.parts } };
  };
  it('keeps its room place through saves that leave it out, until one clears it', async () => {
    const s = await setup();
    const room = { at: { x: 0.5, y: 5 }, surfaceId: null };
    const fan = (
      await s.post('fixtures/save', { fixture: { ...input(), room } })
    ).json<DeskMemory>().fixtures![0]!;
    expect(fan.room).toEqual(room);
    // A move where the camera puts it leaves the room's place alone.
    const moved = (
      await s.post('fixtures/save', { fixture: { ...input(), id: fan.id, at: { x: 3, y: 2 } } })
    ).json<DeskMemory>().fixtures![0]!;
    expect(moved).toMatchObject({ at: { x: 3, y: 2 }, room });
    const cleared = (
      await s.post('fixtures/save', { fixture: { ...input(), id: fan.id, room: null } })
    ).json<DeskMemory>().fixtures![0]!;
    expect(cleared.room).toBeUndefined();
    const outside = await s.post('fixtures/save', {
      fixture: { ...input(), id: fan.id, room: { at: { x: 9, y: 9 }, surfaceId: null } },
    });
    expect(outside.statusCode).toBe(400);
  });
  it('saves, moves and refuses a fixture that can’t stand or switch', async () => {
    const s = await setup();
    const saved = (await s.post('fixtures/save', { fixture: input() })).json<DeskMemory>();
    const fan = saved.fixtures![0]!;
    expect(fan).toMatchObject({ label: 'Fan', state: null, model: { source: 'demo' } });
    const moved = (
      await s.post('fixtures/save', { fixture: { ...input(), id: fan.id, at: { x: 3, y: 2 } } })
    ).json<DeskMemory>();
    expect(moved.fixtures).toHaveLength(1);
    expect(moved.fixtures![0]).toMatchObject({
      id: fan.id,
      at: { x: 3, y: 2 },
      createdAt: fan.createdAt,
    });
    const off = await s.post('fixtures/save', { fixture: { ...input(), at: { x: 20, y: 2 } } });
    expect(off.statusCode).toBe(400);
    const unknown = await s.post('fixtures/save', {
      fixture: { ...input(), control: { kind: 'switch', entityId: 'switch.heater' } },
    });
    expect(unknown.statusCode).toBe(400);
    const ghost = await s.post('fixtures/save', {
      fixture: { ...input(), id: crypto.randomUUID() },
    });
    expect(ghost.statusCode).toBe(404);
  });
  it('switches a demo fixture on and off and records each action', async () => {
    const s = await setup();
    const fan = (await s.post('fixtures/save', { fixture: input() })).json<DeskMemory>()
      .fixtures![0]!;
    const on = (await s.post('fixtures/control', { fixtureId: fan.id, action: 'on' })).json<{
      memory: DeskMemory;
      event: EvidenceRun<LampResult>;
    }>();
    expect(on.event).toMatchObject({ kind: 'lamp', status: 'completed' });
    expect(on.event.output).toMatchObject({
      entityId: 'switch.demo_fan',
      action: 'on',
      desired: {},
    });
    expect(on.memory.fixtures![0]!.state).toBe('on');
    const off = (await s.post('fixtures/control', { fixtureId: fan.id, action: 'off' })).json<{
      memory: DeskMemory;
    }>();
    expect(off.memory.fixtures![0]!.state).toBe('off');
    const mouse = (
      await s.post('fixtures/save', {
        fixture: { ...input(), label: 'Mouse', control: { kind: 'none' } },
      })
    ).json<DeskMemory>().fixtures![1]!;
    const nothing = await s.post('fixtures/control', { fixtureId: mouse.id, action: 'on' });
    expect(nothing.statusCode).toBe(400);
  });
  it('marks a fixture on when a rule switches its entity', async () => {
    const s = await setup();
    const segment = (await s.post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
    const picked = (
      await s.post('desk/select', { segmentRunId: segment.id, detectionId: '7' })
    ).json<DeskMemory>();
    const fan = (await s.post('fixtures/save', { fixture: input() })).json<DeskMemory>()
      .fixtures![0]!;
    await s.post('desk/rules/save', {
      rule: {
        label: 'Desk',
        objectId: picked.object!.id,
        entityId: 'switch.demo_fan',
        fixtureId: fan.id,
        rect: { x: 0, y: 0, width: 1, height: 1 },
      },
    });
    const checked = (await s.post('desk/rules/verify')).json<{ memory: DeskMemory }>();
    expect(checked.memory.fixtures![0]!.state).toBe('on');
    const gone = (await s.post('fixtures/delete', { fixtureId: fan.id })).json<DeskMemory>();
    expect(gone.fixtures).toEqual([]);
    expect(gone.rules![0]!.entityId).toBe('switch.demo_fan');
    expect(gone.rules![0]!.fixtureId).toBeUndefined();
  });
  it('deletes several fixtures at once, and skips them in scans when asked', async () => {
    const s = await setup();
    const save = async (label: string) =>
      (await s.post('fixtures/save', { fixture: { ...input(), label, control: { kind: 'none' } } }))
        .json<DeskMemory>()
        .fixtures!.at(-1)!;
    const [fan, mouse, plant] = [await save('Fan'), await save('Mouse'), await save('Plant')];
    const gone = await s.post('fixtures/delete', { fixtureIds: [fan.id, plant.id], dismiss: true });
    expect(gone.statusCode, gone.body).toBe(200);
    const memory = gone.json<DeskMemory>();
    expect(memory.fixtures!.map((f) => f.id)).toEqual([mouse.id]);
    expect(memory.dismissed).toEqual(['Fan', 'Plant']);
    // One way or the other, not both.
    const both = await s.post('fixtures/delete', { fixtureId: mouse.id, fixtureIds: [mouse.id] });
    expect(both.statusCode).toBe(400);
  });
  it('switches a live fixture through Home Assistant and lists switches', async () => {
    const { fetcher, calls } = fakeHa(() => 'on');
    const s = await setup(ha, fetcher);
    const status = (await s.app.inject('/api/status')).json<{ lamp: { switches: string[] } }>();
    expect(status.lamp.switches).toEqual(['switch.fan']);
    const live = (path: string, body: object) =>
      s.app.inject({ method: 'POST', url: `/api/${path}`, payload: { mode: 'live', ...body } });
    const fan = (
      await live('fixtures/save', {
        fixture: { ...input(), control: { kind: 'switch', entityId: 'switch.fan' } },
      })
    ).json<DeskMemory>().fixtures![0]!;
    const on = (await live('fixtures/control', { fixtureId: fan.id, action: 'on' })).json<{
      memory: DeskMemory;
    }>();
    expect(calls.map((c) => c.path)).toContain('/api/services/switch/turn_on');
    expect(on.memory.fixtures![0]!.state).toBe('on');
    // A switch is not proof of the lamp.
    const after = (await s.app.inject('/api/status')).json<{ liveEvidence: { lamp: boolean } }>();
    expect(after.liveEvidence.lamp).toBe(false);
  });
});

describe('drafting a fixture from a reference picture', () => {
  type Drafted = { run: EvidenceRun; draft: FixtureDraft };
  it('sizes a fixture by the scene’s own desk', () => {
    expect(tileCm()).toBe(30);
    expect(sizeInTiles({ w: 6.5, d: 11.5, h: 4 })).toEqual({ w: 0.22, d: 0.38, h: 0.13 });
    expect(sizeInTiles({ w: 1, d: 900, h: 4 })).toMatchObject({ w: 0.1, d: 8 });
  });
  it('drafts the demo mouse offline, then saves it with its fit', async () => {
    const s = await setup();
    const res = await s.post('fixtures/draft', { scene: 'desk', reference: 'mouse' });
    expect(res.statusCode).toBe(200);
    const { run, draft } = res.json<Drafted>();
    expect(run).toMatchObject({ kind: 'fixture', mode: 'demo', status: 'completed', usage: null });
    expect(draft).toMatchObject({
      label: 'Computer mouse',
      suggested: 'none',
      size: { w: 0.22, d: 0.38, h: 0.13 },
      reference: { runId: run.id, asset: `${run.id}/reference.png` },
      model: { source: 'demo' },
    });
    // Seen from above, it is a flat outline, as tall as a mouse is for its length.
    expect(draft.model.parts).toHaveLength(1);
    expect(draft.model.parts[0]).toMatchObject({ shape: 'extrude' });
    expect(itemHeight(draft.model)).toBeCloseTo(4 / 11.5, 2);
    expect(draft.model.fit!.iou).toBeGreaterThan(0.9);
    expect(run.assets).toContain(`${run.id}/item-crop.png`);
    const saved = (
      await s.post('fixtures/save', {
        fixture: {
          label: draft.label,
          scene: 'desk',
          surfaceId: 'desk:top',
          at: { x: 3, y: 2 },
          turns: 0,
          size: draft.size,
          model: { label: draft.model.label, parts: draft.model.parts },
          reference: draft.reference,
          control: { kind: 'none' },
        },
      })
    ).json<DeskMemory>();
    const mouse = saved.fixtures![0]!;
    expect(mouse.model.swatches).toEqual(draft.model.swatches);
    expect(mouse.model.fit).toMatchObject({ crop: draft.model.fit!.crop, archetype: 'device' });
    expect(mouse.model.fit!.iou).toBeCloseTo(draft.model.fit!.iou, 5);
  });
  it('takes the real size of a saved product its name matches', async () => {
    const s = await setup();
    const { draft } = (
      await s.post('fixtures/draft', {
        scene: 'office',
        reference: 'mouse',
        label: 'IKEA Alex desk',
      })
    ).json<Drafted>();
    expect(draft.product).toBe('IKEA ALEX desk');
    // 131 × 60 × 76 cm, laid along the drafted thing's own longer side (its depth).
    expect(draft.size).toEqual({ w: 60 / 30, d: 131 / 30, h: 76 / 30 });
    expect(draft.model.fit!.assists.at(-1)).toMatch(/^Sized as the IKEA ALEX desk/);
    const plain = (
      await s.post('fixtures/draft', { scene: 'office', reference: 'mouse' })
    ).json<Drafted>();
    expect(plain.draft.product).toBeUndefined();
    expect(plain.draft.size).toEqual({ w: 0.22, d: 0.38, h: 0.13 });
  });
  it('takes a name, and only bundled pictures in demo mode', async () => {
    const s = await setup();
    const named = (
      await s.post('fixtures/draft', { scene: 'office', reference: 'mouse', label: 'My mouse' })
    ).json<Drafted>();
    expect(named.draft.label).toBe('My mouse');
    expect((await s.post('fixtures/draft', { scene: 'desk' })).statusCode).toBe(400);
    const live = await s.app.inject({
      method: 'POST',
      url: '/api/fixtures/draft',
      payload: { mode: 'live', scene: 'desk', reference: 'mouse' },
    });
    expect(live.statusCode).toBe(400);
    expect(
      (await s.post('fixtures/draft', { scene: 'custom', reference: 'mouse' })).statusCode,
    ).toBe(409);
  });
});

describe('fixture shapes', () => {
  it('names devices and lamps from their labels', () => {
    expect(archetypeOf('wireless mouse')).toBe('device');
    expect(archetypeOf('light switch')).toBe('device');
    expect(archetypeOf('tv remote')).toBe('device');
    expect(archetypeOf('desk lamp')).toBe('lamp');
    expect(archetypeOf('phone')).toBe('box');
  });
  it('takes only a thing named as a cat for one, not a cat tower or bed', () => {
    const states = (label: string) =>
      defaultFixtureStates({ label, model: { label, parts: [], swatches: [] } as never }).states;
    for (const cat of ['Gray cat', 'Sleeping kitten', 'Black cat '])
      expect([archetypeOf(cat), Object.keys(states(cat) ?? {})]).toEqual([
        'cat',
        ['idle', 'sleeping'],
      ]);
    for (const thing of ['Gray cat tower', 'cat bed', 'Cat litter box']) {
      expect(archetypeOf(thing)).not.toBe('cat');
      expect(states(thing)).toBeUndefined();
    }
  });
  it('builds a flat thing as one rounded extrusion, and a lamp as a turned body', () => {
    const flat = buildItem('Mouse', defaultFit('device'));
    expect(isoItemSchema.safeParse(flat).success).toBe(true);
    expect(flat.parts.map((p) => p.shape)).toEqual(['extrude']);
    const lamp = buildItem('Lamp', defaultFit('lamp'));
    expect(isoItemSchema.safeParse(lamp).success).toBe(true);
    expect(lamp.parts.map((p) => p.shape)).toEqual(['lathe']);
  });
  it('drafts the demo lamp as a light with a stem under its shade', async () => {
    const s = await setup();
    const { draft } = (await s.post('fixtures/draft', { scene: 'desk', reference: 'lamp' })).json<{
      draft: FixtureDraft;
    }>();
    expect(draft).toMatchObject({ label: 'Desk lamp', suggested: 'light', archetype: 'lamp' });
    const profile = draft.model.parts[0]!.profile!;
    const r = (z: number) =>
      profile.reduce((a, p) => (Math.abs(p.z - z) < Math.abs(a.z - z) ? p : a)).r;
    expect(r(0.35)).toBeLessThan(0.2);
    expect(Math.max(...profile.filter((p) => p.z > 0.6).map((p) => p.r))).toBeGreaterThan(0.9);
    expect(draft.model.fit!.iou).toBeGreaterThan(0.8);
  });
});

describe('drafting a fixture live, with a mocked Meta API', () => {
  const demo = JSON.parse(readFileSync('testdata/sam-mug.json', 'utf8')) as { wire: string };
  async function samResponse(wire: string) {
    const events = [];
    for await (const event of syntheticStream(wire))
      events.push(
        event.type === 'response.completed'
          ? { ...event, response: { id: 'resp_sam', model: 'sam-3.1', status: 'completed' } }
          : event,
      );
    const body =
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') +
      'data: [DONE]\n\n';
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }
  const sparkResponse = (output: object) =>
    new Response(
      JSON.stringify({
        id: 'resp_spark',
        object: 'response',
        model: 'muse-spark-1.3',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      }),
      { headers: { 'content-type': 'application/json', 'x-request-id': 'req-spark' } },
    );
  const lampClass: FixtureClass = {
    label: 'Desk lamp',
    archetype: 'box',
    material: 'matte',
    control: 'light',
    description: 'A cream lamp base.',
    box: { x1: 360, y1: 270, x2: 640, y2: 730 },
    sizeCm: { w: 15, d: 15, h: 40 },
  };
  async function live(sam: 'found' | 'empty' = 'found', env: Record<string, string> = {}) {
    const asked: string[] = [];
    const fetcher = mock<Fetcher>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === 'sam-3.1') {
        asked.push('sam');
        return samResponse(sam === 'found' ? `<0f>1${demo.wire.replace(/^<0f>7/, '')}` : '');
      }
      const name = body.text.format.name as string;
      asked.push(`spark:${name}`);
      return sparkResponse(
        name === 'fixture_class'
          ? lampClass
          : { height: 1, radius: 1, handleReach: 1, body: null, note: 'Close.' },
      );
    });
    const s = await setup(
      { MODEL_API_KEY: 'test-key', META_LIVE_ENABLED: 'true', ...env },
      fetcher,
    );
    const photo = await sharp(readFileSync('testdata/desk.svg')).png().toBuffer();
    const imageDataUrl = `data:image/png;base64,${photo.toString('base64')}`;
    const draft = (body: object = {}) =>
      s.app.inject({
        method: 'POST',
        url: '/api/fixtures/draft',
        payload: { mode: 'live', scene: 'desk', imageDataUrl, ...body },
      });
    return { ...s, asked, draft, fetcher };
  }
  it('names it with Spark, outlines it with SAM from Spark’s box, and models it', async () => {
    const s = await live();
    const res = await s.draft({ label: 'my lamp' });
    expect(res.statusCode, res.body).toBe(200);
    const { run, draft } = res.json<{ run: EvidenceRun; draft: FixtureDraft }>();
    expect(s.asked).toEqual(['spark:fixture_class', 'sam', 'spark:item_check']);
    expect(run).toMatchObject({ kind: 'fixture', mode: 'live', status: 'completed' });
    expect(run.usage?.totalTokens).toBe(240);
    expect(draft).toMatchObject({
      label: 'my lamp',
      suggested: 'light',
      model: { source: 'spark' },
      size: { w: 0.5, d: 0.5, h: 1.33 },
    });
    expect(draft.model.fit!.assists[0]).toMatch(/^Spark: box, matte/);
    expect(run.assets).toContain(`${run.id}/sam-output.txt`);
    const reference = await s.app.inject(`/api/fixtures/reference?runId=${run.id}`);
    expect(reference.headers['content-type']).toBe('image/png');
  });
  it('says so when SAM finds nothing in Spark’s box', async () => {
    const s = await live('empty');
    const res = await s.draft();
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/Couldn’t find/);
  });
  it('shows Spark only the boxed part of a desk photo, and SAM the person’s box', async () => {
    const s = await live();
    const sent: number[] = [];
    s.fetcher.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const image = body.input[0].content[1].image_url as string;
      sent.push((await sharp(Buffer.from(image.split(',')[1]!, 'base64')).metadata()).width!);
      return sparkResponse(lampClass);
    });
    const res = await s.draft({ box: { x1: 360, y1: 270, x2: 640, y2: 730 } });
    expect(res.statusCode, res.body).toBe(200);
    expect(s.asked).toEqual(['sam', 'spark:item_check']);
    expect(sent[0]).toBeLessThan(960);
  });
  it('refuses before any call when today’s limit can’t cover the worst case', async () => {
    const s = await live('found', { META_DAILY_SPEND_LIMIT_USD: '0.0001' });
    expect((await s.draft()).statusCode).toBe(429);
    expect(s.asked).toEqual([]);
  });
  it('takes only photos live, and only bundled pictures in the demo', async () => {
    const s = await live();
    expect((await s.draft({ reference: 'mouse' })).statusCode).toBe(400);
    expect(
      (await s.post('fixtures/draft', { scene: 'desk', imageDataUrl: 'data:' })).statusCode,
    ).toBe(400);
  });
});

describe('another photo of a fixture', () => {
  it('fits a close photo and fuses it with the far one, counting it for more', async () => {
    const s = await setup();
    // The mug, boxed on the demo office's frame: about 20 pixels across.
    const mug = (await demoPhotoSegmentation()).detections.find(
      (d) => Number(d.objectId) === demoPhotoInventory.things.findIndex((t) => t.id === 'mug') + 1,
    )!;
    const k = (v: number, of: number) => Math.round((v / of) * 1000);
    const box = {
      x1: k(mug.box.x, 960),
      y1: k(mug.box.y, 640),
      x2: k(mug.box.x + mug.box.width, 960),
      y2: k(mug.box.y + mug.box.height, 640),
    };
    const { draft } = (await s.post('fixtures/draft', { scene: 'desk', box })).json<{
      draft: FixtureDraft;
    }>();
    const far = draft.model.fit!;
    expect(far.views).toBe(1);
    expect(far.cropPx!.width).toBeLessThan(60);
    const saved = (
      await s.post('fixtures/save', {
        fixture: {
          label: draft.label,
          scene: 'desk',
          surfaceId: 'desk:top',
          at: { x: 3, y: 2 },
          turns: 0,
          size: draft.size,
          model: { label: draft.model.label, parts: draft.model.parts },
          reference: draft.reference,
          control: { kind: 'none' },
        },
      })
    ).json<DeskMemory>();
    const id = saved.fixtures![0]!.id;
    const res = await s.post('fixtures/photo', { fixtureId: id });
    expect(res.statusCode, res.body).toBe(200);
    const fit = res.json<{ memory: DeskMemory }>().memory.fixtures![0]!.model.fit!;
    expect(fit.views).toBe(2);
    expect(fit.cropPx!.width).toBeGreaterThan(far.cropPx!.width * 2);
    expect(fit.crop).not.toBe(far.crop);
    expect(fit.assists.at(-1)).toMatch(/Fused with 1 earlier view, this one counted 4\.0 times/);
    // The far fit is kept as an earlier draft, and can be picked back; the pick is noted.
    const fused = res.json<{ memory: DeskMemory }>().memory.fixtures![0]!;
    expect(fused.drafts).toHaveLength(1);
    expect(fused.drafts![0]).toMatchObject({ origin: 'fit', model: { fit: { views: 1 } } });
    const chose = await s.post('fixtures/choose', { fixtureId: id, draft: 0 });
    expect(chose.statusCode, chose.body).toBe(200);
    const back = chose.json<DeskMemory>().fixtures![0]!;
    expect(back.model.fit!.views).toBe(1);
    expect(back.drafts![0]).toMatchObject({ origin: 'photos', model: { fit: { views: 2 } } });
    const picks = readFileSync(join(s.dataDir, 'fixture-picks.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(picks.at(-1)!)).toMatchObject({
      label: draft.label,
      chosen: 'fit',
      over: ['photos'],
      archetype: 'mug',
    });
    expect((await s.post('fixtures/choose', { fixtureId: id, draft: 3 })).statusCode).toBe(404);
  });
  it('has no close photo in the demo of a thing it never pictured', async () => {
    const s = await setup();
    const saved = (
      await s.post('fixtures/save', {
        fixture: {
          label: 'Fan',
          scene: 'desk',
          surfaceId: 'desk:top',
          at: { x: 3, y: 2 },
          turns: 0,
          size: { w: 0.5, d: 0.5, h: 1 },
          model: { label: 'Fan', parts: starterFixtureDraft('lamp').model.parts },
          reference: null,
          control: { kind: 'none' },
        },
      })
    ).json<DeskMemory>();
    const res = await s.post('fixtures/photo', { fixtureId: saved.fixtures![0]!.id });
    expect(res.statusCode).toBe(409);
    expect(
      (await s.post('fixtures/photo', { fixtureId: saved.fixtures![0]!.id, imageDataUrl: 'x' }))
        .statusCode,
    ).toBe(400);
  });
});

describe('refining a fixture with SAM 3D', () => {
  async function withSam3d(sam3d: ((crop: Buffer) => Promise<Buffer>) | null) {
    const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-fixture-'));
    dirs.push(dataDir);
    const app = await buildApp(parseConfig({ DATA_DIR: dataDir }), {
      fetcher: mock<Fetcher>(),
      serveWeb: false,
      sam3d,
    });
    const post = (path: string, body: object = {}) =>
      app.inject({ method: 'POST', url: `/api/${path}`, payload: { mode: 'demo', ...body } });
    return { app, post };
  }
  /** A fixture drafted from a demo picture and placed on the desk. */
  async function placed(s: Awaited<ReturnType<typeof withSam3d>>, reference: 'lamp' | 'mouse') {
    const { draft } = (await s.post('fixtures/draft', { scene: 'desk', reference })).json<{
      draft: FixtureDraft;
    }>();
    const memory = (
      await s.post('fixtures/save', {
        fixture: {
          label: draft.label,
          scene: 'desk',
          surfaceId: 'desk:top',
          at: { x: 3, y: 2 },
          turns: 0,
          size: draft.size,
          model: { label: draft.model.label, parts: draft.model.parts },
          reference: draft.reference,
          control: { kind: 'none' },
        },
      })
    ).json<DeskMemory>();
    return memory.fixtures!.at(-1)!;
  }
  async function ended(s: Awaited<ReturnType<typeof withSam3d>>, jobId: string) {
    for (let i = 0; i < 200; i++) {
      const job = (await s.app.inject(`/api/jobs/${jobId}`)).json<Job>();
      if (job.done) return job;
      await Bun.sleep(25);
    }
    throw new Error('The job never ended.');
  }
  it('answers at once, then reshapes a turned body from the splat as a job', async () => {
    let splat: Buffer | null = null;
    const asked: number[] = [];
    const s = await withSam3d(async (crop) => {
      asked.push((await sharp(crop).metadata()).width!);
      return splat!;
    });
    const lamp = await placed(s, 'lamp');
    // SAM 3D sees the lamp as the fit drew it, but a little taller.
    const fit = lamp.model.fit!.params as LatheFit;
    splat = latheSplat({ ...fit, height: fit.height * 1.1 });
    const jobId = crypto.randomUUID();
    const res = await s.post('fixtures/refine3d', { fixtureId: lamp.id, jobId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ jobId });
    const job = await ended(s, jobId);
    expect(job.outcome, job.error).toBe('done');
    expect(asked).toHaveLength(1);
    expect(job.steps.map((x) => x.id)).toEqual([
      'picture',
      'reconstruct',
      'shape',
      'check',
      'save',
    ]);
    expect(job.steps[3]!.detail).toMatch(/: kept$/);
    const after = (await s.app.inject('/api/desk/demo')).json<DeskMemory>().fixtures!.at(-1)!;
    expect(after.model.fit!.assists.at(-1)).toMatch(/^SAM 3D/);
    const shaped = after.model.fit!.params as LatheFit;
    expect(shaped.height / fit.height).toBeCloseTo(1.1, 1);
    expect(shaped.colors).toEqual(fit.colors);
  });
  it('keeps the model as it was when the splat is of something else', async () => {
    const s = await withSam3d(async () => mugSplat({ height: 3.2, base: 0.6, handle: false }));
    const lamp = await placed(s, 'lamp');
    const jobId = crypto.randomUUID();
    await s.post('fixtures/refine3d', { fixtureId: lamp.id, jobId });
    const job = await ended(s, jobId);
    expect(job.steps[3]!.detail).toMatch(/not kept$/);
    const after = (await s.app.inject('/api/desk/demo')).json<DeskMemory>().fixtures!.at(-1)!;
    expect(after.model).toEqual(lamp.model);
  });
  it('is off unless SAM3D_ENABLED, whatever else is set', () => {
    expect(parseConfig({ SAM3D_MLX_WEIGHTS: '/weights', FAL_KEY: 'k' }).sam3d).toBeNull();
    expect(
      parseConfig({ SAM3D_ENABLED: 'true', SAM3D_MLX_WEIGHTS: '/weights' }).sam3d,
    ).toMatchObject({ kind: 'local', weights: '/weights' });
    expect(parseConfig({ SAM3D_ENABLED: 'true', FAL_KEY: 'k' }).sam3d).toEqual({
      kind: 'fal',
      key: 'k',
    });
  });
  it('refuses when SAM 3D isn’t set up, or for a shape it can’t refine yet', async () => {
    const off = await withSam3d(null);
    const lamp = await placed(off, 'lamp');
    const jobId = crypto.randomUUID();
    expect((await off.post('fixtures/refine3d', { fixtureId: lamp.id, jobId })).statusCode).toBe(
      409,
    );
    const on = await withSam3d(async () => mugSplat());
    const mouse = await placed(on, 'mouse');
    const refused = await on.post('fixtures/refine3d', { fixtureId: mouse.id, jobId });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { message: string } }>().error.message).toMatch(/turned body/);
  });
});

describe('editing a fixture’s model', () => {
  it('saves edits, refits to its photo keeping its height, and serves its crop', async () => {
    const s = await setup();
    const { draft } = (await s.post('fixtures/draft', { scene: 'desk', reference: 'mouse' })).json<{
      draft: FixtureDraft;
    }>();
    const mouse = (
      await s.post('fixtures/save', {
        fixture: {
          label: draft.label,
          scene: 'desk',
          surfaceId: 'desk:top',
          at: { x: 3, y: 2 },
          turns: 0,
          size: draft.size,
          model: { label: draft.model.label, parts: draft.model.parts },
          reference: draft.reference,
          control: { kind: 'none' },
        },
      })
    ).json<DeskMemory>().fixtures![0]!;
    const body = mouse.model.parts[0]!;
    const edited = (
      await s.post('item/save', {
        objectId: mouse.id,
        item: { label: 'Mouse', parts: [{ ...body, color: '#aa3322' }] },
      })
    ).json<DeskMemory>();
    const after = edited.fixtures![0]!;
    expect(after.model.parts[0]!.color).toBe('#aa3322');
    expect(after.model.fit?.crop).toBe(mouse.model.fit?.crop);
    const refit = (await s.post('item/refit', { objectId: mouse.id })).json<DeskMemory>();
    expect(itemHeight(refit.fixtures![0]!.model)).toBeCloseTo(itemHeight(mouse.model), 2);
    const crop = await s.app.inject(`/api/item/crop?mode=demo&objectId=${mouse.id}`);
    expect(crop.headers['content-type']).toBe('image/png');
    const redraft = await s.post('item/draft', { objectId: mouse.id, source: 'sampled' });
    expect(redraft.statusCode).toBe(409);
    expect(redraft.json<{ error: { code: string } }>().error.code).toBe('item_fixture');
  });
});

describe('switching a light directly', () => {
  it('switches a configured entity with no fixture, and only a configured one', async () => {
    const s = await setup();
    const on = await s.post('fixtures/control', { entityId: 'light.demo_desk', action: 'on' });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json<{ event: EvidenceRun<LampResult> }>().event.output).toMatchObject({
      entityId: 'light.demo_desk',
      action: 'on',
      stateConfirmed: true,
    });
    const unknown = await s.post('fixtures/control', { entityId: 'light.kitchen', action: 'on' });
    expect(unknown.statusCode).toBe(409);
    const both = await s.post('fixtures/control', {
      entityId: 'light.demo_desk',
      fixtureId: crypto.randomUUID(),
      action: 'on',
    });
    expect(both.statusCode).toBe(400);
  });
});

describe('drafting a fixture from a box on the desk photo', () => {
  it('picks the demo room’s thing under the box', async () => {
    const s = await setup();
    // A box drawn a little loosely around the book on the demo room's desk.
    const at = demoPhotoInventory.things.find((t) => t.id === 'book')!.box;
    const box = { x1: at.x1 - 10, y1: at.y1 - 10, x2: at.x2 + 10, y2: at.y2 + 10 };
    const book = await s.post('fixtures/draft', { scene: 'office', box });
    expect(book.statusCode, book.body).toBe(200);
    const { run, draft } = book.json<{ run: EvidenceRun; draft: FixtureDraft }>();
    expect(draft).toMatchObject({ label: 'Green book', archetype: 'book', suggested: 'none' });
    // The review shows the part of the desk that was boxed, not the whole desk.
    const shown = await sharp(
      (await s.app.inject(`/api/fixtures/reference?runId=${run.id}`)).rawPayload,
    ).metadata();
    expect(shown.width).toBeLessThan(960);
    const empty = await s.post('fixtures/draft', {
      scene: 'office',
      box: { x1: 0, y1: 0, x2: 60, y2: 60 },
    });
    expect(empty.statusCode).toBe(422);
    const both = await s.post('fixtures/draft', { scene: 'office', reference: 'mouse', box });
    expect(both.statusCode).toBe(400);
  });
});

describe('fixture states and cat poses', () => {
  it('drafts and switches a cat between idle and sleeping poses, each with its own model and size', async () => {
    const s = await setup();
    const res = await s.post('fixtures/draft', { scene: 'office', reference: 'cat' });
    expect(res.statusCode, res.body).toBe(200);
    const { draft } = res.json<{ draft: FixtureDraft }>();
    expect(draft.archetype).toBe('cat');
    expect(draft.state).toBe('idle');
    expect(Object.keys(draft.states ?? {})).toEqual(['idle', 'sleeping']);
    expect(itemHeight(draft.states!.idle!.model)).toBeGreaterThan(
      itemHeight(draft.states!.sleeping!.model),
    );

    const saved = (
      await s.post('fixtures/save', {
        fixture: {
          label: 'Mochi',
          scene: 'office',
          surfaceId: null,
          at: { x: 1, y: 1 },
          turns: 0,
          size: draft.size,
          model: { label: 'Mochi', parts: draft.model.parts },
          reference: draft.reference,
          control: { kind: 'none' },
        },
      })
    ).json<DeskMemory>().fixtures![0]!;
    expect(saved.state).toBe('idle');
    expect(fixtureStateNames(saved)).toEqual(['idle', 'sleeping']);
    const idleBox = fixtureBox(saved);

    const sleeping = (
      await s.post('fixtures/control', { fixtureId: saved.id, action: 'sleeping' })
    ).json<{ memory: DeskMemory }>().memory.fixtures![0]!;
    expect(sleeping.state).toBe('sleeping');
    expect(fixtureBox(sleeping).size.h).toBeLessThan(idleBox.size.h);
    expect(fixtureModel(sleeping).parts.map((p) => p.id)).toEqual([
      'body',
      'head',
      'ear-l',
      'ear-r',
      'tail',
    ]);
  });

  it('supports on/off states on lamps and monitors and arbitrary custom states with unique models', async () => {
    const s = await setup();
    const monDraft = (
      await s.post('fixtures/draft', { scene: 'office', reference: 'monitor' })
    ).json<{ draft: FixtureDraft }>().draft;
    const mon = (
      await s.post('fixtures/save', {
        fixture: {
          label: 'Monitor',
          scene: 'office',
          surfaceId: 'desk:top',
          at: { x: 2.5, y: 1.4 },
          turns: 0,
          size: monDraft.size,
          model: { label: 'Monitor', parts: monDraft.model.parts },
          reference: monDraft.reference,
          control: { kind: 'switch', entityId: 'switch.demo_monitor' },
        },
      })
    ).json<DeskMemory>().fixtures![0]!;
    expect(fixtureModel(mon, 'off').parts.find((p) => p.id === 'screen')?.color).toBe('#2c3858');
    expect(fixtureModel(mon, 'on').parts.find((p) => p.id === 'screen')?.color).toBe('#68b5e8');

    // Add an arbitrary custom state ("gaming") with its own unique model and size.
    const gamingModel = catItem('Gaming cat', 'idle', ['#aa3355', '#ffffff']);
    const withCustom = (
      await s.post('fixtures/state', {
        fixtureId: mon.id,
        state: 'gaming',
        fixture: { model: gamingModel, size: { w: 1.5, d: 0.8, h: 1.2 } },
      })
    ).json<DeskMemory>().fixtures![0]!;
    expect(withCustom.state).toBe('gaming');
    expect(fixtureStateNames(withCustom)).toContain('gaming');
    expect(fixtureModel(withCustom).parts[0]!.color).toBe('#aa3355');
    expect(fixtureSize(withCustom)).toEqual({ w: 1.5, d: 0.8, h: 1.2 });

    // Editing the model while a state is active updates only that state's unique model.
    const edited = (
      await s.post('item/save', {
        objectId: mon.id,
        item: {
          label: 'Gaming cat',
          parts: gamingModel.parts.map((p, i) => (i === 0 ? { ...p, color: '#2288aa' } : p)),
        },
      })
    ).json<DeskMemory>().fixtures![0]!;
    expect(fixtureModel(edited, 'gaming').parts[0]!.color).toBe('#2288aa');
    expect(fixtureModel(edited, 'off').parts.find((p) => p.id === 'screen')?.color).toBe('#2c3858');

    // Removing the custom state clears it and resets active state if it was selected.
    const removed = (
      await s.post('fixtures/state', { fixtureId: mon.id, remove: 'gaming' })
    ).json<DeskMemory>().fixtures![0]!;
    expect(removed.state).toBeNull();
    expect(removed.states?.gaming).toBeUndefined();
  });

  it('builds valid starter drafts from every template without needing a photo', async () => {
    const s = await setup();
    for (const t of STARTER_TEMPLATES) {
      const draft = starterFixtureDraft(t, { colors: ['#cc7744', '#eeece6'] });
      expect(
        isoItemSchema.safeParse({ label: draft.model.label, parts: draft.model.parts }).success,
      ).toBe(true);
      expect(draft.reference).toBeNull();
      for (const state of Object.values(draft.states ?? {})) {
        expect(
          isoItemSchema.safeParse({ label: state.model.label, parts: state.model.parts }).success,
        ).toBe(true);
      }
    }
    const catDraft = starterFixtureDraft('cat', {
      label: 'Biscuit',
      colors: ['#333844', '#f0f0f5'],
    });
    expect(catDraft.states?.idle?.model.parts[0]!.color).toBe('#333844');
    expect(catDraft.states?.sleeping?.model.parts[0]!.color).toBe('#333844');
    const saved = await s.post('fixtures/save', {
      fixture: {
        label: catDraft.label,
        scene: 'office',
        surfaceId: null,
        at: { x: 1, y: 1 },
        turns: 0,
        size: catDraft.size,
        model: { label: catDraft.model.label, parts: catDraft.model.parts },
        reference: catDraft.reference,
        control: { kind: 'none' },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
  });
});
