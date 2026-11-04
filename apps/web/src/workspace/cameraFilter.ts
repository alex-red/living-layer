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
  | 'crawl';

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
