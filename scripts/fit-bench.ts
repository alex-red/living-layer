/**
 * How closely fitted models match their photos. Runs the fitter on a fixed
 * set of crops and prints silhouette overlap (IoU) and colour error (OKLab
 * ΔE) per case, so a change to the fitter or kernel shows whether accuracy
 * moved. Exits non-zero when a synthetic or demo turned body misses
 * IoU ≥ 0.9 or ΔE ≤ 8. Real crops are reported against the same targets but
 * don't fail the run: the only ones so far are a mug that isn't rotationally
 * symmetric, a known gap for a model made of turned bodies. Lamps are a
 * known gap too, and so is the demo room's mug (see KNOWN_GAPS).
 *
 * Cases:
 * - synthetic: known models drawn from known camera angles, lit from one side;
 * - the demo: the demo room's mug in the close photo its draft is modelled
 *   from, and the fixture pictures (a mouse from above, a lamp), cut out by
 *   their outlines;
 * - real crops: any `testdata/items/<name>.png` (a masked RGBA crop) with a
 *   `<name>.json` of `{ "label", "archetype", "elevation"?, "object"?,
 *   "sizeCm"? }` beside it. With `sizeCm` (the real height and rim, in cm),
 *   `shape` is how far the fit's height over rim is from the real one's;
 *   crops sharing an `object` get a row of how far their views disagree
 *   (`spread`). Silhouettes can match each crop while the shapes disagree,
 *   so these say more about the model than IoU does (SHAPE_TARGETS). A
 *   `<name>.sam3d.json` beside a crop (from `scripts/experiments/sam3d.ts
 *   --lathe`) adds SAM 3D's shape of it, scored the same way.
 *
 *   bun run bench:fit
 *   bun run bench:fit --json out/fit-base.json, later --compare out/fit-base.json
 *
 * Targets are FIT_TARGETS; flags are in scripts/lib/bench.ts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  ARCHETYPE_FAMILY,
  FIT_TARGETS,
  SHAPE_TARGETS,
  fuseFits,
  latheProportions,
  buildItem,
  defaultFit,
  fitItem,
  syntheticCrop,
  type Archetype,
  type ArchetypeFit,
  type FitInput,
  type LatheFit,
} from '@livinglayer/domain';
import { maskedCrop } from '../apps/server/src/images.js';
import { demoReference, demoMugCloseUp } from '../apps/server/src/demo.js';
import { parseArgs } from './lib/args.js';
import { report, type Row } from './lib/bench.js';

const root = resolve(import.meta.dir, '..');
interface Case {
  name: string;
  input: FitInput;
  source: 'synthetic' | 'demo' | 'real';
  object?: string;
  sizeCm?: { h: number; rim: number; estimate?: boolean };
  /** SAM 3D's shape of the same crop, when the experiment wrote one (`<name>.sam3d.json`). */
  sam3d?: Pick<LatheFit, 'radius' | 'height' | 'profile' | 'handle'>;
}
const cases: Case[] = [];
const synthetic = (
  name: string,
  archetype: Archetype,
  colours: string[],
  elevation: number,
  change: (fit: ReturnType<typeof defaultFit>) => void = () => {},
) => {
  const fit = defaultFit(archetype, colours);
  change(fit);
  const crop = syntheticCrop(buildItem(name, fit), { elevation, ppu: 150 });
  cases.push({ name, source: 'synthetic', input: { ...crop, label: name, archetype } });
};
synthetic('cream mug 30°', 'mug', ['#ece5d0', '#5a3d2b'], 30);
synthetic('blue banded mug 45°', 'mug', ['#2f5d8c', '#3b2416'], 45, (f) => {
  (f as LatheFit).bands = [{ from: 0.55, to: 0.72, color: '#f2efe6' }];
});
synthetic('tall mug 20°', 'mug', ['#c94f3d'], 20, (f) => {
  (f as LatheFit).height = 1.2;
});
synthetic('tapered cup 35°', 'cup', ['#8a90a8'], 35);
synthetic('bottle 25°', 'bottle', ['#7fa08a', '#2f3b33'], 25);
synthetic('striped can 30°', 'can', ['#e8e2d0'], 30, (f) => {
  (f as LatheFit).material = 'matte';
  (f as LatheFit).bands = [
    { from: 0.2, to: 0.35, color: '#b0302a' },
    { from: 0.65, to: 0.8, color: '#b0302a' },
  ];
});
synthetic('plant pot 30°', 'plant', ['#c06a45', '#4d6a54'], 30);
synthetic('book 40°', 'book', ['#3c554a'], 40);
synthetic('box 30°', 'box', ['#8a90a8', '#b3a796'], 30);
synthetic('desk lamp 15°', 'lamp', ['#e8dcc0'], 15);

// The demo mug as the item draft models it: from a close photo of it, not the room camera.
const close = await demoMugCloseUp('centre');
const crop = await maskedCrop(close.png, close.detection);
cases.push({
  name: 'demo room mug, close up',
  source: 'demo',
  input: {
    rgba: crop.rgba,
    width: crop.width,
    height: crop.height,
    label: 'mug',
    archetype: 'mug',
  },
});

for (const [name, archetype, knownHeight] of [
  ['mouse', 'device', 4 / 11.5],
  ['lamp', 'lamp', 45 / 25],
] as const) {
  const { png, detection } = await demoReference(name);
  const cut = await maskedCrop(png, detection);
  cases.push({
    name: `illustrated ${name}`,
    source: 'demo',
    input: {
      rgba: cut.rgba,
      width: cut.width,
      height: cut.height,
      label: name,
      archetype,
      knownHeight,
    },
  });
}

const dir = join(root, 'testdata/items');
if (existsSync(dir))
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
    const meta = join(dir, file.replace(/\.png$/, '.json'));
    if (!existsSync(meta)) continue;
    const { label, archetype, elevation, object, sizeCm } = JSON.parse(
      readFileSync(meta, 'utf8'),
    ) as {
      label: string;
      archetype: Archetype;
      elevation?: number;
      /** Crops of one thing share it, so the bench can say whether its views agree. */
      object?: string;
      /** The real thing's height and rim, in cm; `estimate` when not measured. */
      sizeCm?: { h: number; rim: number; estimate?: boolean };
    };
    const { data, info } = await sharp(join(dir, file))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    cases.push({
      name: file.replace(/\.png$/, ''),
      source: 'real',
      ...(object ? { object } : {}),
      ...(sizeCm ? { sizeCm } : {}),
      ...(existsSync(join(dir, file.replace(/\.png$/, '.sam3d.json')))
        ? {
            sam3d: JSON.parse(
              readFileSync(join(dir, file.replace(/\.png$/, '.sam3d.json')), 'utf8'),
            ),
          }
        : {}),
      input: {
        rgba: new Uint8Array(data),
        width: info.width,
        height: info.height,
        label,
        archetype,
        elevation: elevation ?? null,
      },
    });
  }

/**
 * Lamps miss the target even fitted to a lamp the fitter built itself: a
 * stem a tenth of the shade's width, under it, is lost between profile
 * samples and voxels. The demo room's mug misses on colour only: its close
 * photo is rendered with each face of the body shaded flat, in bands no
 * lathe lit by the kernel draws. Reported, but they don't fail the run.
 */
const KNOWN_GAPS = new Set(['desk lamp 15°', 'illustrated lamp', 'demo room mug, close up']);
const rows: Row[] = [];
/** Each thing's fits, per view, for the across-views rows; SAM 3D's shapes apart. */
const views = new Map<string, { rim: number; params: LatheFit }[]>();
const sam3dViews = new Map<string, number[]>();
const sizes = new Map<string, NonNullable<Case['sizeCm']>>();
for (const c of cases) {
  const start = performance.now();
  const out = fitItem(c.input);
  const ms = Math.round(performance.now() - start);
  // Only turned bodies are held to the targets; the rest are shown as they are.
  const lathe = ARCHETYPE_FAMILY[c.input.archetype ?? 'generic'] === 'lathe';
  const iou = out.score.iou.toFixed(3);
  const deltaE = out.score.deltaE.toFixed(2);
  const rim = out.params.family === 'lathe' ? latheProportions(out.params).rim : null;
  if (rim !== null && c.object && out.params.family === 'lathe') {
    views.set(c.object, [...(views.get(c.object) ?? []), { rim, params: out.params }]);
    if (c.sizeCm) sizes.set(c.object, c.sizeCm);
  }
  rows.push({
    case: c.name,
    variant: 'as built',
    knownGap: c.source === 'real' || KNOWN_GAPS.has(c.name),
    metrics: lathe
      ? {
          IoU: { value: out.score.iou, target: FIT_TARGETS.iou, better: 'higher', digits: 3 },
          ΔE: { value: out.score.deltaE, target: FIT_TARGETS.deltaE, better: 'lower' },
          // A silhouette can match its crop and be the wrong shape: against the real one.
          ...(rim !== null && c.sizeCm
            ? {
                shape: {
                  value: Math.abs(rim / (c.sizeCm.h / c.sizeCm.rim) - 1),
                  target: SHAPE_TARGETS.aspect,
                  better: 'lower' as const,
                  unit: '%' as const,
                  digits: 0,
                },
              }
            : {}),
        }
      : {},
    notes: {
      source: c.source,
      model: out.archetype,
      ...(lathe ? {} : { 'IoU*': iou, 'ΔE*': deltaE }),
      camera: `${Math.round(out.elevation)}°`,
      ms: String(ms),
    },
  });
  // SAM 3D's shape of the same crop, against the real one: a reconstruction, not a fit.
  if (c.sam3d && out.params.family === 'lathe') {
    const sam3dRim = latheProportions({ ...out.params, ...c.sam3d }).rim;
    if (c.object) sam3dViews.set(c.object, [...(sam3dViews.get(c.object) ?? []), sam3dRim]);
    rows.push({
      case: `${c.name}, SAM 3D`,
      variant: 'as built',
      knownGap: true,
      metrics: c.sizeCm
        ? {
            shape: {
              value: Math.abs(sam3dRim / (c.sizeCm.h / c.sizeCm.rim) - 1),
              target: SHAPE_TARGETS.aspect,
              better: 'lower',
              unit: '%',
              digits: 0,
            },
          }
        : {},
      notes: { source: 'real', model: 'sam 3d' },
    });
  }
}
// One thing seen from several sides should come out one shape, and its views
// fused (as a fixture's photos are) should come out closer than most alone.
for (const [object, seen] of views) {
  if (seen.length < 2) continue;
  const rims = seen.map((v) => v.rim);
  let fused: ArchetypeFit = seen[0]!.params;
  for (const [i, v] of seen.slice(1).entries()) fused = fuseFits(fused, i + 1, v.params);
  const size = sizes.get(object);
  const fusedRim = fused.family === 'lathe' ? latheProportions(fused).rim : NaN;
  rows.push({
    case: `${object}, across ${seen.length} views`,
    variant: 'as built',
    knownGap: true,
    metrics: {
      spread: {
        value: Math.max(...rims) - Math.min(...rims),
        target: SHAPE_TARGETS.spread,
        better: 'lower',
      },
      ...(size
        ? {
            'fused shape': {
              value: Math.abs(fusedRim / (size.h / size.rim) - 1),
              target: SHAPE_TARGETS.aspect,
              better: 'lower' as const,
              unit: '%' as const,
              digits: 0,
            },
          }
        : {}),
    },
    notes: { source: 'real', 'height/rim': rims.map((r) => r.toFixed(2)).join(' ') },
  });
}
for (const [object, rims] of sam3dViews)
  if (rims.length > 1)
    rows.push({
      case: `${object}, SAM 3D across ${rims.length} views`,
      variant: 'as built',
      knownGap: true,
      metrics: {
        spread: {
          value: Math.max(...rims) - Math.min(...rims),
          target: SHAPE_TARGETS.spread,
          better: 'lower',
        },
      },
      notes: { source: 'real', 'height/rim': rims.map((r) => r.toFixed(2)).join(' ') },
    });
const code = report(rows, parseArgs(), 'fit');
console.log('* shown, not held to a target: only turned bodies are.');
if (!cases.some((c) => c.source === 'real'))
  console.log(
    '\nNo real crops in testdata/items yet: add <name>.png and <name>.json to measure them.',
  );
process.exit(code);
