/**
 * Scripted shots of the demo video (docs/demo-video.md): each drives the lab
 * in a fresh Chrome, paced by its voice over, and is cut with eased zooms,
 * speed ramps, burned-in captions, lower thirds and its voice. Needs the
 * running dev server and ffmpeg. Output goes to out/demo-video/ (ignored).
 *
 *   bun run shot list                    the shots, in film order
 *   bun run shot tour                    record and cut one → out/demo-video/tour/cut.mp4 (+ sheet.png)
 *   bun run shot tour zone               several; `all` for every one
 *   bun run shot tour --compose          cut again from the last take, without recording
 *   bun run shot zone --dry              rehearse: drive the lab, no recording
 *   bun run shot film                    join the cut shots → out/demo-video/film.mp4
 *
 * The voice: put `<n>.wav` (or .m4a, .mp3, .aiff) for line n of a shot in
 * `<voice dir>/<shot>/` (default out/demo-video/voice/, `--voice <dir>`) and
 * record again: the take waits for each line's real length and the cut mixes
 * it in. Until then each line gets an estimated length and the cut is silent,
 * with its captions.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { flag, has, parseArgs } from './lib/args.js';
import {
  cameraKeys,
  joinFilter,
  overlays,
  rampFilter,
  rampsOf,
  retime,
  zoomFilter,
  type Take,
} from './lib/demo-shot.js';
import { Director, LAB, audioSeconds, voiceFile, type Shot } from './lib/director.js';
import { SHOTS } from './shots/index.js';

const args = parseArgs();
const root = resolve(import.meta.dir, '..');
const outDir = resolve(root, 'out/demo-video');
const voiceDir = resolve(flag(args, 'voice') ?? join(outDir, 'voice'));
const OUT = { width: 1920, height: 1080 };
const FPS = 30;
const FADE = 0.35;
const rel = (p: string) => relative(root, p);

function ffmpeg(argv: string[], what: string) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], {
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  if (r.status !== 0)
    throw new Error(`${what}: ffmpeg ${r.status ?? r.signal}\n${String(r.stderr).slice(-2000)}`);
}

async function record(shot: Shot, dry: boolean): Promise<Take | null> {
  const dir = join(outDir, shot.name);
  mkdirSync(dir, { recursive: true });
  const d = new Director(shot, {
    view: { width: 1600, height: 900 },
    scale: 2,
    fps: FPS,
    voiceDir,
    dir,
    record: !dry,
  });
  try {
    await d.open();
    await shot.setup(d);
    await d.roll();
    await shot.run(d);
    const take = await d.cut();
    await d.close();
    if (dry) return null;
    await Bun.write(join(dir, 'take.json'), JSON.stringify(take, null, 2));
    return take;
  } catch (e) {
    await d.close(e);
    console.error(`  the page as it failed: ${rel(join(dir, 'failed.png'))} (+ failed.yaml)`);
    throw e;
  }
}

async function compose(shot: Shot, take: Take) {
  const dir = join(outDir, shot.name);
  const ramps = rampsOf(take.beats, take.length);
  const length = retime(take.length, ramps);
  const ass = join(dir, 'overlays.ass');
  await Bun.write(ass, overlays(take.beats, shot.lines, ramps, OUT));

  const video = [
    `[0:v]${zoomFilter(cameraKeys(take.beats, take.view), OUT, take.fps)}`,
    rampFilter(ramps, take.fps),
    `subtitles=${ass}`,
    `fade=t=in:st=0:d=0.3,fade=t=out:st=${Math.max(0, length - 0.4).toFixed(2)}:d=0.4[v]`,
  ]
    .filter(Boolean)
    .join(',');

  // Each voiced line where its caption is; silence under the rest, so every cut has sound to join.
  const inputs = ['-i', join(dir, 'take.mp4')];
  const voiced: { file: string; at: number }[] = [];
  for (const b of take.beats) {
    if (b.kind !== 'line') continue;
    const file = voiceFile(voiceDir, shot.name, b.i);
    if (!file) continue;
    if (Math.abs(audioSeconds(file) - b.dur) > 0.25)
      console.warn(`  line ${b.i + 1}'s voice is not the length the take waited for: record again`);
    voiced.push({ file, at: retime(b.t, ramps) });
  }
  for (const v of voiced) inputs.push('-i', v.file);
  inputs.push('-f', 'lavfi', '-t', length.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
  const silence = voiced.length + 1;
  const audio = voiced.length
    ? voiced
        .map((v, k) => `[${k + 1}:a]aresample=48000,adelay=${Math.round(v.at * 1000)}:all=1[a${k}]`)
        .join(';') +
      `;[${silence}:a]${voiced.map((_, k) => `[a${k}]`).join('')}amix=inputs=${voiced.length + 1}:normalize=0,atrim=0:${length.toFixed(3)}[a]`
    : `[${silence}:a]anull[a]`;

  const cut = join(dir, 'cut.mp4');
  ffmpeg(
    [
      ...inputs,
      '-filter_complex',
      `${video};${audio}`,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '16',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-t',
      length.toFixed(3),
      '-movflags',
      '+faststart',
      cut,
    ],
    `cutting ${shot.name}`,
  );
  // Nine frames across the cut, to look at without playing it.
  ffmpeg(
    [
      '-i',
      cut,
      '-vf',
      `fps=9/${length.toFixed(3)},scale=640:-1,tile=3x3:padding=6`,
      '-frames:v',
      '1',
      join(dir, 'sheet.png'),
    ],
    `sheet for ${shot.name}`,
  );
  console.log(
    `  → ${rel(cut)} (${length.toFixed(1)} s, ${voiced.length}/${shot.lines.length} lines voiced) · ${rel(join(dir, 'sheet.png'))}`,
  );
}

function film() {
  const cuts = SHOTS.map((s) => ({ s, file: join(outDir, s.name, 'cut.mp4') })).filter((c) =>
    existsSync(c.file),
  );
  if (!cuts.length) throw new Error('No shots cut yet: bun run shot all');
  const lengths = cuts.map((c) => audioSeconds(c.file));
  const out = join(outDir, 'film.mp4');
  ffmpeg(
    [
      ...cuts.flatMap((c) => ['-i', c.file]),
      '-filter_complex',
      `${joinFilter(lengths, FADE)};[a]loudnorm=I=-14:TP=-1.5:LRA=11[an]`,
      '-map',
      '[v]',
      '-map',
      '[an]',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '17',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-movflags',
      '+faststart',
      out,
    ],
    'joining the film',
  );
  const total = audioSeconds(out);
  console.log(`→ ${rel(out)}: ${cuts.map((c) => c.s.name).join(' · ')}, ${total.toFixed(1)} s`);
  const missing = SHOTS.filter((s) => !cuts.some((c) => c.s === s)).map((s) => s.name);
  if (missing.length) console.log(`  not cut yet: ${missing.join(', ')}`);
  if (total > 178) console.warn(`  over 2:58: judges may stop at 3:00`);
}

const names = args.positional;
if (!names.length || names[0] === 'list') {
  for (const s of SHOTS)
    console.log(`${s.at.padStart(5)}  ${s.name.padEnd(8)} ${s.about} (${s.lines.length} lines)`);
  console.log('\nbun run shot <name…|all> [--compose] [--dry] [--voice <dir>] · bun run shot film');
  process.exit(0);
}
if (names[0] === 'film') {
  film();
  process.exit(0);
}
const chosen = names[0] === 'all' ? SHOTS : names.map((n) => SHOTS.find((s) => s.name === n) ?? n);
const unknown = chosen.filter((s): s is string => typeof s === 'string');
if (unknown.length) throw new Error(`No shot ${unknown.join(', ')}: bun run shot list`);
if (!has(args, 'compose'))
  await fetch(LAB, { signal: AbortSignal.timeout(3000) }).catch(() => {
    throw new Error(`Nothing answers at ${LAB}: start the dev server (bun run dev).`);
  });

for (const shot of chosen as Shot[]) {
  console.log(`${shot.at} ${shot.name}: ${shot.about}`);
  const takeFile = join(outDir, shot.name, 'take.json');
  const take = has(args, 'compose')
    ? existsSync(takeFile)
      ? ((await Bun.file(takeFile).json()) as Take)
      : null
    : await record(shot, has(args, 'dry'));
  if (has(args, 'compose') && !take)
    throw new Error(`${shot.name} has no take yet: record it first`);
  if (take) await compose(shot, take);
  else console.log('  rehearsed: it runs through');
}
if (has(args, 'dry')) process.exit(0);
