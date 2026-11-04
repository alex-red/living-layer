/**
 * The GPU tracker node (`services/gpu-tracker/`) from this machine.
 *
 *   bun run gpu-tracker deploy                 copy it to the GPU host, build, start
 *   bun run gpu-tracker check --box mug=x,y,w,h [--image <png>]
 *                                              health, then one picture's boxes
 *   bun run gpu-tracker watch --box mug=x,y,w,h [--seconds 30] [--fps 10] [--motion 0]
 *                                              follow things on the saved camera; summary
 *   bun run gpu-tracker stop                   stop following and the container
 *
 * Boxes are shares of the camera's cropped frame, as the lab's. The host is
 * GPU_TRACKER_HOST (its ssh host; needed to deploy and stop), the node
 * GPU_TRACKER_URL (default http://<host>:43450); its token is read from the
 * host's .env unless GPU_TRACKER_TOKEN is set. Results go to out/gpu-tracker/.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SavedCamera, UnitBox } from '@livinglayer/domain';
import { flag, parseArgs } from './lib/args.js';
import { dataDir } from './lib/evidence.js';

const args = parseArgs();
const command = args.positional[0];
const host = process.env.GPU_TRACKER_HOST ?? '';
// Check and watch can go by the node's URL and token alone; anything over ssh needs the host.
const byUrl = process.env.GPU_TRACKER_URL && process.env.GPU_TRACKER_TOKEN;
if (!host && !(byUrl && (command === 'check' || command === 'watch'))) {
  console.error('Set GPU_TRACKER_HOST to the GPU machine, as ssh reaches it (e.g. gpu-box.lan).');
  process.exit(1);
}
const url = process.env.GPU_TRACKER_URL ?? `http://${host}:43450`;
const remoteDir = 'docker/livinglayer-tracker';
const out = resolve(import.meta.dir, '..', 'out', 'gpu-tracker');

interface Seen {
  id: string;
  seen: boolean;
  score: number;
  area: number;
  box?: UnitBox;
}
interface TracksEvent {
  type: 'tracks' | 'error';
  seq: number;
  at: number;
  ms: number;
  motion: number;
  seeded: boolean;
  things: Seen[];
  error?: string;
}

function run(cmd: string[]) {
  const done = Bun.spawnSync(cmd, { stdout: 'inherit', stderr: 'inherit' });
  if (!done.success) throw new Error(`${cmd.slice(0, 3).join(' ')}… failed`);
}

function token() {
  if (process.env.GPU_TRACKER_TOKEN) return process.env.GPU_TRACKER_TOKEN;
  const read = Bun.spawnSync(['ssh', '-o', 'BatchMode=yes', host, `cat ${remoteDir}/.env`]);
  const line = read.stdout.toString().match(/^TRACKER_TOKEN=(\S+)/m);
  if (!line) throw new Error(`No TRACKER_TOKEN in ${host}:${remoteDir}/.env; deploy first.`);
  return line[1]!;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

/** `--box mug=0.36,0.51,0.06,0.08`, repeated. */
function boxes() {
  const given = args.flags.get('box') ?? [];
  if (!given.length) throw new Error('Name at least one thing: --box mug=x,y,w,h (shares).');
  return given.map((spec) => {
    const [id, numbers] = spec.split('=');
    const [x, y, width, height] = (numbers ?? '').split(',').map(Number);
    if (!id || [x, y, width, height].some((n) => n === undefined || !Number.isFinite(n)))
      throw new Error(`Not a box: ${spec}`);
    return { id, box: { x: x!, y: y!, width: width!, height: height! } };
  });
}

function savedCamera() {
  const db = new Database(join(dataDir(), 'livinglayer.sqlite'), { readonly: true });
  const row = db.query("SELECT value FROM settings WHERE key = 'cameras'").get() as {
    value: string;
  } | null;
  db.close();
  const cameras = JSON.parse(row?.value ?? '[]') as SavedCamera[];
  const name = flag(args, 'camera');
  const camera = name ? cameras.find((c) => c.name === name || c.id === name) : cameras[0];
  if (!camera?.url.startsWith('rtsp')) throw new Error('No saved RTSP camera (--camera <name>).');
  return camera;
}

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};
const fmt = (b?: UnitBox) =>
  b ? [b.x, b.y, b.width, b.height].map((n) => n.toFixed(3)).join(',') : '—';

async function health() {
  const response = await fetch(`${url}/health`).catch(() => null);
  if (!response?.ok) throw new Error(`The node at ${url} doesn't answer; deploy it first.`);
  const body = await response.json();
  console.log('health', JSON.stringify(body));
}

async function check() {
  await health();
  const image = flag(args, 'image') ?? join(dataDir(), 'clips', 'plushies.png');
  const result = await call<{ ms: number; things: Seen[]; memory: object }>('/segment', {
    method: 'POST',
    body: JSON.stringify({ image: readFileSync(image).toString('base64'), things: boxes() }),
  });
  console.log(`segment ${result.ms} ms, memory ${JSON.stringify(result.memory)}`);
  for (const t of result.things)
    console.log(`  ${t.id}: ${t.seen ? 'seen' : 'not seen'} ${t.score} box ${fmt(t.box)}`);
}

async function watch() {
  await health();
  const camera = savedCamera();
  const seconds = Number(flag(args, 'seconds') ?? 30);
  const fps = Number(flag(args, 'fps') ?? 10);
  const motion = flag(args, 'motion');
  const things = boxes();
  console.log(
    `Following ${things.map((t) => t.id).join(', ')} on ${camera.name} for ${seconds} s…`,
  );
  await call('/session', {
    method: 'PUT',
    body: JSON.stringify({
      source: camera.url,
      crop: camera.crop ?? null,
      fps,
      things,
      ...(motion === undefined ? {} : { motion: Number(motion) }),
    }),
  });
  const events: TracksEvent[] = [];
  const stream = await fetch(`${url}/tracks`, {
    headers: { authorization: `Bearer ${token()}` },
    signal: AbortSignal.timeout(seconds * 1000),
  });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!chunk.startsWith('data: ')) continue;
        const event = JSON.parse(chunk.slice(6)) as TracksEvent;
        events.push(event);
        if (event.type === 'error') console.log(`  error ${event.error}`);
        else
          console.log(
            `  #${event.seq} ${event.ms.toFixed(0)} ms motion ${event.motion}${event.seeded ? ' seeded' : ''} ` +
              event.things.map((t) => `${t.id} ${t.seen ? fmt(t.box) : 'lost'}`).join('  '),
          );
      }
    }
  } catch (error) {
    if ((error as Error).name !== 'TimeoutError') throw error;
  }
  const state = await call<{
    frames: number;
    skipped: number;
    cameraRate: number;
    memory: object;
  }>('/session');
  await call('/session', { method: 'DELETE' });
  const tracks = events.filter((e) => e.type === 'tracks');
  const times = tracks.filter((e) => !e.seeded).map((e) => e.ms);
  console.log(
    `\n${tracks.length} results in ${seconds} s (${(tracks.length / seconds).toFixed(1)}/s), ` +
      `${state.skipped} still frames skipped, camera ${state.cameraRate} frames/s; step p50 ${quantile(times, 0.5).toFixed(0)} ms, ` +
      `p95 ${quantile(times, 0.95).toFixed(0)} ms; memory ${JSON.stringify(state.memory)}`,
  );
  for (const { id } of things) {
    const mine = tracks.map((e) => e.things.find((t) => t.id === id));
    const seen = mine.filter((t) => t?.seen).length;
    console.log(
      `  ${id}: seen in ${seen}/${mine.length}, last ${fmt(mine.findLast((t) => t?.seen)?.box)}`,
    );
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'tracks.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
  console.log(`→ out/gpu-tracker/tracks.jsonl`);
}

if (command === 'deploy') {
  const source = resolve(import.meta.dir, '..', 'services', 'gpu-tracker') + '/';
  run([
    'rsync',
    '-a',
    '--exclude',
    '.env',
    '--exclude',
    '__pycache__',
    source,
    `${host}:${remoteDir}/`,
  ]);
  run([
    'ssh',
    host,
    `cd ${remoteDir} && { [ -f .env ] || echo "TRACKER_TOKEN=$(openssl rand -hex 24)" > .env; } && chmod 600 .env && docker compose up -d --build`,
  ]);
  console.log(`Started on ${host}; the model loads in the first minute: bun run gpu-tracker check`);
} else if (command === 'check') await check();
else if (command === 'watch') await watch();
else if (command === 'stop') {
  await call('/session', { method: 'DELETE' }).catch(() => undefined);
  run(['ssh', host, `cd ${remoteDir} && docker compose stop`]);
} else {
  console.log('bun run gpu-tracker deploy | check --box id=x,y,w,h | watch --box … | stop');
  process.exit(command ? 1 : 0);
}
