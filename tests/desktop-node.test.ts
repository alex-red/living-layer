import { describe, expect, it } from 'bun:test';
import { desktopNodeCommandSchema, type DesktopNodeCommand } from '@livinglayer/domain';
import { commandArgv, detectDesktop } from '../apps/node/src/desktop.js';
import { createNode, type Identity } from '../apps/node/src/handler.js';
import { advertiseArgv, systemdUnit } from '../apps/node/src/system.js';

const off: DesktopNodeCommand = { kind: 'display', to: 'off' };

describe('which desktop the node is on', () => {
  it('reads KDE Plasma from XDG_CURRENT_DESKTOP', () => {
    expect(
      detectDesktop('linux', { XDG_CURRENT_DESKTOP: 'KDE', WAYLAND_DISPLAY: 'wayland-0' }),
    ).toBe('kde');
  });
  it('reads a colon list such as ubuntu:GNOME', () => {
    expect(detectDesktop('linux', { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBe('gnome');
  });
  it('knows Hyprland by its instance signature alone', () => {
    expect(detectDesktop('linux', { HYPRLAND_INSTANCE_SIGNATURE: 'abc' })).toBe('hyprland');
  });
  it('falls back to X11 when there is a DISPLAY and no Wayland', () => {
    expect(detectDesktop('linux', { DISPLAY: ':0' })).toBe('x11');
  });
  it('is macOS on darwin whatever the environment says', () => {
    expect(detectDesktop('darwin', { XDG_CURRENT_DESKTOP: 'KDE' })).toBe('macos');
  });
});

describe('the commands for each desktop', () => {
  it('turns a KDE display off through kscreen-doctor', () => {
    expect(commandArgv(off, 'kde')).toEqual([['kscreen-doctor', '--dpms', 'off']]);
  });
  it('sets Mutter’s power save mode to 3 for a GNOME display off', () => {
    expect(commandArgv(off, 'gnome')?.[0]?.at(-1)).toBe('3');
  });
  it('wakes a Mac display with caffeinate', () => {
    expect(commandArgv({ kind: 'display', to: 'on' }, 'macos')).toEqual([
      ['caffeinate', '-u', '-t', '2'],
    ]);
  });
  it('can’t switch the display on a desktop it doesn’t know', () => {
    expect(commandArgv(off, 'unknown')).toBeNull();
  });
  it('opens a page in the default browser unless asked for a kiosk', () => {
    expect(commandArgv({ kind: 'open', url: 'https://example.com' }, 'kde', ['firefox'])).toEqual([
      ['xdg-open', 'https://example.com'],
    ]);
  });
  it('opens a kiosk page in the best installed browser', () => {
    const open: DesktopNodeCommand = { kind: 'open', url: 'https://example.com', kiosk: true };
    expect(commandArgv(open, 'kde', ['firefox', 'chromium'])).toEqual([
      ['chromium', '--app=https://example.com', '--start-fullscreen'],
    ]);
  });
  it('passes a banner’s words as arguments after --, never as options', () => {
    const banner: DesktopNodeCommand = { kind: 'banner', title: '--help', text: 'hi', seconds: 3 };
    const argv = commandArgv(banner, 'kde')![0]!;
    expect(argv.slice(-3)).toEqual(['--', '--help', 'hi']);
    expect(argv).toContain('--expire-time=3000');
  });
  it('hands a Mac banner’s words to AppleScript as arguments, not as script', () => {
    const banner: DesktopNodeCommand = { kind: 'banner', title: '" & quit', text: 'x' };
    const argv = commandArgv(banner, 'macos')![0]!;
    expect(argv.slice(-2)).toEqual(['" & quit', 'x']);
    expect(argv.filter((a) => a.includes('quit'))).toHaveLength(1);
  });
});

describe('the command schema', () => {
  it('refuses a page that is not http or https', () => {
    expect(
      desktopNodeCommandSchema.safeParse({ kind: 'open', url: 'file:///etc/passwd' }).success,
    ).toBe(false);
  });
  it('refuses a field it doesn’t know', () => {
    expect(
      desktopNodeCommandSchema.safeParse({ kind: 'display', to: 'off', argv: ['rm'] }).success,
    ).toBe(false);
  });
});

function node(desktop: 'kde' | 'unknown' = 'kde', fail = false) {
  const identity: Identity = { id: 'n1', name: 'cachy-desk', token: null, adoptedBy: null };
  const ran: string[][] = [];
  const saved: Identity[] = [];
  const n = createNode({
    identity,
    save: (i) => saved.push({ ...i }),
    desktop,
    os: 'linux',
    run: async (argv) => {
      ran.push(argv);
      return fail ? { ok: false, error: 'no display' } : { ok: true };
    },
    now: () => new Date('2026-11-03T10:00:00Z'),
  });
  const call = (method: string, path: string, body?: unknown, token?: string) =>
    n.fetch(
      new Request(`http://node${path}`, {
        method,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const pair = async () =>
    ((await (await call('POST', '/pair', { by: 'lab' })).json()) as { token: string }).token;
  return { call, pair, ran, saved };
}

describe('the node’s API', () => {
  it('tells anyone who it is and that it isn’t adopted yet', async () => {
    const info = await (await node().call('GET', '/info')).json();
    expect(info).toMatchObject({ id: 'n1', name: 'cachy-desk', desktop: 'kde', adopted: false });
  });
  it('gives the first lab to pair a token, saves it, and says so on screen', async () => {
    const n = node();
    const token = await n.pair();
    expect(token.length).toBeGreaterThan(20);
    expect(n.saved.at(-1)).toMatchObject({ token, adoptedBy: 'lab' });
    expect(n.ran[0]?.[0]).toBe('notify-send');
  });
  it('refuses a second lab once adopted', async () => {
    const n = node();
    await n.pair();
    expect((await n.call('POST', '/pair', { by: 'other' })).status).toBe(409);
  });
  it('refuses a command without its token', async () => {
    const n = node();
    await n.pair();
    expect((await n.call('POST', '/command', off, 'wrong')).status).toBe(401);
    expect(n.ran).toHaveLength(1);
  });
  it('runs a command with its token and remembers the display it set', async () => {
    const n = node();
    const token = await n.pair();
    expect((await n.call('POST', '/command', off, token)).status).toBe(200);
    expect(n.ran.at(-1)).toEqual(['kscreen-doctor', '--dpms', 'off']);
    expect(await (await n.call('GET', '/status', undefined, token)).json()).toEqual({
      display: 'off',
      last: { kind: 'display', at: '2026-11-03T10:00:00.000Z', ok: true },
    });
  });
  it('answers 502 with the error when the desktop command fails, and keeps the display unknown', async () => {
    const n = node('kde', true);
    const token = await n.pair();
    const response = await n.call('POST', '/command', off, token);
    expect(response.status).toBe(502);
    const status = (await (await n.call('GET', '/status', undefined, token)).json()) as {
      display: unknown;
    };
    expect(status.display).toBeNull();
  });
  it('refuses a display command on a desktop it can’t drive, running nothing', async () => {
    const n = node('unknown');
    const token = await n.pair();
    const ran = n.ran.length;
    expect((await n.call('POST', '/command', off, token)).status).toBe(502);
    expect(n.ran).toHaveLength(ran);
  });
  it('forgets its lab on unpair, so another may adopt it', async () => {
    const n = node();
    const token = await n.pair();
    expect((await n.call('POST', '/unpair', {}, token)).status).toBe(200);
    expect((await n.call('POST', '/command', off, token)).status).toBe(401);
    expect((await n.call('POST', '/pair', { by: 'other' })).status).toBe(200);
  });
});

describe('advertising and installing', () => {
  it('advertises the node service with avahi on Linux, its id and caps in TXT', () => {
    const argv = advertiseArgv('linux', { id: 'n1', name: 'desk', port: 43440, caps: ['display'] });
    expect(argv.slice(0, 4)).toEqual([
      'avahi-publish-service',
      'desk',
      '_livinglayer-node._tcp',
      '43440',
    ]);
    expect(argv).toContain('id=n1');
    expect(argv).toContain('caps=display');
  });
  it('starts the service with the graphical session, quoting a path with spaces', () => {
    const unit = systemdUnit(['/home/me/My Apps/living-layer-node', 'run']);
    expect(unit).toContain('ExecStart="/home/me/My Apps/living-layer-node" run');
    expect(unit).toContain('WantedBy=graphical-session.target');
  });
});
