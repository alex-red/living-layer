# Desktop node

A small program on a desktop (CachyOS with KDE Plasma 6 first, macOS for development) that the lab finds on the network, adopts with one click, and attaches to a monitor in the office. Through it the lab turns the display on and off, opens a web page, and shows a banner. It is built to demo: adopting shows a banner on the real screen, and the iso monitor goes dark with the real one.

## Shape

It works the way shared cameras do (`scripts/share-camera.sh`): the node advertises itself over mDNS and the server connects to it. The browser never talks to a node, and the server stays loopback-only.

```
lab (browser) ──/api/nodes──▶ server ──HTTP + token──▶ node (LAN, port 43440) ──▶ kscreen-doctor, xdg-open, notify-send
                                 ◀── mDNS _livinglayer-node._tcp ──┘
```

An adopted node's display is an ordinary switch entity, `switch.node_<id>_display`, so fixture control, rules, zone steps and the Home Assistant entities take it as they are. Only the banner and opening a page are new: two zone steps.

## Status

All five phases are built. Checked end to end on macOS against a node in `--dry-run`: found over mDNS, adopted, a banner, the display off through the monitor's switch, forgotten. **Not yet run on a real CachyOS machine**: the KDE, GNOME, Hyprland and X11 commands are unit-tested only. Run `living-layer-node doctor` there first.

## Phases

1. **The node** (`apps/node/`). One Bun file, compiled to a single binary for Linux. HTTP: `GET /info` (open), `POST /pair` (first caller gets the token), `GET /status` and `POST /command` (token). Commands are a closed set: `display`, `open`, `banner` (`desktopNodeCommandSchema` in `packages/domain/src/desktop-node.ts`), each run with `execFile`-style argument lists, never a shell. `install` writes a systemd user service: it has to run in the user's session to reach Wayland and D-Bus.
2. **Server.** `apps/server/src/nodes.ts`, `/api/nodes`: browse (the camera browse with the service as a parameter), adopt, forget, command; adopted nodes in `settings` under `nodes`, tokens never sent to the browser; `/status` polled every 10 s. The display entity joins `entities(mode)` and `switchLive` routes it to the node, beside MQTT. A virtual node in demo mode, which makes no network calls.
3. **Web.** A _Desktops_ section in the setup card: found nodes, _Adopt_ onto one of the office's monitors (made a Thing with `promoteBuiltIn`, its control the display entity). The inspector: display toggle, open a URL, show a banner, online dot. The iso monitor's screen dark while the display is off.
4. **Zone steps** `banner` and `open` (`zone-actions.ts`, run by `runZoneSteps`), and the rule editor's steps for them.
5. **CachyOS.** `living-layer-node doctor` checks, on the desktop, the programs each command needs, the session (Wayland or X11, D-Bus) and avahi, and names the `pacman` package for what is missing; `run` warns of the same. Still to do: try the KDE backend on the real machine.

## Desktop backends

`commandArgv` (`apps/node/src/desktop.ts`) picks the commands from the desktop the node detects.

|         | KDE Plasma 6                              | GNOME                                | Hyprland                | X11               | macOS                                     |
| ------- | ----------------------------------------- | ------------------------------------ | ----------------------- | ----------------- | ----------------------------------------- |
| display | `kscreen-doctor --dpms off/on`            | Mutter `PowerSaveMode` over `busctl` | `hyprctl dispatch dpms` | `xset dpms force` | `pmset displaysleepnow` / `caffeinate -u` |
| open    | `xdg-open`, kiosk in an installed browser | same                                 | same                    | same              | `open`                                    |
| banner  | `notify-send -a "Living Layer"`           | same                                 | same                    | same              | `osascript` notification                  |

The node can't read the display's real state, so it reports what it last set and whether the command succeeded, like `LampResult`: confirmed means the device reported it, not that anyone saw the screen.

## Decisions

- **Pairing: trust on first use.** The first `POST /pair` gets the token and the screen says who adopted it; after that `/pair` refuses until `living-layer-node unpair`. A code shown on screen and typed in the lab is the safer option if it is ever needed.
- **Live for the real machine, a virtual node in demo mode,** so demo mode keeps making no network calls.

## Running it on CachyOS

```sh
sudo pacman -S --needed avahi libnotify
sudo systemctl enable --now avahi-daemon
./living-layer-node doctor      # what it needs here, and how to get what's missing
./living-layer-node install     # systemd user service, starts now and at login
./living-layer-node run --dry-run   # in a terminal instead: logs each command rather than running it
```

With a firewall on, open 43440/tcp and 5353/udp. `bun run --filter @livinglayer/node build` makes the binary (`apps/node/dist/living-layer-node`). On this Mac, `bun run desktop-node run --dry-run` runs it from source and logs each command instead of running it.

## In the lab

- **Outline → Desktops** lists what it finds (every 15 s; the panel every 4 s). The panel adopts one (or one by address, when the network hides mDNS), and drives it.
- **The office's monitor** becomes its Thing on adopting: _Turn on_ and _Turn off_ are the display, and _On <desktop>_ shows a banner or opens a page.
- **A zone's steps** take _Desktop_: a banner or a page on an adopted desktop; the display is a _Switch_ step on `switch.node_<id>_display`.
- **Forgetting** unpairs the desktop and leaves the monitor a plain thing. A rule that switched it keeps the entity and fails until it is adopted again.

## Demo

1. Start the node. The lab's _Desktops_ lists it within a second or so.
2. _Adopt_: a banner on the real desktop, and the office's monitor lights.
3. Click the monitor, _Show banner_ "Hello". It shows on the real screen.
4. Display off: the real screen and the room's go dark.
5. A rule: when the mug enters the desk zone, display on, open the dashboard, banner "Coffee's here". Put the mug down.
