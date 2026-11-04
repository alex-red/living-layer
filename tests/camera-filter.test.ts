import { describe, expect, test } from 'bun:test';
import {
  CAMERA_FILTERS,
  CAMERA_FILTER_GROUPS,
  CAMERA_FILTER_KINDS,
  cameraFilterMenu,
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

describe('anime filter', () => {
  const cel = CAMERA_FILTERS.anime.pixel!;
  const ink = cel.cel!.ink.join(',');
  /** A frame whose left half is `left` and right half `right`. */
  function halves(width: number, height: number, left: number[], right: number[]) {
    const data = frame(width, height, left);
    for (let y = 0; y < height; y++)
      for (let x = width / 2; x < width; x++) data.set([...right, 255], (y * width + x) * 4);
    return data;
  }

  test('inks the edge between two flat areas, once', () => {
    const data = halves(8, 4, [30, 40, 60], [220, 210, 190]);
    paintPixels(data, 8, 4, cel, 0);
    const inked = (x: number) => `${data[x * 4]},${data[x * 4 + 1]},${data[x * 4 + 2]}` === ink;
    expect([0, 1, 2, 3, 4, 5, 6, 7].filter(inked)).toEqual([3]);
  });

  test('draws no ink inside a flat area', () => {
    const data = frame(8, 8, [120, 90, 160]);
    paintPixels(data, 8, 8, cel, 0);
    expect(colours(data).has(ink)).toBe(false);
  });

  test('draws a gentle gradient in a few flat bands', () => {
    const width = 64;
    const data = new Uint8ClampedArray(width * 4);
    // Brightness rising 3 a block: under the ink's step, so only bands show.
    for (let x = 0; x < width; x++) data.set([x * 3 + 40, x * 3 + 30, x * 3 + 20, 255], x * 4);
    paintPixels(data, width, 1, cel, 0);
    expect(colours(data).size).toBeLessThanOrEqual(cel.cel!.bands * 4);
    expect(colours(data).size).toBeGreaterThan(1);
  });

  test('keeps black a dark band, not black', () => {
    const data = frame(2, 2, [0, 0, 0]);
    paintPixels(data, 2, 2, cel, 0);
    expect(data[0]).toBeGreaterThan(30);
  });

  test('pushes a colour further from grey', () => {
    // Two colours, so balancing the frame leaves each its own.
    const data = halves(4, 2, [180, 120, 100], [100, 120, 180]);
    paintPixels(data, 4, 2, cel, 0);
    expect(data[0]! - data[2]!).toBeGreaterThan(180 - 100);
  });

  test('softens a tinted light’s cast rather than pushing it', () => {
    // A grey room under purple light.
    const spread = (spec: PixelSpec) => {
      const data = frame(4, 4, [150, 110, 170]);
      paintPixels(data, 4, 4, spec, 0);
      return Math.max(data[0]!, data[1]!, data[2]!) - Math.min(data[0]!, data[1]!, data[2]!);
    };
    const unbalanced: PixelSpec = { ...cel, cel: { ...cel.cel!, balance: 0 } };
    expect(spread(cel)).toBeLessThan(spread(unbalanced));
  });

  test('draws no ink over fine texture', () => {
    // A checkerboard of light and dark blocks, like a keyboard's keys from across the room.
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        data.set((x + y) % 2 ? [200, 200, 200, 255] : [90, 90, 90, 255], (y * 16 + x) * 4);
    paintPixels(data, 16, 16, cel, 0);
    expect(colours(data).has(ink)).toBe(false);
  });
});

describe('animated anime filter', () => {
  const fx = CAMERA_FILTERS.animeFx.pixel!;
  const ink = fx.cel!.ink.join(',');
  const paint = (data: Uint8ClampedArray, w: number, h: number, tick: number) => {
    paintPixels(data, w, h, fx, tick);
    return data;
  };
  /** A soft diagonal edge, dark to light, rising about half the ink's threshold a block: its ink sits near the threshold. */
  function softEdge(w: number, h: number) {
    const rise = fx.cel!.outline / 2;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = Math.max(40, Math.min(200, 120 + (x - y) * rise + ((x * 7 + y * 3) % 5)));
        data.set([v, v * 0.9, v * 0.8, 255], (y * w + x) * 4);
      }
    return data;
  }
  const whites = (data: Uint8ClampedArray) => {
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] === 255 && data[i + 2] === 240) n++;
    return n;
  };

  test('is a smooth, finer canvas among the animated filters', () => {
    expect(CAMERA_FILTERS.animeFx.group).toBe('animated');
    expect(fx.smooth).toBe(true);
    expect(fx.cols).toBeGreaterThan(CAMERA_FILTERS.anime.pixel!.cols);
  });

  test('boils its ink lines from tick to tick', () => {
    const at = (tick: number) => paint(softEdge(24, 24), 24, 24, tick).join();
    expect(new Set([0, 1, 2, 3].map(at)).size).toBeGreaterThan(1);
  });

  test('draws the same frame at the same tick', () => {
    expect(paint(softEdge(24, 24), 24, 24, 5).join()).toBe(
      paint(softEdge(24, 24), 24, 24, 5).join(),
    );
  });

  test('still inks a hard edge at every tick', () => {
    for (const tick of [0, 1, 2, 3]) {
      const data = frame(8, 4, [30, 40, 60]);
      for (let y = 0; y < 4; y++)
        for (let x = 4; x < 8; x++) data.set([220, 210, 190, 255], (y * 8 + x) * 4);
      paint(data, 8, 4, tick);
      expect(colours(data).has(ink)).toBe(true);
    }
  });

  test('twinkles sparkles on a bright spot over time, not all the time', () => {
    // Bright 3 × 3 patches across a frame, like lamps and glints: some are chosen to sparkle, each at its own phase.
    const w = 96;
    const h = 96;
    const counts = Array.from({ length: 12 }, (_, tick) => {
      const data = frame(w, h, [40, 40, 50]);
      for (let cy = 6; cy < h - 6; cy += 8)
        for (let cx = 6; cx < w - 6; cx += 8)
          for (let y = cy - 1; y <= cy + 1; y++)
            for (let x = cx - 1; x <= cx + 1; x++) data.set([250, 250, 250, 255], (y * w + x) * 4);
      return whites(paint(data, w, h, tick));
    });
    expect(Math.max(...counts)).toBeGreaterThan(0);
    expect(new Set(counts).size).toBeGreaterThan(1);
  });

  test('puts no sparkles on a dark frame', () => {
    for (const tick of [0, 1, 2])
      expect(whites(paint(frame(32, 32, [60, 50, 70]), 32, 32, tick))).toBe(0);
  });
});

describe('camera filter menu', () => {
  const noop = { choose: () => {}, off: () => {} };

  test('ticks Off while the filter is off', () => {
    const items = cameraFilterMenu(false, 'dither', noop);
    expect(items.filter((i) => i.checked).map((i) => i.label)).toEqual(['Off']);
  });

  test('ticks the filter showing while it is on', () => {
    const items = cameraFilterMenu(true, 'dither', noop);
    expect(items.filter((i) => i.checked).map((i) => i.label)).toEqual(['Dither']);
  });

  test('offers every filter once, after Off, in its group', () => {
    const labels = cameraFilterMenu(false, 'mono', noop).map((i) => i.label);
    const byGroup = CAMERA_FILTER_GROUPS.flatMap(({ group }) =>
      CAMERA_FILTER_KINDS.filter((k) => CAMERA_FILTERS[k].group === group).map(
        (k) => CAMERA_FILTERS[k].label,
      ),
    );
    expect(labels).toEqual(['Off', ...byGroup]);
  });

  test('heads each group at its first filter', () => {
    const headings = cameraFilterMenu(false, 'mono', noop).flatMap((i) =>
      i.heading ? [`${i.heading}:${i.label}`] : [],
    );
    expect(headings).toEqual(['Looks:Mono', 'Animated:Drift', 'Privacy:Blur']);
  });

  test('chooses the filter picked, and turns it off from Off', () => {
    const chosen: string[] = [];
    const items = cameraFilterMenu(true, 'mono', {
      choose: (k) => chosen.push(k),
      off: () => chosen.push('off'),
    });
    items.find((i) => i.label === 'Crawl')!.onSelect();
    items.find((i) => i.label === 'Off')!.onSelect();
    expect(chosen).toEqual(['crawl', 'off']);
  });
});
