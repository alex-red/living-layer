import { useState } from 'react';
import {
  roomScreens,
  type DeskMemory,
  type DesktopNodeView,
  type LampResult,
} from '@livinglayer/domain';
import { Button, Check, Field, Select } from '../ui/controls';
import { useDesk, useFeedback, useLabParts, useNavigation, useView } from './LabContext';
import { Details, Panel, useCall, type Tone } from './panel';
import { keepNodes, useDesktopNodes } from './state/nodes';
import './desktops.css';

/** How often the panel asks again: a node started meanwhile shows within this. */
const POLL_MS = 4000;
const SETUP = `sudo pacman -S --needed avahi libnotify
sudo systemctl enable --now avahi-daemon
./living-layer-node install`;

const DESKTOP_LABEL: Record<DesktopNodeView['desktop'], string> = {
  kde: 'KDE Plasma',
  gnome: 'GNOME',
  hyprland: 'Hyprland',
  x11: 'X11',
  macos: 'macOS',
  unknown: 'unknown desktop',
};

/**
 * Desktops the lab can drive: found on the network (or typed in), adopted
 * with one click, and attached to the office's monitor, whose switch is the
 * desktop's display. From here or the monitor's panel: the display, a
 * banner, a page.
 */
export function DesktopsPanel() {
  const lab = useLabParts(useView(), useDesk(), useFeedback(), useNavigation());
  const nodes = useDesktopNodes(lab.mode, POLL_MS);
  const { call, off } = useCall();
  const adopted = nodes.filter((n) => n.adopted);
  const adopt = (node: { id?: string; host?: string; port?: number }, name: string) =>
    void call<{ nodes: DesktopNodeView[]; memory: DeskMemory; fixtureId: string | null }>(
      'nodes/adopt',
      node,
      (r) => {
        keepNodes(lab.mode, r.nodes);
        lab.setMemory(r.memory, false);
        const monitor = r.memory.fixtures?.find((f) => f.id === r.fixtureId);
        lab.setMessage(
          monitor
            ? `Adopted ${name}: ${monitor.label} in the room is its display now.`
            : `Adopted ${name}. Link it to a monitor in your room to see its display there.`,
        );
      },
    );
  const [summary, tone]: [string, Tone] = !nodes.length
    ? [
        lab.mode === 'live'
          ? 'Looking for desktops on the network…'
          : 'The demo’s desktop is on its way.',
        'unsure',
      ]
    : adopted.length
      ? [
          `${adopted.length} adopted${adopted.some((n) => !n.online) ? ', one not answering' : ''}.`,
          adopted.every((n) => n.online) ? 'ok' : 'unsure',
        ]
      : [`${nodes.length} found. Adopt one to drive its screen.`, 'seen'];
  return (
    <Panel tiny="DESKTOPS" title="Desktops it can drive" status={summary} tone={tone}>
      <p className="micro">
        A desktop running <code>living-layer-node</code> lets Living Layer wake or sleep its
        display, show a banner and open a page, from here, from its monitor in the office, or as a
        zone’s step.
        {lab.mode === 'demo' && ' In the demo it is virtual: nothing leaves this machine.'}
      </p>
      <ul className="dn-list">
        {nodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n}
            disabled={off}
            onAdopt={() => adopt({ id: n.id }, n.name)}
            onOpenMonitor={() => n.fixtureId && lab.select({ kind: 'fixture', id: n.fixtureId })}
          />
        ))}
      </ul>
      {lab.mode === 'live' && <ByAddress disabled={off} onAdopt={adopt} />}
      {lab.mode === 'live' && (
        <Details summary="Set up a desktop">
          <p className="micro">
            On the desktop (CachyOS, or any Linux with KDE Plasma, GNOME or Hyprland), copy the{' '}
            <code>living-layer-node</code> binary over, then:
          </p>
          <pre className="devices-snippet">{SETUP}</pre>
          <p className="micro">
            It runs in your session from then on, and shows up here within a few seconds. With a
            firewall on, open 43440/tcp and 5353/udp. On a Mac, run{' '}
            <code>bun run desktop-node run</code> from this repo.
          </p>
        </Details>
      )}
    </Panel>
  );
}

function NodeCard({
  node: n,
  disabled,
  onAdopt,
  onOpenMonitor,
}: {
  node: DesktopNodeView;
  disabled: boolean;
  onAdopt: () => void;
  onOpenMonitor: () => void;
}) {
  const { call, off } = useCall();
  const lab = useLabParts(useView(), useDesk(), useFeedback());
  const screens = lab.memory ? roomScreens(lab.memory) : [];
  // Only a monitor in the room being worked in: one elsewhere (the office preset's) isn't this room's.
  const monitor = screens.find((f) => f.id === n.fixtureId);
  const [chosen, setChosen] = useState('');
  const pick = screens.find((f) => f.id === chosen) ?? screens.find((f) => f.id !== monitor?.id);
  const link = (fixtureId: string) =>
    void call<{ nodes: DesktopNodeView[]; memory: DeskMemory; fixtureId: string }>(
      'nodes/link',
      { id: n.id, fixtureId },
      (r) => {
        keepNodes(lab.mode, r.nodes);
        lab.setMemory(r.memory, false);
        const f = r.memory.fixtures?.find((x) => x.id === r.fixtureId);
        lab.setMessage(`${f?.label ?? 'That thing'} is ${n.name}’s display now.`);
      },
    );
  const forget = () =>
    void call<{ nodes: DesktopNodeView[]; memory: DeskMemory }>(
      'nodes/forget',
      { id: n.id },
      (r) => {
        keepNodes(lab.mode, r.nodes);
        lab.setMemory(r.memory, false);
        lab.setMessage(`Forgot ${n.name}; it can be adopted again.`);
      },
    );
  return (
    <li className={`dn-card ${n.online ? 'online' : 'offline'}`}>
      <div className="dn-head">
        <span className="dn-dot" aria-hidden="true" />
        <strong>{n.name}</strong>
        <span className="micro">
          {DESKTOP_LABEL[n.desktop]} · {n.address}
          {n.adopted && !n.online && ' · not answering'}
        </span>
      </div>
      {!n.adopted ? (
        <div className="save-actions">
          <Button
            variant="primary"
            disabled={disabled || n.taken || !n.online}
            title={n.taken ? 'Another lab adopted it' : undefined}
            onClick={onAdopt}
          >
            Adopt
          </Button>
          {n.taken && (
            <p className="micro">
              Another lab adopted it. Run <code>living-layer-node unpair</code> on it first.
            </p>
          )}
        </div>
      ) : (
        <>
          <DesktopControls node={n} disabled={disabled || off || !n.online} />
          <div className="save-actions">
            {monitor ? (
              <Button variant="text" onClick={onOpenMonitor}>
                Its monitor, {monitor.label} →
              </Button>
            ) : !screens.length ? (
              <p className="micro">
                No monitor in this room yet. Add one to the room, then link it here.
              </p>
            ) : null}
          </div>
          {pick && (
            <div className="save-actions">
              <Field label={monitor ? 'Another monitor' : 'Its monitor in this room'}>
                <Select
                  value={pick.id}
                  disabled={disabled || off}
                  options={screens
                    .filter((f) => f.id !== monitor?.id)
                    .map((f) => ({ value: f.id, label: f.label }))}
                  onChange={setChosen}
                />
              </Field>
              <Button disabled={disabled || off} onClick={() => link(pick.id)}>
                Link
              </Button>
            </div>
          )}
          {lab.mode === 'live' && (
            <Details summary="Forget">
              <p className="micro">
                The desktop forgets this lab, and its monitor stays in the office as a plain thing.
              </p>
              <Button disabled={disabled || off} onClick={forget}>
                Forget {n.name}
              </Button>
            </Details>
          )}
        </>
      )}
    </li>
  );
}

/** For a network that hides mDNS (a venue's Wi-Fi): adopt a desktop by its address. */
function ByAddress({
  disabled,
  onAdopt,
}: {
  disabled: boolean;
  onAdopt: (at: { host: string; port?: number }, name: string) => void;
}) {
  const [address, setAddress] = useState('');
  const [host = '', portText] = address.trim().split(':');
  const port = portText ? Number(portText) : undefined;
  const valid =
    /^[\w.-]{1,253}$/.test(host) &&
    (port === undefined || (Number.isInteger(port) && port > 0 && port < 65536));
  return (
    <Details summary="Not listed? Adopt by address">
      <form
        className="devices-login"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onAdopt({ host, ...(port ? { port } : {}) }, host);
        }}
      >
        <Field
          label="Address"
          hint="Its IP address, as the desktop’s `ip addr` shows it; port 43440 unless you changed it."
        >
          <input
            value={address}
            placeholder="192.168.1.40"
            onChange={(e) => setAddress(e.target.value)}
            inputMode="url"
          />
        </Field>
        <div className="save-actions">
          <Button variant="primary" type="submit" disabled={disabled || !valid}>
            Adopt
          </Button>
        </div>
      </form>
    </Details>
  );
}

/**
 * A desktop's display, a banner and a page: the Desktops panel's card and
 * the monitor's own panel both show these.
 */
export function DesktopControls({
  node,
  disabled,
  display: showDisplay = true,
}: {
  node: DesktopNodeView;
  disabled: boolean;
  /** Its own display buttons; the monitor's panel has its on and off already. */
  display?: boolean;
}) {
  const lab = useLabParts(useDesk(), useFeedback());
  const { call, off } = useCall();
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [kiosk, setKiosk] = useState(false);
  const busy = disabled || off;
  const send = (
    command:
      | { kind: 'display'; to: 'on' | 'off' }
      | { kind: 'banner'; title: string }
      | { kind: 'open'; url: string; kiosk?: boolean },
    done: string,
  ) =>
    void call<{ memory: DeskMemory; lamp: LampResult | null }>(
      'nodes/command',
      { id: node.id, command },
      (r) => {
        lab.setMemory(r.memory, false);
        lab.setMessage(r.lamp?.explanation ?? done);
      },
    );
  const display = node.status?.display;
  const page =
    url.trim() && !/^https?:\/\//i.test(url.trim()) ? `https://${url.trim()}` : url.trim();
  return (
    <div className="dn-controls">
      {showDisplay && (
        <div className="save-actions">
          <Button
            variant={display === 'on' ? 'primary' : 'secondary'}
            disabled={busy || !node.caps.includes('display')}
            onClick={() => send({ kind: 'display', to: 'on' }, `Woke ${node.name}’s display.`)}
          >
            Display on
          </Button>
          <Button
            variant={display === 'off' ? 'primary' : 'secondary'}
            disabled={busy || !node.caps.includes('display')}
            onClick={() =>
              send({ kind: 'display', to: 'off' }, `Put ${node.name}’s display to sleep.`)
            }
          >
            Display off
          </Button>
        </div>
      )}
      <form
        className="dn-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim())
            send(
              { kind: 'banner', title: title.trim() },
              `Showed “${title.trim()}” on ${node.name}.`,
            );
        }}
      >
        <input
          aria-label="Banner"
          placeholder="A banner, like Coffee’s here"
          maxLength={80}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button type="submit" disabled={busy || !title.trim()}>
          Show
        </Button>
      </form>
      <form
        className="dn-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (page)
            send(
              { kind: 'open', url: page, ...(kiosk ? { kiosk } : {}) },
              `Opened ${page} on ${node.name}.`,
            );
        }}
      >
        <input
          aria-label="Page"
          placeholder="A page, like example.com"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button type="submit" disabled={busy || !page}>
          Open
        </Button>
      </form>
      <Check checked={kiosk} onChange={setKiosk} disabled={busy}>
        Full screen, nothing around it
      </Check>
      {node.status?.last && !node.status.last.ok && (
        <p className="micro">Last try failed: {node.status.last.error ?? 'no reason given'}.</p>
      )}
    </div>
  );
}
