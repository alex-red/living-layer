import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig } from '../apps/server/src/config.js';
import { BUNDLED_CATALOG, Catalog } from '../apps/server/src/research.js';
import {
  assembleRecipe,
  DEMO_CAMERA,
  DEMO_ROOM,
  floorSolid,
  fitGroup,
  fitKept,
  groupBounds,
  moveGroup,
  placeOfGroup,
  renderRoom,
  roomMask,
  sceneSolids,
  sceneWithRecipe,
  type IsoScene,
  type SceneFit,
} from '@livinglayer/domain';

// The desk's outline as the demo camera sees it, where it really stands.
const picture = renderRoom(DEMO_CAMERA, [floorSolid(DEMO_ROOM.grid), ...sceneSolids(DEMO_ROOM)], {
  labels: true,
});
const outline = roomMask(picture, 'desk')!;
const middle = (s: IsoScene, g: string) => {
  const b = groupBounds(s, g)!;
  return { x: b.at.x + b.size.w / 2, y: b.at.y + b.size.d / 2 };
};
// Only the desk moves: what stands on it stays where it is in the room.
const misplace = (dx: number, dy: number) => {
  const own = DEMO_ROOM.props.filter((p) => p.group === 'desk');
  const alone: IsoScene = {
    ...DEMO_ROOM,
    props: own,
    surfaces: DEMO_ROOM.surfaces.filter((s) => own.some((p) => p.id === s.propId)),
  };
  const moved = moveGroup(alone, 'desk', dx, dy);
  return {
    ...DEMO_ROOM,
    props: [...DEMO_ROOM.props.filter((p) => p.group !== 'desk'), ...moved.props],
    surfaces: [
      ...DEMO_ROOM.surfaces.filter((s) => !own.some((p) => p.id === s.propId)),
      ...moved.surfaces,
    ],
  };
};

describe('fitting a thing to its outline through the room camera', () => {
  it('puts a desk drawn 40 cm off back where the camera sees it', () => {
    const off = misplace(1.2, -0.6);
    const fit = fitGroup(DEMO_CAMERA, off, 'desk', outline)!;
    const want = middle(DEMO_ROOM, 'desk');
    const got = middle(fit.scene, 'desk');
    expect(Math.hypot(got.x - want.x, got.y - want.y)).toBeLessThan(0.1);
    expect(fit.turned).toBe(false);
    expect(fit.iou).toBeGreaterThan(0.9);
    expect(fit.from).toBeLessThan(0.7);
    expect(fitKept(fit)).toBe(true);
  });

  it('turns a desk with its drawers on the wrong side back', () => {
    const alex = assembleRecipe(
      'desk',
      new Catalog([BUNDLED_CATALOG]).find('IKEA Alex desk')!.facts,
    );
    const room = sceneWithRecipe(DEMO_ROOM, alex, placeOfGroup(DEMO_ROOM, 'desk')!, 'alex');
    const seen = roomMask(
      renderRoom(DEMO_CAMERA, [floorSolid(room.grid), ...sceneSolids(room)], { labels: true }),
      'alex',
    )!;
    const wrong = sceneWithRecipe(
      DEMO_ROOM,
      alex,
      {
        ...placeOfGroup(DEMO_ROOM, 'desk')!,
        turns: (placeOfGroup(DEMO_ROOM, 'desk')!.turns + 2) % 4,
      },
      'alex',
    );
    const fit = fitGroup(DEMO_CAMERA, wrong, 'alex', seen)!;
    expect(fit.turned).toBe(true);
    expect(fit.iou).toBeGreaterThan(0.9);
  });

  it('leaves a desk that already fits, and keeps what stands on it in place', () => {
    const fit = fitGroup(DEMO_CAMERA, DEMO_ROOM, 'desk', outline)!;
    expect(Math.hypot(fit.moved.x, fit.moved.y)).toBeLessThan(0.06);
    expect(fitKept(fit)).toBe(false);
    expect(middle(fit.scene, 'monitor')).toEqual(middle(DEMO_ROOM, 'monitor'));
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/scene/fit', () => {
  it('moves a prop of the scene being edited to where the demo camera sees it, saving nothing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-fit-'));
    dirs.push(dataDir);
    const app = await buildApp(parseConfig({ DATA_DIR: dataDir }), { serveWeb: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/scene/fit',
      payload: { mode: 'demo', scene: { ...misplace(1.2, -0.6), kind: 'custom' }, group: 'desk' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { scene, fit } = res.json<SceneFit>();
    expect(fit.kept).toBe(true);
    expect(Math.hypot(fit.movedCm.x, fit.movedCm.y)).toBeGreaterThan(30);
    const want = middle(DEMO_ROOM, 'desk');
    const got = middle(scene, 'desk');
    expect(Math.hypot(got.x - want.x, got.y - want.y)).toBeLessThan(0.1);
    expect((await app.inject('/api/desk/demo')).json<{ scene?: unknown }>().scene).toBeFalsy();
    await app.close();
  });
});
