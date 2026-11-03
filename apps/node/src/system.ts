/**
 * What the node needs from the machine it runs on: advertising over mDNS, its
 * systemd user service, and running a command. The argument lists are pure,
 * so they are tested on any machine.
 */
import {
  DESKTOP_NODE_SERVICE,
  DESKTOP_NODE_VERSION,
  type DesktopKind,
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

/** One thing the node needs, and how to get it when it is missing. */
interface Check {
  label: string;
  ok: boolean;
  fix?: string;
}

const DISPLAY_TOOL: Partial<Record<DesktopKind, { bin: string; pkg: string }>> = {
  kde: { bin: 'kscreen-doctor', pkg: 'sudo pacman -S libkscreen' },
  gnome: { bin: 'busctl', pkg: 'systemd ships busctl; is this a systemd distro?' },
  hyprland: { bin: 'hyprctl', pkg: 'sudo pacman -S hyprland' },
  x11: { bin: 'xset', pkg: 'sudo pacman -S xorg-xset' },
  macos: { bin: 'pmset', pkg: 'pmset comes with macOS' },
};

/**
 * What `living-layer-node doctor` checks on this machine: the desktop, the
 * programs each command runs, the session it needs, and mDNS. `which` finds
 * a program on `PATH`; `avahiRunning` is whether the daemon answers (Linux).
 */
export function doctorChecks({
  platform,
  desktop,
  env,
  which,
  avahiRunning,
}: {
  platform: NodeJS.Platform;
  desktop: DesktopKind;
  env: Record<string, string | undefined>;
  which: (bin: string) => boolean;
  avahiRunning: boolean;
}): Check[] {
  const linux = platform === 'linux';
  const tool = DISPLAY_TOOL[desktop];
  const checks: Check[] = [
    {
      label: `Desktop: ${desktop}`,
      ok: desktop !== 'unknown',
      fix: 'Run it from a KDE Plasma, GNOME, Hyprland or X11 session, or as its systemd user service.',
    },
    tool
      ? { label: `Display: ${tool.bin}`, ok: which(tool.bin), fix: tool.pkg }
      : { label: 'Display: nothing to switch it with here', ok: false },
    linux
      ? { label: 'Banner: notify-send', ok: which('notify-send'), fix: 'sudo pacman -S libnotify' }
      : { label: 'Banner: osascript', ok: which('osascript') },
    linux
      ? { label: 'Pages: xdg-open', ok: which('xdg-open'), fix: 'sudo pacman -S xdg-utils' }
      : { label: 'Pages: open', ok: which('open') },
  ];
  if (linux)
    checks.push(
      {
        label: 'Session: Wayland or X11 display',
        ok: Boolean(env.WAYLAND_DISPLAY || env.DISPLAY),
        fix: 'Run it inside your desktop session: `living-layer-node install` does.',
      },
      {
        label: 'Session: D-Bus, for banners',
        ok: Boolean(env.DBUS_SESSION_BUS_ADDRESS),
        fix: 'Run it inside your desktop session: `living-layer-node install` does.',
      },
      {
        label: 'mDNS: avahi-publish-service',
        ok: which('avahi-publish-service'),
        fix: 'sudo pacman -S avahi',
      },
      {
        label: 'mDNS: avahi-daemon running',
        ok: avahiRunning,
        fix: 'sudo systemctl enable --now avahi-daemon',
      },
    );
  else checks.push({ label: 'mDNS: dns-sd', ok: which('dns-sd') });
  return checks;
}
