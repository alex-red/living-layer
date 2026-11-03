/**
 * Living Layer's desktop node: lets the lab switch this machine's display,
 * open a page and show a banner. Plan: docs/plans/desktop-node.md.
 *
 *   living-layer-node [run] [--name NAME] [--port N] [--dry-run]
 *   living-layer-node install [--name NAME] [--port N]   systemd user service, started now and at login
 *   living-layer-node unpair                             forget the lab that adopted it
 *   living-layer-node info                               who it is, and where it keeps that
 *   living-layer-node doctor                             what it needs here, and how to get what's missing
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { DESKTOP_NODE_PORT } from '@livinglayer/domain';
import { KIOSK_BROWSER_NAMES, desktopCaps, detectDesktop } from './desktop.js';
import { createNode, type Identity, type Runner } from './handler.js';
import { advertiseArgv, doctorChecks, runCommand, systemdUnit } from './system.js';

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    port: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
const action = positionals[0] ?? 'run';
if (values.help || !['run', 'install', 'unpair', 'info', 'doctor'].includes(action)) {
  console.log(
    'Usage: living-layer-node [run|install|unpair|info|doctor] [--name NAME] [--port N] [--dry-run]',
  );
  process.exit(values.help ? 0 : 2);
}

const configDir = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'living-layer-node',
);
const identityFile = join(configDir, 'node.json');
const port = Number(values.port ?? DESKTOP_NODE_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('--port must be a port number.');
  process.exit(2);
}

function loadIdentity(): Identity {
  const name = values.name ?? hostname().split('.')[0] ?? 'desktop';
  if (existsSync(identityFile)) {
    const saved = JSON.parse(readFileSync(identityFile, 'utf8')) as Identity;
    return values.name ? { ...saved, name } : saved;
  }
  return { id: randomUUID(), name, token: null, adoptedBy: null };
}
function saveIdentity(identity: Identity) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(identityFile, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
}

const identity = loadIdentity();
saveIdentity(identity);

if (action === 'info') {
  console.log(JSON.stringify({ ...identity, token: identity.token ? '***' : null }, null, 2));
  console.log(`Kept in ${identityFile}`);
  process.exit(0);
}
if (action === 'unpair') {
  saveIdentity({ ...identity, token: null, adoptedBy: null });
  console.log('Forgot its lab: the next one to adopt it may.');
  process.exit(0);
}
if (action === 'install') {
  if (process.platform !== 'linux') {
    console.error('install sets up a systemd user service, on Linux. Use `run` here.');
    process.exit(1);
  }
  // Compiled, the binary is the program; under bun, it's bun and this file.
  const self = process.execPath.endsWith('/bun')
    ? [process.execPath, Bun.main]
    : [process.execPath];
  const exec = [...self, 'run', '--name', identity.name, '--port', String(port)];
  const unit = join(homedir(), '.config/systemd/user/living-layer-node.service');
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, systemdUnit(exec));
  for (const argv of [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', 'living-layer-node.service'],
  ]) {
    const done = await runCommand(argv);
    if (!done.ok) {
      console.error(done.error);
      process.exit(1);
    }
  }
  console.log(`Installed ${unit}; running now and at every login.`);
  console.log('Logs: journalctl --user -u living-layer-node -f');
  process.exit(0);
}

const desktop = detectDesktop(process.platform, process.env);
const checks = async () =>
  doctorChecks({
    platform: process.platform,
    desktop,
    env: process.env,
    which: (bin) => Bun.which(bin) !== null,
    avahiRunning:
      process.platform === 'linux' &&
      (await runCommand(['systemctl', 'is-active', '--quiet', 'avahi-daemon'])).ok,
  });
if (action === 'doctor') {
  const found = await checks();
  for (const c of found)
    console.log(`${c.ok ? '✓' : '✗'} ${c.label}${c.ok || !c.fix ? '' : `\n    ${c.fix}`}`);
  process.exit(found.every((c) => c.ok) ? 0 : 1);
}
const run: Runner = values['dry-run']
  ? async (argv) => {
      console.log(`would run: ${argv.map((a) => JSON.stringify(a)).join(' ')}`);
      return { ok: true };
    }
  : runCommand;
const node = createNode({
  identity,
  save: saveIdentity,
  desktop,
  os: process.platform === 'darwin' ? 'macos' : 'linux',
  run,
  browsers: KIOSK_BROWSER_NAMES.filter((name) => Bun.which(name)),
});

const server = Bun.serve({
  hostname: '0.0.0.0',
  port,
  async fetch(request) {
    const response = await node.fetch(request);
    console.log(`${request.method} ${new URL(request.url).pathname} → ${response.status}`);
    return response;
  },
});

const publish = advertiseArgv(process.platform, {
  id: identity.id,
  name: identity.name,
  port,
  caps: desktopCaps(desktop),
});
let publisher: ReturnType<typeof Bun.spawn> | null = null;
if (Bun.which(publish[0]!)) publisher = Bun.spawn(publish, { stdout: 'ignore', stderr: 'ignore' });
else
  console.warn(
    process.platform === 'linux'
      ? 'No avahi-publish-service, so the lab won’t find this node by itself: sudo pacman -S avahi && sudo systemctl enable --now avahi-daemon'
      : `No ${publish[0]}, so the lab won’t find this node by itself.`,
  );

const stop = () => {
  publisher?.kill();
  void server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

for (const c of await checks())
  if (!c.ok) console.warn(`Missing: ${c.label}${c.fix ? ` (${c.fix})` : ''}`);
console.log(
  `${identity.name} (${desktop}) on port ${port}, ${identity.token ? `adopted by ${identity.adoptedBy}` : 'waiting to be adopted'}${values['dry-run'] ? ', dry run' : ''}.`,
);
