/**
 * What reading a network camera costs the server, with no camera and no tab:
 * a fake one (1080p30 H.264 over RTSP from a local mediamtx, like an IP
 * camera) read straight and through the lab's own relay (`CameraRelay`).
 *
 *   bun run bench:stream                   keyframe every 2 s, a usual camera default
 *   bun run bench:stream --gop 0.5         keyframe every half second
 *   bun run bench:stream --runs 8 --seconds 15
 *   bun run bench:stream --url rtsp://…    a real camera instead (read only; the URL isn't printed)
 *
 * For each way in it times the watcher's source (`FfmpegSource.start` to its
 * first grey frame), a still with no source running, one from the running
 * source and one asked of another source while it runs,
 * then keeps one running for `--seconds`: frame rate, the longest gap, and
 * ffmpeg's CPU. It also reports the camera itself: codec, size, rate and how
 * often a keyframe comes, which bounds how soon any new reader sees a frame.
 * Timing is noisy: compare runs on one machine, not against fixed targets.
 * Results go to out/stream-bench.json. Needs ffmpeg and mediamtx.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SavedCamera } from '@livinglayer/domain';
import { FfmpegSource } from '../apps/server/src/frames.js';
import { CameraRelay, RELAY_ENV } from '../apps/server/src/relay.js';
import { flag, parseArgs } from './lib/args.js';

const args = parseArgs();
const runs = Number(flag(args, 'runs') ?? 6);
const seconds = Number(flag(args, 'seconds') ?? 10);
const gop = Number(flag(args, 'gop') ?? 2);
const realUrl = flag(args, 'url');

const mediamtx = Bun.which('mediamtx');
if (!mediamtx || !Bun.which('ffmpeg')) {
  console.error('Needs ffmpeg and mediamtx on the PATH.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'livinglayer-stream-bench-'));
const children: ReturnType<typeof Bun.spawn>[] = [];
let relay: CameraRelay | null = null;
const cleanUp = () => {
  relay?.stop();
  for (const c of children) c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
};
process.on('SIGINT', () => (cleanUp(), process.exit(130)));

/** A free loopback TCP port with the two after it free too, as the relay needs. */
async function freePorts() {
  for (;;) {
    const base = 40_000 + Math.floor(Math.random() * 20_000);
    const free = await Promise.all(
      [0, 1, 2].map(async (k) => {
        try {
          const server = Bun.listen({
            hostname: '127.0.0.1',
            port: base + k,
            socket: { data() {} },
          });
          server.stop(true);
          return true;
        } catch {
          return false;
        }
      }),
    );
    if (free.every(Boolean)) return base;
  }
}

async function waitForPort(port: number, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) {
    const open = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } })
      .then((s) => (s.end(), true))
      .catch(() => false);
    if (open) return;
  }
  throw new Error(`Nothing listened on ${port}.`);
}

/** The fake camera: a mediamtx taking one published path, and ffmpeg publishing to it. */
async function fakeCamera() {
  const port = await freePorts();
  const config = join(dir, 'camera.yml');
  writeFileSync(
    config,
    [
      'logLevel: warn',
      'api: false',
      'rtmp: false',
      'hls: false',
      'webrtc: false',
      'srt: false',
      `rtspAddress: 127.0.0.1:${port}`,
      'rtspTransports: [tcp]',
      'paths:',
      '  cam:',
      '    source: publisher',
      '',
    ].join('\n'),
  );
  children.push(
    Bun.spawn([mediamtx!, config], {
      env: { ...process.env, ...RELAY_ENV },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }),
  );
  await waitForPort(port);
  const url = `rtsp://127.0.0.1:${port}/cam`;
  // The hardware encoder where there is one, so the publisher doesn't eat the CPU being measured.
  const hardware = Bun.spawnSync(['ffmpeg', '-hide_banner', '-encoders'])
    .stdout.toString()
    .includes('h264_videotoolbox');
  const encoder = hardware
    ? ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-b:v', '4M']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', '4M'];
  const publisher = Bun.spawn(
    [
      'ffmpeg',
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-re',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=30',
      ...encoder,
      '-g',
      String(Math.max(1, Math.round(gop * 30))),
      '-bf',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-f',
      'rtsp',
      '-rtsp_transport',
      'tcp',
      url,
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
  );
  children.push(publisher);
  // Published once a reader can learn its size.
  for (const end = Date.now() + 10_000; Date.now() < end; await Bun.sleep(200))
    if ((await describe(url)).codec) return url;
  throw new Error('The fake camera did not start publishing.');
}

/** The camera's codec, size and rate, and how often a keyframe came over a few seconds. */
async function describe(url: string, sampleS = 0) {
  const stream = Bun.spawnSync(
    [
      'ffprobe',
      '-v',
      'error',
      '-rtsp_transport',
      'tcp',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,avg_frame_rate',
      '-of',
      'json',
      url,
    ],
    { timeout: 10_000 },
  );
  const info = (JSON.parse(stream.stdout.toString() || '{}').streams?.[0] ?? {}) as {
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
  };
  let keyframeS: number | null = null;
  if (sampleS > 0) {
    const packets = Bun.spawnSync(
      [
        'ffprobe',
        '-v',
        'error',
        '-rtsp_transport',
        'tcp',
        '-select_streams',
        'v:0',
        '-read_intervals',
        `%+${sampleS}`,
        '-show_entries',
        'packet=pts_time,flags',
        '-of',
        'csv=p=0',
        url,
      ],
      { timeout: (sampleS + 15) * 1000 },
    );
    const keys = packets.stdout
      .toString()
      .trim()
      .split('\n')
      .map((l) => l.split(','))
      .filter(([, flags]) => flags?.includes('K'))
      .map(([t]) => Number(t))
      .filter(Number.isFinite);
    if (keys.length > 1) keyframeS = (keys.at(-1)! - keys[0]!) / (keys.length - 1);
  }
  const [n, d] = (info.avg_frame_rate ?? '0/1').split('/').map(Number);
  return {
    codec: info.codec_name ?? null,
    width: info.width ?? null,
    height: info.height ?? null,
    fps: d ? Math.round((n! / d) * 10) / 10 : null,
    keyframeS: keyframeS === null ? null : Math.round(keyframeS * 100) / 100,
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};
const ms = (n: number) => (Number.isFinite(n) ? `${Math.round(n)} ms` : '—');

async function firstFrame(source: FfmpegSource) {
  const started = performance.now();
  let first = 0;
  let resolveFirst: () => void = () => {};
  const arrived = new Promise<void>((r) => (resolveFirst = r));
  const times: number[] = [];
  await source.start(
    () => {
      const now = performance.now();
      times.push(now);
      if (!first) ((first = now), resolveFirst());
    },
    () => resolveFirst(),
  );
  await Promise.race([arrived, Bun.sleep(20_000)]);
  return { ms: first ? first - started : NaN, times };
}

async function measure(label: string, url: string) {
  const starts: number[] = [];
  const cold: number[] = [];
  for (let i = 0; i < runs; i++) {
    // Start at a different point of the keyframe interval each time.
    await Bun.sleep(Math.random() * gop * 1000);
    const source = new FfmpegSource(url);
    starts.push((await firstFrame(source)).ms);
    source.stop();
    // Not straight after the keyframe that frame came from, or every still waits a whole interval.
    await Bun.sleep(Math.random() * gop * 1000);
    const still = performance.now();
    await new FfmpegSource(url).snapshot().catch(() => null);
    cold.push(performance.now() - still);
  }
  const source = new FfmpegSource(url);
  const { times } = await firstFrame(source);
  await Bun.sleep(1000);
  const warm: number[] = [];
  const shared: number[] = [];
  for (let i = 0; i < runs; i++) {
    let still = performance.now();
    await source.snapshot().catch(() => null);
    warm.push(performance.now() - still);
    // As the snapshot route asks while the watcher reads the same camera.
    still = performance.now();
    await new FfmpegSource(url).snapshot().catch(() => null);
    shared.push(performance.now() - still);
  }
  const from = times.length;
  await Bun.sleep(seconds * 1000);
  const steady = times.slice(from);
  const gaps = steady.slice(1).map((t, i) => t - steady[i]!);
  const pid = (source as unknown as { proc: { pid: number } | null }).proc?.pid;
  const cpu = pid
    ? Number(Bun.spawnSync(['ps', '-o', '%cpu=', '-p', String(pid)]).stdout.toString())
    : NaN;
  source.stop();
  return {
    way: label,
    firstFrameMs: { median: median(starts), min: Math.min(...starts), max: Math.max(...starts) },
    stillColdMs: median(cold),
    stillWarmMs: median(warm),
    stillSharedMs: median(shared),
    fps: steady.length > 1 ? ((steady.length - 1) * 1000) / (steady.at(-1)! - steady[0]!) : NaN,
    longestGapMs: gaps.length ? Math.max(...gaps) : NaN,
    cpuPercent: cpu,
  };
}

try {
  const cameraUrl = realUrl ?? (await fakeCamera());
  const camera = await describe(cameraUrl, Math.max(4, gop * 3));
  const relayPort = await freePorts();
  relay = new CameraRelay(dir, mediamtx, relayPort);
  const saved: SavedCamera = {
    id: 'bench',
    name: 'Bench',
    url: cameraUrl,
    scene: null,
    createdAt: new Date().toISOString(),
  };
  await relay.sync([saved]);
  const relayed = relay.rtspFor(saved);
  console.log(
    `Camera: ${realUrl ? 'given URL' : 'fake'}, ${camera.codec ?? '?'} ${camera.width}×${camera.height} at ${camera.fps} fps, a keyframe every ${camera.keyframeS ?? '?'} s.`,
  );
  console.log(`${runs} starts and stills each way, then ${seconds} s of frames.\n`);
  const results = [await measure('straight', cameraUrl)];
  if (relayed) results.push(await measure('through the relay', relayed));
  for (const r of results)
    console.log(
      [
        `${r.way}:`,
        `  first grey frame  ${ms(r.firstFrameMs.median)} (${ms(r.firstFrameMs.min)} to ${ms(r.firstFrameMs.max)})`,
        `  still, cold       ${ms(r.stillColdMs)}`,
        `  still, running    ${ms(r.stillWarmMs)}`,
        `  still, elsewhere  ${ms(r.stillSharedMs)} (while another reads it)`,
        `  frames            ${r.fps.toFixed(1)} fps, longest gap ${ms(r.longestGapMs)}`,
        `  ffmpeg CPU        ${Number.isFinite(r.cpuPercent) ? `${r.cpuPercent}%` : '—'}`,
        '',
      ].join('\n'),
    );
  mkdirSync('out', { recursive: true });
  writeFileSync(
    'out/stream-bench.json',
    JSON.stringify({ at: new Date().toISOString(), gop, runs, seconds, camera, results }, null, 2),
  );
  console.log('Written to out/stream-bench.json.');
} finally {
  cleanUp();
}
