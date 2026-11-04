/**
 * Start the dev servers, after stopping any this checkout already runs. An
 * old one keeps the port (a terminal closed in another session, a run that
 * never ended), and the new server then can't listen: the page talks to the
 * old code, and its log is in a terminal no one is looking at.
 *
 *   bun run dev
 *   bun run dev --dry-run   (only says what it would stop)
 *
 * Nothing reloads by itself: an edit (often another session's, half done)
 * would otherwise restart the API server and reload the page under you. A
 * change is noticed and the page shows `Reload now` (`DevReload.tsx`), which
 * restarts the API server when its code changed, then reloads the page. An API
 * server that stops (a crash) is started again the same way. While an AI task
 * or a request that changes something is running, the reload waits for it
 * (`/api/busy`), unless the page says `Reload anyway`.
 *
 * Only this checkout's servers are stopped: the API server and Vite started
 * from its apps, the `bun run dev` above them, and whatever of this checkout
 * holds their ports. Worktrees' servers (browser tests) run on ports of their
 * own and are left alone. A port held by anything else is named, and nothing
 * starts.
 */
import { readlinkSync, statSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { lanAddress } from '../apps/server/src/remote.js';
import { devBanner } from './lib/dev-banner.js';

const root = resolve(import.meta.dir, '..');
const ports = [Number(process.env.PORT || 43431), 43430];

const run = (cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'ignore' });
  return p.stdout.toString();
};
/** The folder a process runs in, or null when it can't be read (it ended, or isn't ours). */
function cwdOf(pid: number): string | null {
  if (process.platform === 'linux')
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  const line = run(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n')
    .find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}
const ours = (cwd: string | null) => cwd !== null && (cwd === root || cwd.startsWith(`${root}/`));
const apps = [join(root, 'apps/server'), join(root, 'apps/web')];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const listeners = (port: number) =>
  run(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    .split('\n')
    .filter(Boolean)
    .map(Number);

const table = run(['ps', '-ax', '-o', 'pid=,ppid=,command='])
  .split('\n')
  .flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }] : [];
  });
// This run and the shells and runners above it are never stopped.
const mine = new Set<number>();
for (let pid = process.pid; pid > 1 && !mine.has(pid);) {
  mine.add(pid);
  pid = table.find((p) => p.pid === pid)?.ppid ?? 0;
}
// A server that failed to listen still waits under --watch, and takes the port when it frees.
const servers = table.filter(
  (p) =>
    !mine.has(p.pid) &&
    (/\bbun\b.*src\/index\.ts/.test(p.command) || /\bvite\b.*--port\b/.test(p.command)) &&
    apps.includes(cwdOf(p.pid) ?? ''),
);
// The `bun run dev` runners above them, so none is left waiting on a child that is gone.
const runners = table.filter(
  (p) =>
    !mine.has(p.pid) &&
    (/\bbun\b.*\brun\b.*\bdev\b/.test(p.command) || /\bscripts\/dev\.ts\b/.test(p.command)) &&
    servers.some((s) => s.ppid === p.pid || table.find((t) => t.pid === s.ppid)?.ppid === p.pid),
);
const foreign = ports.flatMap((port) =>
  listeners(port)
    .filter((pid) => !mine.has(pid) && !servers.some((s) => s.pid === pid))
    .map((pid) => ({ port, pid, cwd: cwdOf(pid) })),
);
const strangers = foreign.filter((f) => !ours(f.cwd));
if (strangers.length) {
  for (const s of strangers)
    console.error(
      `Port ${s.port} is held by process ${s.pid} (${table.find((p) => p.pid === s.pid)?.command ?? '?'}), from ${s.cwd ?? 'an unknown folder'}, not this checkout. Stop it, or set PORT in .env.`,
    );
  process.exit(1);
}
const stopping = [...servers, ...runners, ...foreign.map((f) => ({ pid: f.pid, command: '' }))];
if (process.argv.includes('--dry-run')) {
  for (const p of stopping)
    console.log(
      `Would stop ${p.pid} ${p.command.slice(0, 100) || `(holds port ${foreign.find((f) => f.pid === p.pid)?.port})`}`,
    );
  if (!stopping.length) console.log('No earlier dev server to stop.');
  process.exit(0);
}
if (stopping.length) {
  for (const p of servers)
    console.log(`Stopping an earlier dev server: ${p.pid} ${p.command.slice(0, 80)}`);
  for (const p of stopping) if (alive(p.pid)) process.kill(p.pid, 'SIGTERM');
  // A server closes its relay and watchers first; one that hasn't in 5 s is killed.
  const until = Date.now() + 5000;
  while (stopping.some((p) => alive(p.pid)) && Date.now() < until) await Bun.sleep(100);
  for (const p of stopping) if (alive(p.pid)) process.kill(p.pid, 'SIGKILL');
  while (ports.some((port) => listeners(port).length) && Date.now() < until + 3000)
    await Bun.sleep(100);
}

/** What the page last saw: web edits counted (a tab keeps the count it loaded with), and the API server. */
const state = {
  web: 0,
  server: 'running' as 'running' | 'changed' | 'stopped' | 'restarting',
  files: [] as string[],
  /** What the API server is still working on: running jobs' titles, and requests that change something. */
  busy: { jobs: [] as string[], requests: 0 },
  /** A reload is waiting for that to end. */
  waiting: false,
};
const clients = new Set<ReadableStreamDefaultController<string>>();
const send = (c: ReadableStreamDefaultController<string>) =>
  c.enqueue(`data: ${JSON.stringify(state)}\n\n`);
let pending: Timer | undefined;
/** Batches the many events one save makes. */
const broadcast = () => {
  clearTimeout(pending);
  pending = setTimeout(() => clients.forEach(send), 150);
};

const control = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 0,
  routes: {
    '/__dev/events': () => {
      let me: ReadableStreamDefaultController<string>;
      const body = new ReadableStream<string>({
        start(c) {
          me = c;
          clients.add(c);
          send(c);
        },
        cancel: () => void clients.delete(me),
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      });
    },
    '/__dev/reload': {
      POST: async (request) => {
        if (!new URL(request.url).searchParams.has('now')) await idle();
        else if (state.waiting) skipWait = true;
        if (state.server !== 'running') await restartServer();
        return Response.json({ ok: state.server === 'running' });
      },
    },
  },
});

const env = { ...process.env, LIVING_LAYER_DEV: '1', HOST: '0.0.0.0' };
const apiPort = ports[0]!;

/** What the API server is working on; nothing when it doesn't answer (stopped, or still starting). */
async function busyNow(): Promise<typeof state.busy> {
  const none = { jobs: [], requests: 0 };
  if (state.server === 'stopped' || state.server === 'restarting') return none;
  return fetch(`http://127.0.0.1:${apiPort}/api/busy`)
    .then((r) => (r.ok ? (r.json() as Promise<typeof state.busy>) : none))
    .catch(() => none);
}
const isBusy = (b: typeof state.busy) => b.jobs.length > 0 || b.requests > 0;
async function pollBusy() {
  const busy = await busyNow();
  if (JSON.stringify(busy) === JSON.stringify(state.busy)) return;
  state.busy = busy;
  broadcast();
}
// Only once something changed and a page is open to show it.
setInterval(() => {
  if (clients.size && (state.web || state.server !== 'running')) void pollBusy();
}, 1000).unref();
let skipWait = false;
let waiting: Promise<void> | undefined;
/** Waits until the API server has no AI task or changing request left, or a page says not to. */
function idle() {
  return (waiting ??= (async () => {
    state.waiting = true;
    broadcast();
    while (!skipWait && isBusy(await busyNow())) await Bun.sleep(1000);
    skipWait = false;
    state.waiting = false;
    broadcast();
  })().finally(() => (waiting = undefined)));
}
let server: Bun.Subprocess | undefined;
let quitting = false;
function startServer() {
  const p = Bun.spawn(['bun', '--env-file=../../.env', 'src/index.ts'], {
    cwd: join(root, 'apps/server'),
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  server = p;
  void p.exited.then((code) => {
    if (quitting || server !== p || state.server === 'restarting') return;
    state.server = 'stopped';
    console.log(`\nThe API server stopped (${code}). Reload now in the page starts it again.`);
    broadcast();
  });
}
let restarting: Promise<void> | undefined;
/** Stops the API server, starts it with the code on disk and waits until it answers. */
function restartServer() {
  return (restarting ??= (async () => {
    state.server = 'restarting';
    broadcast();
    const old = server;
    if (old && old.exitCode === null && old.signalCode === null) {
      old.kill('SIGTERM');
      // It closes its relay and watchers first; one that hasn't in 5 s is killed.
      const timer = setTimeout(() => old.kill('SIGKILL'), 5000);
      await old.exited;
      clearTimeout(timer);
    }
    console.log('\nRestarting the API server.');
    startServer();
    const p = server!;
    let up = false;
    for (const until = Date.now() + 60_000; !up && p.exitCode === null && Date.now() < until;) {
      up = await fetch(`http://127.0.0.1:${apiPort}/api/status`).then(
        (r) => r.ok,
        () => false,
      );
      if (!up) await Bun.sleep(200);
    }
    state.server = up ? 'running' : 'stopped';
    state.files = [];
    broadcast();
  })().finally(() => (restarting = undefined)));
}

// What each part runs: the page reads apps/web and the packages, the API server its src and the packages.
const ignored =
  /(^|\/)(node_modules|dist|\.data|out|\.turbo)(\/|$)|(~|\.swp|\.tmp)$|(^|\/)\.#|\.tsbuildinfo$/;
const watched = [
  { dir: 'apps/web', web: true, server: false },
  { dir: 'apps/server/src', web: false, server: true },
  { dir: 'packages', web: true, server: true },
];
for (const w of watched)
  watch(join(root, w.dir), { recursive: true }, (_event, name) => {
    if (!name) return;
    const file = `${w.dir}/${name}`;
    if (ignored.test(file)) return;
    if (w.web) state.web++;
    if (w.server && state.server === 'running') state.server = 'changed';
    state.files = [file, ...state.files.filter((f) => f !== file)].slice(0, 5);
    broadcast();
  });

startServer();
const web = Bun.spawn(['bun', 'run', 'dev'], {
  cwd: join(root, 'apps/web'),
  env: { ...env, LIVING_LAYER_DEV_CONTROL: control.url.origin },
  stdio: ['ignore', 'inherit', 'inherit'],
});
async function quit(signal: NodeJS.Signals | null, code: number) {
  if (quitting) return;
  quitting = true;
  for (const p of [server, web]) if (p && p.exitCode === null) p.kill(signal ?? 'SIGTERM');
  await Promise.race([Promise.all([server?.exited, web.exited]), Bun.sleep(6000)]);
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.on(signal, () => void quit(signal, 0));
void web.exited.then((code) => quit(null, code));

/** Answers at all within a minute: the API's status, or Vite's page. */
async function answers(url: string) {
  for (const until = Date.now() + 60_000; Date.now() < until && !quitting; await Bun.sleep(300))
    if (
      await fetch(url).then(
        (r) => r.ok,
        () => false,
      )
    )
      return true;
  return false;
}
// Once both answer, say which address is the lab: the API server serves a page too, the last build's.
void Promise.all([
  answers(`http://127.0.0.1:${apiPort}/api/status`),
  answers(`http://127.0.0.1:${ports[1]}/`),
]).then(([api, page]) => {
  if (!api || !page || quitting) return;
  let builtAt: Date | null = null;
  try {
    builtAt = statSync(join(root, 'apps/web/dist/index.html')).mtime;
  } catch {
    // Never built.
  }
  console.log(devBanner({ webPort: ports[1]!, apiPort, builtAt, lan: lanAddress() }));
});
