import { describe, expect, it } from 'bun:test';
import {
  ISO_PRESETS,
  TEMPLATE_IDS,
  believableWidth,
  cm,
  groupBounds,
  isoSceneSchema,
  overlappingGroups,
  placeTemplate,
  propModel,
  propSolids,
  rotateGroup,
  type IsoScene,
} from '../packages/domain/src/index.js';

const EPS = 1e-6;
const scene = (id: (typeof TEMPLATE_IDS)[number]): IsoScene => {
  const built = placeTemplate(id, id, 2, 2, 0);
  return { kind: 'custom', label: id, grid: { w: 12, d: 12 }, ...built };
};

describe('furniture models', () => {
  it('keeps every part inside its prop, at every quarter turn', () => {
    for (const id of TEMPLATE_IDS) {
      let s = scene(id);
      for (let turn = 0; turn < 4; turn++) {
        for (const p of s.props) {
          const parts = propModel(p);
          if (!parts) continue;
          for (const q of parts) {
            expect(q.at.x).toBeGreaterThanOrEqual(-EPS);
            expect(q.at.y).toBeGreaterThanOrEqual(-EPS);
            expect(q.at.z).toBeGreaterThanOrEqual(-EPS);
            expect(q.at.x + q.size.w).toBeLessThanOrEqual(p.size.w + EPS);
            expect(q.at.y + q.size.d).toBeLessThanOrEqual(p.size.d + EPS);
            expect(q.at.z + q.size.h).toBeLessThanOrEqual(p.size.h + EPS);
          }
        }
        s = rotateGroup(s, id);
      }
    }
  });

  it('turns a model with its group, so a chair turned four times faces the same way', () => {
    let s = scene('chair');
    const before = propModel(s.props[0]!);
    s = rotateGroup(s, 'chair');
    expect(s.props[0]!.turns).toBe(1);
    // A quarter turn puts the back (at +y) on the -x side.
    const back = (parts: ReturnType<typeof propModel>) =>
      parts!.reduce((a, b) => (b.size.h > a.size.h ? b : a));
    const turned = back(propModel(s.props[0]!));
    expect(turned.at.x + turned.size.w / 2).toBeLessThan(s.props[0]!.size.w / 2);
    for (let i = 0; i < 3; i++) s = rotateGroup(s, 'chair');
    expect(s.props[0]!.turns).toBe(0);
    expect(propModel(s.props[0]!)).toEqual(before);
  });

  it('stands things at real sizes: a 72 cm desk, a 16 cm book, a monitor under half a metre', () => {
    const desk = groupBounds(scene('desk'), 'desk')!;
    expect(desk.size.h).toBeCloseTo(cm(72));
    const book = groupBounds(scene('book'), 'book')!;
    expect(book.size.w).toBeCloseTo(cm(16));
    expect(book.size.h).toBeLessThan(cm(5));
    expect(groupBounds(scene('monitor'), 'monitor')!.size.h).toBeLessThan(cm(50));
    expect(groupBounds(scene('bottle'), 'bottle')!.size.w).toBeLessThan(cm(10));
  });

  it('shows a camera a desk by its parts, open underneath', () => {
    const solids = propSolids(scene('desk').props[0]!);
    expect(solids.length).toBeGreaterThan(4);
    // Nothing fills the middle of the space under the top.
    const desk = scene('desk').props[0]!;
    const mid = { x: desk.at.x + desk.size.w / 2, y: desk.at.y + desk.size.d / 2, z: cm(30) };
    const inside = solids.some(
      ({ box: b }) =>
        mid.x > b.at.x &&
        mid.x < b.at.x + b.size.w &&
        mid.y > b.at.y &&
        mid.y < b.at.y + b.size.d &&
        mid.z > b.at.z &&
        mid.z < b.at.z + b.size.h,
    );
    expect(inside).toBe(false);
  });

  it('keeps the presets valid and free of clashes', () => {
    for (const preset of Object.values(ISO_PRESETS)) {
      expect(overlappingGroups(preset).size).toBe(0);
      const custom = { ...preset, kind: 'custom' as const };
      expect(isoSceneSchema.safeParse(custom).success).toBe(true);
    }
  });
});

describe('believable widths', () => {
  it('holds a mug near 12 cm, however wide the camera makes it look', () => {
    expect(believableWidth(0.8, 'mug')).toBeCloseTo(cm(12) * 1.35);
    expect(believableWidth(0.1, 'Coffee mug')).toBeCloseTo(cm(12) * 0.75);
    expect(believableWidth(0.4, 'thing', 'mug')).toBeCloseTo(0.4);
    // Nothing known about it: left as measured.
    expect(believableWidth(0.8, 'gadget')).toBe(0.8);
  });
});
