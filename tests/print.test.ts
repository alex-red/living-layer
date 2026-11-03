import { describe, expect, it } from 'bun:test';
import {
  fromSculpt,
  isoItemSchema,
  mugItem,
  printDecal,
  printKey,
  renderSprite,
  rotateItem,
  STARTER_DECALS,
  STARTER_PRINTS,
  partFingerprint,
  starterTemplateModel,
  type StarterTemplate,
  toSculpt,
  voxelize,
  type Ink,
  type ItemPart,
  type Print,
  type Sculpt,
} from '@livinglayer/domain';
import { inkPrints } from '../apps/server/src/print-ink.js';

/** A straight-sided turned body, so how far round a print reaches is easy to check. */
const body: ItemPart = {
  id: 'body',
  shape: 'lathe',
  profile: [
    { r: 1, z: 0 },
    { r: 1, z: 1 },
  ],
  at: { x: 0, y: 0, z: 0 },
  size: { w: 0.78, d: 0.78, h: 0.9 },
  color: '#ece5d0',
  taper: 1,
  wall: 0.1,
  inside: { wall: '#c9c0a8', liquid: null, level: 0 },
};
const print = (over: Partial<Print> = {}): Print => ({
  text: 'Hi',
  style: 'sans',
  color: '#4a2219',
  around: 0,
  at: 0.5,
  size: 0.4,
  underline: false,
  ...over,
});
/** Ink twice as wide as tall, its left half inked: which way round it lands shows. */
const halfInk = (): Ink => {
  const width = 16;
  const height = 8;
  const coverage = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width / 2; x++) coverage[y * width + x] = 1;
  return { width, height, coverage };
};

describe('printDecal', () => {
  it('faces where the print says, and reads left to right', () => {
    const front = printDecal(body, print({ around: 0 }), halfInk())!;
    expect((front.u0 + front.u1) / 2).toBeCloseTo(0.625, 5);
    const right = printDecal(body, print({ around: 90 }), halfInk())!;
    expect((right.u0 + right.u1) / 2).toBeCloseTo(0.375, 5);
    // u grows to the viewer's left, so the ink's left half is the decal's right half.
    const row = front.data.slice(0, front.w);
    expect(row.slice(0, front.w / 2)).toMatch(/^\.+$/);
    expect(row.slice(front.w / 2)).toMatch(/^0+$/);
    expect(front.print).toEqual(print({ around: 0 }));
  });

  it('is as wide round the part as its letters need, and never most of the way round', () => {
    const d = printDecal(body, print(), halfInk())!;
    expect(d.v1 - d.v0).toBeCloseTo(0.4, 5);
    const girth = Math.PI * body.size.w;
    expect((d.u1 - d.u0) * girth).toBeCloseTo(0.4 * body.size.h * 2, 3);
    const wide: Ink = { width: 64, height: 2, coverage: new Float32Array(128).fill(1) };
    const capped = printDecal(body, print({ size: 0.9 }), wide)!;
    expect(capped.u1 - capped.u0).toBeCloseTo(0.8, 5);
  });
});

describe('prints in a sculpt', () => {
  const sculpt = (): Sculpt => ({
    note: '',
    parts: toSculpt(mugItem()).map((p) =>
      p.id === 'body' ? { ...p, prints: [print({ text: 'Tim\nHortons', style: 'script' })] } : p,
    ),
  });

  it('becomes a decal once set in type, and goes back to Spark as words', () => {
    const p = print({ text: 'Tim\nHortons', style: 'script' });
    const item = fromSculpt('Mug', sculpt(), new Map([[printKey(p), halfInk()]]))!;
    const decal = item.parts.find((q) => q.id === 'body')!.paint!.find((l) => l.kind === 'decal')!;
    expect(decal.kind === 'decal' && decal.print?.text).toBe('Tim\nHortons');
    expect(isoItemSchema.safeParse(item).success).toBe(true);
    expect(toSculpt(item).find((q) => q.id === 'body')!.prints).toEqual([p]);
  });

  it('is left off when it could not be set', () => {
    const item = fromSculpt('Mug', sculpt())!;
    expect(item.parts.find((q) => q.id === 'body')!.paint ?? []).toEqual([]);
  });

  it('turns with the model', () => {
    const p = print({ text: 'Tim\nHortons', style: 'script' });
    const item = fromSculpt('Mug', sculpt(), new Map([[printKey(p), halfInk()]]))!;
    const turned = rotateItem(item);
    const decal = turned.parts.find((q) => q.id === 'body')!.paint!.find((l) => l.kind === 'decal');
    expect(decal?.kind === 'decal' && decal.print?.around).toBe(270);
  });
});

describe('a clean finish', () => {
  const draw = (paint: ItemPart['paint']) =>
    renderSprite(
      voxelize([{ ...body, paint }, ...mugItem().parts.filter((p) => p.id !== 'body')], {
        resolution: 48,
      }),
      { scale: 6, pixel: 4, finish: 'clean', shadow: false },
    ).rgba;
  const plain = draw(undefined);
  /** How many pixels a print facing this way changes. */
  const inked = (around: number) => {
    const full: Ink = { width: 8, height: 4, coverage: new Float32Array(32).fill(1) };
    const rgba = draw([printDecal(body, print({ around, size: 0.5 }), full)!]);
    let n = 0;
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i] !== plain[i]) n++;
    return n;
  };

  it('letters a print facing the viewer, and hides one on the back', () => {
    expect(inked(45)).toBeGreaterThan(40);
    expect(inked(225)).toBe(0);
  });
});

describe('inkPrints', () => {
  it('sets a print in type, wider than tall for a long word, alike prints once', async () => {
    const p = print({ text: 'Hortons', style: 'script', underline: true });
    const inks = await inkPrints([p, { ...p, color: '#000000' }]);
    expect(inks.size).toBe(1);
    const set = inks.get(printKey(p))!;
    expect(set.width).toBeGreaterThan(set.height * 2);
    expect(set.coverage.some((c) => c > 0.9)).toBe(true);
  });
});

describe("starters' prints", () => {
  it('are set for their parts as they are now (else run `bun scripts/starter-prints.ts`)', () => {
    for (const [template, { part }] of Object.entries(STARTER_PRINTS)) {
      const set = STARTER_DECALS[template];
      expect(set, template).toBeDefined();
      const model = starterTemplateModel(template as StarterTemplate);
      const target = model.parts.find((p) => p.id === part)!;
      const plain = { ...target, paint: target.paint?.filter((l) => l.kind !== 'decal') };
      expect(partFingerprint(plain), template).toBe(set!.fingerprint);
      expect(
        target.paint?.some((l) => l.kind === 'decal' && l.print),
        template,
      ).toBe(true);
    }
  });

  it('leave the plain mug plain', () => {
    expect(mugItem().parts.every((p) => !p.paint?.length)).toBe(true);
    expect(starterTemplateModel('mug').parts.every((p) => !p.paint?.length)).toBe(true);
  });
});
