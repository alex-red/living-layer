import { useEffect, useState } from 'react';
import type { EvidenceRun, LampResult } from '@livinglayer/domain';
import { api } from '../api';
import { Button, Check, Field } from '../ui/controls';
import { useDesk, useFeedback, useLabParts, useNavigation, useView } from './LabContext';
import { Details, Panel, useCall, type Tone } from './panel';

/** One device Home Assistant has that Living Layer could switch (`GET /api/ha/entities`). */
interface HaEntity {
  entityId: string;
  name: string;
  domain: 'light' | 'switch' | 'fan' | 'input_boolean';
  state: string;
}
const DOMAIN_LABEL: Record<HaEntity['domain'], string> = {
  light: 'Lights',
  switch: 'Switches',
  fan: 'Fans',
  input_boolean: 'Helper toggles',
};
/** The server keeps at most this many (`MAX_CHOSEN`). */
const MAX_CHOSEN = 24;
const ENV_SNIPPET = `HA_URL=http://homeassistant.local:8123
HA_TOKEN=paste-the-long-lived-token-here`;

/**
 * Home Assistant, for switching: sign in (or `.env`), tick the few devices
 * Living Layer may switch, try each one, then use them in rules and fixtures.
 */
export function DevicesPanel() {
  const lab = useLabParts(useView(), useDesk());
  const { mode, status } = lab;
  const ha = status?.ha;
  const ready = lab.entities;
  const live = mode === 'live';
  const [list, setList] = useState<HaEntity[] | null>(null);
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true);
    setListError('');
    try {
      setList((await api<{ entities: HaEntity[] }>('ha/entities')).entities);
    } catch (e) {
      setList(null);
      setListError(e instanceof Error ? e.message : 'Home Assistant could not be reached.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (live && ha?.connected) void load();
  }, [live, ha?.connected]);
  const names = new Map(list?.map((e) => [e.entityId, e.name]));
  const [summary, tone]: [string, Tone] = !live
    ? ['Demo: these virtual devices stand in for yours. Switch to Live to use your own.', 'seen']
    : !ha?.connected && !ha?.overMqtt.length
      ? ['Not connected yet: sign in below.', 'unsure']
      : !ready.length
        ? ['Connected. Tick the devices it may switch.', 'unsure']
        : ha?.connected && !ha.enabled && !ha.overMqtt.length
          ? [
              `${count(ready.length)} chosen, but switching is off: HA_LIVE_ENABLED=false in .env.`,
              'unsure',
            ]
          : [`${count(ready.length)} ready to switch.`, 'ok'];
  return (
    <Panel tiny="HOME ASSISTANT" title="Devices it can switch" status={summary} tone={tone}>
      <p className="micro">
        Living Layer turns a device on when something lands in a zone (a rule), or when you press a
        fixture’s button. It only ever touches the devices ticked here, sends one request each time,
        and checks that Home Assistant reports the new state.
      </p>
      {live && <ConnectStep />}
      {live && ha?.connected && (
        <ChooseStep list={list} error={listError} loading={loading} onReload={() => void load()} />
      )}
      {ready.length > 0 && <TryStep names={names} />}
      <Details summary="Use them">
        <ul className="devices-uses">
          <li>
            <strong>Rules</strong>: under Rules, Add rule, draw a zone and pick a device in “turn
            on”. Tick “and off again when it empties” for a light that follows you.
          </li>
          <li>
            <strong>Fixtures</strong>: a lamp or a fan in the room can be tied to its device, then
            switched from its panel or the room.
          </li>
          <li>
            <strong>The other way</strong>: Show in Home Assistant gives Home Assistant sensors of
            Living Layer’s own (who’s at the desk, a missing mug), for its automations.
          </li>
        </ul>
      </Details>
      <Details summary="More than on and off">
        <p className="micro">
          Living Layer only turns things on and off; a light it turns on goes to 85%, warm white
          where it can. To do more (a scene, a colour, the heating), make a toggle helper in Home
          Assistant (Settings → Devices &amp; services → Helpers → Toggle), tick it here, and let an
          automation do the rest when it turns on.
        </p>
      </Details>
    </Panel>
  );
}

/**
 * Step one: sign in to Home Assistant (the server trades the password for a
 * token of its own and keeps only that), or `.env`'s URL and token.
 */
function ConnectStep() {
  const lab = useLabParts(useFeedback(), useDesk());
  const ha = lab.status?.ha;
  const { call, off } = useCall();
  const [url, setUrl] = useState('http://homeassistant.local:8123');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState<{ flowId: string; message: string } | null>(null);
  const done = Boolean(ha?.connected && ha.enabled);
  function submit() {
    void call<{ kind: 'done'; user: string } | { kind: 'code'; flowId: string; message: string }>(
      'ha/login',
      { url, username, password, ...(mfa ? { flowId: mfa.flowId, code } : {}) },
      (r) => {
        if (r.kind === 'code') {
          setMfa({ flowId: r.flowId, message: r.message });
          setCode('');
          return;
        }
        setMfa(null);
        setPassword('');
        lab.setMessage(`Signed in to Home Assistant as ${r.user}. Now tick the devices.`);
      },
    );
  }
  return (
    <Details summary="1 · Connect" open={!done}>
      {ha?.via === 'login' ? (
        <>
          <ul className="devices-checks">
            <li className="ok">
              Signed in as {ha.user} at {ha.url}.
            </li>
          </ul>
          <p className="micro">
            Living Layer keeps a token of its own, not the password. Home Assistant lists it under
            that user’s profile → Security as “Living Layer …”; delete it there to cut it off.
          </p>
          <div className="save-actions">
            <Button
              disabled={off}
              onClick={() =>
                void call('ha/logout', {}, () =>
                  lab.setMessage(
                    'Signed out. Delete the token in Home Assistant too, to revoke it.',
                  ),
                )
              }
            >
              Sign out
            </Button>
          </div>
        </>
      ) : ha?.via === 'env' ? (
        <ul className="devices-checks">
          <li className="ok">Connected through HA_URL and HA_TOKEN in .env ({ha.url}).</li>
        </ul>
      ) : (
        <form
          className="devices-login"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="micro">
            Sign in as a Home Assistant user, as you would in its app. A user of its own for Living
            Layer is best (Settings → People → Add person, allowed to log in, an administrator so it
            can see every device).
          </p>
          <Field label="Address" hint="As you open it in a browser, with its port.">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={Boolean(mfa)}
              inputMode="url"
              autoComplete="url"
            />
          </Field>
          {mfa ? (
            <Field label="Two-factor code" hint={mfa.message}>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
              />
            </Field>
          ) : (
            <>
              <Field label="Username">
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </Field>
            </>
          )}
          <div className="save-actions">
            <Button
              variant="primary"
              type="submit"
              disabled={off || !url.trim() || (mfa ? !code.trim() : !username.trim() || !password)}
            >
              {off ? 'Signing in…' : mfa ? 'Check code' : 'Sign in'}
            </Button>
            {mfa && (
              <Button variant="text" type="button" onClick={() => setMfa(null)}>
                Start again
              </Button>
            )}
          </div>
          <p className="micro">
            The password goes to Home Assistant once and isn’t kept; the token stays on this
            machine, never in the browser.
          </p>
        </form>
      )}
      {ha?.connected && !ha.enabled && (
        <ul className="devices-checks">
          <li>Switching off: HA_LIVE_ENABLED=false is in .env; remove it to switch.</li>
        </ul>
      )}
      {!ha?.connected && (
        <Details summary="Or a token in .env">
          <p className="micro">
            Make a long-lived token in Home Assistant (your profile → Security → Long-lived access
            tokens), put these in <code>.env</code> and restart the server:
          </p>
          <pre className="devices-snippet">{ENV_SNIPPET}</pre>
          <Button
            variant="text"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(ENV_SNIPPET)
                .then(() => lab.setMessage('Copied the .env lines.'))
                .catch(() => {})
            }
          >
            Copy
          </Button>
        </Details>
      )}
    </Details>
  );
}

/** Step two: what Home Assistant has, ticked to let Living Layer switch it. */
function ChooseStep({
  list,
  error,
  loading,
  onReload,
}: {
  list: HaEntity[] | null;
  error: string;
  loading: boolean;
  onReload: () => void;
}) {
  const lab = useLabParts(useFeedback(), useDesk());
  const ha = lab.status!.ha;
  const { call, off } = useCall();
  const fixed = new Set(ha.fromEnv);
  const [picked, setPicked] = useState(() => new Set(ha.chosen));
  const [query, setQuery] = useState('');
  useEffect(() => setPicked(new Set(ha.chosen)), [ha.chosen.join()]);
  const changed = picked.size !== ha.chosen.length || ha.chosen.some((e) => !picked.has(e));
  const q = query.trim().toLowerCase();
  const shown = (list ?? []).filter(
    (e) => !q || e.name.toLowerCase().includes(q) || e.entityId.includes(q),
  );
  const groups = (Object.keys(DOMAIN_LABEL) as HaEntity['domain'][])
    .map((domain) => ({ domain, items: shown.filter((e) => e.domain === domain) }))
    .filter((g) => g.items.length);
  const missing = [...picked].filter((e) => list && !list.some((x) => x.entityId === e));
  return (
    <Details summary="2 · Choose devices" open={!ha.chosen.length && !ha.fromEnv.length}>
      <p className="micro">
        Tick the few it may switch: the desk lamp, a fan, a monitor plug. Everything else stays out
        of reach.
      </p>
      {error ? (
        <>
          <p className="micro devices-error" role="alert">
            {error}
          </p>
          <Button onClick={onReload} disabled={loading}>
            {loading ? 'Trying…' : 'Try again'}
          </Button>
        </>
      ) : !list ? (
        <p className="micro">Asking Home Assistant what it has…</p>
      ) : (
        <>
          <input
            className="devices-search"
            type="search"
            aria-label="Find a device"
            placeholder={`Find among ${list.length}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="devices-list">
            {groups.map((g) => (
              <fieldset key={g.domain}>
                <legend className="tiny">{DOMAIN_LABEL[g.domain]}</legend>
                {g.items.map((e) => {
                  const env = fixed.has(e.entityId);
                  return (
                    <Check
                      key={e.entityId}
                      checked={env || picked.has(e.entityId)}
                      disabled={env || (!picked.has(e.entityId) && picked.size >= MAX_CHOSEN)}
                      title={env ? 'Named in .env; change it there.' : undefined}
                      onChange={(on) => {
                        const next = new Set(picked);
                        if (on) next.add(e.entityId);
                        else next.delete(e.entityId);
                        setPicked(next);
                      }}
                    >
                      <span className="devices-name">{e.name}</span>
                      <small>
                        {e.entityId} · {e.state}
                        {env ? ' · from .env' : ''}
                      </small>
                    </Check>
                  );
                })}
              </fieldset>
            ))}
            {!groups.length && (
              <p className="micro">
                {list.length
                  ? 'Nothing matches.'
                  : 'Home Assistant has no lights, switches, fans or toggle helpers.'}
              </p>
            )}
          </div>
          {missing.length > 0 && (
            <p className="micro">
              Home Assistant no longer has {missing.join(', ')}; untick it to forget it.
            </p>
          )}
        </>
      )}
      {ha.overMqtt.length > 0 && (
        <p className="micro">
          Also switched over MQTT (MQTT_DEVICES in .env): {ha.overMqtt.join(', ')}.
        </p>
      )}
      <div className="save-actions">
        <Button
          variant="primary"
          disabled={off || !changed}
          onClick={() =>
            void call<{ chosen: string[] }>('ha/chosen', { entityIds: [...picked] }, (r) =>
              lab.setMessage(
                r.chosen.length
                  ? `Living Layer may now switch ${count(r.chosen.length)}. Try one below.`
                  : 'Living Layer switches none of them now.',
              ),
            )
          }
        >
          Save choice
        </Button>
        {list && (
          <Button variant="text" onClick={onReload} disabled={loading}>
            {loading ? 'Reloading…' : 'Reload list'}
          </Button>
        )}
      </div>
    </Details>
  );
}

/** Step three: switch each one by hand, to see it works before a rule does. */
function TryStep({ names }: { names: Map<string, string> }) {
  const lab = useLabParts(useView(), useDesk());
  const { call, off } = useCall();
  const [results, setResults] = useState<Record<string, LampResult>>({});
  const live = lab.mode === 'live';
  const blocked = live && !lab.lampReady;
  return (
    <Details summary="3 · Try them" open>
      <p className="micro">
        {live
          ? 'This switches the real device. Look at it too: Home Assistant reporting “on” isn’t proof the bulb lit.'
          : 'Demo: nothing real is switched.'}
      </p>
      <ul className="devices-try">
        {lab.entities.map((entityId) => {
          const r = results[entityId];
          const act = (action: 'on' | 'off') =>
            void call<EvidenceRun<LampResult>>('lamp', { entityId, action }, (run) =>
              setResults((all) => ({ ...all, [entityId]: run.output })),
            );
          return (
            <li key={entityId}>
              <span>
                <span className="devices-name">{names.get(entityId) ?? entityId}</span>
                <small>
                  {r
                    ? r.stateConfirmed
                      ? `reports ${r.state}`
                      : r.explanation
                    : names.has(entityId)
                      ? entityId
                      : ''}
                </small>
              </span>
              <Button disabled={off || blocked} onClick={() => act('on')}>
                On
              </Button>
              <Button disabled={off || blocked} onClick={() => act('off')}>
                Off
              </Button>
            </li>
          );
        })}
      </ul>
      {blocked && (
        <p className="micro">
          Switching is off: remove HA_LIVE_ENABLED=false from .env and restart.
        </p>
      )}
    </Details>
  );
}

const count = (n: number) => `${n} device${n === 1 ? '' : 's'}`;

/** Where a panel with nothing to switch sends someone: the Home Assistant panel. */
export function ChooseDevicesLink({ why }: { why: string }) {
  const lab = useLabParts(useNavigation());
  return (
    <p className="micro">
      {why}{' '}
      <Button variant="text" onClick={() => lab.select({ kind: 'devices' })}>
        Set up Home Assistant →
      </Button>
    </p>
  );
}
