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
 *   bun run shot plushies --cue          say cues aloud and wait for them (a hand in the room)
 *   bun run shot scene hook              cut one scene of the film → out/demo-video/scenes/hook.mp4
 *   bun run shot film                    cut every scene and join them → out/demo-video/film.mp4
 *
 * The film is scenes (`scripts/shots/scenes.ts`): each a run of shots' cuts,
 * clips filmed on the phone (under out/demo-video/phone/) and cards. A clip
 * not filmed yet, or a shot not cut yet, shows as a slate saying what to do,
 * so the film can be cut at any point.
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
  estimateSeconds,
  joinFilter,
  overlays,
  rampFilter,
  rampsOf,
  retime,
  zoomFilter,
  type Take,
} from './lib/demo-shot.js';
import { Director, LAB, audioSeconds, voiceFile, type Shot } from './lib/director.js';
import { clipFilter, clipSeconds, sceneBeats, timeline, type Scene } from './lib/scenes.js';
import { SCENES } from './shots/scenes.js';
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
    cues: has(args, 'cue'),
  });
  try {
    await d.open();
    await shot.setup(d);
    await d.roll();
    await shot.run(d);
    const take = await d.cut();
    await shot.after?.(d);
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

/** A black stretch of `seconds`, silent: under a card or a slate. */
function blank(file: string, seconds: number) {
  ffmpeg(
    [
      '-f',
      'lavfi',
      '-i',
      `color=c=0x0a0c12:s=${OUT.width}x${OUT.height}:r=${FPS}`,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-t',
      seconds.toFixed(3),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      file,
    ],
    'a blank stretch',
  );
}

/** A filmed clip trimmed, filled to the frame and sped up, with its sound or silence. */
function clipSegment(
  part: Extract<Scene['parts'][number], { clip: string }>,
  src: string,
  file: string,
) {
  const speed = part.speed ?? 1;
  const trim = [
    ...(part.from ? ['-ss', String(part.from)] : []),
    ...(part.to !== undefined ? ['-to', String(part.to)] : []),
  ];
  const audio = part.sound
    ? ['-filter:a', `${speed !== 1 ? `atempo=${speed},` : ''}aresample=48000`, '-ac', '2']
    : ['-an'];
  const hasAudio =
    part.sound &&
    String(
      spawnSync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'a',
        '-show_entries',
        'stream=index',
        '-of',
        'csv=p=0',
        src,
      ]).stdout,
    ).trim();
  ffmpeg(
    [
      ...trim,
      '-i',
      src,
      ...(hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']),
      '-map',
      '0:v',
      '-map',
      hasAudio ? '0:a' : '1:a',
      '-vf',
      clipFilter(OUT, FPS, speed),
      ...(hasAudio ? audio : []),
      '-shortest',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '16',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      file,
    ],
    `the clip ${part.clip}`,
  );
}

/** One scene: its parts cut one after another, its slates, lines, lower thirds and voice. */
async function renderScene(scene: Scene): Promise<string> {
  const dir = join(outDir, 'scenes', scene.name);
  mkdirSync(dir, { recursive: true });
  const parts: { file: string; length: number; missing: string | null }[] = [];
  scene.parts.forEach((part, k) => {
    const file = join(dir, `part-${k + 1}.mp4`);
    if ('shot' in part) {
      const cut = join(outDir, part.shot, 'cut.mp4');
      if (existsSync(cut))
        return parts.push({ file: cut, length: audioSeconds(cut), missing: null });
      blank(file, 5);
      return parts.push({ file, length: 5, missing: rel(cut) });
    }
    if ('clip' in part) {
      const src = resolve(outDir, part.clip);
      if (existsSync(src)) {
        clipSegment(part, src, file);
        return parts.push({ file, length: clipSeconds(part, audioSeconds(src)), missing: null });
      }
      blank(file, part.seconds);
      return parts.push({ file, length: part.seconds, missing: rel(src) });
    }
    blank(file, part.seconds);
    return parts.push({ file, length: part.seconds, missing: null });
  });
  // Each part's real length, as encoded, so the overlays land on it.
  for (const p of parts) p.length = audioSeconds(p.file);
  const lines = scene.lines ?? [];
  const voices = lines.map((_, i) => voiceFile(voiceDir, scene.name, i));
  const seconds = lines.map((l, i) =>
    voices[i] ? audioSeconds(voices[i]!) : estimateSeconds(l.text),
  );
  const ass = join(dir, 'overlays.ass');
  await Bun.write(
    ass,
    overlays(
      sceneBeats(scene, parts, seconds),
      lines.map((l) => l.text),
      [],
      OUT,
    ),
  );
  const { length } = timeline(parts.map((p) => p.length));
  const voiced = lines.flatMap((l, i) => (voices[i] ? [{ file: voices[i]!, at: l.at }] : []));
  const n = parts.length;
  const joined = `${parts.map((_, k) => `[${k}:v][${k}:a]`).join('')}concat=n=${n}:v=1:a=1[cv][ca]`;
  const video = `[cv]subtitles=${ass}[v]`;
  const audio = voiced.length
    ? voiced
        .map((v, k) => `[${n + k}:a]aresample=48000,adelay=${Math.round(v.at * 1000)}:all=1[a${k}]`)
        .join(';') +
      `;[ca]${voiced.map((_, k) => `[a${k}]`).join('')}amix=inputs=${voiced.length + 1}:normalize=0,atrim=0:${length.toFixed(3)}[a]`
    : '[ca]anull[a]';
  const out = join(outDir, 'scenes', `${scene.name}.mp4`);
  ffmpeg(
    [
      ...parts.flatMap((p) => ['-i', p.file]),
      ...voiced.flatMap((v) => ['-i', v.file]),
      '-filter_complex',
      `${joined};${video};${audio}`,
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
      '-movflags',
      '+faststart',
      out,
    ],
    `cutting the scene ${scene.name}`,
  );
  ffmpeg(
    [
      '-i',
      out,
      '-vf',
      `fps=9/${length.toFixed(3)},scale=640:-1,tile=3x3:padding=6`,
      '-frames:v',
      '1',
      join(dir, 'sheet.png'),
    ],
    `sheet for the scene ${scene.name}`,
  );
  const todo = parts.filter((p) => p.missing).map((p) => p.missing);
  console.log(
    `${scene.title.padEnd(30)} → ${rel(out)} (${length.toFixed(1)} s)${todo.length ? `, slates for ${todo.join(', ')}` : ''}`,
  );
  return out;
}

async function film() {
  const cuts: string[] = [];
  for (const scene of SCENES) cuts.push(await renderScene(scene));
  const lengths = cuts.map((c) => audioSeconds(c));
  const out = join(outDir, 'film.mp4');
  ffmpeg(
    [
      ...cuts.flatMap((c) => ['-i', c]),
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
  console.log(`→ ${rel(out)}: ${SCENES.length} scenes, ${total.toFixed(1)} s`);
  if (total > 178) console.warn(`  over 2:58: judges may stop at 3:00`);
}

const names = args.positional;
if (!names.length || names[0] === 'list') {
  for (const s of SHOTS)
    console.log(`${s.at.padStart(5)}  ${s.name.padEnd(8)} ${s.about} (${s.lines.length} lines)`);
  console.log('\nScenes, in film order:');
  for (const s of SCENES) console.log(`  ${s.name.padEnd(10)} ${s.title}`);
  console.log(
    '\nbun run shot <shot…|all> [--compose] [--dry] [--voice <dir>] · bun run shot scene <scene…> · bun run shot film',
  );
  process.exit(0);
}
if (names[0] === 'film') {
  await film();
  process.exit(0);
}
if (names[0] === 'scene') {
  const wanted = names.slice(1);
  const scenes = wanted.length ? wanted.map((n) => SCENES.find((s) => s.name === n) ?? n) : SCENES;
  const unknownScenes = scenes.filter((s): s is string => typeof s === 'string');
  if (unknownScenes.length)
    throw new Error(`No scene ${unknownScenes.join(', ')}: bun run shot list`);
  for (const scene of scenes as Scene[]) await renderScene(scene);
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
