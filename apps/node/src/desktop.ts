/**
 * Which desktop this is, and the commands that do each thing on it. Pure: the
 * caller runs what it returns, so every desktop is tested on any machine.
 */
import type { DesktopKind, DesktopNodeCap, DesktopNodeCommand } from '@livinglayer/domain';

/** The session's desktop, from what the session puts in the environment. */
export function detectDesktop(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): DesktopKind {
  if (platform === 'darwin') return 'macos';
  if (platform !== 'linux') return 'unknown';
  const current = (env.XDG_CURRENT_DESKTOP ?? '').toLowerCase().split(':');
  if (current.includes('kde')) return 'kde';
  if (current.includes('gnome')) return 'gnome';
  if (current.includes('hyprland') || env.HYPRLAND_INSTANCE_SIGNATURE) return 'hyprland';
  if (env.XDG_SESSION_TYPE === 'x11' || (env.DISPLAY && !env.WAYLAND_DISPLAY)) return 'x11';
  return 'unknown';
}

/** Browsers that can open a page full screen with nothing around it, best first. */
const KIOSK_BROWSERS: Record<string, (url: string) => string[]> = {
  chromium: (url) => ['chromium', `--app=${url}`, '--start-fullscreen'],
  'google-chrome-stable': (url) => ['google-chrome-stable', `--app=${url}`, '--start-fullscreen'],
  brave: (url) => ['brave', `--app=${url}`, '--start-fullscreen'],
  firefox: (url) => ['firefox', '--kiosk', url],
  'cachy-browser': (url) => ['cachy-browser', '--kiosk', url],
};
/** The browsers a kiosk page may open in, for the caller to look up on `PATH`. */
export const KIOSK_BROWSER_NAMES = Object.keys(KIOSK_BROWSERS);

/** What the node can do on this desktop. */
export function desktopCaps(desktop: DesktopKind): DesktopNodeCap[] {
  return desktop === 'unknown' ? ['open', 'banner'] : ['display', 'open', 'banner'];
}

/**
 * The commands, run in order, that carry out `command` on `desktop`, or null
 * when this desktop can't. `installed` are the kiosk browsers found on `PATH`.
 */
export function commandArgv(
  command: DesktopNodeCommand,
  desktop: DesktopKind,
  installed: readonly string[] = [],
): string[][] | null {
  if (command.kind === 'display') {
    const on = command.to === 'on';
    switch (desktop) {
      case 'kde':
        return [['kscreen-doctor', '--dpms', command.to]];
      case 'gnome':
        return [
          [
            'busctl',
            '--user',
            'set-property',
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig',
            'PowerSaveMode',
            'i',
            on ? '0' : '3',
          ],
        ];
      case 'hyprland':
        return [['hyprctl', 'dispatch', 'dpms', command.to]];
      case 'x11':
        return [['xset', 'dpms', 'force', command.to]];
      case 'macos':
        return [on ? ['caffeinate', '-u', '-t', '2'] : ['pmset', 'displaysleepnow']];
      default:
        return null;
    }
  }
  if (command.kind === 'open') {
    if (desktop === 'macos') return [['open', command.url]];
    const kiosk = command.kiosk
      ? KIOSK_BROWSER_NAMES.find((name) => installed.includes(name))
      : undefined;
    return [kiosk ? KIOSK_BROWSERS[kiosk]!(command.url) : ['xdg-open', command.url]];
  }
  const text = command.text ?? '';
  if (desktop === 'macos')
    // The words go in as arguments, so nothing in them is read as AppleScript.
    return [
      [
        'osascript',
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        command.title,
        text,
      ],
    ];
  return [
    [
      'notify-send',
      '--app-name=Living Layer',
      '--icon=dialog-information',
      `--expire-time=${(command.seconds ?? 8) * 1000}`,
      '--',
      command.title,
      text,
    ],
  ];
}
