/**
 * SAM 3D Objects (experimental): a masked crop in, a Gaussian splat of the
 * whole thing out, as PLY bytes. On this machine through mlx-spatial (about
 * 9.5 minutes on an M4 Pro), or on fal.ai (`fal-ai/sam-3/3d-objects`,
 * billed by fal, not counted against Meta's daily limit). Meta's own API has
 * no 3D model. See docs/plans/sam3d-experiment.md.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { toDataUrl } from './images.js';
import type { Config, Fetcher } from './config.js';

const FAL_ENDPOINT = 'https://fal.run/fal-ai/sam-3/3d-objects';
/** Crops are small (a mug is ~100 px across); SAM 3D reads them better scaled up. */
const SCALE = 4;

/** The crop over white, scaled up, and its alpha as a black and white mask. */
async function sam3dInput(cropPng: Buffer) {
  const { width = 0, height = 0 } = await sharp(cropPng).metadata();
  const size = { width: width * SCALE, height: height * SCALE };
  const image = await sharp(cropPng)
    .flatten({ background: '#ffffff' })
    .resize({ ...size, kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const mask = await sharp(cropPng)
    .ensureAlpha()
    .extractChannel('alpha')
    .resize({ ...size, kernel: 'nearest' })
    .threshold(128)
    .png()
    .toBuffer();
  return { image, mask };
}

/** Reconstruct the crop's thing; rejects when SAM 3D isn't set up or fails. */
export async function reconstruct(
  sam3d: NonNullable<Config['sam3d']>,
  cropPng: Buffer,
  { signal, fetcher = fetch }: { signal?: AbortSignal; fetcher?: Fetcher } = {},
): Promise<Buffer> {
  const { image, mask } = await sam3dInput(cropPng);
  return sam3d.kind === 'local'
    ? reconstructLocally(sam3d, image, mask, signal)
    : reconstructOnFal(sam3d.key, image, mask, fetcher, signal);
}

async function reconstructLocally(
  { weights, bin }: { weights: string; bin: string },
  image: Buffer,
  mask: Buffer,
  signal?: AbortSignal,
): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'sam3d-'));
  try {
    writeFileSync(join(dir, 'input.png'), image);
    writeFileSync(join(dir, 'mask.png'), mask);
    // It only writes under an `outputs` folder of where it runs; MoGe is found beside the weights.
    const args = [
      'reconstruct',
      weights,
      'input.png',
      '--mask',
      'mask.png',
      '--moge-root',
      join(weights, 'moge'),
      '--seed',
      '1',
      '--output',
      'outputs/splat.ply',
    ];
    const tail: string[] = [];
    const code = await new Promise<number>((done, fail) => {
      const child = spawn(bin, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], signal });
      const keep = (b: Buffer) => tail.push(...b.toString().split('\n').filter(Boolean));
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.on('error', fail);
      child.on('close', (c) => done(c ?? 1));
    });
    if (code !== 0)
      throw new Error(
        `SAM 3D stopped (${code}): ${tail.findLast((l) => l.startsWith('reason=')) ?? tail.at(-1) ?? 'no output'}`,
      );
    return readFileSync(join(dir, 'outputs/splat.ply'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function reconstructOnFal(
  key: string,
  image: Buffer,
  mask: Buffer,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<Buffer> {
  const url = toDataUrl;
  const res = await fetcher(FAL_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: url(image), mask_urls: [url(mask)], seed: 1 }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`fal answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const answer = (await res.json()) as { gaussian_splat?: { url?: string } };
  if (!answer.gaussian_splat?.url) throw new Error('fal sent no splat.');
  const splat = await fetcher(answer.gaussian_splat.url, signal ? { signal } : {});
  if (!splat.ok) throw new Error(`fal's splat: ${splat.status}`);
  return Buffer.from(await splat.arrayBuffer());
}
