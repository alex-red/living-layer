import { describe, expect, it } from 'bun:test';
import {
  DESKTOP_NODE_SERVICE,
  desktopNodeEntity,
  fixtureEntity,
  type DesktopNodeCommand,
  type DesktopNodeInfo,
  type DesktopNodeStatus,
  type DesktopNodeView,
} from '@livinglayer/domain';
import { testApp } from './lib/app.js';
import { foundNodes, type FoundNode, type NodeClient } from '../apps/server/src/nodes.js';
import { LabError } from '../apps/server/src/errors.js';

const DEMO = 'demo-desktop';
const demoEntity = desktopNodeEntity(DEMO);

const CACHY: FoundNode = {
  id: '5c067aa2-dfa9-46e3-bec6-bc6c39d3e425',
  name: 'cachy-desk',
  host: '192.168.1.40',
  port: 43440,
  caps: ['display', 'open', 'banner'],
};

/** A node on the network that does what it is told, and remembers what. */
function fakeNode(info: Partial<DesktopNodeInfo> = {}) {
  const sent: DesktopNodeCommand[] = [];
  const paired: string[] = [];
  const unpaired: string[] = [];
  let status: DesktopNodeStatus = { display: null, last: null };
  let token: string | null = null;
  const client: NodeClient = {
    info: async () => ({
      id: CACHY.id,
      name: CACHY.name,
      version: 1,
      os: 'linux',
      desktop: 'kde',
      caps: CACHY.caps,
      adopted: token !== null,
      ...info,
    }),
    pair: async (_h, _p, by) => {
      paired.push(by);
      return { token: (token = 'secret-token-of-the-node') };
    },
    status: async (_h, _p, t) => {
      if (t !== token) throw new LabError('node_unpaired', 'No.', 409);
      return status;
    },
    command: async (_h, _p, _t, command) => {
      sent.push(command);
      status = {
        display: command.kind === 'display' ? command.to : status.display,
        last: { kind: command.kind, at: '2026-11-03T10:00:00.000Z', ok: true },
      };
      return status;
    },
    unpair: async (_h, _p, t) => {
      unpaired.push(t);
      token = null;
    },
  };
  return { client, sent, paired, unpaired };
}

async function liveApp(node = fakeNode()) {
  const t = await testApp({
    desktopNodes: { client: node.client, browse: async () => [CACHY] },
  });
  const live = (path: string, body: object = {}) => t.post(path, { mode: 'live', ...body });
  return { ...t, live, node };
}

describe('desktop nodes in the demo', () => {
  it('lists the virtual office desktop, not adopted yet', async () => {
    const { post } = await testApp();
    const { nodes } = (await post('nodes/list')).json<{ nodes: DesktopNodeView[] }>();
    expect(nodes).toEqual([
      expect.objectContaining({ id: DEMO, adopted: false, online: true, fixtureId: null }),
    ]);
  });

  it('adopting makes the office monitor a Thing switched by the desktop’s display, lit', async () => {
    const { post } = await testApp();
    const r = await post('nodes/adopt', { id: DEMO });
    expect(r.statusCode).toBe(200);
    const { memory, fixtureId, nodes } = r.json();
    const monitor = memory.fixtures.find((f: { id: string }) => f.id === fixtureId);
    expect(monitor).toMatchObject({ scene: 'office', builtIn: 'monitor', state: 'on' });
    expect(fixtureEntity(monitor)).toBe(demoEntity);
    expect(nodes[0]).toMatchObject({ adopted: true, fixtureId });
  });

  it('adopting twice keeps the one monitor', async () => {
    const { post } = await testApp();
    await post('nodes/adopt', { id: DEMO });
    const { memory } = (await post('nodes/adopt', { id: DEMO })).json();
    expect(
      memory.fixtures.filter((f: { builtIn?: string }) => f.builtIn === 'monitor'),
    ).toHaveLength(1);
  });

  it('turns the monitor dark when the display is switched off', async () => {
    const { post } = await testApp();
    const { fixtureId } = (await post('nodes/adopt', { id: DEMO })).json();
    const r = await post('nodes/command', { id: DEMO, command: { kind: 'display', to: 'off' } });
    expect(r.json().lamp).toMatchObject({ entityId: demoEntity, stateConfirmed: true });
    const monitor = r.json().memory.fixtures.find((f: { id: string }) => f.id === fixtureId);
    expect(monitor.state).toBe('off');
  });

  it('switches the display through the fixture like any switch', async () => {
    const { post } = await testApp();
    const { fixtureId } = (await post('nodes/adopt', { id: DEMO })).json();
    const r = await post('fixtures/control', { fixtureId, action: 'off' });
    expect(r.statusCode).toBe(200);
    const { nodes } = (await post('nodes/list')).json<{ nodes: DesktopNodeView[] }>();
    expect(nodes[0]!.status?.display).toBe('off');
  });

  it('keeps the last banner the virtual desktop was sent', async () => {
    const { post } = await testApp();
    await post('nodes/adopt', { id: DEMO });
    await post('nodes/command', { id: DEMO, command: { kind: 'banner', title: 'Hello' } });
    const { nodes } = (await post('nodes/list')).json<{ nodes: DesktopNodeView[] }>();
    expect(nodes[0]!.status?.last?.kind).toBe('banner');
  });

  it('refuses a page that isn’t http or https', async () => {
    const { post } = await testApp();
    const r = await post('nodes/command', {
      id: DEMO,
      command: { kind: 'open', url: 'javascript:alert(1)' },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('desktop nodes, live', () => {
  it('lists a node found on the network as adoptable', async () => {
    const { live } = await liveApp();
    const { nodes } = (await live('nodes/list')).json<{ nodes: DesktopNodeView[] }>();
    expect(nodes).toEqual([
      expect.objectContaining({
        id: CACHY.id,
        address: '192.168.1.40:43440',
        desktop: 'kde',
        adopted: false,
        taken: false,
      }),
    ]);
  });

  it('pairs once on adopting, keeps the token from the page, and offers its display', async () => {
    const { live, get, node } = await liveApp();
    const r = await live('nodes/adopt', { id: CACHY.id });
    expect(r.statusCode).toBe(200);
    expect(node.paired).toHaveLength(1);
    expect(r.body).not.toContain('secret-token');
    expect(node.sent).toEqual([{ kind: 'display', to: 'on' }]);
    const status = (await get('status')).json();
    expect(status.lamp.desktops).toEqual([desktopNodeEntity(CACHY.id)]);
  });

  it('adopts a desktop by its address where mDNS finds nothing', async () => {
    const node = fakeNode();
    const t = await testApp({ desktopNodes: { client: node.client, browse: async () => [] } });
    const r = await t.post('nodes/adopt', { mode: 'live', host: '192.168.1.40' });
    expect(r.statusCode).toBe(200);
    expect(node.paired).toHaveLength(1);
  });

  it('refuses a desktop another lab adopted', async () => {
    const { live, node } = await liveApp(fakeNode({ adopted: true }));
    const r = await live('nodes/adopt', { id: CACHY.id });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('node_taken');
    expect(node.paired).toEqual([]);
  });

  it('switches the display without Home Assistant', async () => {
    const { live, node } = await liveApp();
    const { fixtureId } = (await live('nodes/adopt', { id: CACHY.id })).json();
    const r = await live('fixtures/control', { fixtureId, action: 'off' });
    expect(r.statusCode).toBe(200);
    expect(node.sent.at(-1)).toEqual({ kind: 'display', to: 'off' });
  });

  it('sends a banner to the node', async () => {
    const { live, node } = await liveApp();
    await live('nodes/adopt', { id: CACHY.id });
    const banner = { kind: 'banner', title: 'Coffee’s here', seconds: 5 } as const;
    expect((await live('nodes/command', { id: CACHY.id, command: banner })).statusCode).toBe(200);
    expect(node.sent.at(-1)).toEqual(banner);
  });

  it('forgetting unpairs the node and leaves the monitor a plain thing', async () => {
    const { live, node } = await liveApp();
    const { fixtureId } = (await live('nodes/adopt', { id: CACHY.id })).json();
    const r = await live('nodes/forget', { id: CACHY.id });
    expect(node.unpaired).toEqual(['secret-token-of-the-node']);
    const monitor = r.json().memory.fixtures.find((f: { id: string }) => f.id === fixtureId);
    expect(monitor.control).toEqual({ kind: 'none' });
    expect(r.json().nodes[0]).toMatchObject({ adopted: false });
  });
});

describe('finding nodes over mDNS', () => {
  it('reads a node’s id, name and caps from its TXT record', () => {
    const instance = `cachy-desk.${DESKTOP_NODE_SERVICE}`;
    const records = [
      { name: DESKTOP_NODE_SERVICE, type: 12, target: instance },
      { name: instance, type: 33, port: 43440, target: 'cachy.local' },
      {
        name: instance,
        type: 16,
        text: { id: CACHY.id, name: 'cachy-desk', caps: 'display,banner,teleport', v: '1' },
      },
      { name: 'cachy.local', type: 1, address: '192.168.1.40' },
    ] as Parameters<typeof foundNodes>[0]['records'];
    expect(foundNodes({ records, from: new Map() })).toEqual([
      { ...CACHY, caps: ['display', 'banner'] },
    ]);
  });

  it('skips a node whose id isn’t one', () => {
    const instance = `x.${DESKTOP_NODE_SERVICE}`;
    const records = [
      { name: DESKTOP_NODE_SERVICE, type: 12, target: instance },
      { name: instance, type: 33, port: 1, target: 'x.local' },
      { name: instance, type: 16, text: { id: '../../etc' } },
      { name: 'x.local', type: 1, address: '10.0.0.2' },
    ] as Parameters<typeof foundNodes>[0]['records'];
    expect(foundNodes({ records, from: new Map() })).toEqual([]);
  });
});
