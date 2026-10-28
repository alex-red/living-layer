import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildApp } from '../apps/server/src/app.js';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { maskedCrop } from '../apps/server/src/images.js';
import {
  isoItemSchema,
  itemHeight,
  mugItem,
  rotateItem,
  sampledItem,
  swatchesOf,
  uniqueParts,
  type DeskMemory,
  type EvidenceRun,
  type SavedItem,
  type Segmentation,
} from '@livinglayer/domain';

describe('item models', () => {
  it('accepts the mug template and rejects parts outside the contract', () => {
    const mug = mugItem();
    expect(isoItemSchema.safeParse(mug).success).toBe(true);
    const bad = (change: object) =>
      isoItemSchema.safeParse({ ...mug, parts: [{ ...mug.parts[0]!, ...change }] }).success;
    expect(bad({ shape: 'sphere' })).toBe(false);
    expect(bad({ color: 'red' })).toBe(false);
    expect(bad({ size: { w: 0, d: 1, h: 1 } })).toBe(false);
    expect(bad({ at: { x: 4, y: 0, z: 0 } })).toBe(false);
    expect(isoItemSchema.safeParse({ ...mug, parts: [] }).success).toBe(false);
  });
  it('turns four quarters back to where it started, keeping the handle on the far side', () => {
    const mug = mugItem();
    const handle = (i: typeof mug) => i.parts.find((p) => p.id === 'handle')!;
    const once = rotateItem(mug);
    // A quarter turn moves the handle from the right (+x) to the front (+y).
    expect(handle(once).at.y + handle(once).size.d / 2).toBeGreaterThan(0.5);
    expect(handle(once).size.w).toBeCloseTo(handle(mug).size.d);
    const back = rotateItem(mug, 4);
    back.parts.forEach((p, i) => {
      expect(p.at.x).toBeCloseTo(mug.parts[i]!.at.x);
      expect(p.at.y).toBeCloseTo(mug.parts[i]!.at.y);
    });
    expect(rotateItem(mug, -1)).toEqual(rotateItem(mug, 3));
  });
  it('drafts a sampled mug in the photo proportions and colours', () => {
    const item = sampledItem(
      'Blue mug',
      1.2,
      [
        { hex: '#2244aa', share: 0.7 },
        { hex: '#331100', share: 0.3 },
      ],
      true,
    );
    expect(isoItemSchema.safeParse(item).success).toBe(true);
    expect(item.parts[0]!.color).toBe('#2244aa');
    expect(itemHeight(item)).toBeCloseTo(1.2 * 1.1 + 0.02);
    const plain = sampledItem('Bottle', 2.5, [], false);
    expect(plain.parts).toHaveLength(1);
    expect(itemHeight(plain)).toBe(2.5);
  });
  it('gives repeated part ids a suffix', () => {
    const mug = mugItem();
    const twice = uniqueParts({ ...mug, parts: [...mug.parts, mug.parts[0]!] });
    expect(new Set(twice.parts.map((p) => p.id)).size).toBe(4);
  });
  it('counts only opaque pixels, most common colour first', () => {
    const px = (r: number, g: number, b: number, a = 255) => [r, g, b, a];
    const rgba = new Uint8Array([
      ...px(250, 10, 10),
      ...px(240, 20, 12),
      ...px(245, 15, 8),
      ...px(10, 10, 250),
      ...px(0, 255, 0, 0),
      ...px(0, 255, 0, 0),
      ...px(0, 255, 0, 0),
      ...px(0, 255, 0, 0),
    ]);
    const swatches = swatchesOf(rgba);
    expect(swatches).toHaveLength(2);
    expect(swatches[0]!.hex).toBe('#f50f0a');
    expect(swatches[0]!.share).toBeCloseTo(0.75);
  });
});

describe('masked crop', () => {
  it('keeps the masked pixels of the box and drops the rest', async () => {
    // A red square on blue; the mask covers only the left half of the box.
    const source = await sharp({
      create: { width: 100, height: 80, channels: 3, background: '#0000ff' },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 40, height: 40, channels: 3, background: '#ff0000' },
          })
            .png()
            .toBuffer(),
          left: 20,
          top: 20,
        },
      ])
      .png()
      .toBuffer();
    const crop = await maskedCrop(source, {
      objectId: '1',
      confidence: 0.9,
      box: { x: 20, y: 20, width: 40, height: 40 },
      mask: { width: 10, height: 10, foregroundPixels: 50, svgPath: 'M0 0L5 0L5 10L0 10Z' },
    });
    expect([crop.width, crop.height]).toEqual([40, 40]);
    const swatches = swatchesOf(crop.rgba);
    expect(swatches[0]!.hex).toBe('#ff0000');
    expect(swatches[0]!.share).toBeGreaterThan(0.95);
    const opaque = [...crop.rgba].filter((_, i) => i % 4 === 3 && crop.rgba[i]! >= 128).length;
    expect(opaque / (40 * 40)).toBeCloseTo(0.5, 1);
  });
});

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'livinglayer-item-'));
  dirs.push(dataDir);
  const fetcher = mock<Fetcher>();
  const app = await buildApp(parseConfig({ DATA_DIR: dataDir }), { fetcher, serveWeb: false });
  const post = (path: string, body: object = {}) =>
    app.inject({ method: 'POST', url: `/api/${path}`, payload: { mode: 'fixture', ...body } });
  return { app, post, fetcher };
}

describe('item routes', () => {
  it('needs a confirmed object before drafting or saving', async () => {
    const s = await setup();
    expect((await s.post('item/draft', { source: 'sampled' })).statusCode).toBe(409);
    expect((await s.post('item/save', { item: mugItem() })).statusCode).toBe(409);
  });
  it('drafts the fixture mug offline, saves edits, keeps it across sightings and clears it on reset', async () => {
    const s = await setup();
    const segment = (await s.post('segment', { concept: 'mug' })).json<EvidenceRun<Segmentation>>();
    await s.post('desk/select', { segmentRunId: segment.id, detectionId: '7' });
    const drafted = (await s.post('item/draft', { source: 'spark' })).json<{
      run: EvidenceRun<SavedItem>;
      memory: DeskMemory;
    }>();
    expect(drafted.run.kind).toBe('item');
    expect(drafted.run.output.source).toBe('fixture');
    expect(drafted.memory.item?.segmentRunId).toBe(segment.id);
    expect(drafted.memory.item?.parts.map((p) => p.id)).toEqual(['body', 'coffee', 'handle']);
    expect(s.fetcher).not.toHaveBeenCalled();

    const edited = mugItem('#3c554a');
    const saved = (await s.post('item/save', { item: edited })).json<DeskMemory>();
    expect(saved.item?.parts[0]!.color).toBe('#3c554a');
    expect(saved.item?.source).toBe('fixture');
    const extra = await s.post('item/save', { item: { ...edited, source: 'spark' } });
    expect(extra.statusCode).toBe(400);

    const again = (await s.post('segment', { concept: 'mug', fixturePosition: 'right' })).json<
      EvidenceRun<Segmentation>
    >();
    const tracked = (await s.post('desk/track', { segmentRunId: again.id })).json<{
      memory: DeskMemory;
    }>();
    expect(tracked.memory.item?.parts[0]!.color).toBe('#3c554a');
    const reset = (await s.post('desk/reset')).json<DeskMemory>();
    expect(reset.item ?? null).toBeNull();
  });
});
