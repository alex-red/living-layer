import { describe, expect, it, mock } from 'bun:test';
import { parseConfig, type Fetcher } from '../apps/server/src/config.js';
import { ControlAdapter } from '../apps/server/src/control.js';
import { HaLive } from '../apps/server/src/ha-live.js';
import type { OpenSocket } from '../apps/server/src/ha.js';
import { tempDir, testApp } from './lib/app.js';

type Sent = Record<string, unknown> & { id?: number; type: string };
/**
 * A Home Assistant websocket: signs in with `token`, answers
 * `subscribe_entities` with `states`, and pushes `on` from each service call.
 */
function fakeHa(
  states: Record<string, { s: string; a?: Record<string, unknown> }>,
  {
    token = 'good',
    onCall,
  }: { token?: string; onCall?: (m: Sent, push: (c: object) => void) => void } = {},
) {
  const sockets: {
    sent: Sent[];
    closed: boolean;
    drop(): void;
    push(event: object): void;
  }[] = [];
  const openSocket: OpenSocket = () => {
    const listeners: Record<string, ((e: { data: unknown }) => void)[]> = {};
    const fire = (type: string, data?: unknown) =>
      queueMicrotask(() => {
        for (const l of listeners[type] ?? []) l({ data: JSON.stringify(data) });
      });
    let sub = 0;
    const record = {
      sent: [] as Sent[],
      closed: false,
      drop() {
        record.closed = true;
        fire('close');
      },
      push: (event: object) => fire('message', { id: sub, type: 'event', event }),
    };
    sockets.push(record);
    fire('message', { type: 'auth_required' });
    return {
      send(data) {
        const m = JSON.parse(data) as Sent;
        record.sent.push(m);
        if (m.type === 'auth')
          fire('message', { type: m.access_token === token ? 'auth_ok' : 'auth_invalid' });
        else if (m.type === 'subscribe_entities') {
          sub = m.id!;
          fire('message', { id: sub, type: 'result', success: true, result: null });
          record.push({ a: states });
        } else if (m.type === 'call_service') {
          fire('message', { id: m.id, type: 'result', success: true, result: {} });
          onCall?.(m, record.push);
        }
      },
      close() {
        record.closed = true;
      },
      addEventListener(type: string, l: (e: { data: unknown }) => void) {
        (listeners[type] ??= []).push(l);
      },
    } as ReturnType<OpenSocket>;
  };
  return { openSocket, sockets };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Waits up to 2 s for `ok`: the first reconnect is half a second away. */
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};
const connection = { url: 'http://ha.local:8123', token: 'good' };

describe('Home Assistant websocket', () => {
  it('holds every state from one list, then only what changes', async () => {
    const ha = fakeHa({ 'light.desk': { s: 'off', a: { brightness: null } } });
    const live = new HaLive(() => connection, ha.openSocket);
    expect(live.state('light.desk')).toBeUndefined();
    live.start();
    await until(() => live.ready());
    expect(ha.sockets[0]!.sent.map((m) => m.type)).toEqual(['auth', 'subscribe_entities']);
    expect(live.state('light.desk')?.state).toBe('off');
    const heard: string[][] = [];
    live.subscribe((changed) => heard.push(changed));
    ha.sockets[0]!.push({ c: { 'light.desk': { '+': { s: 'on', a: { brightness: 200 } } } } });
    ha.sockets[0]!.push({ c: { 'sensor.other': { '+': { s: '3' } } } });
    await until(() => heard.length > 0);
    expect(live.state('light.desk')).toEqual({ state: 'on', attributes: { brightness: 200 } });
    expect(heard).toEqual([['light.desk']]);
    live.stop();
    expect(ha.sockets[0]!.closed).toBe(true);
    expect(live.link).toBe('off');
  });
  it('reconnects when the socket drops and starts again from the full list', async () => {
    const states = { 'light.desk': { s: 'off' } };
    const ha = fakeHa(states);
    const live = new HaLive(() => connection, ha.openSocket);
    live.start();
    await until(() => live.ready());
    states['light.desk'] = { s: 'on' };
    ha.sockets[0]!.drop();
    await until(() => live.link === 'unreachable');
    expect(live.state('light.desk')).toBeUndefined();
    await until(() => live.ready());
    expect(ha.sockets).toHaveLength(2);
    expect(live.state('light.desk')?.state).toBe('on');
    live.stop();
  });
  it('says the token was refused and opens again for a new sign-in', async () => {
    let token = 'revoked';
    const ha = fakeHa({ 'light.desk': { s: 'on' } });
    const live = new HaLive(() => ({ ...connection, token }), ha.openSocket);
    live.start();
    await until(() => live.link === 'unauthorized');
    expect(live.ready()).toBe(false);
    token = 'good';
    live.refresh();
    await until(() => live.ready());
    expect(ha.sockets).toHaveLength(2);
    live.stop();
  });
});

describe('switching over the websocket', () => {
  const haConfig = () =>
    parseConfig({
      DATA_DIR: tempDir('ha-live'),
      HA_URL: connection.url,
      HA_TOKEN: connection.token,
      HA_ENTITY_ID: 'light.desk',
      HA_LIVE_ENABLED: 'true',
    });
  it('needs no read first, calls the service on the socket and confirms by the pushed state', async () => {
    const ha = fakeHa(
      { 'light.desk': { s: 'off', a: { supported_color_modes: ['brightness'] } } },
      {
        onCall: (_m, push) =>
          setTimeout(
            () => push({ c: { 'light.desk': { '+': { s: 'on', a: { brightness: 217 } } } } }),
            20,
          ),
      },
    );
    const live = new HaLive(() => connection, ha.openSocket);
    live.start();
    await until(() => live.ready());
    const fetcher = mock<Fetcher>();
    const result = await new ControlAdapter(haConfig(), fetcher, undefined, { live }).turnOn(
      'light.desk',
      { kind: 'warm', brightness: 85 },
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stateConfirmed: true, state: 'on' });
    expect(ha.sockets[0]!.sent.find((m) => m.type === 'call_service')).toMatchObject({
      domain: 'light',
      service: 'turn_on',
      service_data: { entity_id: 'light.desk', brightness_pct: 85, transition: 0 },
    });
    live.stop();
  });
  it('refuses a device Home Assistant reports unavailable, without sending anything', async () => {
    const ha = fakeHa({ 'light.desk': { s: 'unavailable' } });
    const live = new HaLive(() => connection, ha.openSocket);
    live.start();
    await until(() => live.ready());
    const fetcher = mock<Fetcher>();
    const adapter = new ControlAdapter(haConfig(), fetcher, undefined, { live });
    expect(adapter.turnOn('light.desk')).rejects.toMatchObject({ code: 'ha_unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(ha.sockets[0]!.sent.some((m) => m.type === 'call_service')).toBe(false);
    live.stop();
  });
  it('lists the switchable entities from the states it holds', async () => {
    const ha = fakeHa({
      'light.desk': { s: 'on', a: { friendly_name: 'Desk lamp' } },
      'sensor.temp': { s: '21' },
    });
    const live = new HaLive(() => connection, ha.openSocket);
    live.start();
    await until(() => live.ready());
    const fetcher = mock<Fetcher>();
    const entities = await new ControlAdapter(haConfig(), fetcher, undefined, {
      live,
    }).entities();
    expect(entities).toEqual([
      { entityId: 'light.desk', name: 'Desk lamp', domain: 'light', state: 'on' },
    ]);
    expect(fetcher).not.toHaveBeenCalled();
    live.stop();
  });
});

describe('the lab and the websocket', () => {
  it('opens only once listening, says how it went, and streams the devices’ states', async () => {
    const ha = fakeHa({ 'light.desk': { s: 'on' }, 'sensor.temp': { s: '21' } });
    // The lab answers its own port only, so it listens on one picked here.
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const { app } = await testApp({
      name: 'ha-live',
      env: {
        HA_URL: connection.url,
        HA_TOKEN: connection.token,
        HA_ENTITY_ID: 'light.desk',
        PORT: String(port),
      },
      haSocket: ha.openSocket,
    });
    const link = async () => (await app.inject('/api/status')).json().ha.link;
    expect(await link()).toBe('off');
    expect(ha.sockets).toHaveLength(0);
    await app.listen({ host: '127.0.0.1', port });
    for (let i = 0; i < 200 && (await link()) !== 'connected'; i++) await tick();
    expect(await link()).toBe('connected');
    const events = await fetch(`http://127.0.0.1:${port}/api/watch/live/events`);
    const reader = events.body!.getReader();
    let text = '';
    while (!text.includes('event: ha'))
      text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    const line = text.split('event: ha\ndata: ')[1]!.split('\n')[0]!;
    expect(JSON.parse(line)).toEqual({ link: 'connected', states: { 'light.desk': 'on' } });
  });
});
