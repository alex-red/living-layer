import type { MenuItem } from './ContextMenu';

/**
 * A look laid over the live camera's picture, for the person's eyes only.
 * A look or an animation is CSS on the `<video>`; a privacy filter draws
 * the frame into a small canvas over it and hides the video. Either way
 * the frames a scan, SAM or the tracker read (drawn from the video onto a
 * canvas of their own) are untouched.
 */

export type CameraFilterKind =
  | 'mono'
  | 'contrast'
  | 'bright'
  | 'sepia'
  | 'cool'
  | 'night'
  | 'drift'
  | 'scan'
  | 'glitch'
  | 'blur'
  | 'pixel'
  | 'dither'
  | 'fourtone'
  | 'crawl'
  | 'anime'
  | 'animeFx';

type CameraFilterGroup = 'look' | 'animated' | 'privacy';

/** How a privacy filter draws the frame: in `cols` blocks across, its colours cut down. */
export interface PixelSpec {
  /** Blocks across the frame; rows follow the frame's shape. */
  cols: number;
  /** The colours drawn, flat RGB; null keeps the frame's own, cut to `levels` a channel. */
  palette: readonly number[] | null;
  /** Steps a channel keeps when there is no palette. */
  levels: number;
  /** How far ordered dithering nudges a channel before it is cut (0 for none). */
  dither: number;
  /** Whether the dither pattern crawls across the blocks over time. */
  crawl: boolean;
  /** Cel shading instead of a palette: brightness in flat bands, colours pushed, edges inked. */
  cel?: CelSpec;
  /** Scaled up smoothly rather than in hard blocks. */
  smooth?: boolean;
}

/** Cel shading, as in a cartoon: each block's brightness cut to bands, its hue kept. */
interface CelSpec {
  /** Brightness bands. */
  bands: number;
  /** How far colours are pushed from grey (1 keeps them). */
  saturate: number;
  /** Steps a channel keeps after that, so a band's colour is flat. */
  tones: number;
  /** How far the frame's colours are balanced to grey on average first (0 to 1), against a tinted light. */
  balance: number;
  /** The brightness step between neighbours, out of 255, that draws an ink line; 0 for none. */
  outline: number;
  /** The ink, RGB. */
  ink: readonly [number, number, number];
  /** How far each block's ink threshold wanders each tick (a share of it), so lines boil as if redrawn. */
  boil?: number;
  /** The share of the brightest blocks that can hold a twinkling sparkle. */
  sparkle?: number;
  /** Bands and colours from the frame smoothed over 3 × 3 blocks, so an area is one flat colour, not speckled. */
  flat?: boolean;
}

interface CameraFilter {
  label: string;
  title: string;
  group: CameraFilterGroup;
  /** A CSS filter on the video. */
  css?: string;
  /** A class on the video that animates it (`.cam-fx-<kind>`). */
  animated?: boolean;
  /** A layer drawn over the video, like scan lines. */
  overlay?: 'scan';
  pixel?: PixelSpec;
}

// Original palettes: a 16-colour one with warm and cool ramps, and four greens.
const PALETTE_16 = [
  20, 18, 28, 58, 40, 52, 96, 60, 56, 164, 92, 64, 222, 158, 96, 246, 222, 170, 44, 58, 92, 58, 104,
  140, 96, 168, 196, 176, 220, 226, 42, 82, 58, 82, 140, 74, 168, 196, 92, 128, 120, 132, 196, 188,
  196, 250, 248, 240,
];
const PALETTE_GREENS = [16, 32, 24, 44, 84, 60, 110, 160, 96, 200, 224, 160];

export const CAMERA_FILTERS: Record<CameraFilterKind, CameraFilter> = {
  mono: {
    label: 'Mono',
    title: 'Black and white, a little crisper: outlines and masks stand out',
    group: 'look',
    css: 'grayscale(1) contrast(1.15)',
  },
  contrast: {
    label: 'Contrast',
    title: 'Stronger contrast and colour, for a flat or washed-out picture',
    group: 'look',
    css: 'contrast(1.4) saturate(1.2)',
  },
  bright: {
    label: 'Bright',
    title: 'Lifted shadows, for a dim room',
    group: 'look',
    css: 'brightness(1.6) contrast(1.1)',
  },
  sepia: {
    label: 'Sepia',
    title: 'Warm brown tones, like an old print',
    group: 'look',
    css: 'sepia(0.85) contrast(1.05)',
  },
  cool: {
    label: 'Cool',
    title: 'A blue cast, colours a little quieter',
    group: 'look',
    css: 'saturate(0.8) hue-rotate(-18deg) brightness(1.05)',
  },
  night: {
    label: 'Night',
    title: 'Green night vision: brightened, one hue',
    group: 'look',
    css: 'grayscale(1) sepia(1) hue-rotate(60deg) saturate(3) brightness(1.3) contrast(1.2)',
  },
  drift: {
    label: 'Drift',
    title: 'Colours that drift slowly round the wheel',
    group: 'animated',
    animated: true,
  },
  scan: {
    label: 'Scan',
    title: 'An old monitor: rolling scan lines and a slight flicker',
    group: 'animated',
    animated: true,
    overlay: 'scan',
  },
  glitch: {
    label: 'Glitch',
    title: 'Now and then the picture jumps and its colours split',
    group: 'animated',
    animated: true,
  },
  blur: {
    label: 'Blur',
    title: 'Heavily blurred: shapes show, faces and screens do not',
    group: 'privacy',
    css: 'blur(18px) saturate(1.1)',
  },
  pixel: {
    label: 'Pixel',
    title: 'Big blocks in the frame’s own colours: faces and screens do not read',
    group: 'privacy',
    pixel: { cols: 64, palette: null, levels: 6, dither: 0, crawl: false },
  },
  dither: {
    label: 'Dither',
    title: 'Pixel art in 16 colours, dithered',
    group: 'privacy',
    pixel: { cols: 96, palette: PALETTE_16, levels: 0, dither: 56, crawl: false },
  },
  fourtone: {
    label: '4-tone',
    title: 'Pixel art in four greens, dithered',
    group: 'privacy',
    pixel: { cols: 80, palette: PALETTE_GREENS, levels: 0, dither: 64, crawl: false },
  },
  crawl: {
    label: 'Crawl',
    title: 'Pixel art in 16 colours whose dither crawls: animated',
    group: 'privacy',
    animated: true,
    pixel: { cols: 72, palette: PALETTE_16, levels: 0, dither: 72, crawl: true },
  },
  anime: {
    label: 'Anime',
    title: 'Cel-shaded pixel art: flat bands of bright colour, inked outlines',
    group: 'privacy',
    pixel: {
      cols: 120,
      palette: null,
      levels: 0,
      dither: 0,
      crawl: false,
      cel: { bands: 4, saturate: 1.2, tones: 6, balance: 0.5, outline: 20, ink: [28, 22, 44] },
    },
  },
  animeFx: {
    label: 'Anime ✦',
    title:
      'Smooth cel shading whose ink lines boil like hand-drawn animation, with sparkles on highlights',
    group: 'animated',
    animated: true,
    pixel: {
      cols: 240,
      palette: null,
      levels: 0,
      dither: 0,
      crawl: false,
      smooth: true,
      cel: {
        bands: 4,
        saturate: 1.3,
        tones: 6,
        balance: 0.25,
        outline: 10,
        flat: true,
        ink: [40, 30, 58],
        boil: 0.35,
        sparkle: 0.3,
      },
    },
  },
};

export const CAMERA_FILTER_KINDS = Object.keys(CAMERA_FILTERS) as CameraFilterKind[];

export const CAMERA_FILTER_GROUPS: { group: CameraFilterGroup; label: string }[] = [
  { group: 'look', label: 'Looks' },
  { group: 'animated', label: 'Animated' },
  { group: 'privacy', label: 'Privacy' },
];

/** What the stage does for a filter: the video's CSS and class, whether it hides, and what draws over it. */
export interface CameraFilterView {
  videoFilter?: string;
  videoClass?: string;
  /** A privacy canvas stands in for the video, which must not show even before its first frame. */
  hideVideo: boolean;
  overlay?: 'scan';
  pixel?: PixelSpec;
}

/** How the camera's picture is shown with the filter `on` or off. */
export function cameraFilterView(on: boolean, kind: CameraFilterKind): CameraFilterView {
  if (!on) return { hideVideo: false };
  const f = CAMERA_FILTERS[kind];
  return {
    ...(f.css ? { videoFilter: f.css } : {}),
    ...(f.animated && !f.pixel ? { videoClass: `cam-fx-${kind}` } : {}),
    hideVideo: Boolean(f.pixel),
    ...(f.overlay ? { overlay: f.overlay } : {}),
    ...(f.pixel ? { pixel: f.pixel } : {}),
  };
}

/** The privacy canvas's size: `cols` blocks across, rows in the frame's shape. */
export function pixelGrid(
  frameWidth: number,
  frameHeight: number,
  cols: number,
): { width: number; height: number } {
  const width = Math.max(1, Math.min(cols, Math.round(frameWidth)));
  return { width, height: Math.max(1, Math.round((width * frameHeight) / frameWidth)) };
}

// A 4×4 ordered-dither matrix, as offsets in (-0.5, 0.5).
const BAYER_4 = new Float32Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]).map(
  (v) => (v + 0.5) / 16 - 0.5,
);

/**
 * Cut a small frame's colours to `spec`'s, in place: RGBA, `width` × `height`.
 * `tick` moves a crawling dither's pattern; 0 holds it still.
 */
export function paintPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  spec: PixelSpec,
  tick: number,
): void {
  if (spec.cel) return paintCel(data, width, height, spec.cel, tick);
  const { palette, dither } = spec;
  const shift = spec.crawl ? tick : 0;
  const steps = Math.max(2, spec.levels) - 1;
  const n = palette ? palette.length / 3 : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const nudge = dither ? BAYER_4[((y + shift) & 3) * 4 + ((x + shift) & 3)]! * dither : 0;
      const r = data[i]! + nudge;
      const g = data[i + 1]! + nudge;
      const b = data[i + 2]! + nudge;
      if (palette) {
        let best = 0;
        let bestD = Infinity;
        for (let p = 0; p < n; p++) {
          const dr = r - palette[p * 3]!;
          const dg = g - palette[p * 3 + 1]!;
          const db = b - palette[p * 3 + 2]!;
          // Weighted towards green, as the eye is.
          const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        data[i] = palette[best * 3]!;
        data[i + 1] = palette[best * 3 + 1]!;
        data[i + 2] = palette[best * 3 + 2]!;
      } else {
        data[i] = (Math.round((r / 255) * steps) * 255) / steps;
        data[i + 1] = (Math.round((g / 255) * steps) * 255) / steps;
        data[i + 2] = (Math.round((b / 255) * steps) * 255) / steps;
      }
      data[i + 3] = 255;
    }
  }
}

/**
 * The Filter button's menu: Off, then each filter under its group's heading,
 * the one showing ticked. Choosing a filter turns it on.
 */
export function cameraFilterMenu(
  on: boolean,
  kind: CameraFilterKind,
  act: { choose: (kind: CameraFilterKind) => void; off: () => void },
): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Off', checked: !on, title: 'The camera’s picture as it is', onSelect: act.off },
  ];
  for (const { group, label } of CAMERA_FILTER_GROUPS)
    CAMERA_FILTER_KINDS.filter((k) => CAMERA_FILTERS[k].group === group).forEach((k, i) =>
      items.push({
        label: CAMERA_FILTERS[k].label,
        title: CAMERA_FILTERS[k].title,
        checked: on && k === kind,
        ...(i === 0 ? { heading: label, separated: true } : {}),
        onSelect: () => act.choose(k),
      }),
    );
  return items;
}

/** The smoothed brightness's change across block (x, y), along x or y. */
function slope(s: Float32Array, w: number, h: number, x: number, y: number, alongX: boolean) {
  return alongX
    ? s[y * w + Math.min(x + 1, w - 1)]! - s[y * w + Math.max(x - 1, 0)]!
    : s[Math.min(y + 1, h - 1) * w + x]! - s[Math.max(y - 1, 0) * w + x]!;
}

/**
 * Whether block (x, y) is inked: the smoothed brightness changes by more than
 * `t` across it, most there along that direction (so a line is one block
 * thick), and it is the darker side, so the line sits on the object's edge.
 */
function isInk(
  smooth: Float32Array,
  luma: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
  t: number,
): boolean {
  const gx = slope(smooth, w, h, x, y, true);
  const gy = slope(smooth, w, h, x, y, false);
  const alongX = Math.abs(gx) >= Math.abs(gy);
  const g = Math.abs(alongX ? gx : gy);
  if (g <= t) return false;
  // The blocks before and after this one along the edge's direction.
  const bx = alongX ? x - 1 : x;
  const by = alongX ? y : y - 1;
  const ax = alongX ? x + 1 : x;
  const ay = alongX ? y : y + 1;
  if (bx < 0 || by < 0 || ax >= w || ay >= h) return false;
  if (g < Math.abs(slope(smooth, w, h, bx, by, alongX))) return false;
  if (g < Math.abs(slope(smooth, w, h, ax, ay, alongX))) return false;
  // The brighter neighbour across the edge is past it: this block is the dark side.
  const brighter = (alongX ? gx : gy) > 0 ? ay * w + ax : by * w + bx;
  return luma[y * w + x]! < luma[brighter]!;
}

// Each block's brightness, and the same smoothed, kept between frames so a frame allocates nothing.
let lumaScratch = new Float32Array(0);
let smoothScratch = new Float32Array(0);
// Each block's colour smoothed, for a flat cel.
let colourScratch = new Float32Array(0);

/** Cel-shade a small frame in place: banded brightness, pushed colour, inked edges. */
function paintCel(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cel: CelSpec,
  tick: number,
): void {
  const n = width * height;
  if (lumaScratch.length < n) {
    lumaScratch = new Float32Array(n);
    smoothScratch = new Float32Array(n);
    colourScratch = new Float32Array(n * 3);
  }
  const colour = colourScratch;
  const luma = lumaScratch;
  const smooth = smoothScratch;
  // Grey-world balance: a room's tinted light would otherwise be pushed into a cast over everything.
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < n * 4; i += 4) {
    sr += data[i]!;
    sg += data[i + 1]!;
    sb += data[i + 2]!;
  }
  const mean = (sr + sg + sb) / 3;
  const gain = (sum: number) => Math.min(1.8, Math.max(0.6, sum ? (mean / sum) ** cel.balance : 1));
  const gr = gain(sr);
  const gg = gain(sg);
  const gb = gain(sb);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    data[i] = data[i]! * gr;
    data[i + 1] = data[i + 1]! * gg;
    data[i + 2] = data[i + 2]! * gb;
    luma[p] = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
  }
  // Brightness smoothed over 3 × 3 blocks, to tell an edge from texture (keys, shelves); for a flat
  // cel, the colour too.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const q = yy * width + xx;
          sum += luma[q]!;
          if (cel.flat) {
            r += data[q * 4]!;
            g += data[q * 4 + 1]!;
            b += data[q * 4 + 2]!;
          }
          count++;
        }
      }
      const p = y * width + x;
      smooth[p] = sum / count;
      colour[p * 3] = r / count;
      colour[p * 3 + 1] = g / count;
      colour[p * 3 + 2] = b / count;
    }
  }
  const bands = Math.max(2, cel.bands);
  const [inkR, inkG, inkB] = cel.ink;
  const steps = Math.max(2, cel.tones) - 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      const l = luma[p]!;
      // A boiling line's threshold wanders block by block, tick by tick.
      const t = cel.boil
        ? cel.outline * (1 + (hash01(x, y, tick) - 0.5) * 2 * cel.boil)
        : cel.outline;
      if (cel.outline && isInk(smooth, luma, width, height, x, y, t)) {
        data[i] = inkR;
        data[i + 1] = inkG;
        data[i + 2] = inkB;
        data[i + 3] = 255;
        continue;
      }
      // The band's brightness, its middle, never black: shadows stay coloured as in a cel.
      const lb = cel.flat ? smooth[p]! : l;
      const band = Math.min(bands - 1, Math.floor((lb / 256) * bands));
      const target = 40 + ((band + 0.5) / bands) * 215;
      // Scaled to the band, a block's grey is the band's: push its colour away from that.
      const scale = lb > 1 ? target / lb : 0;
      for (let c = 0; c < 3; c++) {
        const own = cel.flat ? colour[p * 3 + c]! : data[i + c]!;
        const v = scale ? target + (own * scale - target) * cel.saturate : target;
        data[i + c] = (Math.round((Math.min(255, Math.max(0, v)) / 255) * steps) * 255) / steps;
      }
      data[i + 3] = 255;
    }
  }
  if (cel.sparkle) paintSparkles(data, smooth, width, height, cel.sparkle, tick);
}

/** A steady pseudo-random share in [0, 1) for block (x, y) at tick `t`. */
function hash01(x: number, y: number, t: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(t, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// A sparkle's life in ticks, and the ticks of it it shows (growing, full, fading).
const SPARKLE_PERIOD = 12;
const SPARKLE_SHOWN = 4;

/**
 * Four-point sparkles on the brightest blocks: each chosen block (a steady
 * `share` of the smoothed brightness's peaks near white) twinkles at its own
 * phase, its arms growing from one block to three and fading back.
 */
function paintSparkles(
  data: Uint8ClampedArray,
  luma: Float32Array,
  width: number,
  height: number,
  share: number,
  tick: number,
): void {
  // Kept three blocks in, so the longest arm stays on the frame.
  for (let y = 3; y < height - 3; y++) {
    for (let x = 3; x < width - 3; x++) {
      const p = y * width + x;
      if (luma[p]! < 200 || hash01(x, y, 0) >= share) continue;
      // Only a peak over the blocks two around sparkles, so a bright patch gets one, not a cluster.
      if (!isPeak(luma, width, x, y)) continue;
      const phase = (tick + Math.floor(hash01(y, x, 1) * SPARKLE_PERIOD)) % SPARKLE_PERIOD;
      if (phase >= SPARKLE_SHOWN) continue;
      // Arms grow 1, 2, 3 blocks, then fade back to 2.
      const arm = phase === 3 ? 2 : phase + 1;
      for (let k = -arm; k <= arm; k++) {
        whiten(data, (y * width + x + k) * 4);
        whiten(data, ((y + k) * width + x) * 4);
      }
    }
  }
}

/** Whether block (x, y) is at least as bright as every block within two of it. */
function isPeak(luma: Float32Array, width: number, x: number, y: number): boolean {
  const l = luma[y * width + x]!;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) if (luma[(y + dy) * width + x + dx]! > l) return false;
  return true;
}

function whiten(data: Uint8ClampedArray, i: number): void {
  data[i] = 255;
  data[i + 1] = 252;
  data[i + 2] = 240;
}
