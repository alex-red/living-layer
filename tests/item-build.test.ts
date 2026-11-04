import { describe, expect, it } from 'bun:test';
import {
  blob,
  buildModel,
  faceDecal,
  lathe,
  MAX_ITEM_PARTS,
  pixels,
  rbox,
  renderSprite,
  restOn,
  scaleAbout,
  starterTemplateModel,
  topOf,
  tube,
  voxelize,
  type Face,
} from '@livinglayer/domain';

const RED = '#ff0000';
const BLUE = '#0000ff';
/** The mean screen x of a colour's pixels in a box's sprite with `art` painted on `face`. */
function screenX(face: Face, art: ReturnType<typeof pixels>, across?: [number, number]) {
  const box = rbox('box', [0, 0, 0], [1, 1, 1], {
    color: '#808080',
    paint: [faceDecal(face, art, across ? { across } : {})],
  });
  const s = renderSprite(voxelize([box], { resolution: 32 }), { scale: 3, finish: 'clean' });
  const mean = (want: (r: number, g: number, b: number) => boolean) => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < s.height; y++)
      for (let x = 0; x < s.width; x++) {
        const i = (x + y * s.width) * 4;
        if (s.rgba[i + 3] && want(s.rgba[i]!, s.rgba[i + 1]!, s.rgba[i + 2]!))
          [sum, n] = [sum + x, n + 1];
      }
    return n ? sum / n : NaN;
  };
  return {
    red: mean((r, g, b) => r > 150 && g < 90 && b < 90),
    blue: mean((r, g, b) => b > 150 && r < 90 && g < 90),
    width: s.width,
  };
}

describe('paint on the face the room sees', () => {
  const art = pixels(['rb', 'rb'], { r: RED, b: BLUE });
  for (const face of ['left', 'right', 'front'] as const)
    it(`reads left to right on the ${face} face`, () => {
      const { red, blue } = screenX(face, art);
      expect(red).toBeLessThan(blue);
    });

  it('lands on the left or right half of the picture by its face', () => {
    const left = screenX('left', art);
    const right = screenX('right', art);
    expect(left.blue).toBeLessThan(left.width / 2);
    expect(right.red).toBeGreaterThan(right.width / 2);
  });

  it('covers only the share of the face it is given', () => {
    const solid = pixels(['r'], { r: RED });
    const near = screenX('left', solid, [0, 0.3]).red;
    const far = screenX('left', solid, [0.7, 1]).red;
    expect(near).toBeLessThan(far);
  });
});

describe('pixel art as a decal', () => {
  it('pads short rows with nothing and keeps the legend’s colours in order', () => {
    const art = pixels(['ab', 'a'], { a: RED, b: BLUE });
    expect(art).toEqual({ w: 2, h: 2, colors: [RED, BLUE], data: '01' + '0.' });
  });

  it('refuses a character the legend doesn’t name', () => {
    expect(() => pixels(['ax'], { a: RED })).toThrow(/"x" is not in the legend/);
  });
});

describe('placing parts', () => {
  const tree = starterTemplateModel('cat-tree').parts;

  it('stands a group with its lowest part on a height, every part moved alike', () => {
    const moved = restOn(tree, 2);
    expect(Math.min(...moved.map((p) => p.at.z))).toBeCloseTo(2, 9);
    expect(topOf(moved) - 2).toBeCloseTo(topOf(tree) - Math.min(...tree.map((p) => p.at.z)), 9);
  });

  it('scales a group about a point that stays put', () => {
    const pivot = { x: 0.5, y: 0.5, z: 0 };
    const half = scaleAbout(tree, 0.5, pivot);
    expect(topOf(half)).toBeCloseTo(topOf(tree) / 2, 9);
    const base = tree.find((p) => p.id === 'base')!;
    const halfBase = half.find((p) => p.id === 'base')!;
    expect(halfBase.at.x - pivot.x).toBeCloseTo((base.at.x - pivot.x) / 2, 9);
    expect(halfBase.size.w).toBeCloseTo(base.size.w / 2, 9);
  });
});

describe('a model built by hand', () => {
  const tree = starterTemplateModel('cat-tree').parts;

  it('builds every shape as a part the app accepts', () => {
    const look = { color: '#e89a4e', material: 'fabric' as const };
    const cat = buildModel('Cat', [
      blob('body', [0.1, 0.1, 0], [0.6, 0.5, 0.3], { ...look, rough: 0.05 }),
      lathe('ear', [0.5, 0.5, 0.25], [0.1, 0.1, 0.12], {
        ...look,
        profile: [
          { r: 1, z: 0 },
          { r: 0.1, z: 1 },
        ],
      }),
      rbox('bed', [0, 0, 0], [1, 1, 0.05], { ...look, radius: 0.3 }),
      tube(
        'tail',
        [0, 0, 0],
        [0.5, 0.5, 0.1],
        [
          [0, 0, 0],
          [1, 1, 0],
        ],
        { ...look, radius: 0.04 },
      ),
    ]);
    expect(cat.parts.map((p) => p.shape)).toEqual(['blob', 'lathe', 'rbox', 'tube']);
  });

  it('is checked as the app checks one', () => {
    expect(buildModel('Cat tree', tree).parts).toHaveLength(tree.length);
  });

  it('says how many parts it has against the cap', () => {
    const many = Array.from({ length: MAX_ITEM_PARTS + 1 }, (_, i) => ({
      ...tree[0]!,
      id: `p${i}`,
    }));
    expect(() => buildModel('Tower', many)).toThrow(`${MAX_ITEM_PARTS + 1} parts`);
  });

  it('names the part that is wrong', () => {
    const bad = [...tree, { ...tree[0]!, id: 'bad', color: 'grey' }];
    expect(() => buildModel('Tower', bad)).toThrow(/part bad/);
  });

  it('refuses two parts of one name', () => {
    expect(() => buildModel('Tower', [...tree, tree[0]!])).toThrow(/more than one part base/);
  });
});
