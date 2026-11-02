/**
 * Experiment: can Meta's SAM 3D Objects turn a close crop of a thing into a
 * model we could use, in place of (or as a check on) the item fitter?
 *
 * SAM 3D isn't on Meta's own API (its list has Spark, Wonder, Image and SAM
 * 3.1 only). `--local` runs it on this Mac through `mlx-spatial-sam3d`
 * (`pip install mlx-spatial`, Python 3.13, and the 14 GB
 * `appautomaton/sam-3d-objects-mlx` weights), found by SAM3D_MLX_WEIGHTS and
 * SAM3D_MLX_BIN; otherwise it asks fal.ai's host (`fal-ai/sam-3/3d-objects`,
 * billed, FAL_KEY). Either way it sends the crop with its own alpha as the
 * mask, flattened onto white and scaled up: the test crops are about 100
 * pixels across.
 *
 * For each crop it saves the splat (.ply), the mesh (.glb) and the answer or
 * trace under `out/sam3d/<crop>/` (`<crop>-local/` for `--local`), and prints
 * the mesh's size and proportions beside the crop's own. `views.png` draws
 * the splat's centres from the front, the side and above, in their own
 * colours, to look at. Results are cached, so a rerun costs nothing
 * (`--fresh` asks again).
 *
 *   bun scripts/experiments/sam3d.ts --local              every mug in testdata/items
 *   bun scripts/experiments/sam3d.ts mug-front --scale 6
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { flag, has, parseArgs } from '../lib/args.js';

const ENDPOINT = 'https://fal.run/fal-ai/sam-3/3d-objects';
const ITEMS = resolve('testdata/items');

const args = parseArgs();
const scale = Number(flag(args, 'scale') ?? 4);
const names = args.positional.length
  ? args.positional
  : readdirSync(ITEMS)
      .filter((f) => f.startsWith('mug') && f.endsWith('.png'))
      .map((f) => f.slice(0, -4));

const key = process.env.FAL_KEY;
const local = has(args, 'local');
const glb = has(args, 'glb');

for (const name of names) {
  const dir = resolve('out/sam3d', local ? `${name}-local` : name);
  mkdirSync(dir, { recursive: true });
  const { image, mask, width, height } = await prepare(join(ITEMS, `${name}.png`));
  writeFileSync(join(dir, 'input.png'), image);
  writeFileSync(join(dir, 'mask.png'), mask);

  const cached = join(dir, local ? 'splat.ply' : 'answer.json');
  let answer: Sam3dAnswer | null = null;
  if (existsSync(cached) && !has(args, 'fresh')) {
    if (!local) answer = JSON.parse(readFileSync(cached, 'utf8'));
  } else if (local) {
    runLocal(dir, name);
  } else {
    if (!key) throw new Error('Set FAL_KEY (fal.ai) to ask SAM 3D; cached answers need none.');
    const started = Date.now();
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: dataUrl(image),
        mask_urls: [dataUrl(mask)],
        seed: 1,
      }),
    });
    if (!res.ok) throw new Error(`${name}: fal answered ${res.status}: ${await res.text()}`);
    answer = (await res.json()) as Sam3dAnswer;
    console.log(`${name}: answered in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    writeFileSync(cached, JSON.stringify(answer, null, 2));
    writeFileSync(join(dir, 'splat.ply'), await download(answer.gaussian_splat.url));
    if (answer.model_glb)
      writeFileSync(join(dir, 'model.glb'), await download(answer.model_glb.url));
  }

  const splat = readPly(readFileSync(join(dir, 'splat.ply')));
  const glbPath = join(dir, 'model.glb');
  const box = existsSync(glbPath) ? glbBounds(readFileSync(glbPath)) : null;
  await writeViews(splat, join(dir, 'views.png'));

  console.log(`\n${name}  (crop ${width}×${height}, sent ×${scale})`);
  console.log(`  splat: ${splat.count} gaussians`);
  const shape = proportions(splat);
  console.log(
    `  height / body width at base, middle, rim: ${shape.body.map((r) => r.toFixed(2)).join(', ')}` +
      `   widest (with a handle) / body: ${shape.reach.toFixed(2)}`,
  );
  if (box) {
    const [sx, sy, sz] = box.size;
    console.log(
      `  mesh box: ${sx.toFixed(3)} × ${sy.toFixed(3)} × ${sz.toFixed(3)} (x × y × z, its own units)`,
    );
    console.log(
      `  height / widest side: ${(sy / Math.max(sx, sz)).toFixed(2)}   crop height / width: ${(height / width).toFixed(2)}`,
    );
  }
  for (const m of answer?.metadata ?? [])
    console.log(
      `  pose: scale ${fmt(m.scale)}  rotation ${fmt(m.rotation)}  translation ${fmt(m.translation)}`,
    );
  console.log(`  look: ${join(dir, 'views.png')}`);
}

interface Sam3dFile {
  url: string;
}
interface Sam3dAnswer {
  gaussian_splat: Sam3dFile;
  model_glb?: Sam3dFile;
  metadata?: { scale?: number[]; rotation?: number[]; translation?: number[] }[];
}

/**
 * SAM 3D on this Mac: the splat and its trace into `dir`, about 8 minutes on
 * an M4 Pro. The mesh only with `--glb`: its FlexiCubes step estimated 44 GB
 * for a mug and stops at the tool's 6 GB guard.
 */
function runLocal(dir: string, name: string) {
  const weights = process.env.SAM3D_MLX_WEIGHTS;
  if (!weights) throw new Error('Set SAM3D_MLX_WEIGHTS to the sam-3d-objects-mlx folder.');
  const started = Date.now();
  const run = Bun.spawnSync(
    [
      process.env.SAM3D_MLX_BIN ?? 'mlx-spatial-sam3d',
      'reconstruct',
      weights,
      join(dir, 'input.png'),
      '--mask',
      join(dir, 'mask.png'),
      '--moge-root',
      join(weights, 'moge'),
      '--seed',
      '1',
      // It only writes under an `outputs` folder of where it runs.
      '--output',
      'outputs/splat.ply',
      ...(glb ? ['--glb-output', 'outputs/model.glb'] : []),
      '--trace-output',
      'outputs/trace.json',
    ],
    { cwd: dir, stdout: 'inherit', stderr: 'inherit' },
  );
  if (run.exitCode !== 0) throw new Error(`${name}: mlx-spatial-sam3d exited ${run.exitCode}`);
  for (const file of ['splat.ply', 'trace.json', ...(glb ? ['model.glb'] : [])])
    renameSync(join(dir, 'outputs', file), join(dir, file));
  console.log(`${name}: reconstructed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

/** The crop over white, scaled up, and its alpha as a black and white mask. */
async function prepare(path: string) {
  const src = sharp(path).ensureAlpha();
  const { width = 0, height = 0 } = await src.metadata();
  const size = { width: width * scale, height: height * scale, kernel: 'lanczos3' as const };
  const image = await sharp(path).flatten({ background: '#ffffff' }).resize(size).png().toBuffer();
  const mask = await sharp(path)
    .ensureAlpha()
    .extractChannel('alpha')
    .resize({ ...size, kernel: 'nearest' })
    .threshold(128)
    .png()
    .toBuffer();
  return { image, mask, width, height };
}

function dataUrl(png: Buffer) {
  return `data:image/png;base64,${png.toString('base64')}`;
}
function fmt(v?: number[]) {
  return v ? `[${v.map((x) => x.toFixed(3)).join(', ')}]` : '–';
}

async function download(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** A binary little-endian PLY's vertices: position and, for splats, base colour. */
function readPly(buf: Buffer) {
  const end = buf.indexOf('end_header\n') + 'end_header\n'.length;
  const header = buf.subarray(0, end).toString('latin1').split('\n');
  const count = Number(header.find((l) => l.startsWith('element vertex'))!.split(' ')[2]);
  const props = header.filter((l) => l.startsWith('property')).map((l) => l.split(' '));
  const sizes: Record<string, number> = { float: 4, uchar: 1, double: 8, int: 4, uint: 4 };
  const offsets = new Map<string, { at: number; type: string }>();
  let stride = 0;
  for (const [, type, prop] of props) {
    offsets.set(prop!, { at: stride, type: type! });
    stride += sizes[type!] ?? 4;
  }
  const read = (i: number, prop: string) => {
    const o = offsets.get(prop);
    if (!o) return 0;
    const at = end + i * stride + o.at;
    return o.type === 'uchar' ? buf[at]! / 255 : buf.readFloatLE(at);
  };
  // Splats keep colour as the 0th spherical harmonic; a plain PLY as 0–255.
  const SH = 0.28209479177387814;
  const colour = (i: number, c: number) =>
    offsets.has(`f_dc_${c}`)
      ? 0.5 + SH * read(i, `f_dc_${c}`)
      : read(i, ['red', 'green', 'blue'][c]!);
  const points = Array.from({ length: count }, (_, i) => ({
    p: [read(i, 'x'), read(i, 'y'), read(i, 'z')] as const,
    c: [0, 1, 2].map((c) => Math.max(0, Math.min(1, colour(i, c)))),
    o: offsets.has('opacity') ? 1 / (1 + Math.exp(-read(i, 'opacity'))) : 1,
  }));
  return { count, points };
}

/** A GLB's extent, from its position accessors' min and max. */
function glbBounds(buf: Buffer) {
  const jsonLength = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of gltf.meshes ?? [])
    for (const prim of mesh.primitives) {
      const acc = gltf.accessors[prim.attributes.POSITION];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, acc.min[k]);
        max[k] = Math.max(max[k]!, acc.max[k]);
      }
    }
  const size: [number, number, number] = [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!];
  return { min, max, size };
}

/**
 * The splat's shape with z up, in its own units (it fits a unit box, so no
 * size in cm): height over the body's width at 10, 50 and 90% of the height,
 * the body being the narrower of its x and y spreads (a handle widens the
 * other), and how far the widest spread reaches past the body's.
 */
function proportions(splat: ReturnType<typeof readPly>) {
  const pts = splat.points.filter((q) => q.o > 0.2);
  const spread = (vals: number[]) => {
    const s = vals.toSorted((a, b) => a - b);
    return s[Math.floor(0.99 * (s.length - 1))]! - s[Math.floor(0.01 * (s.length - 1))]!;
  };
  const height = spread(pts.map((q) => q.p[2]));
  const zs = pts.map((q) => q.p[2]).toSorted((a, b) => a - b);
  const base = zs[Math.floor(0.01 * (zs.length - 1))]!;
  const widths = (f: number) => {
    const slice = pts.filter((q) => Math.abs(q.p[2] - (base + f * height)) < height * 0.03);
    return [spread(slice.map((q) => q.p[0])), spread(slice.map((q) => q.p[1]))];
  };
  const body = [0.1, 0.5, 0.9].map((f) => height / Math.min(...widths(f)));
  const mid = widths(0.5);
  return { body, reach: Math.max(...mid) / Math.min(...mid) };
}

/** The splat's centres from the front (x,z), the side (y,z) and above (x,y); z is up. */
async function writeViews(splat: ReturnType<typeof readPly>, out: string) {
  const S = 320;
  const pts = splat.points.filter((q) => q.o > 0.2);
  // Hundreds of thousands of splats: too many to spread into Math.min.
  const lo = [0, 1, 2].map((k) => pts.reduce((m, q) => Math.min(m, q.p[k]!), Infinity));
  const hi = [0, 1, 2].map((k) => pts.reduce((m, q) => Math.max(m, q.p[k]!), -Infinity));
  const span = Math.max(...hi.map((h, k) => h - lo[k]!)) || 1;
  // [across, up, depth]: nearer is larger depth.
  const views: [number, number, number][] = [
    [0, 2, 1],
    [1, 2, 0],
    [0, 1, 2],
  ];
  const img = Buffer.alloc(S * 3 * S * 3, 255);
  for (const [vi, [a, b, depth]] of views.entries()) {
    const zbuf = new Float32Array(S * S).fill(-Infinity);
    for (const q of pts) {
      const u = Math.round(((q.p[a]! - lo[a]!) / span) * (S - 20) + 10);
      const v = Math.round(((hi[b]! - q.p[b]!) / span) * (S - 20) + 10);
      if (u < 0 || v < 0 || u >= S || v >= S) continue;
      const d = q.p[depth]!;
      if (d < zbuf[v * S + u]!) continue;
      zbuf[v * S + u] = d;
      const at = (v * S * 3 + vi * S + u) * 3;
      for (let c = 0; c < 3; c++) img[at + c] = Math.round(q.c[c]! * 255);
    }
  }
  await sharp(img, { raw: { width: S * 3, height: S, channels: 3 } })
    .png()
    .toFile(out);
}
