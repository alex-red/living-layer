/**
 * Colour maths for item models: sRGB to OKLab and back, so shading ramps,
 * clustering and colour error are measured the way people see colour.
 */
export type Rgb = [number, number, number];
export type Lab = [number, number, number];

export function hexRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
export function rgbHex([r, g, b]: Rgb): string {
  const h = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) =>
  255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);

export function rgbLab([r8, g8, b8]: Rgb): Lab {
  const r = toLinear(r8);
  const g = toLinear(g8);
  const b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
export function labRgb([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
export const hexLab = (hex: string) => rgbLab(hexRgb(hex));
export const labHex = (lab: Lab) => rgbHex(labRgb(lab));

/** Distance in OKLab, times 100, so about 2 is a just-visible step. */
export function deltaE(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100;
}
/**
 * Two colours that differ mainly in lightness, the way a lit and a shaded
 * side of one material do. Used to keep a shadow from reading as a band.
 */
export function sameMaterial(a: Lab, b: Lab): boolean {
  return Math.hypot(a[1] - b[1], a[2] - b[2]) < 0.03 && Math.abs(a[0] - b[0]) < 0.3;
}

/**
 * One step of a pixel-art ramp. `level` 2 is the colour itself; 3 is the lit
 * highlight, warmer; 1 and 0 are shadows, darker and cooler rather than grey.
 */
export function rampLab(base: Lab, level: number): Lab {
  const [L, a, b] = base;
  switch (level) {
    case 3:
      return [Math.min(0.98, L * 1.08 + 0.03), a + 0.002, b + 0.012];
    case 2:
      return base;
    case 1:
      return [L * 0.8, a - 0.004 + a * 0.08, b - 0.018 + b * 0.08];
    default:
      return [L * 0.6, a - 0.008 + a * 0.15, b - 0.036 + b * 0.15];
  }
}
/**
 * The colour whose ramp step `level` is `target`: the inverse of `rampLab`,
 * for matching a picture. A lit top in a reference is step 3, a face lit
 * side-on step 2, a face turned away step 0.
 */
export function unrampLab(target: Lab, level: number): Lab {
  const [L, a, b] = target;
  switch (level) {
    case 3:
      return [(L - 0.03) / 1.08, a - 0.002, b - 0.012];
    case 2:
      return target;
    case 1:
      return [L / 0.8, (a + 0.004) / 1.08, (b + 0.018) / 1.08];
    default:
      return [L / 0.6, (a + 0.008) / 1.15, (b + 0.036) / 1.15];
  }
}
/** The darker, cooler line drawn around a colour where it meets the background. */
export function outlineLab([L, a, b]: Lab): Lab {
  return [L * 0.42, a * 1.1 - 0.006, b * 1.1 - 0.03];
}

/** The palette entry nearest to a colour, compared in OKLab. */
export function nearest(lab: Lab, palette: Lab[]): Lab {
  let best = palette[0]!;
  let bestD = Infinity;
  for (const p of palette) {
    const d = (p[0] - lab[0]) ** 2 + (p[1] - lab[1]) ** 2 + (p[2] - lab[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

export interface Cluster {
  lab: Lab;
  hex: string;
  /** Share of the pixels in this cluster, 0 to 1. */
  share: number;
}
/** A small deterministic pseudo-random sequence, so clustering is repeatable. */
function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
function kmeansOnce(points: Lab[], k: number): { centres: Lab[]; labels: Int32Array; sse: number } {
  const rand = seeded(7 + k);
  // k-means++ seeding: spread the first centres across the colours present.
  const centres: Lab[] = [points[Math.floor(rand() * points.length)]!];
  const d2 = new Float64Array(points.length);
  while (centres.length < k) {
    let total = 0;
    points.forEach((p, i) => {
      let best = Infinity;
      for (const c of centres)
        best = Math.min(best, (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2);
      d2[i] = best;
      total += best;
    });
    let pick = rand() * total;
    let index = 0;
    for (; index < points.length - 1; index++) {
      pick -= d2[index]!;
      if (pick <= 0) break;
    }
    centres.push(points[index]!);
  }
  const labels = new Int32Array(points.length);
  let sse = 0;
  for (let iter = 0; iter < 12; iter++) {
    sse = 0;
    const sums = centres.map(() => [0, 0, 0, 0]);
    points.forEach((p, i) => {
      let best = 0;
      let bestD = Infinity;
      centres.forEach((c, j) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      labels[i] = best;
      sse += bestD;
      const s = sums[best]!;
      s[0]! += p[0];
      s[1]! += p[1];
      s[2]! += p[2];
      s[3]!++;
    });
    sums.forEach((s, j) => {
      if (s[3]) centres[j] = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!];
    });
  }
  return { centres, labels, sse };
}
/**
 * The main colours of a set of pixels: k-means in OKLab for k from 1 to
 * `maxK`, keeping the smallest k after which another cluster stops paying
 * for itself (an elbow rule). Largest cluster first.
 */
export function clusterColours(
  pixels: Lab[],
  maxK = 6,
): { clusters: Cluster[]; labels: Int32Array } {
  if (!pixels.length) return { clusters: [], labels: new Int32Array(0) };
  // Cluster a fixed sample so big crops stay fast; then label every pixel.
  const step = Math.max(1, Math.floor(pixels.length / 4000));
  const sample = pixels.filter((_, i) => i % step === 0);
  const runs = [];
  for (let k = 1; k <= Math.min(maxK, sample.length); k++) runs.push(kmeansOnce(sample, k));
  let chosen = runs[0]!;
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1]!.sse;
    // Stop when the extra cluster removes less than an eighth of the error,
    // or the error is already below what a person would notice.
    if (prev < sample.length * 0.0004 || (prev - runs[i]!.sse) / prev < 0.12) break;
    chosen = runs[i]!;
  }
  const labels = new Int32Array(pixels.length);
  const counts = chosen.centres.map(() => 0);
  const sums = chosen.centres.map(() => [0, 0, 0]);
  pixels.forEach((p, i) => {
    let best = 0;
    let bestD = Infinity;
    chosen.centres.forEach((c, j) => {
      const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    });
    labels[i] = best;
    counts[best]!++;
    sums[best]![0]! += p[0];
    sums[best]![1]! += p[1];
    sums[best]![2]! += p[2];
  });
  const order = counts.map((_, i) => i).sort((a, b) => counts[b]! - counts[a]!);
  const remap = new Int32Array(order.length);
  order.forEach((old, i) => (remap[old] = i));
  for (let i = 0; i < labels.length; i++) labels[i] = remap[labels[i]!]!;
  const clusters = order
    .filter((j) => counts[j]! > 0)
    .map((j) => {
      const n = counts[j]!;
      const lab: Lab = [sums[j]![0]! / n, sums[j]![1]! / n, sums[j]![2]! / n];
      return { lab, hex: labHex(lab), share: n / pixels.length };
    });
  return { clusters, labels };
}
