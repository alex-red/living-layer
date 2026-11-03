import { median, pointInPolygon } from './math.js';
import { clamp } from './math.js';
import {
  clusterColours,
  deltaE,
  hexRgb,
  labHex,
  labRgb,
  rgbLab,
  sameMaterial,
  type Lab,
} from './color.js';
import {
  ARCHETYPE_FAMILY,
  buildItem,
  defaultFit,
  type Archetype,
  type ArchetypeFit,
  type Band,
  type BoxFit,
  type FlatFit,
  type LatheFit,
} from './iso-archetypes.js';
import type { Decal, IsoItem, ItemMaterial, Swatch } from './iso-item.js';
import { renderView, voxelize, type VoxelGrid } from './iso-voxel.js';

/**
 * Fit a model to one masked crop: measure the silhouette and colours, build
 * the archetype's parts, then render them from the photo's camera and nudge
 * the numbers until the render and the mask agree (analysis by synthesis).
 * Pure and deterministic, so demo mode and tests run the real thing.
 */
export interface FitInput {
  /** The crop as RGBA, with the mask in alpha. */
  rgba: Uint8Array;
  width: number;
  height: number;
  label: string;
  archetype?: Archetype;
  material?: ItemMaterial | null;
  /** The camera's angle above the surface from a surface pin, in degrees. */
  elevation?: number | null;
  /** Part masks from SAM, as 0/1 per crop pixel. */
  parts?: { handle?: Uint8Array | null; inside?: Uint8Array | null };
  /** Renders the refine step may spend. */
  budget?: number;
  /**
   * How tall it is, as a share of its longer side, when that is known from
   * elsewhere (a fixture's usual size). Flat things seen from above need it.
   */
  knownHeight?: number | null;
}
interface FitScore {
  /** Silhouette overlap with the mask, 0 to 1. */
  iou: number;
  /** Mean OKLab colour error inside both, times 100. */
  deltaE: number;
}
export interface FitOutput {
  item: IsoItem;
  params: ArchetypeFit;
  archetype: Archetype;
  score: FitScore;
  elevation: number;
  swatches: Swatch[];
  renders: number;
}

/** The mask, trimmed to its bounds, with every pixel's colour group. */
interface Photo {
  w: number;
  h: number;
  mask: Uint8Array;
  lab: Float32Array;
  /** Colour group per pixel, -1 outside the mask; groups merge lit and shaded clusters. */
  group: Int16Array;
  groups: { lab: Lab; hex: string; share: number }[];
  handle: Uint8Array | null;
  inside: Uint8Array | null;
}
function preparePhoto(input: FitInput): Photo {
  const { rgba, width, height } = input;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (rgba[(x + y * width) * 4 + 3]! >= 128) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  if (x1 < 0) throw new Error('The mask is empty.');
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const mask = new Uint8Array(w * h);
  const lab = new Float32Array(w * h * 3);
  const crop = (m?: Uint8Array | null) => {
    if (!m) return null;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) out[x + y * w] = m[x + x0 + (y + y0) * width] ? 1 : 0;
    return out;
  };
  const pixels: Lab[] = [];
  const where: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (x + x0 + (y + y0) * width) * 4;
      if (rgba[i + 3]! < 128) continue;
      const p = x + y * w;
      mask[p] = 1;
      const c = rgbLab([rgba[i]!, rgba[i + 1]!, rgba[i + 2]!]);
      lab.set(c, p * 3);
      pixels.push(c);
      where.push(p);
    }
  const { clusters, labels } = clusterColours(pixels, 6);
  // Merge clusters that are one material in light and shade.
  const groupOf: number[] = [];
  const reps: number[] = [];
  clusters.forEach((c, i) => {
    const j = reps.findIndex((r) => sameMaterial(clusters[r]!.lab, c.lab));
    if (j >= 0) groupOf[i] = j;
    else {
      groupOf[i] = reps.length;
      reps.push(i);
    }
  });
  // A group's colour is the share-weighted mean of its clusters: lit and shaded together.
  const shares = reps.map(() => 0);
  const sums = reps.map(() => [0, 0, 0]);
  clusters.forEach((c, i) => {
    const g = groupOf[i]!;
    shares[g]! += c.share;
    for (let k = 0; k < 3; k++) sums[g]![k]! += c.lab[k]! * c.share;
  });
  const group = new Int16Array(w * h).fill(-1);
  where.forEach((p, k) => (group[p] = groupOf[labels[k]!]!));
  const groups = reps.map((_, g) => {
    const lab: Lab = [
      sums[g]![0]! / shares[g]!,
      sums[g]![1]! / shares[g]!,
      sums[g]![2]! / shares[g]!,
    ];
    return { lab, hex: labHex(lab), share: shares[g]! };
  });
  return {
    w,
    h,
    mask,
    lab,
    group,
    groups,
    handle: crop(input.parts?.handle),
    inside: crop(input.parts?.inside),
  };
}
function dominant(photo: Photo, pixels: Iterable<number>): number {
  const counts = new Map<number, number>();
  for (const p of pixels) {
    const g = photo.group[p]!;
    if (g >= 0) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best = -1;
  let bestN = 0;
  for (const [g, n] of counts)
    if (n > bestN) {
      best = g;
      bestN = n;
    }
  return best;
}
const DEG = Math.PI / 180;
const ARCHETYPE_HANDLES = new Set<Archetype>(['mug']);

/** Douglas–Peucker on a polyline, keeping the ends. */
function simplify(
  points: { r: number; z: number }[],
  tolerance: number,
): { r: number; z: number }[] {
  if (points.length <= 2) return points;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  let worst = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const ex = b.r - a.r;
    const ez = b.z - a.z;
    const len = Math.hypot(ex, ez) || 1;
    const d = Math.abs((p.r - a.r) * ez - (p.z - a.z) * ex) / len;
    if (d > worst) {
      worst = d;
      index = i;
    }
  }
  if (worst <= tolerance) return [a, b];
  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ];
}

interface Rows {
  l: number[];
  r: number[];
  runs: [number, number][][];
  top: number;
  bottom: number;
}
function rowsOf(photo: Photo): Rows {
  const l: number[] = [];
  const r: number[] = [];
  const runs: [number, number][][] = [];
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < photo.h; y++) {
    const row: [number, number][] = [];
    let start = -1;
    for (let x = 0; x <= photo.w; x++) {
      const on = x < photo.w && photo.mask[x + y * photo.w];
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        row.push([start, x - 1]);
        start = -1;
      }
    }
    runs.push(row);
    l.push(row.length ? row[0]![0] : -1);
    r.push(row.length ? row[row.length - 1]![1] : -1);
    if (row.length) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  return { l, r, runs, top, bottom };
}

/**
 * Measure a turned body: its axis, its side profile corrected for the
 * camera's elevation, a handle on one side, and the colours of the body,
 * inside, handle and any bands or print.
 */
function measureLathe(
  photo: Photo,
  archetype: Archetype,
  hint: number | null,
  material: ItemMaterial | null,
): { fit: LatheFit; elevation: number } {
  const rows = rowsOf(photo);
  const { l, r, top, bottom } = rows;
  const ys = Array.from({ length: bottom - top + 1 }, (_, i) => top + i);
  const span0 = bottom - top + 1;
  // The axis from the narrowest rows: a handle only ever widens a row, and
  // it can cover more than half of them, so a plain median would drift.
  const inner = ys.slice(Math.floor(ys.length * 0.15), Math.ceil(ys.length * 0.85));
  const narrowest = Math.min(...inner.map((y) => r[y]! - l[y]!));
  const slim = inner.filter((y) => r[y]! - l[y]! <= narrowest * 1.06 + 1);
  let axis = median((slim.length ? slim : ys).map((y) => (l[y]! + r[y]!) / 2));
  let handleRows = new Set<number>();
  let side = 1;
  const findHandle = () => {
    if (photo.handle) {
      const xs: number[] = [];
      handleRows = new Set();
      for (const y of ys)
        for (let x = 0; x < photo.w; x++)
          if (photo.handle[x + y * photo.w]) {
            handleRows.add(y);
            xs.push(x);
          }
      side = median(xs) >= axis ? 1 : -1;
      return;
    }
    const diffs = ys.map((y) => r[y]! - axis - (axis - l[y]!));
    const body = median(ys.map((y) => Math.min(axis - l[y]!, r[y]! - axis)));
    const flagged = ys.filter((_, i) => Math.abs(diffs[i]!) > Math.max(2, 0.14 * body));
    const sum = flagged.reduce((a, y) => a + (r[y]! - axis - (axis - l[y]!)), 0);
    side = sum >= 0 ? 1 : -1;
    // Keep the longest stretch of rows, allowing small gaps: the handle is one piece.
    let best: number[] = [];
    let cur: number[] = [];
    for (const y of flagged) {
      if (cur.length && y - cur[cur.length - 1]! > 3) cur = [];
      cur.push(y);
      if (cur.length > best.length) best = [...cur];
    }
    handleRows = new Set(best.length >= Math.max(3, 0.08 * ys.length) ? best : []);
  };
  // Only mugs have handles; anything else that sticks out is part of the body.
  const handled = ARCHETYPE_HANDLES.has(archetype);
  // Rows with a gap show the hole between body and handle: there the widest
  // run is the body alone, which fixes the axis even when the mask's bottom
  // is cut off or the handle spans most rows.
  const holed = handled
    ? ys.filter(
        (y) => rows.runs[y]!.length >= 2 && y >= top + span0 * 0.1 && y <= bottom - span0 * 0.1,
      )
    : [];
  if (holed.length >= Math.max(3, span0 * 0.08)) {
    const bodyRun = (y: number) =>
      rows.runs[y]!.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
    axis = median(holed.map((y) => (bodyRun(y)[0] + bodyRun(y)[1]) / 2));
    const outer = holed.map((y) => {
      const runs = rows.runs[y]!;
      const body = bodyRun(y);
      return runs.filter((q) => q !== body).reduce((a, q) => a + Math.sign(q[0] - body[0]), 0);
    });
    side = outer.reduce((a, b) => a + b, 0) >= 0 ? 1 : -1;
  }
  if (handled) findHandle();
  const quiet = inner.filter((y) => !handleRows.has(y));
  if (quiet.length && holed.length < Math.max(3, span0 * 0.08))
    axis = median(quiet.map((y) => (l[y]! + r[y]!) / 2));
  if (handled) findHandle();
  if (!handleRows.size) side = 1;
  const half = (y: number) => {
    const yy = clamp(Math.round(y), top, bottom);
    if (l[yy]! < 0) return 0;
    if (!handleRows.size) return Math.max(0, (r[yy]! - l[yy]!) / 2);
    // With a handle, measure the side away from it: the rows where the handle
    // joins widen its own side without being flagged.
    return Math.max(0, side > 0 ? axis - l[yy]! : r[yy]! - axis);
  };
  const span = bottom - top + 1;
  // The top rim's ellipse: how many rows until the width stops growing gives
  // its minor radius, and minor over major radius is the sine of the elevation.
  // Walk down from the top while the outline keeps widening: where it levels
  // off is the rim's radius (a bottle's cap, a mug's lip), not a wider shoulder.
  // Walk rows in from one end while the outline keeps widening; return the
  // rim's radius and its minor radius estimated from the steep rows.
  const rim = (walk: number[]) => {
    let radius = 1;
    let flat = 0;
    let widest = 0;
    for (const [i, y] of walk.entries()) {
      if (half(y) > radius + 0.5) {
        radius = half(y);
        widest = i;
        flat = 0;
      } else if (++flat >= 3) break;
    }
    // On an ellipse of radii R and ry, the half-width d rows below the top is
    // R·√(1 − (1 − d/ry)²). Solve each steep row for ry; the flat rows near the
    // widest point are too sensitive to a pixel of noise to use. Rows past the
    // widest are another edge (a base's top, a neck), not this rim.
    const estimates: number[] = [];
    for (let i = 0; i <= widest; i++) {
      const q = half(walk[i]!) / radius;
      if (q < 0.3 || q > 0.9) continue;
      estimates.push((i + 0.5) / (1 - Math.sqrt(1 - q * q)));
    }
    return { radius, estimates };
  };
  const topRows = ys.slice(0, Math.max(3, Math.floor(span * 0.5)));
  const { radius: rTop, estimates } = rim(topRows);
  // A lamp's shade keeps widening below its rim, which reads as a steep angle;
  // its base is a plain disc, so read the angle from the base's bottom edge.
  const read =
    archetype === 'lamp' ? rim(ys.slice(-Math.max(3, Math.floor(span * 0.25))).reverse()) : null;
  const ry = median((read ?? { estimates }).estimates);
  const rRead = read ? read.radius : rTop;
  // A top that is already full width in its first rows is seen nearly side-on.
  const flatTop = half(top) / rTop > 0.8 && half(top + 1) / rTop > 0.8;
  const fromRim =
    (read ?? { estimates }).estimates.length >= 2
      ? Math.asin(clamp(ry / rRead, 0.1, 0.97)) / DEG
      : 30;
  // A camera on a desk rarely looks down more steeply than 60°: a steeper
  // reading means a tilted or cut-off rim, so fall back to a typical angle.
  const rimElevation = flatTop ? 8 : fromRim > 60 ? 30 : fromRim;
  const elevation = clamp(hint ?? rimElevation, 8, 75);
  const sinE = Math.sin(elevation * DEG);
  const cosE = Math.cos(elevation * DEG);
  const bottomRows = ys.slice(-Math.max(3, Math.floor(span * 0.25)));
  const rBottom = Math.max(1, ...bottomRows.map(half));
  const yRim = top + rTop * sinE;
  const yBase = bottom - rBottom * sinE;
  let hPx = (yBase - yRim) / cosE;
  if (!(hPx > 2)) hPx = span * 0.8;
  const samples = Array.from({ length: 25 }, (_, i) => {
    const f = i / 24;
    return { f, row: yBase - f * hPx * cosE, half: half(yBase - f * hPx * cosE) };
  });
  // A real mask's edge is ragged by a pixel or two; smooth it so the
  // correction below doesn't turn that noise into ridges.
  const smooth = () => {
    const before = samples.map((x) => x.half);
    samples.forEach((x, i) => {
      const near = [before[i - 1], before[i], before[i + 1]].filter(
        (v): v is number => v !== undefined,
      );
      x.half = near.reduce((a, b) => a + b, 0) / near.length;
    });
  };
  smooth();
  // From above, each height's slice is an ellipse, and the outline is all of
  // them together: a shoulder's back edge widens the neck's rows above it.
  // Correct each radius until the profile's own outline matches the photo's.
  for (let iter = 0; iter < 10; iter++) {
    const outline = samples.map((a) =>
      Math.max(
        ...samples.map((b) => {
          const t = (a.row - b.row) / Math.max(1e-6, b.half * sinE);
          return t * t < 1 ? b.half * Math.sqrt(1 - t * t) : 0;
        }),
      ),
    );
    samples.forEach((sample, i) => {
      const seen = half(sample.row);
      if (outline[i]! > 0) sample.half *= clamp(seen / outline[i]!, 0.7, 1.3);
    });
  }
  smooth();
  const rMax = Math.max(1, ...samples.map((s) => s.half));
  let tolerance = 0.03;
  let profile = simplify(
    samples.map((s) => ({ r: s.half / rMax, z: s.f })),
    tolerance,
  );
  while (profile.length > 16) profile = simplify(profile, (tolerance *= 1.5));
  const unit = photo.w;
  const base = defaultFit(archetype) as LatheFit;
  const fit: LatheFit = {
    ...base,
    radius: rMax / unit,
    height: hPx / unit,
    profile,
    material: material ?? base.material,
    bands: [],
    decal: null,
  };
  // The handle: its rows give top and bottom, its farthest pixel the reach.
  if (handleRows.size) {
    const hy = [...handleRows];
    const edge = (y: number) => (side > 0 ? r[y]! - (axis + half(y)) : axis - half(y) - l[y]!);
    const reachPx = Math.max(...hy.map(edge));
    const middle = hy.slice(Math.floor(hy.length / 3), Math.ceil((hy.length * 2) / 3));
    const widths = middle
      .map((y) => {
        const runs = rows.runs[y]!;
        if (runs.length < 2) return 0;
        const outer = side > 0 ? runs[runs.length - 1]! : runs[0]!;
        return outer[1] - outer[0] + 1;
      })
      .filter((v) => v > 0);
    const thickPx = widths.length ? median(widths) : reachPx * 0.35;
    const zOf = (y: number) => (yBase - y) / cosE / hPx;
    fit.handle = {
      top: clamp(zOf(Math.min(...hy)) - thickPx / 2 / hPx, 0.15, 1),
      bottom: clamp(zOf(Math.max(...hy)) + thickPx / 2 / hPx, 0, 0.85),
      reach: Math.max(0.02, (reachPx - thickPx / 2) / unit),
      thickness: clamp(thickPx / unit, 0.02, 0.3),
    };
  } else fit.handle = null;
  // Colours: the body from the middle columns, the inside from the rim's
  // ellipse, the handle from beyond the body's edge.
  const at = (x: number, y: number) => Math.round(x) + Math.round(y) * photo.w;
  const bodyPixels: number[] = [];
  for (let y = Math.ceil(yRim + rTop * sinE); y <= Math.floor(yBase); y++)
    for (let x = Math.ceil(axis - half(y) * 0.55); x <= axis + half(y) * 0.55; x++)
      if (photo.mask[at(x, y)]) bodyPixels.push(at(x, y));
  const bodyGroup = Math.max(
    0,
    dominant(photo, bodyPixels.length ? bodyPixels : photo.group.keys()),
  );
  const color = (g: number) => photo.groups[g]?.hex ?? fit.colors.body;
  fit.colors = {
    ...fit.colors,
    body: color(bodyGroup),
    handle: color(bodyGroup),
    inside: color(bodyGroup),
  };
  if (fit.handle) {
    const px: number[] = [];
    for (const y of handleRows)
      for (let x = 0; x < photo.w; x++) {
        const beyond = side > 0 ? x > axis + half(y) + 1 : x < axis - half(y) - 1;
        if (beyond && photo.mask[at(x, y)]) px.push(at(x, y));
      }
    const g = dominant(photo, px);
    if (g >= 0) fit.colors.handle = color(g);
  }
  if (fit.wall > 0) {
    const px: number[] = [];
    const rx = rTop * 0.75;
    const ry = rTop * sinE * 0.75;
    for (let y = Math.floor(yRim - ry); y <= yRim + ry; y++)
      for (let x = Math.floor(axis - rx); x <= axis + rx; x++) {
        if (x < 0 || y < 0 || x >= photo.w || y >= photo.h) continue;
        const inEllipse = ((x - axis) / rx) ** 2 + ((y - yRim) / Math.max(ry, 0.5)) ** 2 <= 1;
        const p = at(x, y);
        if ((photo.inside ? photo.inside[p] : inEllipse) && photo.mask[p]) px.push(p);
      }
    let g = dominant(photo, px);
    if (!photo.inside && (g < 0 || g === bodyGroup)) {
      // The opening may sit higher than the ellipse guess (a tilted rim, a
      // wrong angle): look across the top of the outline for a second colour
      // that fills a good part of it and isn't on the body's front.
      const opening: number[] = [];
      for (let y = top; y <= Math.min(bottom, yRim + rTop * sinE); y++)
        for (let x = Math.floor(axis - rTop * 0.8); x <= axis + rTop * 0.8; x++)
          if (x >= 0 && x < photo.w && photo.mask[at(x, y)]) opening.push(at(x, y));
      const counts = new Map<number, number>();
      for (const p of opening) {
        const q = photo.group[p]!;
        if (q !== bodyGroup && q >= 0) counts.set(q, (counts.get(q) ?? 0) + 1);
      }
      const [best, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [-1, 0];
      if (n >= opening.length * 0.2) g = best;
    }
    // The inner wall is the body's colour, a step into the shade.
    const [L, a, b] = photo.groups[bodyGroup]?.lab ?? [0.7, 0, 0];
    fit.colors.inside = labHex([L * 0.82, a, b - 0.01]);
    if (archetype === 'plant') {
      // A pot is filled with soil: the opening's colour is the soil's.
      if (g >= 0 && g !== bodyGroup) fit.colors.liquid = color(g);
      fit.level = 0.88;
    } else {
      // Another colour in the opening is the inside's own (a dark glaze, the shade
      // inside it): from above the rim, an empty mug and a full one look alike,
      // so a drink is only what the person says is in it.
      if (g >= 0 && g !== bodyGroup) fit.colors.inside = color(g);
      fit.colors.liquid = null;
      fit.level = 0;
    }
  }
  // Bands: down the front of the body, rows whose middle is another colour.
  // On a cylinder seen from above, the front of height z sits R·sinE below its side.
  const vOf = (y: number) => clamp((yBase + half(y) * sinE - y) / cosE / hPx, 0, 1);
  const rowGroups: { y: number; g: number; fill: number }[] = [];
  for (let y = Math.ceil(yRim + rTop * sinE); y <= bottom; y++) {
    const centre: number[] = [];
    const wide: number[] = [];
    for (let x = Math.ceil(axis - half(y) * 0.7); x <= axis + half(y) * 0.7; x++)
      if (photo.mask[at(x, y)]) {
        wide.push(at(x, y));
        if (Math.abs(x - axis) <= half(y) * 0.35) centre.push(at(x, y));
      }
    const g = dominant(photo, centre);
    const fill = wide.filter((p) => photo.group[p] === g).length / Math.max(1, wide.length);
    if (centre.length) rowGroups.push({ y, g, fill });
  }
  const bands: Band[] = [];
  const minRun = Math.max(2, Math.round(span * 0.04));
  for (let i = 0; i < rowGroups.length;) {
    let j = i;
    while (j + 1 < rowGroups.length && rowGroups[j + 1]!.g === rowGroups[i]!.g) j++;
    const g = rowGroups[i]!.g;
    const run = rowGroups.slice(i, j + 1);
    // A band wraps the body, so its colour fills most of its rows; a line of
    // print in the middle of the front doesn't.
    const fill = run.reduce((a, r) => a + r.fill, 0) / run.length;
    if (g !== bodyGroup && g >= 0 && run.length >= minRun && fill >= 0.6)
      bands.push({ from: vOf(rowGroups[j]!.y), to: vOf(rowGroups[i]!.y), color: color(g) });
    i = j + 1;
  }
  fit.bands = bands.slice(0, 4);
  fit.decal = unwrapLathe(photo, fit, { axis, yBase, hPx, rMax, sinE, cosE, bodyGroup });
  if (archetype === 'plant' && fit.foliage) {
    // Whatever stands above the pot's rim in another colour is the plant.
    const px: number[] = [];
    for (let y = top; y < yRim; y++)
      for (let x = 0; x < photo.w; x++) if (photo.mask[at(x, y)]) px.push(at(x, y));
    const g = dominant(photo, px);
    if (g >= 0 && g !== bodyGroup) fit.foliage = { ...fit.foliage, color: color(g) };
  }
  return { fit, elevation };
}

/**
 * A plant in a pot: the pot is the lower rows in the bottom's colour, fitted
 * as a lathe on its own; what grows above it is the foliage. The foliage
 * hides the pot's rim, so the camera angle comes from a pin or a default.
 */
function measurePlant(
  photo: Photo,
  hint: number | null,
  material: ItemMaterial | null,
): { fit: LatheFit; elevation: number } {
  const rows = rowsOf(photo);
  const rowPixels = (y: number) => {
    const px: number[] = [];
    for (let x = 0; x < photo.w; x++) if (photo.mask[x + y * photo.w]) px.push(x + y * photo.w);
    return px;
  };
  const bottomRows = Array.from(
    { length: Math.max(2, Math.floor((rows.bottom - rows.top) * 0.15)) },
    (_, i) => rows.bottom - i,
  );
  const potGroup = dominant(photo, bottomRows.flatMap(rowPixels));
  let potTop = rows.bottom;
  for (let y = rows.bottom; y >= rows.top; y--) {
    const px = rowPixels(y);
    const pot = px.filter((p) => photo.group[p] === potGroup).length;
    if (px.length && pot / px.length < 0.5) break;
    potTop = y;
  }
  const pot: Photo = { ...photo, mask: photo.mask.slice(), handle: null };
  for (let y = 0; y < potTop; y++) pot.mask.fill(0, y * photo.w, (y + 1) * photo.w);
  const measured = measureLathe(pot, 'plant', hint ?? 30, material);
  const leaves = Array.from(
    { length: Math.max(0, potTop - rows.top) },
    (_, i) => rows.top + i,
  ).flatMap(rowPixels);
  const leafGroup = dominant(photo, leaves);
  const cos = Math.cos(measured.elevation * DEG);
  measured.fit.foliage = {
    height: clamp(((potTop - rows.top) / cos / photo.w) * 1.1, 0.1, 1.5),
    color: photo.groups[leafGroup]?.hex ?? measured.fit.foliage?.color ?? '#4d6a54',
  };
  return measured;
}

/**
 * The visible half of the body's surface as a decal: each decal pixel maps
 * to an angle around the axis and a height, and from there to a photo pixel.
 * Body-coloured pixels stay clear so the shading shows through.
 */
function unwrapLathe(
  photo: Photo,
  fit: LatheFit,
  m: {
    axis: number;
    yBase: number;
    hPx: number;
    rMax: number;
    sinE: number;
    cosE: number;
    bodyGroup: number;
  },
): Decal | null {
  const w = 32;
  const h = 32;
  const profileAt = (v: number) => {
    const p = fit.profile;
    for (let i = 1; i < p.length; i++)
      if (v <= p[i]!.z) {
        const a = p[i - 1]!;
        const b = p[i]!;
        return a.r + ((b.r - a.r) * (v - a.z)) / Math.max(1e-6, b.z - a.z);
      }
    return p[p.length - 1]!.r;
  };
  const bandAt = (v: number) => fit.bands.find((b) => v >= b.from && v <= b.to);
  // Sample the surface: each decal pixel is an angle around the axis and a height.
  const cells: (Lab | null)[] = [];
  const body: boolean[] = [];
  for (let row = 0; row < h; row++) {
    const v = 1 - (row + 0.5) / h;
    for (let col = 0; col < w; col++) {
      const u = 0.25 + ((col + 0.5) / w) * 0.5;
      const phi = (0.5 - u) * 2 * Math.PI;
      const radius = profileAt(v) * m.rMax;
      const x = Math.round(m.axis + radius * Math.sin(phi));
      const y = Math.round(m.yBase - v * m.hPx * m.cosE + radius * Math.cos(phi) * m.sinE);
      const p = x + y * photo.w;
      // Near the limbs the surface turns away and the colour is unreliable.
      const ok =
        Math.abs(phi) < 1.25 && x >= 0 && y >= 0 && x < photo.w && y < photo.h && photo.mask[p];
      cells.push(
        ok && !bandAt(v) ? [photo.lab[p * 3]!, photo.lab[p * 3 + 1]!, photo.lab[p * 3 + 2]!] : null,
      );
      body.push(Boolean(ok) && photo.group[p] === m.bodyGroup);
    }
  }
  // The body's own shading in each column (light falls off around the curve):
  // print is what stands out from it, even a grey logo on a white mug.
  const shade: (Lab | null)[] = Array.from({ length: w }, (_, col) => {
    const column = Array.from({ length: h }, (_, row) => row * w + col)
      .filter((i) => body[i] && cells[i])
      .map((i) => cells[i]!);
    if (column.length < h * 0.15) return null;
    const mid = (k: number) => median(column.map((c) => c[k]!));
    return [mid(0), mid(1), mid(2)] as Lab;
  });
  // A column that is all print (a vertical stripe) borrows its nearest neighbour's shading.
  for (let col = 0; col < w; col++)
    if (!shade[col])
      for (let d = 1; d < w && !shade[col]; d++)
        shade[col] = shade[col - d] ?? shade[col + d] ?? null;
  const ink: Lab[] = [];
  const marks = cells.map((c, i) => {
    const s = shade[i % w];
    const on = c && s && deltaE(c, s) > 6;
    if (on) ink.push(c);
    return Boolean(on);
  });
  if (ink.length < w * h * 0.03) return null;
  const { clusters, labels } = clusterColours(ink, 4);
  let k = 0;
  const data = marks.map((on) => (on ? '0123'[labels[k++]!]! : '.')).join('');
  return {
    kind: 'decal',
    face: 'around',
    u0: 0.25,
    u1: 0.75,
    v0: 0,
    v1: 1,
    turns: 0,
    w,
    h,
    colors: clusters.map((c) => c.hex),
    data,
  };
}

/**
 * Measure a box seen from the front: its width is the crop's, its depth
 * comes from the archetype and its height from what is left of the
 * silhouette once the top face is accounted for. The top face's colours
 * become a decal (a book's cover).
 */
/** Whatever on the top face differs from its main colour, as a top decal: print, buttons. */
function topDecal(photo: Photo, topPx: number, topGroup: number): Decal | null {
  const dw = 32;
  const dh = 24;
  const used = new Map<number, string>();
  let data = '';
  let marked = 0;
  for (let row = 0; row < dh; row++)
    for (let col = 0; col < dw; col++) {
      const x = Math.floor(((col + 0.5) / dw) * photo.w);
      const y = Math.floor(((row + 0.5) / dh) * topPx);
      const g = photo.group[x + y * photo.w]!;
      let ch = '.';
      if (g >= 0 && g !== topGroup) {
        if (!used.has(g) && used.size < 16) used.set(g, '0123456789abcdef'[used.size]!);
        ch = used.get(g) ?? '.';
        if (ch !== '.') marked++;
      }
      data += ch;
    }
  if (topPx < 4 || marked < dw * dh * 0.03) return null;
  return {
    kind: 'decal',
    face: 'top',
    u0: 0,
    u1: 1,
    v0: 0,
    v1: 1,
    turns: 0,
    w: dw,
    h: dh,
    colors: [...used.keys()].map((g) => photo.groups[g]!.hex),
    data,
  };
}
function measureBox(
  photo: Photo,
  archetype: Archetype,
  hint: number | null,
  material: ItemMaterial | null,
): { fit: BoxFit; elevation: number } {
  const elevation = clamp(hint ?? 35, 8, 80);
  const sinE = Math.sin(elevation * DEG);
  const cosE = Math.cos(elevation * DEG);
  const base = defaultFit(archetype) as BoxFit;
  const w = 0.96;
  const ratio = base.d / base.w;
  let d = w * ratio;
  let h = (photo.h / photo.w - d * sinE) / cosE;
  if (h < 0.04) {
    h = 0.04;
    d = clamp((photo.h / photo.w - h * cosE) / sinE, 0.1, 1);
  }
  const topPx = Math.round(d * sinE * photo.w);
  const region = (y0: number, y1: number) => {
    const px: number[] = [];
    for (let y = Math.max(0, y0); y < Math.min(photo.h, y1); y++)
      for (let x = 0; x < photo.w; x++) if (photo.mask[x + y * photo.w]) px.push(x + y * photo.w);
    return px;
  };
  const topGroup = Math.max(0, dominant(photo, region(0, topPx)));
  const sideGroup = dominant(photo, region(topPx, photo.h));
  const color = (g: number) => photo.groups[g]?.hex ?? '#b3a796';
  const fit: BoxFit = {
    ...base,
    w,
    d,
    h,
    colors: { top: color(topGroup), side: color(sideGroup >= 0 ? sideGroup : topGroup) },
    material: material ?? base.material,
    bands: [],
    decal: null,
  };
  // The top face is a squashed rectangle: undo the squash into a decal.
  fit.decal = topDecal(photo, topPx, topGroup);
  return { fit, elevation };
}

/**
 * Measure a flat thing seen from above: its outline from the mask, cast
 * from the middle in twelve directions, the colour of its top and any print
 * on it. Its height can't be seen, so it is the known one or a typical one.
 */
function measureFlat(
  photo: Photo,
  hint: number | null,
  material: ItemMaterial | null,
  height: number | null,
): { fit: FlatFit; elevation: number } {
  // A reference photo of one thing is usually taken from above.
  const elevation = clamp(hint ?? 80, 8, 80);
  const base = defaultFit('device') as FlatFit;
  const h = clamp(height ?? base.h, 0.03, 6);
  const long = Math.max(photo.w, photo.h);
  const w = photo.w / long;
  // What shows below the top is the side, as tall as h looks from this angle.
  const d = clamp(
    (photo.h / long - h * Math.cos(elevation * DEG)) / Math.sin(elevation * DEG),
    0.05,
    1,
  );
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (let y = 0; y < photo.h; y++)
    for (let x = 0; x < photo.w; x++)
      if (photo.mask[x + y * photo.w]) {
        cx += x;
        cy += y;
        n++;
      }
  cx /= Math.max(1, n);
  cy /= Math.max(1, n);
  const outline: FlatFit['outline'] = [];
  for (let i = 0; i < 12; i++) {
    // Clockwise in the image from straight up: the back of the thing.
    const a = (i / 12) * 2 * Math.PI;
    const dx = Math.sin(a);
    const dy = -Math.cos(a);
    let far = 0;
    for (let t = 0; t < long * 1.5; t += 0.5) {
      const x = Math.round(cx + dx * t);
      const y = Math.round(cy + dy * t);
      if (x < 0 || y < 0 || x >= photo.w || y >= photo.h) break;
      if (photo.mask[x + y * photo.w]) far = t;
    }
    outline.push({
      x: clamp((cx + dx * far) / Math.max(1, photo.w - 1), 0, 1),
      y: clamp((cy + dy * far) / Math.max(1, photo.h - 1), 0, 1),
    });
  }
  const all: number[] = [];
  for (let p = 0; p < photo.w * photo.h; p++) if (photo.mask[p]) all.push(p);
  const topGroup = Math.max(0, dominant(photo, all));
  const color = (g: number) => photo.groups[g]?.hex ?? '#b3a796';
  return {
    fit: {
      ...base,
      outline,
      w,
      d,
      h,
      colors: { top: color(topGroup), side: color(topGroup) },
      decal: topDecal(photo, photo.h, topGroup),
      material: material ?? base.material,
    },
    elevation,
  };
}

/** The photo at most `side` pixels on its longer edge, for quick comparisons. */
function shrink(
  photo: Photo,
  side = 96,
): { w: number; h: number; mask: Uint8Array; lab: Float32Array; k: number } {
  const k = Math.min(1, side / Math.max(photo.w, photo.h));
  const w = Math.max(1, Math.round(photo.w * k));
  const h = Math.max(1, Math.round(photo.h * k));
  const mask = new Uint8Array(w * h);
  const lab = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let on = 0;
      let n = 0;
      const sum = [0, 0, 0];
      const xs0 = Math.floor(x / k);
      const xs1 = Math.max(xs0 + 1, Math.floor((x + 1) / k));
      const ys0 = Math.floor(y / k);
      const ys1 = Math.max(ys0 + 1, Math.floor((y + 1) / k));
      for (let yy = ys0; yy < Math.min(photo.h, ys1); yy++)
        for (let xx = xs0; xx < Math.min(photo.w, xs1); xx++) {
          n++;
          const p = xx + yy * photo.w;
          if (!photo.mask[p]) continue;
          on++;
          sum[0]! += photo.lab[p * 3]!;
          sum[1]! += photo.lab[p * 3 + 1]!;
          sum[2]! += photo.lab[p * 3 + 2]!;
        }
      const i = x + y * w;
      if (on * 2 >= n) {
        mask[i] = 1;
        lab[i * 3] = sum[0]! / on;
        lab[i * 3 + 1] = sum[1]! / on;
        lab[i * 3 + 2] = sum[2]! / on;
      }
    }
  return { w, h, mask, lab, k };
}

/**
 * Render a model from the photo's camera and compare: silhouette overlap,
 * and colour error where both cover. The render is aligned to the photo's
 * bottom left, since both are cropped to their own bounds. `grids` keeps the
 * voxelized shapes between calls: the camera angle moves without the shape.
 */
function scoreItem(
  item: IsoItem,
  target: { w: number; h: number; mask: Uint8Array; lab: Float32Array },
  ppu: number,
  elevation: number,
  grids?: Map<string, VoxelGrid>,
): FitScore {
  const flat = scoreFromAbove(item, target);
  if (flat) return flat;
  const resolution = scoringResolution(item);
  const key = grids && JSON.stringify([item.parts, resolution]);
  let grid = key === undefined ? undefined : grids!.get(key);
  if (!grid) {
    grid = voxelize(item.parts, { resolution });
    if (key !== undefined) grids!.set(key, grid);
  }
  const view = renderView(grid, { elevation, ppu });
  const W = Math.max(target.w, view.width);
  const H = Math.max(target.h, view.height);
  const dyT = H - target.h;
  const dyV = H - view.height;
  let inter = 0;
  let union = 0;
  let err = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const ty = y - dyT;
      const vy = y - dyV;
      const t = x < target.w && ty >= 0 ? target.mask[x + ty * target.w]! : 0;
      const v = x < view.width && vy >= 0 ? view.mask[x + vy * view.width]! : 0;
      if (t || v) union++;
      if (t && v) {
        inter++;
        const a = (x + ty * target.w) * 3;
        const b = (x + vy * view.width) * 3;
        err += deltaE(
          [target.lab[a]!, target.lab[a + 1]!, target.lab[a + 2]!],
          [view.lab[b]!, view.lab[b + 1]!, view.lab[b + 2]!],
        );
      }
    }
  return { iou: union ? inter / union : 0, deltaE: inter ? err / inter : 100 };
}

/**
 * A flat model (one extruded part) is fitted to a photo from above, which the
 * renderer's iso-corner camera can't take: from there it would be turned 45°.
 * So its outline is drawn flat over the crop instead, coloured by its top and
 * any decal on it, and compared pixel by pixel. Null for any other model.
 */
function scoreFromAbove(
  item: IsoItem,
  target: { w: number; h: number; mask: Uint8Array; lab: Float32Array },
): FitScore | null {
  const part = item.parts.length === 1 ? item.parts[0] : undefined;
  if (part?.shape !== 'extrude' || !part.outline) return null;
  const outline = part.outline;
  const top = part.paint?.find((p) => p.kind === 'top')?.color ?? part.color;
  const topLab = rgbLab(hexRgb(top));
  const decal = part.paint?.find((p): p is Decal => p.kind === 'decal' && p.face === 'top');
  const decalLab = decal?.colors.map((c) => rgbLab(hexRgb(c)));
  const inside = (u: number, v: number) => pointInPolygon(outline, u, v);
  let inter = 0;
  let union = 0;
  let err = 0;
  for (let y = 0; y < target.h; y++)
    for (let x = 0; x < target.w; x++) {
      const u = (x + 0.5) / target.w;
      const v = (y + 0.5) / target.h;
      const t = target.mask[x + y * target.w]!;
      const m = inside(u, v);
      if (t || m) union++;
      if (!t || !m) continue;
      inter++;
      let lab = topLab;
      if (decal && decalLab) {
        const ch = decal.data[Math.floor(v * decal.h) * decal.w + Math.floor(u * decal.w)];
        if (ch && ch !== '.') lab = decalLab[parseInt(ch, 16)] ?? topLab;
      }
      const i = (x + y * target.w) * 3;
      err += deltaE([target.lab[i]!, target.lab[i + 1]!, target.lab[i + 2]!], lab);
    }
  return { iou: union ? inter / union : 0, deltaE: inter ? err / inter : 100 };
}

/**
 * Enough voxels that the item's narrowest side still gets about a dozen: a
 * bottle's neck at 32 voxels along its height would be four across.
 */
function scoringResolution(item: IsoItem): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of item.parts) {
    const a = [p.at.x, p.at.y, p.at.z];
    const b = [p.at.x + p.size.w, p.at.y + p.size.d, p.at.z + p.size.h];
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, a[k]!);
      hi[k] = Math.max(hi[k]!, b[k]!);
    }
  }
  const spans = [0, 1, 2].map((k) => hi[k]! - lo[k]!);
  return Math.round(clamp((12 * Math.max(...spans)) / Math.max(1e-3, Math.min(...spans)), 32, 64));
}

type Knob = (fit: ArchetypeFit, step: number) => ArchetypeFit | null;
const latheKnobs: Knob[] = [
  (f, s) => (f.family === 'lathe' ? { ...f, height: f.height * (1 + s) } : null),
  (f, s) => (f.family === 'lathe' ? { ...f, radius: f.radius * (1 + s) } : null),
  (f, s) =>
    f.family === 'lathe'
      ? {
          ...f,
          profile: f.profile.map((p) => (p.z < 0.5 ? { ...p, r: clamp(p.r * (1 + s), 0, 1) } : p)),
        }
      : null,
  (f, s) =>
    f.family === 'lathe'
      ? {
          ...f,
          profile: f.profile.map((p) => (p.z >= 0.5 ? { ...p, r: clamp(p.r * (1 + s), 0, 1) } : p)),
        }
      : null,
  (f, s) =>
    f.family === 'lathe' && f.handle
      ? { ...f, handle: { ...f.handle, reach: f.handle.reach * (1 + s) } }
      : null,
  (f, s) =>
    f.family === 'lathe' && f.handle
      ? { ...f, handle: { ...f.handle, top: clamp(f.handle.top + s * 0.5, 0.15, 1) } }
      : null,
  (f, s) =>
    f.family === 'lathe' && f.handle
      ? { ...f, handle: { ...f.handle, bottom: clamp(f.handle.bottom + s * 0.5, 0, 0.85) } }
      : null,
];
const boxKnobs: Knob[] = [
  (f, s) => (f.family === 'box' ? { ...f, h: clamp(f.h * (1 + s), 0.03, 6) } : null),
  (f, s) => (f.family === 'box' ? { ...f, d: clamp(f.d * (1 + s), 0.05, 1) } : null),
];

/**
 * Nudge the measured numbers, one at a time, keeping a change only when the
 * render matches the mask better. Coordinate descent with halving steps;
 * deterministic and bounded by `budget` renders.
 */
function refineFit(
  label: string,
  start: ArchetypeFit,
  elevation: number,
  target: { w: number; h: number; mask: Uint8Array; lab: Float32Array },
  ppu: number,
  budget = 48,
): { fit: ArchetypeFit; elevation: number; score: FitScore; renders: number } {
  const cost = (s: FitScore) => 1 - s.iou + s.deltaE * 0.001;
  let best = start;
  let bestE = elevation;
  const grids = new Map<string, VoxelGrid>();
  let bestScore = scoreItem(buildItem(label, best), target, ppu, bestE, grids);
  let renders = 1;
  // A flat thing's outline is read straight off the mask; only the camera angle is refined.
  const knobs = start.family === 'lathe' ? latheKnobs : start.family === 'box' ? boxKnobs : [];
  let step = 0.12;
  while (renders < budget && step > 0.01) {
    let improved = false;
    for (let k = -1; k < knobs.length && renders < budget; k++) {
      for (const sign of [1, -1]) {
        if (renders >= budget) break;
        // Knob -1 is the camera's elevation.
        const fit = k < 0 ? best : knobs[k]!(best, sign * step);
        // The measured angle is trusted to within 15°: a silhouette alone can
        // trade camera angle against height, so it must not wander far.
        const e =
          k < 0
            ? clamp(
                bestE + sign * step * 40,
                Math.max(8, elevation - 15),
                Math.min(80, elevation + 15),
              )
            : bestE;
        if (!fit) continue;
        const score = scoreItem(buildItem(label, fit), target, ppu, e, grids);
        renders++;
        if (cost(score) < cost(bestScore) - 1e-4) {
          best = fit;
          bestE = e;
          bestScore = score;
          improved = true;
          break;
        }
      }
    }
    if (!improved) step /= 2;
  }
  return { fit: best, elevation: bestE, score: bestScore, renders };
}

/** Fit a model to a masked crop. */
/**
 * What a fitted turned body should reach, shared by the fit bench and the
 * tests: silhouette overlap at least `iou`, colour error at most `deltaE`.
 */
export const FIT_TARGETS = { iou: 0.9, deltaE: 8 } as const;
/**
 * What a turned body's shape should reach against the real thing, when its
 * size is known: height over rim within `aspect` (a share) of the real
 * one's, and views of one thing agreeing within `spread` of each other.
 * A silhouette can match its own crop and still be the wrong shape.
 */
export const SHAPE_TARGETS = { aspect: 0.15, spread: 0.2 } as const;

/** A turned body's radius at a share of its height, from its profile. */
function profileRadius(fit: LatheFit, z: number): number {
  const p = fit.profile;
  for (let i = 1; i < p.length; i++)
    if (p[i]!.z >= z) {
      const a = p[i - 1]!;
      const b = p[i]!;
      return fit.radius * (a.r + ((b.r - a.r) * (z - a.z)) / (b.z - a.z || 1));
    }
  return fit.radius * (p.at(-1)?.r ?? 1);
}
/** Height over the body's width at its base, middle and rim (5, 50 and 95% up). */
export function latheProportions(fit: LatheFit) {
  const at = (z: number) => fit.height / (2 * profileRadius(fit, z));
  return { base: at(0.05), middle: at(0.5), rim: at(0.95) };
}
export function fitItem(input: FitInput): FitOutput {
  const photo = preparePhoto(input);
  const archetype = input.archetype ?? 'generic';
  let family = ARCHETYPE_FAMILY[archetype];
  let measured: { fit: ArchetypeFit; elevation: number } =
    archetype === 'plant'
      ? measurePlant(photo, input.elevation ?? null, input.material ?? null)
      : family === 'cat'
        ? {
            fit: {
              family: 'cat',
              pose: photo.h / Math.max(1, photo.w) < 0.72 ? 'sleeping' : 'idle',
              colors: {
                body: photo.groups[0]?.hex ?? '#d88b4b',
                accent: photo.groups[1]?.hex ?? '#f2e6d8',
              },
              material: input.material ?? 'fabric',
            },
            elevation: clamp(input.elevation ?? 30, 8, 75),
          }
        : family === 'lathe'
          ? measureLathe(photo, archetype, input.elevation ?? null, input.material ?? null)
          : family === 'flat'
            ? measureFlat(
                photo,
                input.elevation ?? null,
                input.material ?? null,
                input.knownHeight ?? null,
              )
            : measureBox(photo, archetype, input.elevation ?? null, input.material ?? null);
  // A generic object that is far from symmetric is drawn as a box instead.
  if (archetype === 'generic' && measured.fit.family === 'lathe') {
    const rows = rowsOf(photo);
    const axisFit = measured.fit;
    let asym = 0;
    let n = 0;
    for (let y = rows.top; y <= rows.bottom; y++) {
      const a = rows.r[y]! - rows.l[y]!;
      if (a <= 0) continue;
      const mid = (rows.l[y]! + rows.r[y]!) / 2;
      asym += Math.abs(mid - photo.w / 2) / Math.max(1, a);
      n++;
    }
    if (n && asym / n > 0.12 && !axisFit.handle) {
      family = 'box';
      measured = measureBox(photo, 'box', input.elevation ?? null, input.material ?? null);
    }
  }
  const target = shrink(photo);
  const ppu = photo.w * target.k;
  const refined = refineFit(
    input.label,
    measured.fit,
    measured.elevation,
    target,
    ppu,
    input.budget ?? 48,
  );
  return {
    item: buildItem(input.label, refined.fit),
    params: refined.fit,
    archetype: family === ARCHETYPE_FAMILY[archetype] ? archetype : 'box',
    score: { iou: round3(refined.score.iou), deltaE: round3(refined.score.deltaE) },
    elevation: round3(refined.elevation),
    swatches: photo.groups.slice(0, 6).map((g) => ({ hex: g.hex, share: round3(g.share) })),
    renders: refined.renders,
  };
}
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Score an edited model against the crop it was fitted to. */
export function scoreAgainst(item: IsoItem, input: FitInput, elevation: number): FitScore {
  const photo = preparePhoto(input);
  const target = shrink(photo);
  const s = scoreItem(item, target, photo.w * target.k, elevation);
  return { iou: round3(s.iou), deltaE: round3(s.deltaE) };
}

/**
 * Combine a new sighting's fit with what earlier ones measured: the shape
 * is averaged, weighted by how many views each side carries; colours and
 * print come from the newer view, or the older one when the newer saw none.
 * `weight` counts the new view as more than one (a close photo of a thing
 * the room's camera saw from across the room) or less.
 */
export function fuseFits(
  prev: ArchetypeFit,
  views: number,
  next: ArchetypeFit,
  weight = 1,
): ArchetypeFit {
  const w = views / (views + weight);
  const mix = (a: number, b: number) => a * w + b * (1 - w);
  if (prev.family === 'box' && next.family === 'box')
    return {
      ...next,
      d: mix(prev.d, next.d),
      h: mix(prev.h, next.h),
      decal: next.decal ?? prev.decal,
    };
  if (prev.family !== 'lathe' || next.family !== 'lathe') return next;
  const at = (p: LatheFit['profile'], v: number) => {
    for (let i = 1; i < p.length; i++)
      if (v <= p[i]!.z) {
        const a = p[i - 1]!;
        const b = p[i]!;
        return a.r + ((b.r - a.r) * (v - a.z)) / Math.max(1e-6, b.z - a.z);
      }
    return p[p.length - 1]!.r;
  };
  const zs = [
    ...new Set([...prev.profile, ...next.profile].map((p) => Math.round(p.z * 100) / 100)),
  ]
    .sort((a, b) => a - b)
    .filter(
      (_, i, all) =>
        all.length <= 16 || i % Math.ceil(all.length / 15) === 0 || i === all.length - 1,
    );
  const handle =
    prev.handle && next.handle
      ? {
          top: mix(prev.handle.top, next.handle.top),
          bottom: mix(prev.handle.bottom, next.handle.bottom),
          reach: mix(prev.handle.reach, next.handle.reach),
          thickness: mix(prev.handle.thickness, next.handle.thickness),
        }
      : (next.handle ?? prev.handle);
  return {
    ...next,
    radius: mix(prev.radius, next.radius),
    height: mix(prev.height, next.height),
    profile: zs.map((z) => ({ r: mix(at(prev.profile, z), at(next.profile, z)), z })),
    handle,
    decal: next.decal ?? prev.decal,
  };
}

/**
 * A stand-in photo of a model: the camera's view of it, lit from the left the
 * way a desk lamp or window would, as RGBA with the mask in alpha. The fit
 * benchmark and tests use it where no real crop is at hand.
 */
export function syntheticCrop(
  item: IsoItem,
  {
    elevation = 30,
    ppu = 120,
    light = 0.25,
  }: { elevation?: number; ppu?: number; light?: number } = {},
): { rgba: Uint8Array; width: number; height: number } {
  const view = renderView(voxelize(item.parts, { resolution: 64 }), { elevation, ppu });
  const rgba = new Uint8Array(view.width * view.height * 4);
  for (let y = 0; y < view.height; y++)
    for (let x = 0; x < view.width; x++) {
      const p = x + y * view.width;
      if (!view.mask[p]) continue;
      // Brighter on the left, darker on the right, as one side faces the light.
      const k = 1 + light * (0.5 - x / view.width);
      const [r, g, b] = labRgb([view.lab[p * 3]! * k, view.lab[p * 3 + 1]!, view.lab[p * 3 + 2]!]);
      rgba.set(
        [r, g, b, 255].map((v) => Math.max(0, Math.min(255, Math.round(v)))),
        p * 4,
      );
    }
  return { rgba, width: view.width, height: view.height };
}
