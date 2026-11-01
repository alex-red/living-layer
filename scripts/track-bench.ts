/**
 * What following things costs, per thing, on frames the watcher really sees.
 *
 *   bun run bench:track capture            record 30 s of the watched camera to .data/clips/
 *   bun run bench:track capture --seconds 60 --name evening
 *   bun run bench:track                    the latest clip: cost per layer and per thing
 *   bun run bench:track <name> --things 1,5,17
 *
 * A clip is the watcher's own input: grey frames 320 px wide at 10 a second,
 * cut to the camera's zoomed view, read through the relay when it runs, plus
 * one full-size still for the layers that need one. Clips are photos of a
 * real home and stay local (`.data/clips/`, ignored). The things followed are
 * the live desk's watched things, then made-up ones on textured parts of the
 * frame up to each count. Nothing here calls a model but the local feature
 * model, and only when its weights are there.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOCAL_TRACK,
  appearanceRegion,
  around,
  asked,
  missed,
  frameMotion,
  matchTemplate,
  savedIdOf,
  searchRegion,
  startLocalTrack,
  watchStep,
  watchThing,
  type LumaFrame,
  type SavedCamera,
  type UnitBox,
  type WatchThing,
} from '@livinglayer/domain';
import { Appearance } from '../apps/server/src/appearance.js';
import { FfmpegSource, LUMA_FPS } from '../apps/server/src/frames.js';
import { watchedThings } from '../apps/server/src/watcher.js';
import { flag, parseArgs } from './lib/args.js';
import { dataDir, openEvidence } from './lib/evidence.js';

const args = parseArgs();
const clips = join(dataDir(), 'clips');
const ms = (n: number) => (n < 0.1 ? n.toFixed(3) : n < 10 ? n.toFixed(2) : n.toFixed(0));

interface ClipInfo {
  width: number;
  height: number;
  fps: number;
  frames: number;
  camera: string;
  takenAt: string;
}

/** The camera the live desk watches, read as the watcher reads it. */
function watchedSource() {
  const store = openEvidence();
  const memory = store.memory('live');
  store.close();
  const id = memory?.watch?.camera?.id && savedIdOf(memory.watch.camera.id);
  if (!id) throw new Error('The live desk watches no saved camera. Choose one in the lab first.');
  const db = new Database(join(dataDir(), 'livinglayer.sqlite'), { readonly: true });
  const row = db.query("SELECT value FROM settings WHERE key = 'cameras'").get() as {
    value: string;
  } | null;
  db.close();
  const camera = (JSON.parse(row?.value ?? '[]') as SavedCamera[]).find((c) => c.id === id);
  if (!camera) throw new Error('The watched camera is no longer saved.');
  // Through the relay when it runs, so the camera keeps one client.
  const relayed = existsSync(join(dataDir(), 'relay', 'mediamtx.pid'));
  const url = relayed ? `rtsp://127.0.0.1:43434/cam-${camera.id}` : camera.url;
  return { camera, source: new FfmpegSource(url, 'ffmpeg', camera.crop ?? null), relayed };
}

async function capture() {
  const seconds = Number(flag(args, 'seconds') ?? 30);
  const name = flag(args, 'name') ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const { camera, source, relayed } = watchedSource();
  console.log(`Recording ${seconds} s of ${camera.name}${relayed ? ' through the relay' : ''}…`);
  const frames: LumaFrame[] = [];
  const snapshotAt = performance.now();
  const still = await source.snapshot();
  const snapshotMs = performance.now() - snapshotAt;
  await new Promise<void>((done, fail) => {
    void source.start(
      (f) => {
        frames.push(f);
        if (frames.length >= seconds * LUMA_FPS) {
          source.stop();
          done();
        }
      },
      (error) => (frames.length ? done() : fail(error ?? new Error('The camera stopped.'))),
    );
  });
  mkdirSync(clips, { recursive: true });
  const first = frames[0]!;
  writeFileSync(join(clips, `${name}.luma`), Buffer.concat(frames.map((f) => f.data)));
  writeFileSync(join(clips, `${name}.png`), still.png);
  const info: ClipInfo = {
    width: first.width,
    height: first.height,
    fps: LUMA_FPS,
    frames: frames.length,
    camera: camera.name,
    takenAt: new Date().toISOString(),
  };
  writeFileSync(join(clips, `${name}.json`), JSON.stringify({ ...info, snapshotMs }, null, 2));
  console.log(
    `${frames.length} frames ${first.width}×${first.height} → .data/clips/${name}.luma; still ${still.width}×${still.height} took ${ms(snapshotMs)} ms`,
  );
}

function load(name?: string) {
  const all = existsSync(clips)
    ? readdirSync(clips)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];
  const file = name ? `${name}.json` : all.at(-1);
  if (!file || !existsSync(join(clips, file)))
    throw new Error('No clip. Record one with `bun run bench:track capture`.');
  const base = file.slice(0, -5);
  const info = JSON.parse(readFileSync(join(clips, file), 'utf8')) as ClipInfo & {
    snapshotMs?: number;
  };
  const raw = readFileSync(join(clips, `${base}.luma`));
  const size = info.width * info.height;
  const frames: LumaFrame[] = [];
  for (let k = 0; k + size <= raw.length; k += size)
    frames.push({
      width: info.width,
      height: info.height,
      data: new Uint8Array(raw.subarray(k, k + size)),
    });
  return { base, info, frames, still: readFileSync(join(clips, `${base}.png`)) };
}

/** The live desk's watched things as boxes, then textured made-up ones to make up `count`. */
function boxes(frame: LumaFrame, count: number): { label: string; box: UnitBox }[] {
  const store = openEvidence();
  const memory = store.memory('live');
  store.close();
  const real = memory
    ? watchedThings(memory).map((s) => {
        const { box, frame: f } = s.observation;
        return {
          label: s.label,
          box: {
            x: box.x / f.width,
            y: box.y / f.height,
            width: box.width / f.width,
            height: box.height / f.height,
          },
        };
      })
    : [];
  const out = real.slice(0, count);
  // A mug-sized box (about 5% of the frame's width) on a grid, kept where it has texture to follow.
  const side = 0.05;
  for (let gy = 0.1; gy < 0.85 && out.length < count; gy += 0.12)
    for (let gx = 0.08; gx < 0.88 && out.length < count; gx += 0.09) {
      const box = { x: gx, y: gy, width: side, height: side * (frame.width / frame.height) };
      if (startLocalTrack(frame, box, false)) out.push({ label: 'made up', box });
    }
  return out;
}

/** Mean time of `run` over the clip's frames, ms. */
function timeOver(frames: LumaFrame[], run: (frame: LumaFrame, k: number) => void) {
  const at = performance.now();
  frames.forEach(run);
  return (performance.now() - at) / frames.length;
}

async function bench() {
  const { base, info, frames, still } = load(args.positional[0]);
  const counts = (flag(args, 'things') ?? '1,5,10,17').split(',').map(Number);
  const first = frames[0]!;
  const moving =
    frames
      .slice(1)
      .filter(
        (f, k) =>
          frameMotion(frames[k]!, f, { x: 0, y: 0, width: 1, height: 1 }) > LOCAL_TRACK.motionShare,
      ).length / Math.max(1, frames.length - 1);
  console.log(
    `${base}: ${info.frames} frames of ${info.camera}, ${info.width}×${info.height} at ${info.fps}/s; ${Math.round(moving * 100)}% of frames show motion somewhere`,
  );

  // Per thing, each layer on its own, over every frame of the clip.
  const things = boxes(first, Math.max(...counts));
  console.log('\nPer thing, per frame (ms):');
  console.log(
    '  thing                         template  L0 motion  L1 match  L1 lost×2  L1 lost×4',
  );
  for (const t of things.slice(0, 6)) {
    const track = startLocalTrack(first, t.box, false)!;
    const l0 = timeOver(frames.slice(1), (f, k) => frameMotion(frames[k]!, f, around(t.box)));
    const l1 = (r: number) => timeOver(frames, (f) => matchTemplate(f, track.template, t.box, r));
    const radius = LOCAL_TRACK.searchRadius;
    console.log(
      `  ${t.label.slice(0, 28).padEnd(28)}  ${`${track.template.width}×${track.template.height}/${track.template.values.length}`.padStart(9)}  ${ms(l0).padStart(9)}  ${ms(l1(radius)).padStart(8)}  ${ms(l1(radius * 2)).padStart(9)}  ${ms(l1(radius * 4)).padStart(9)}`,
    );
  }

  // The watcher's own step, as it runs today, for each count of things.
  console.log('\nThe watcher’s step over the clip, as built:');
  console.log('  things  ms/frame  CPU at 10/s  asks  refinds');
  for (const count of counts) {
    let watched: WatchThing[] = things
      .slice(0, count)
      .map((t) =>
        watchThing(
          { id: t.label, kind: 'object', label: t.label, concept: t.label, zones: [] },
          startLocalTrack(first, t.box, false)!,
          0,
        ),
      );
    let asks = 0;
    let refinds = 0;
    const per = timeOver(frames.slice(1), (f, k) => {
      const now = (k + 1) * (1000 / info.fps);
      watched = watched.map((thing) => {
        const step = watchStep(thing, f, now);
        if (step.refind) refinds++;
        if (!step.ask) return step.thing;
        // As the watcher does: the next ask waits, and a re-anchor here finds nothing.
        asks++;
        const waited = asked(step.thing, step.ask, now);
        return step.ask === 'reanchor' ? missed(waited) : waited;
      });
    });
    console.log(
      `  ${String(watched.length).padStart(6)}  ${ms(per).padStart(8)}  ${`${Math.round((per * info.fps) / 10)}%`.padStart(11)}  ${String(asks).padStart(4)}  ${String(refinds).padStart(7)}`,
    );
  }

  // Layer 2 and SAM: each needs a full picture, then the model.
  console.log('\nOn a loss (once per thing per loss, not per frame):');
  if (info.snapshotMs)
    console.log(`  full-size still through ffmpeg   ${ms(info.snapshotMs)} ms (when recorded)`);
  const model = await Appearance.load(dataDir());
  if (!model)
    console.log('  feature model not downloaded (`bun run fetch-model`): layer 2 not timed');
  else {
    const meta = { width: 1, height: 1 };
    const sharp = (await import('sharp')).default;
    const { width = 1, height = 1 } = await sharp(still).metadata();
    Object.assign(meta, { width, height });
    const box = things[0]!.box;
    await model.embed(still, appearanceRegion(box, meta)); // warm up
    for (const [what, region, side] of [
      ['learn a prototype (224 px)', appearanceRegion(box, meta), 224],
      ['look again, as built', searchRegion(box, meta).region, searchRegion(box, meta).side],
      ['look again at 896 px', searchRegion(box, meta).region, 896],
    ] as const) {
      const at = performance.now();
      for (let i = 0; i < 5; i++) await model.embed(still, region, side);
      console.log(`  feature model, ${what.padEnd(26)} ${ms((performance.now() - at) / 5)} ms`);
    }
  }
  console.log(
    '  SAM (layer 3)                     a billed call, seconds; only on a settled zone crossing or a loss nothing local can fix',
  );
}

await (args.positional[0] === 'capture' ? capture() : bench());
// ffmpeg's pipe can keep the loop alive after the clip is written.
process.exit(0);
