import { describe, expect, test } from 'bun:test';
import {
  CAMERA_FILTERS,
  CAMERA_FILTER_GROUPS,
  CAMERA_FILTER_KINDS,
  cameraFilterView,
  paintPixels,
  pixelGrid,
  type PixelSpec,
} from '../apps/web/src/workspace/cameraFilter.js';
import { prefsOf } from '../apps/web/src/session.js';

/** A frame of `width` × `height` pixels, all one colour. */
function frame(width: number, height: number, [r, g, b]: number[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r!, g!, b!, 255], i);
  return data;
}
const colours = (data: Uint8ClampedArray) => {
  const out = new Set<string>();
  for (let i = 0; i < data.length; i += 4) out.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
  return out;
};

describe('camera filter', () => {
  test('lays nothing on the picture while it is off', () => {
    expect(cameraFilterView(false, 'pixel')).toEqual({ hideVideo: false });
  });

  test('lays a look on the video as a CSS filter', () => {
    expect(cameraFilterView(true, 'bright')).toEqual({
      videoFilter: CAMERA_FILTERS.bright.css,
      hideVideo: false,
    });
  });

  test('animates the video by class, with scan lines drawn over it', () => {
    expect(cameraFilterView(true, 'scan')).toEqual({
      videoClass: 'cam-fx-scan',
      hideVideo: false,
      overlay: 'scan',
    });
  });

  test('hides the video behind a pixel canvas for every pixel privacy filter', () => {
    for (const kind of CAMERA_FILTER_KINDS.filter((k) => CAMERA_FILTERS[k].pixel)) {
      const view = cameraFilterView(true, kind);
      expect(view.hideVideo).toBe(true);
      expect(view.pixel).toBe(CAMERA_FILTERS[kind].pixel!);
      expect(view.videoClass).toBeUndefined();
    }
  });

  test('puts every filter in a group the picker shows', () => {
    const groups = new Set(CAMERA_FILTER_GROUPS.map((g) => g.group));
    for (const kind of CAMERA_FILTER_KINDS)
      expect(groups.has(CAMERA_FILTERS[kind].group)).toBe(true);
  });

  test('offers animated and pixel-art privacy filters', () => {
    const privacy = CAMERA_FILTER_KINDS.filter((k) => CAMERA_FILTERS[k].group === 'privacy');
    expect(privacy.some((k) => CAMERA_FILTERS[k].pixel?.palette)).toBe(true);
    expect(privacy.some((k) => CAMERA_FILTERS[k].pixel?.crawl)).toBe(true);
  });

  test('sizes the pixel grid to its columns in the frame’s shape', () => {
    expect(pixelGrid(1280, 720, 64)).toEqual({ width: 64, height: 36 });
  });

  test('never makes the pixel grid finer than the frame', () => {
    expect(pixelGrid(40, 30, 64)).toEqual({ width: 40, height: 30 });
  });

  test('draws a palette filter in its palette’s colours only', () => {
    const spec = CAMERA_FILTERS.dither.pixel!;
    const palette = new Set<string>();
    for (let p = 0; p < spec.palette!.length; p += 3)
      palette.add(spec.palette!.slice(p, p + 3).join(','));
    const data = frame(8, 8, [137, 91, 210]);
    paintPixels(data, 8, 8, spec, 0);
    for (const c of colours(data)) expect(palette.has(c)).toBe(true);
  });

  test('dithers a flat colour between palette colours', () => {
    const spec = CAMERA_FILTERS.fourtone.pixel!;
    // Halfway between the two middle greens.
    const data = frame(8, 8, [77, 122, 78]);
    paintPixels(data, 8, 8, spec, 0);
    expect(colours(data).size).toBeGreaterThan(1);
  });

  test('moves a crawling dither with the tick, and holds a still one', () => {
    const crawl = CAMERA_FILTERS.crawl.pixel!;
    const still: PixelSpec = { ...crawl, crawl: false };
    const paint = (spec: PixelSpec, tick: number) => {
      const data = frame(8, 8, [120, 100, 90]);
      paintPixels(data, 8, 8, spec, tick);
      return data.join();
    };
    expect(paint(crawl, 1)).not.toBe(paint(crawl, 0));
    expect(paint(still, 1)).toBe(paint(still, 0));
  });

  test('cuts each channel to its levels when there is no palette', () => {
    const spec: PixelSpec = { cols: 8, palette: null, levels: 3, dither: 0, crawl: false };
    const data = frame(2, 2, [10, 120, 250]);
    paintPixels(data, 2, 2, spec, 0);
    expect([...data.slice(0, 4)]).toEqual([0, 128, 255, 255]);
  });

  test('starts off, on mono, with no saved choice', () => {
    expect(prefsOf(undefined)).toMatchObject({ cameraFilter: false, cameraFilterKind: 'mono' });
  });

  test('keeps a saved filter and its kind', () => {
    expect(prefsOf({ cameraFilter: true, cameraFilterKind: 'crawl' })).toMatchObject({
      cameraFilter: true,
      cameraFilterKind: 'crawl',
    });
  });

  test('drops a saved kind it does not know', () => {
    expect(prefsOf({ cameraFilterKind: 'sepiaa' as never }).cameraFilterKind).toBe('mono');
  });
});
