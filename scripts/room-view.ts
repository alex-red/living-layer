/**
 * A room as its corner camera sees it, beside the iso view's idea of the
 * same camera: the demo's frame, to judge without the app.
 *
 *   bun run room                      → out/room-office.png
 *   bun run room desk --hfov 90 --height 210
 *   bun run room --labels             also the per-pixel labels, one colour each
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import {
  ISO_PRESETS,
  cornerCamera,
  floorSolid,
  renderRoom,
  sceneSolids,
  type IsoSceneKind,
} from '@livinglayer/domain';
import { flag, has, parseArgs } from './lib/args.js';

const args = parseArgs();
const kind = (args.positional[0] ?? 'office') as IsoSceneKind;
const scene = ISO_PRESETS[kind];
if (!scene) throw new Error(`No preset ${kind}`);
const camera = cornerCamera(scene.grid, {
  frame: { width: 960, height: 640 },
  ...(flag(args, 'hfov') ? { hfovDeg: Number(flag(args, 'hfov')) } : {}),
  ...(flag(args, 'height') ? { heightCm: Number(flag(args, 'height')) } : {}),
});
const t0 = performance.now();
const picture = renderRoom(camera, [floorSolid(scene.grid), ...sceneSolids(scene)]);
console.log(`${kind}: ${(performance.now() - t0).toFixed(0)} ms, ${picture.names.join(', ')}`);
const out = resolve(import.meta.dir, '..', 'out');
mkdirSync(out, { recursive: true });
const raw = (rgba: Uint8ClampedArray) =>
  sharp(Buffer.from(rgba), { raw: { width: picture.width, height: picture.height, channels: 4 } });
await raw(picture.rgba)
  .png()
  .toFile(resolve(out, `room-${kind}.png`));
console.log(`→ out/room-${kind}.png`);
if (has(args, 'labels')) {
  const rgba = new Uint8ClampedArray(picture.width * picture.height * 4);
  for (let i = 0; i < picture.ids.length; i++) {
    const k = picture.ids[i]!;
    const h = k < 0 ? [0, 0, 0] : [(k * 97) % 255, (k * 57 + 80) % 255, (k * 151 + 40) % 255];
    rgba.set([...h, 255], i * 4);
  }
  await raw(rgba)
    .png()
    .toFile(resolve(out, `room-${kind}-labels.png`));
  console.log(`→ out/room-${kind}-labels.png`);
}
