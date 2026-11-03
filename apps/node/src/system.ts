/**
 * What the node needs from the machine it runs on: advertising over mDNS, its
 * systemd user service, and running a command. The argument lists are pure,
 * so they are tested on any machine.
 */
import {
  DESKTOP_NODE_SERVICE,
  DESKTOP_NODE_VERSION,
  type DesktopNodeCap,
} from '@livinglayer/domain';
import type { Runner } from './handler.js';

/** The publisher that advertises the node, as `share-camera.sh` advertises a camera. */
export function advertiseArgv(
  platform: NodeJS.Platform,
  node: { id: string; name: string; port: number; caps: DesktopNodeCap[] },
): string[] {
  const type = DESKTOP_NODE_SERVICE.replace(/\.local$/, '');
  const txt = [
    `id=${node.id}`,
    `name=${node.name}`,
    `caps=${node.caps.join(',')}`,
    `v=${DESKTOP_NODE_VERSION}`,
  ];
  return platform === 'darwin'
    ? ['dns-sd', '-R', node.name, type, 'local', String(node.port), ...txt]
    : ['avahi-publish-service', node.name, type, String(node.port), ...txt];
}

/** The systemd user unit: in the graphical session, so it reaches Wayland and D-Bus. */
export function systemdUnit(exec: string[]): string {
  const quoted = exec.map((a) => (/[\s"\\]/.test(a) ? JSON.stringify(a) : a)).join(' ');
  return `[Unit]
Description=Living Layer desktop node
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=${quoted}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
`;
}

/** Runs one command with its arguments, no shell; a missing program is a failure, not a throw. */
export const runCommand: Runner = async (argv) => {
  try {
    const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), 10_000);
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    clearTimeout(timer);
    return code === 0
      ? { ok: true }
      : { ok: false, error: stderr.trim().slice(0, 300) || `${argv[0]} exited with ${code}.` };
  } catch {
    return { ok: false, error: `${argv[0]} is not installed.` };
  }
};
