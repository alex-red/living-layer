/**
 * A contact sheet of every furniture template, drawn by the same kernel and
 * palette as the room, so a model can be looked at without the app: one row
 * per template, one column per quarter turn, at an integer zoom. Prints how
 * long each took to voxelize and light. A preset room can be drawn whole too.
 *
 *   bun run sheet                         all templates → out/prop-sheet.png
 *   bun run sheet --only chair,desk --zoom 6
 *   bun run sheet --turns 0               one turn each
 *   bun run sheet --room office           a whole preset → out/room-office.png
 *   bun run sheet --only chair --set chair.heightCm=90,104
 *                                         one sheet per variant, side by side
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import {
  ISO_PRESETS,
  TEMPLATE_IDS,
  depthOrder,
  placeTemplate,
  rotateGroup,
  withFurniture,
  type IsoProp,
  type IsoScene,
  type IsoSceneKind,
  type TemplateId,
} from '@livinglayer/domain';
import { flag, parseArgs, variants } from './lib/args.js';
import { drawProps, type Picture } from './lib/draw.js';

const args = parseArgs();
const zoom = Math.max(1, Math.round(Number(flag(args, 'zoom') ?? 3)));
const turns = flag(args, 'turns') === '0' ? [0] : [0, 1, 2, 3];
const only = flag(args, 'only')?.split(',') as TemplateId[] | undefined;
for (const id of only ?? []) if (!TEMPLATE_IDS.includes(id)) throw new Error(`No template "${id}"`);
const room = flag(args, 'room') as IsoSceneKind | undefined;
const outDir = resolve(import.meta.dir, '..', 'out');
mkdirSync(outDir, { recursive: true });

const label = (text: string, width: number) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="22"><text x="4" y="16" font-family="monospace" font-size="13" fill="#c9c3b5">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></svg>`,
  );
/** Pictures in a grid of rows, each row with a caption, on the room's floor colour. */
async function sheet(rows: { caption: string; cells: Picture[] }[], file: string) {
  const gap = 12;
  const cellW = Math.max(...rows.flatMap((r) => r.cells.map((c) => c.width))) * zoom;
  const heights = rows.map((r) => Math.max(...r.cells.map((c) => c.height)) * zoom + 22);
  const cols = Math.max(...rows.map((r) => r.cells.length));
  const width = cols * (cellW + gap) + gap;
  const height = heights.reduce((a, b) => a + b + gap, gap);
  const layers: OverlayOptions[] = [];
  let y = gap;
  for (const [i, row] of rows.entries()) {
    layers.push({ input: label(row.caption, width), left: gap, top: y });
    for (const [j, cell] of row.cells.entries()) {
      const input = await sharp(Buffer.from(cell.rgba.buffer), {
        raw: { width: cell.width, height: cell.height, channels: 4 },
      })
        .resize(cell.width * zoom, cell.height * zoom, { kernel: 'nearest' })
        .png()
        .toBuffer();
      layers.push({ input, left: gap + j * (cellW + gap), top: y + 22 });
    }
    y += heights[i]! + gap;
  }
  await sharp({ create: { width, height, channels: 4, background: '#0d0f16' } })
    .composite(layers)
    .png()
    .toFile(file);
  console.log(`→ ${file}`);
}

const runs = variants(args.flags.get('set'));
if (room) {
  if (!(room in ISO_PRESETS))
    throw new Error(`No preset "${room}" (${Object.keys(ISO_PRESETS).join(', ')})`);
  const rows = runs.map((v) =>
    withFurniture(v.overrides, () => {
      const scene: IsoScene = ISO_PRESETS[room];
      return { caption: `${room} · ${v.label}`, cells: [drawProps(depthOrder(scene.props))] };
    }),
  );
  await sheet(rows, join(outDir, `room-${room}.png`));
} else {
  const rows: { caption: string; cells: Picture[] }[] = [];
  console.log('template      variant                       parts  ms');
  for (const id of only ?? TEMPLATE_IDS)
    for (const v of runs)
      withFurniture(v.overrides, () => {
        const start = performance.now();
        let scene: IsoScene = {
          kind: 'custom',
          label: id,
          grid: { w: 16, d: 16 },
          ...placeTemplate(id, id, 4, 4, 0),
        };
        const cells: Picture[] = [];
        for (let t = 0; t < 4; t++) {
          if (turns.includes(t)) cells.push(drawProps(depthOrder(scene.props as IsoProp[])));
          scene = rotateGroup(scene, id);
        }
        const ms = Math.round(performance.now() - start);
        const parts = cells[0]?.parts ?? 0;
        console.log(`${id.padEnd(13)} ${v.label.padEnd(29)} ${String(parts).padEnd(6)} ${ms}`);
        rows.push({ caption: `${id} · ${v.label}`, cells });
      });
  await sheet(rows, join(outDir, only?.length === 1 ? `prop-${only[0]}.png` : 'prop-sheet.png'));
}
