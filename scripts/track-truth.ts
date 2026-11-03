/**
 * Marking where each followed thing really is on a recorded clip's keyframes
 * (`<clip>.tracks.json`, see scripts/lib/track-truth.ts), which
 * `bun run bench:track` scores the watcher's identities against. Read boxes
 * off a gridded keyframe, add them under each thing's id, and copy marks over
 * stretches where nothing moved.
 *
 *   bun run bench:track truth <clip>                     things, zones, and which keyframes lack marks
 *   bun run bench:track truth <clip> thing mug-a --label "White mug" --concept mug
 *   bun run bench:track truth <clip> zone desk x,y,w,h   a zone every thing is judged against
 *   bun run bench:track truth <clip> frame 120 [--zoom x,y,w,h] [--scale 4]
 *                                                        that keyframe, gridded every 10 px → out/track-<clip>-120.png
 *   bun run bench:track truth <clip> add 120 mug-a x,y,w,h   its box there (again: replaces it)
 *   bun run bench:track truth <clip> add 120 mug-a hidden    out of sight there
 *   bun run bench:track truth <clip> copy 120 130-300    keyframe 120's marks onto every 10th frame from 130 to 300
 *   bun run bench:track truth <clip> remove 120 [mug-a]
 *
 * Boxes are in the clip's own grey-frame pixels (320 wide). Keyframes are
 * every 10th frame (one a second) unless `--every` says otherwise. Mark only
 * what the frame shows: a thing behind a hand is `hidden`, not a guess.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import type { UnitBox } from '@livinglayer/domain';
import { flag, parseArgs } from './lib/args.js';
import { dataDir } from './lib/evidence.js';
import { keyFrames, loadClip, saveTruth, truthOf, type TrackTruth } from './lib/track-truth.js';

const args = parseArgs();
// `bench:track truth <clip> <command> …`
const [, name, command = 'show', ...rest] = args.positional;
const dir = join(dataDir(), 'clips');
const { base, info, frames } = loadClip(dir, name);
const truth: TrackTruth = truthOf(dir, base) ?? { things: [], keys: {} };
const every = Number(flag(args, 'every') ?? 10);
const out = resolve(import.meta.dir, '..', 'out');
mkdirSync(out, { recursive: true });

const pixels = (text: string | undefined, what: string) => {
  const vs = (text ?? '').split(',').map(Number);
  if (vs.length !== 4 || vs.some((v) => !Number.isFinite(v)))
    throw new Error(`Expected ${what} as x,y,w,h in the clip's pixels, got "${text ?? ''}"`);
  const [x, y, w, h] = vs as [number, number, number, number];
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > info.width || y + h > info.height)
    throw new Error(`${text} isn't inside the ${info.width} × ${info.height} frame`);
  return { x: x / info.width, y: y / info.height, width: w / info.width, height: h / info.height };
};
const frameIndex = (text: string | undefined) => {
  const k = Number(text);
  if (!Number.isInteger(k) || k < 0 || k >= frames.length)
    throw new Error(`Name a frame from 0 to ${frames.length - 1}, got "${text ?? ''}"`);
  return k;
};
const thingId = (text: string | undefined) => {
  if (!text || !truth.things.some((t) => t.id === text))
    throw new Error(
      `Name one of the clip's things (${truth.things.map((t) => t.id).join(', ') || 'none yet: add one with `thing`'})`,
    );
  return text;
};
const inPixels = (b: UnitBox) =>
  [b.x * info.width, b.y * info.height, b.width * info.width, b.height * info.height]
    .map(Math.round)
    .join(',');
const save = () => saveTruth(dir, base, truth);

if (command === 'show') {
  console.log(`${base}: ${frames.length} frames, ${info.width}×${info.height} at ${info.fps}/s`);
  if (!truth.things.length) {
    console.log('No things yet: `thing <id> --label "…" --concept mug`, then `frame` and `add`.');
    process.exit(0);
  }
  const keys = keyFrames(truth);
  for (const t of truth.things) {
    const marked = keys.filter((k) => truth.keys[k]![t.id] !== undefined);
    const hidden = marked.filter((k) => truth.keys[k]![t.id] === 'hidden').length;
    console.log(
      `  ${t.id.padEnd(14)} ${t.concept.padEnd(10)} ${t.label.padEnd(24)} ${marked.length} keyframes, ${hidden} hidden`,
    );
  }
  for (const z of truth.zones ?? []) console.log(`  zone ${z.id.padEnd(9)} ${inPixels(z.rect)}`);
  const lacking: number[] = [];
  for (let k = 0; k < frames.length; k += every)
    if (truth.things.some((t) => truth.keys[k]?.[t.id] === undefined)) lacking.push(k);
  console.log(
    lacking.length
      ? `Keyframes still lacking a thing's mark (every ${every}): ${lacking.slice(0, 30).join(', ')}${lacking.length > 30 ? ` … ${lacking.length} in all` : ''}`
      : `Every ${every}th frame is marked for every thing.`,
  );
} else if (command === 'thing') {
  const id = rest[0];
  if (!id || !/^[\w-]{1,24}$/.test(id)) throw new Error('Give the thing a short id: mug-a');
  const label = flag(args, 'label') ?? id;
  const concept = flag(args, 'concept') ?? id.replace(/-\w+$/, '');
  truth.things = [...truth.things.filter((t) => t.id !== id), { id, label, concept }];
  save();
  console.log(`${id}: "${label}", found by SAM as "${concept}"`);
} else if (command === 'zone') {
  const id = rest[0];
  if (!id) throw new Error('Name the zone');
  const rect = pixels(rest[1], 'the zone');
  truth.zones = [...(truth.zones ?? []).filter((z) => z.id !== id), { id, rect }];
  save();
  console.log(`zone ${id} at ${inPixels(rect)}`);
} else if (command === 'frame') {
  const k = frameIndex(rest[0]);
  const zoom = flag(args, 'zoom');
  const crop = zoom ? pixels(zoom, 'the zoom') : { x: 0, y: 0, width: 1, height: 1 };
  const left = Math.round(crop.x * info.width);
  const top = Math.round(crop.y * info.height);
  const cw = Math.round(crop.width * info.width);
  const ch = Math.round(crop.height * info.height);
  const scale = Number(flag(args, 'scale') ?? (zoom ? 8 : 4));
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
  for (const [id, mark] of Object.entries(truth.keys[k] ?? {})) {
    if (mark === 'hidden') continue;
    const x = (mark.x * info.width - left) * scale;
    const y = (mark.y * info.height - top) * scale;
    lines.push(
      `<rect x="${x}" y="${y}" width="${mark.width * info.width * scale}" height="${mark.height * info.height * scale}" fill="none" stroke="#ff0" stroke-width="2"/><text x="${x}" y="${y - 4}" font-size="13" fill="#ff0">${id}</text>`,
    );
  }
  const file = resolve(out, `track-${base}-${k}${zoom ? '-zoom' : ''}.png`);
  const frame = frames[k]!;
  await sharp(Buffer.from(frame.data), {
    raw: { width: frame.width, height: frame.height, channels: 1 },
  })
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
    .toFile(file);
  const marks = Object.entries(truth.keys[k] ?? {});
  console.log(`${file}  frame ${k}, ${cw} × ${ch} px from ${left},${top}, ${scale}×`);
  for (const [id, mark] of marks)
    console.log(`  ${id.padEnd(14)} ${mark === 'hidden' ? 'hidden' : inPixels(mark)}`);
} else if (command === 'add') {
  const k = frameIndex(rest[0]);
  const id = thingId(rest[1]);
  const mark = rest[2] === 'hidden' ? 'hidden' : pixels(rest[2], 'its box');
  const replaced = truth.keys[k]?.[id] !== undefined;
  truth.keys[k] = { ...truth.keys[k], [id]: mark };
  save();
  console.log(
    `${replaced ? 'Moved' : 'Marked'} ${id} on frame ${k}: ${mark === 'hidden' ? 'hidden' : inPixels(mark)}`,
  );
} else if (command === 'copy') {
  const from = frameIndex(rest[0]);
  const marks = truth.keys[from];
  if (!marks) throw new Error(`Frame ${from} has no marks to copy`);
  const [a, b = a] = (rest[1] ?? '').split('-').map(frameIndex);
  const onto: number[] = [];
  for (let k = a!; k <= b!; k += every) {
    truth.keys[k] = { ...truth.keys[k], ...marks };
    onto.push(k);
  }
  save();
  console.log(
    `Frame ${from}'s ${Object.keys(marks).length} marks copied onto ${onto.length} frames (${onto[0]}–${onto.at(-1)}). Check moving stretches with \`frame\`.`,
  );
} else if (command === 'remove') {
  const k = frameIndex(rest[0]);
  const id = rest[1];
  if (!truth.keys[k]) throw new Error(`Frame ${k} has no marks`);
  if (id) delete truth.keys[k][thingId(id)];
  else delete truth.keys[k];
  save();
  console.log(`Removed ${id ?? 'every mark'} from frame ${k}`);
} else
  throw new Error(`Unknown command "${command}": show, thing, zone, frame, add, copy or remove`);
