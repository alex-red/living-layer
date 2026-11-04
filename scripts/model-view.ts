/**
 * Look at Things' models: any number of them side by side, drawn as the app
 * draws them, beside a reference picture if asked. Sources are those of
 * `scripts/lib/models.ts` (a fixture, a draft, a save, a run, a starter, a
 * stock model, a JSON or TS file).
 *
 *   bun run model fixture:"My desk mug" starter:tim-hortons-mug --against mug
 *   bun run model stock:mug --preset editor --turns all
 *   bun run model fixture:mug --finish pixel --px 4 --zoom 8
 *   bun run model starter:mug --uv          a test print facing the viewer, to check which way paint runs
 *   bun run model fixture:mug --layers      each part alone, and each decal laid flat
 *   bun run model fixture:"cat tower" --states --room   every state, and each as the room draws it
 *   bun run model fixture:"cat tower"@sleeping --focus cat-head,cat-loaf   cropped round those parts
 *   bun run model .data/models/tower.ts --against photo.png --watch   drawn again on every save
 *
 * --preset room|thumb|card|brush|review|editor (default editor), or --scale and
 * --res; --px iso pixels per sprite pixel (1, as the app); --finish clean|pixel
 * (clean, as the app draws things); --shadow; --mode live|demo; --out <name>.
 * --states: a fixture's every state beside it (or name one: fixture:<label>@<state>).
 * --room: a second row as the room draws each at fit, at the fixture's own width
 * (`roomSpriteLook`: a model of more than 12 parts is drawn twice as fine).
 * --focus <part ids>|x0,y0,x1,y1: crop round those parts, or to shares of the picture.
 * --against <reference|png>: a picture beside it. --watch: draw again when a source's folder changes.
 * Writes out/model/<name>.png.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import {
  ITEM_SPRITES,
  printDecal,
  printKey,
  rotateItem,
  type Decal,
  type IsoItem,
  type ItemSpritePreset,
  type Mode,
  type Print,
} from '@livinglayer/domain';
import { inkPrints } from '../apps/server/src/print-ink.js';
import { flag, has, parseArgs } from './lib/args.js';
import { besideReference, parseShare, pictureGrid } from './lib/image.js';
import { expandStates, loadModel, spritePng, type SpriteLook } from './lib/models.js';

const args = parseArgs(undefined, {
  booleans: ['states', 'room', 'watch', 'uv', 'layers', 'shadow'],
});
if (!args.positional.length) {
  console.log(
    'usage: bun run model <source>… [--preset editor] [--against <reference>] [--uv] [--layers] [--turns all]',
  );
  process.exit(1);
}
const presetName = (flag(args, 'preset') ?? 'editor') as ItemSpritePreset;
const preset = ITEM_SPRITES[presetName] as { scale?: number; resolution: number };
if (!preset) throw new Error(`No preset "${presetName}": ${Object.keys(ITEM_SPRITES).join(', ')}`);
const scale = Number(flag(args, 'scale') ?? preset.scale ?? 3);
const finish = (flag(args, 'finish') ?? 'clean') as 'clean' | 'pixel';
const mode = (flag(args, 'mode') ?? 'live') as Mode;
const turnsFlag = flag(args, 'turns');
const turns = turnsFlag === 'all' ? [0, 1, 2, 3] : [Number(turnsFlag ?? 0)];
/** How tall a cell is drawn, scaled by whole pixels so they stay square. */
const CELL = Number(flag(args, 'cell') ?? 360);

const look: SpriteLook = {
  preset: presetName,
  scale,
  // Unset, the preset's (the room's own for a detailed model, `roomSpriteLook`).
  ...(flag(args, 'res') ? { resolution: Number(flag(args, 'res')) } : {}),
  ...(flag(args, 'px') ? { pixel: Number(flag(args, 'px')) } : {}),
  finish,
  shadow: has(args, 'shadow'),
  cell: CELL,
  ...(flag(args, 'zoom') ? { zoom: Number(flag(args, 'zoom')) } : {}),
};
const focusFlag = flag(args, 'focus');
if (focusFlag)
  look.focus = /^[\d.]+(,[\d.]+){3}$/.test(focusFlag)
    ? parseShare(focusFlag)
    : focusFlag.split(',').map((id) => id.trim());
const draw = (item: IsoItem) => spritePng(item, look);

/** Every part's outside painted with "AB↑" facing the viewer: it reads left to right, upright, on a part painted the right way. */
async function withTestPrint(item: IsoItem): Promise<IsoItem> {
  const print: Print = {
    text: 'AB↑',
    style: 'bold',
    color: '#d81b60',
    around: 45,
    at: 0.5,
    size: 0.4,
    underline: false,
  };
  const ink = (await inkPrints([print])).get(printKey(print))!;
  return {
    ...item,
    parts: item.parts.map((p) => {
      const decal = printDecal(p, print, ink);
      return decal ? { ...p, paint: [...(p.paint ?? []).slice(0, 5), decal] } : p;
    }),
  };
}

/** A decal as a flat picture, as it reads on its part, grey where it paints nothing. */
async function decalPng(d: Decal): Promise<Buffer> {
  const rgba = Buffer.alloc(d.w * d.h * 4);
  for (let i = 0; i < d.w * d.h; i++) {
    const ch = d.data[i]!;
    if (ch === '.') continue;
    const hex = d.colors['0123456789abcdef'.indexOf(ch)] ?? '#ff00ff';
    const n = parseInt(hex.slice(1), 16);
    rgba.set([n >> 16, (n >> 8) & 255, n & 255, 255], i * 4);
  }
  // Stored as u runs, to the viewer's left: flopped, it reads as it does on the part.
  return sharp(rgba, { raw: { width: d.w, height: d.h, channels: 4 } })
    .flop()
    .resize({ width: d.w * 4, kernel: 'nearest' })
    .flatten({ background: '#f4f4f4' })
    .png()
    .toBuffer();
}

const sources = has(args, 'states')
  ? args.positional.flatMap((s) => expandStates(s, { mode }))
  : args.positional;
const loaded = await Promise.all(sources.map((s) => loadModel(s, { mode })));
const rows: Buffer[][] = [];
const labels: string[] = [];
for (const turn of turns) {
  const row: Buffer[] = [];
  for (const { name, item } of loaded) {
    let shown = turn ? rotateItem(item, turn) : item;
    if (has(args, 'uv')) shown = await withTestPrint(shown);
    const s = await draw(shown);
    row.push(s.png);
    if (turn === turns[0]) {
      labels.push(name);
      console.log(`${name}: ${s.width} × ${s.height} sprite pixels`);
    }
  }
  rows.push(row);
}
if (has(args, 'room'))
  rows.push(
    await Promise.all(
      loaded.map(async ({ item, size }) => {
        const roomLook: SpriteLook = { ...look, preset: 'room', scale: size?.w ?? scale };
        delete roomLook.resolution;
        delete roomLook.pixel;
        return (await spritePng(item, roomLook)).png;
      }),
    ),
  );
let picture = await pictureGrid(rows, labels);
const against = flag(args, 'against');
if (against) picture = await besideReference(picture, against);
const name = flag(args, 'out') ?? loaded.map((l) => l.name).join('+');
const dir = resolve('out/model');
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `${name}.png`);
await sharp(picture).toFile(file);
console.log(`${file}`);

if (has(args, 'layers'))
  for (const { name: n, item } of loaded) {
    const parts = await Promise.all(
      item.parts.map(async (p) => (await draw({ ...item, parts: [p] })).png),
    );
    const decals = item.parts.flatMap((p) =>
      (p.paint ?? []).flatMap((l) => (l.kind === 'decal' ? [{ part: p.id, l }] : [])),
    );
    const layerRows = [parts];
    const layerLabels = item.parts.map((p) => `${p.id} (${p.shape})`);
    let out = await pictureGrid(layerRows, layerLabels);
    if (decals.length) {
      const flat = await pictureGrid(
        [await Promise.all(decals.map((d) => decalPng(d.l)))],
        decals.map((d) => `${d.part}: ${d.l.w}×${d.l.h}${d.l.print ? ` "${d.l.print.text}"` : ''}`),
      );
      out = await pictureGrid([[out], [flat]]);
    }
    const layersFile = resolve(dir, `${n}-layers.png`);
    await sharp(out).toFile(layersFile);
    console.log(layersFile);
  }

if (has(args, 'watch')) {
  const { watch } = await import('node:fs');
  const { dirname } = await import('node:path');
  const files = [...args.positional, flag(args, 'against') ?? ''].filter((f) =>
    /\.(ts|json|png)$/.test(f),
  );
  const again = process.argv.slice(1).filter((a) => a !== '--watch');
  let timer: ReturnType<typeof setTimeout> | null = null;
  const redraw = () => {
    timer = null;
    // A fresh process: a changed .ts model is imported again, not from the module cache.
    Bun.spawnSync(['bun', ...again], { stdout: 'inherit', stderr: 'inherit' });
  };
  for (const dir of new Set(files.map((f) => dirname(resolve(f)))))
    watch(dir, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(redraw, 150);
    });
  console.log(`watching ${files.join(', ') || 'nothing'} (ctrl-c to stop)`);
}
