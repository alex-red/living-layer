/**
 * Marking where things really touch down in a captured room's frame
 * (`truth.json`, see scripts/lib/truth.ts), which `bun run bench:rooms`
 * scores layouts against. Read a point's pixels off a gridded zoom of the
 * frame, add it under the thing's id, then look at the marks over the layout.
 *
 *   bun run truth office-e                   the marks, each one's error now → out/truth-office-e.png
 *   bun run truth office-e things            the room's things: the ids to mark
 *   bun run truth office-e zoom 540,260,200,160 [--scale 3]
 *                                            that part of the frame, gridded every 10 px → out/truth-office-e-zoom.png
 *   bun run truth office-e add mug 359,455 [--corner x1y0] [--top] [--note "base"]
 *                                            mark it (again: replaces the same thing's same corner)
 *   bun run truth office-e remove mug [--corner x1y0] [--top]
 *
 * A point is a thing's base (the middle of where it stands, at the height it
 * stands on) or one corner of its box. Mark only what the frame shows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { flag, has, parseArgs } from './lib/args.js';
import { layoutOverlay } from './lib/overlay.js';
import { capturedRooms, layOut, roomFrame } from './lib/rooms.js';
import {
  errorLine,
  markName,
  placementError,
  truthIn,
  truthSvg,
  type TruthPoint,
} from './lib/truth.js';

const CORNERS = ['x0y0', 'x1y0', 'x0y1', 'x1y1'] as const;
const args = parseArgs();
const [name, command = 'show', ...rest] = args.positional;
const rooms = capturedRooms();
const room = rooms.find((r) => r.name === name);
if (!room)
  throw new Error(
    `Name a captured room: ${rooms.map((r) => r.name).join(', ') || 'none yet (bun run draft capture)'}`,
  );
const frame = roomFrame(room);
if (!frame) throw new Error(`${room.name} has no frame to mark (a demo run).`);
const { width, height } = await sharp(frame).metadata();
const out = resolve(import.meta.dir, '..', 'out');
mkdirSync(out, { recursive: true });
const file = join(room.dir, 'truth.json');
const marks = truthIn(room.dir) ?? [];
const things = room.input.inventory.things;
const save = (points: TruthPoint[]) => writeFileSync(file, `${JSON.stringify(points, null, 1)}\n`);
const numbers = (text: string | undefined, count: number, what: string) => {
  const vs = (text ?? '').split(',').map(Number);
  if (vs.length !== count || vs.some((v) => !Number.isFinite(v)))
    throw new Error(`Expected ${what}, got "${text ?? ''}"`);
  return vs;
};
const corner = () => {
  const c = flag(args, 'corner');
  if (c && !(CORNERS as readonly string[]).includes(c))
    throw new Error(`--corner is one of ${CORNERS.join(', ')}`);
  return c as TruthPoint['corner'];
};
const same = (p: TruthPoint, thing: string, c: TruthPoint['corner'], top: boolean) =>
  p.thing === thing && p.corner === c && !!p.top === top;

if (command === 'things') {
  for (const t of things)
    console.log(`${t.id.padEnd(14)} ${t.as.padEnd(10)} on ${t.on.padEnd(10)} ${t.label}`);
} else if (command === 'zoom') {
  const [x, y, w, h] = numbers(rest[0], 4, 'x,y,w,h in the frame’s pixels');
  const scale = Number(flag(args, 'scale') ?? 3);
  const left = Math.max(0, Math.round(x!));
  const top = Math.max(0, Math.round(y!));
  const cw = Math.min(Math.round(w!), (width ?? 0) - left);
  const ch = Math.min(Math.round(h!), (height ?? 0) - top);
  const lines: string[] = [];
  // Every 10 px; every 50 px stronger and labelled with the frame's own coordinate.
  for (let gx = Math.ceil(left / 10) * 10; gx < left + cw; gx += 10) {
    const major = gx % 50 === 0;
    lines.push(
      `<line x1="${(gx - left) * scale}" y1="0" x2="${(gx - left) * scale}" y2="${ch * scale}" stroke="${major ? '#f33' : '#3f6'}" stroke-opacity="${major ? 0.8 : 0.35}"/>`,
      major
        ? `<text x="${(gx - left) * scale + 2}" y="12" font-size="12" fill="#f33">${gx}</text>`
        : '',
    );
  }
  for (let gy = Math.ceil(top / 10) * 10; gy < top + ch; gy += 10) {
    const major = gy % 50 === 0;
    lines.push(
      `<line x1="0" y1="${(gy - top) * scale}" x2="${cw * scale}" y2="${(gy - top) * scale}" stroke="${major ? '#f33' : '#3f6'}" stroke-opacity="${major ? 0.8 : 0.35}"/>`,
      major
        ? `<text x="2" y="${(gy - top) * scale - 2}" font-size="12" fill="#f33">${gy}</text>`
        : '',
    );
  }
  for (const m of marks)
    if (m.at.x >= left && m.at.x <= left + cw && m.at.y >= top && m.at.y <= top + ch)
      lines.push(
        `<circle cx="${(m.at.x - left) * scale}" cy="${(m.at.y - top) * scale}" r="5" fill="none" stroke="#ff0" stroke-width="2"/><text x="${(m.at.x - left) * scale + 7}" y="${(m.at.y - top) * scale - 7}" font-size="13" fill="#ff0">${markName(m)}</text>`,
      );
  const zoomed = resolve(out, `truth-${room.name}-zoom.png`);
  await sharp(frame)
    .extract({ left, top, width: cw, height: ch })
    .resize(cw * scale, ch * scale, { kernel: 'nearest' })
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${cw * scale}" height="${ch * scale}">${lines.join('')}</svg>`,
        ),
      },
    ])
    .png()
    .toFile(zoomed);
  console.log(
    `${zoomed}  ${cw} × ${ch} px from ${left},${top}, ${scale}× (lines every 10 px, labelled every 50)`,
  );
} else if (command === 'add') {
  const thing = rest[0];
  if (!thing || !things.some((t) => t.id === thing))
    throw new Error(`Mark one of ${room.name}'s things: ${things.map((t) => t.id).join(', ')}`);
  const [x, y] = numbers(rest[1], 2, 'x,y in the frame’s pixels');
  if (x! < 0 || y! < 0 || x! > (width ?? 0) || y! > (height ?? 0))
    throw new Error(`${x},${y} is outside the ${width} × ${height} frame`);
  const c = corner();
  const top = has(args, 'top');
  const note = flag(args, 'note');
  const point: TruthPoint = {
    thing,
    at: { x: x!, y: y! },
    ...(c ? { corner: c } : {}),
    ...(top ? { top } : {}),
    ...(note ? { note } : {}),
  };
  const replaced = marks.some((p) => same(p, thing, c, top));
  save([...marks.filter((p) => !same(p, thing, c, top)), point]);
  console.log(`${replaced ? 'Moved' : 'Marked'} ${markName(point)} at ${x},${y} in ${file}`);
} else if (command === 'remove') {
  const thing = rest[0] ?? '';
  const c = corner();
  const kept = marks.filter((p) => !same(p, thing, c, has(args, 'top')));
  if (kept.length === marks.length) throw new Error(`No mark for ${thing}${c ? ` ${c}` : ''}`);
  save(kept);
  console.log(`Removed ${thing}${c ? ` ${c}` : ''}`);
} else if (command === 'show') {
  if (!marks.length) {
    console.log(
      `${room.name} has no marks yet: \`bun run truth ${room.name} things\`, then \`zoom\` and \`add\`.`,
    );
    process.exit(0);
  }
  const { layout, calibration } = layOut(room);
  const errors = placementError(layout, calibration.camera, marks);
  for (const e of errors)
    console.log(
      `${markName(e).padEnd(22)} ${String(e.at.x).padStart(5)},${String(e.at.y).padEnd(5)} ${Number.isFinite(e.error) ? `${Math.round(e.error)} px` : 'not drawn'}${e.note ? `  (${e.note})` : ''}`,
    );
  console.log(`\nmedian ${Math.round(errorLine(errors).median)} px (bench:rooms wants 15 or less)`);
  const shown = resolve(out, `truth-${room.name}.png`);
  writeFileSync(
    shown,
    await sharp(await layoutOverlay(layout, calibration.camera, frame))
      .composite([{ input: truthSvg(errors, calibration.camera.frame) }])
      .png()
      .toBuffer(),
  );
  console.log(`${shown}  marked (green) and drawn (red), over this tree's layout`);
} else throw new Error(`Unknown command "${command}": show, things, zoom, add or remove`);
