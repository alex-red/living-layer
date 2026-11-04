/**
 * Desktop nodes (`apps/node`): found over mDNS like shared cameras, adopted
 * by pairing (the node hands this lab a token, kept in `settings`, never sent
 * to the page), and attached to the office's monitor as a Thing whose switch
 * is the node's display. Banners and pages go through `send`. Demo mode has
 * one virtual node and makes no network calls. Plan: docs/plans/desktop-node.md.
 */
import type { FastifyInstance } from 'fastify';
import {
  DEMO_DESKTOP_NODE,
  DESKTOP_NODE_SERVICE,
  dayOf,
  desktopNodeEntity,
  fixtureEntity,
  fixtureInput,
  nodesAdoptBodySchema,
  nodesCommandBodySchema,
  nodesForgetBodySchema,
  nodesLinkBodySchema,
  roomSceneOf,
  displayChoices,
  modeOnlySchema,
  promoteBuiltIn,
  type DeskMemory,
  type DesktopKind,
  type DesktopNodeCap,
  type DesktopNodeCommand,
  type DesktopNodeInfo,
  type DesktopNodeStatus,
  type DesktopNodeView,
  type LampResult,
  type Mode,
} from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import { saveFixture } from './fixture/save.js';
import { noteControl } from './fixture/control.js';
import type { RouteDeps } from './route-deps.js';
import type { EvidenceStore } from './store.js';
import type { Fetcher } from './config.js';
import { browseMdns, mdnsInstances } from './streams.js';

const KEY = 'desktop_nodes';
/** The office's monitor, which an adopted node's display becomes in the office. */
const MONITOR = { scene: 'office', group: 'monitor' } as const;

/** A node this lab adopted, as kept in `settings`. */
interface AdoptedNode {
  id: string;
  name: string;
  host: string;
  port: number;
  token: string;
  desktop: DesktopKind;
  caps: DesktopNodeCap[];
  adoptedAt: string;
}

/** A node heard over mDNS. */
export interface FoundNode {
  id: string;
  name: string;
  host: string;
  port: number;
  caps: DesktopNodeCap[];
}

/** How the server talks to a node; tests pass their own. Each call throws when the node doesn't answer. */
export interface NodeClient {
  info(host: string, port: number): Promise<DesktopNodeInfo>;
  pair(host: string, port: number, by: string): Promise<{ token: string }>;
  status(host: string, port: number, token: string): Promise<DesktopNodeStatus>;
  command(
    host: string,
    port: number,
    token: string,
    command: DesktopNodeCommand,
  ): Promise<DesktopNodeStatus>;
  unpair(host: string, port: number, token: string): Promise<void>;
}

const CAPS = new Set<string>(['display', 'open', 'banner']);

/** The nodes in what an mDNS browse heard, by the id in their TXT record. */
export function foundNodes(heard: Awaited<ReturnType<typeof browseMdns>>): FoundNode[] {
  return mdnsInstances(heard.records, DESKTOP_NODE_SERVICE, heard.from)
    .filter((i) => /^[\w-]{1,64}$/.test(i.text.id ?? ''))
    .map((i) => ({
      id: i.text.id!,
      name: (i.text.name || i.label).slice(0, 80),
      host: i.host,
      port: i.port,
      caps: (i.text.caps ?? '').split(',').filter((c): c is DesktopNodeCap => CAPS.has(c)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const browseNodes = async () => foundNodes(await browseMdns(DESKTOP_NODE_SERVICE));

/** The node's HTTP API with a short timeout: a LAN answers in milliseconds. */
export function httpNodeClient(fetcher: Fetcher = fetch, timeoutMs = 3000): NodeClient {
  async function call<T>(
    host: string,
    port: number,
    path: string,
    init: { token?: string; body?: unknown } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`http://${host}:${port}${path}`, {
        method: init.body === undefined ? 'GET' : 'POST',
        headers: {
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new LabError('node_unreachable', `The desktop at ${host}:${port} didn’t answer.`, 502);
    }
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status === 409)
      throw new LabError(
        'node_taken',
        'Another lab adopted that desktop. Run `living-layer-node unpair` on it first.',
        409,
      );
    if (response.status === 401)
      throw new LabError(
        'node_unpaired',
        'That desktop no longer knows this lab: forget it here and adopt it again.',
        409,
      );
    if (!response.ok)
      throw new LabError(
        'node_failed',
        data.error ?? `The desktop answered ${response.status}.`,
        502,
      );
    return data as T;
  }
  return {
    info: (host, port) => call(host, port, '/info'),
    pair: (host, port, by) => call(host, port, '/pair', { body: { by } }),
    status: (host, port, token) => call(host, port, '/status', { token }),
    command: async (host, port, token, command) =>
      (await call<{ status: DesktopNodeStatus }>(host, port, '/command', { token, body: command }))
        .status,
    unpair: async (host, port, token) => {
      await call(host, port, '/unpair', { token, body: {} });
    },
  };
}

export class DesktopNodes {
  /** What the virtual node was last sent. */
  private demo: DesktopNodeStatus = { display: null, last: null };
  /** The last browse, so adopting a node just listed needn't browse again. */
  private found = new Map<string, FoundNode>();

  constructor(
    private store: EvidenceStore,
    private client: NodeClient,
    private browse: () => Promise<FoundNode[]> = browseNodes,
    /** Who adopts, as the node shows it. */
    private by = 'Living Layer',
    private now: () => Date = () => new Date(),
  ) {}

  adopted(): AdoptedNode[] {
    try {
      return JSON.parse(this.store.setting(KEY) ?? '[]') as AdoptedNode[];
    } catch {
      return [];
    }
  }
  private write(nodes: AdoptedNode[]) {
    this.store.setSetting(KEY, JSON.stringify(nodes));
  }

  /** The display switches of a mode's nodes, for the entities rules and fixtures may name. */
  entities(mode: Mode): string[] {
    return mode === 'demo'
      ? [desktopNodeEntity(DEMO_DESKTOP_NODE.id)]
      : this.adopted().map((n) => desktopNodeEntity(n.id));
  }
  owns(mode: Mode, entity: string | undefined): entity is string {
    return Boolean(entity && this.entities(mode).includes(entity));
  }

  /** Sends a node a command; the virtual one only keeps it. */
  async send(mode: Mode, id: string, command: DesktopNodeCommand): Promise<DesktopNodeStatus> {
    if (mode === 'demo') {
      if (id !== DEMO_DESKTOP_NODE.id)
        throw new LabError('node_unknown', 'That desktop isn’t one this lab adopted.', 404);
      this.demo = {
        display: command.kind === 'display' ? command.to : this.demo.display,
        last: { kind: command.kind, at: this.now().toISOString(), ok: true },
      };
      return this.demo;
    }
    const node = this.adopted().find((n) => n.id === id);
    if (!node) throw new LabError('node_unknown', 'That desktop isn’t one this lab adopted.', 404);
    return this.client.command(node.host, node.port, node.token, command);
  }

  /** An adopted node's display as it says now, or null when it doesn't answer. */
  async display(mode: Mode, id: string): Promise<'on' | 'off' | null> {
    if (mode === 'demo') {
      if (id !== DEMO_DESKTOP_NODE.id)
        throw new LabError('node_unknown', 'That desktop isn’t one this lab adopted.', 404);
      return this.demo.display;
    }
    const node = this.adopted().find((n) => n.id === id);
    if (!node) throw new LabError('node_unknown', 'That desktop isn’t one this lab adopted.', 404);
    return (
      (await this.client.status(node.host, node.port, node.token).catch(() => null))?.display ??
      null
    );
  }

  /** Switches a node's display as an entity, answering like any light or switch. */
  async switchDisplay(mode: Mode, entity: string, action: 'on' | 'off'): Promise<LampResult> {
    const id =
      mode === 'demo'
        ? DEMO_DESKTOP_NODE.id
        : this.adopted().find((n) => desktopNodeEntity(n.id) === entity)?.id;
    if (!id) throw new LabError('lamp_unknown', 'That display is not an adopted desktop’s.', 409);
    const status = await this.send(mode, id, { kind: 'display', to: action });
    return {
      entityId: entity,
      action,
      accepted: true,
      stateConfirmed: status.display === action,
      physicalEffectVerified: false,
      state: status.display ?? 'unknown',
      desired: {},
      explanation:
        mode === 'demo'
          ? 'Virtual desktop only. Nothing was sent and no physical effect was verified.'
          : 'The desktop ran the command and reported the display state. It can’t see the screen, so look at it to be sure.',
    };
  }

  /** Every node this mode can see: adopted ones with their status, then ones found but not adopted. */
  async list(mode: Mode, memory: DeskMemory): Promise<DesktopNodeView[]> {
    const attached = (id: string) =>
      memory.fixtures?.find((f) => fixtureEntity(f) === desktopNodeEntity(id))?.id ?? null;
    if (mode === 'demo') {
      const fixtureId = attached(DEMO_DESKTOP_NODE.id);
      return [
        {
          ...DEMO_DESKTOP_NODE,
          caps: [...DEMO_DESKTOP_NODE.caps],
          address: 'virtual',
          adopted: fixtureId !== null,
          online: true,
          taken: false,
          entityId: desktopNodeEntity(DEMO_DESKTOP_NODE.id),
          fixtureId,
          status: this.demo,
        },
      ];
    }
    const adopted = this.adopted();
    const [found, statuses] = await Promise.all([
      this.browse(),
      Promise.all(
        adopted.map((n) =>
          this.client.status(n.host, n.port, n.token).catch((): DesktopNodeStatus | null => null),
        ),
      ),
    ]);
    this.found = new Map(found.map((f) => [f.id, f]));
    const ours = new Set(adopted.map((n) => n.id));
    const strangers = found.filter((f) => !ours.has(f.id));
    const infos = await Promise.all(
      strangers.map((f) => this.client.info(f.host, f.port).catch(() => null)),
    );
    // A node that moved to another address answers there: follow it.
    const moved = adopted.map((n) => {
      const seen = this.found.get(n.id);
      return seen && (seen.host !== n.host || seen.port !== n.port)
        ? { ...n, host: seen.host, port: seen.port }
        : n;
    });
    if (moved.some((n, i) => n !== adopted[i])) this.write(moved);
    return [
      ...adopted.map((n, i) => ({
        id: n.id,
        name: n.name,
        address: `${n.host}:${n.port}`,
        desktop: n.desktop,
        caps: n.caps,
        adopted: true,
        online: statuses[i] !== null,
        taken: false,
        entityId: desktopNodeEntity(n.id),
        fixtureId: attached(n.id),
        status: statuses[i] ?? null,
      })),
      ...strangers.map((f, i) => ({
        id: f.id,
        name: infos[i]?.name ?? f.name,
        address: `${f.host}:${f.port}`,
        desktop: infos[i]?.desktop ?? 'unknown',
        caps: infos[i]?.caps ?? f.caps,
        adopted: false,
        online: infos[i] !== null,
        taken: infos[i]?.adopted ?? false,
        entityId: desktopNodeEntity(f.id),
        fixtureId: null,
        status: null,
      })),
    ];
  }

  /**
   * Pairs with a node found over mDNS (by id) or at an address typed in, for
   * networks that block mDNS. Adopting one adopted already keeps it as it is.
   */
  async adopt(mode: Mode, at: { id?: string; host?: string; port?: number }): Promise<string> {
    if (mode === 'demo') {
      if (at.id && at.id !== DEMO_DESKTOP_NODE.id)
        throw new LabError('node_unknown', 'The demo has one desktop, the office’s.', 404);
      return DEMO_DESKTOP_NODE.id;
    }
    let where = at.host ? { host: at.host, port: at.port ?? 43440 } : this.found.get(at.id ?? '');
    if (!where && at.id) where = (await this.browse()).find((f) => f.id === at.id);
    if (!where) throw new LabError('node_unknown', 'That desktop isn’t on the network now.', 404);
    const info = await this.client.info(where.host, where.port);
    const nodes = this.adopted();
    const known = nodes.find((n) => n.id === info.id);
    if (known) return known.id;
    if (info.adopted)
      throw new LabError(
        'node_taken',
        'Another lab adopted that desktop. Run `living-layer-node unpair` on it first.',
        409,
      );
    const { token } = await this.client.pair(where.host, where.port, this.by);
    this.write([
      ...nodes,
      {
        id: info.id,
        name: info.name,
        host: where.host,
        port: where.port,
        token,
        desktop: info.desktop,
        caps: info.caps,
        adoptedAt: this.now().toISOString(),
      },
    ]);
    return info.id;
  }

  /** Lets a node go; it forgets this lab too when it can be reached. */
  async forget(mode: Mode, id: string): Promise<void> {
    if (mode === 'demo') return;
    const nodes = this.adopted();
    const node = nodes.find((n) => n.id === id);
    if (!node) throw new LabError('node_unknown', 'That desktop isn’t one this lab adopted.', 404);
    await this.client.unpair(node.host, node.port, node.token).catch(() => {});
    this.write(nodes.filter((n) => n.id !== id));
  }
}

/**
 * The node's display as a Thing: the one already on that switch, else the
 * first screen in the lab's own room left uncontrolled, else (in the office)
 * the office's monitor made a Thing. Null when the room has no screen: the
 * person links one from the Desktops panel.
 */
async function attach(
  deps: Pick<RouteDeps, 'store' | 'entities'>,
  mode: Mode,
  entityId: string,
  display: 'on' | 'off' | null,
): Promise<{ memory: DeskMemory; fixtureId: string | null }> {
  const memory = deps.store.memory(mode);
  const on = memory.fixtures?.find((f) => fixtureEntity(f) === entityId);
  if (on) return { memory, fixtureId: on.id };
  const screen = displayChoices(memory).screens.find((f) => f.control.kind === 'none');
  if (screen) return link(deps, mode, entityId, screen.id, display);
  if (roomSceneOf(memory) !== MONITOR.scene) return { memory, fixtureId: null };
  const monitor = memory.fixtures?.find(
    (f) => f.scene === MONITOR.scene && f.builtIn === MONITOR.group,
  );
  if (monitor) return link(deps, mode, entityId, monitor.id, display);
  const input = promoteBuiltIn(MONITOR.scene, MONITOR.group, dayOf(Date.now()));
  if (!input) throw new LabError('node_attach', 'The office has no monitor to attach it to.', 422);
  const saved = await saveFixture(deps, {
    mode,
    fixture: { ...input, control: { kind: 'switch', entityId } },
  });
  return lit(deps, mode, saved.fixtures!.at(-1)!.id, display);
}

/** The display switched by this Thing alone: any other Thing on it goes plain. */
async function link(
  deps: Pick<RouteDeps, 'store' | 'entities'>,
  mode: Mode,
  entityId: string,
  fixtureId: string,
  display: 'on' | 'off' | null,
): Promise<{ memory: DeskMemory; fixtureId: string }> {
  const thing = deps.store.memory(mode).fixtures?.find((f) => f.id === fixtureId);
  if (!thing) throw new LabError('fixture_unknown', 'That thing is not in this desk memory.', 404);
  await saveFixture(deps, {
    mode,
    fixture: { ...fixtureInput(thing), control: { kind: 'switch', entityId } },
  });
  deps.store.updateMemory(mode, (m) => {
    for (const f of m.fixtures ?? [])
      if (f.id !== fixtureId && fixtureEntity(f) === entityId) f.control = { kind: 'none' };
    return m;
  });
  return lit(deps, mode, fixtureId, display);
}

/** The Thing drawn as the display is: on when nobody knows yet. */
function lit(
  deps: Pick<RouteDeps, 'store'>,
  mode: Mode,
  fixtureId: string,
  display: 'on' | 'off' | null,
): { memory: DeskMemory; fixtureId: string } {
  const memory = deps.store.updateMemory(mode, (m) => {
    const f = m.fixtures?.find((x) => x.id === fixtureId);
    if (f) f.state = display ?? 'on';
    return m;
  });
  return { memory, fixtureId };
}

/** `/api/nodes`: list, adopt (and attach to the room's monitor), link another, forget, and send a command. */
export async function nodeRoutes(
  app: FastifyInstance,
  {
    nodes,
    store,
    entities,
    control,
  }: { nodes: DesktopNodes } & Pick<RouteDeps, 'store' | 'entities' | 'control'>,
) {
  const list = (mode: Mode) => nodes.list(mode, store.memory(mode));
  app.post('/list', async (request) => {
    const { mode } = parseInput(modeOnlySchema, request.body);
    return { nodes: await list(mode) };
  });
  app.post('/adopt', async (request) => {
    const { mode, ...at } = parseInput(nodesAdoptBodySchema, request.body);
    const id = await nodes.adopt(mode, at);
    const status = await nodes.send(mode, id, { kind: 'display', to: 'on' }).catch(() => null);
    const { memory, fixtureId } = await attach(
      { store, entities },
      mode,
      desktopNodeEntity(id),
      status?.display ?? null,
    );
    return { nodes: await list(mode), memory, fixtureId };
  });
  app.post('/link', async (request) => {
    const { mode, id, fixtureId } = parseInput(nodesLinkBodySchema, request.body);
    const display = await nodes.display(mode, id);
    const linked = await link({ store, entities }, mode, desktopNodeEntity(id), fixtureId, display);
    return { nodes: await list(mode), ...linked };
  });
  app.post('/forget', async (request) => {
    const { mode, id } = parseInput(nodesForgetBodySchema, request.body);
    await nodes.forget(mode, id);
    const entity = desktopNodeEntity(id);
    const memory = store.updateMemory(mode, (m) => {
      for (const f of m.fixtures ?? [])
        if (fixtureEntity(f) === entity) f.control = { kind: 'none' };
      return m;
    });
    return { nodes: await list(mode), memory };
  });
  app.post('/command', async (request) => {
    const { mode, id, command } = parseInput(nodesCommandBodySchema, request.body);
    if (command.kind === 'display') {
      // As an entity, so the monitor's Thing follows, as a switch's does.
      const lamp = await control(mode, desktopNodeEntity(id), command.to);
      const memory = store.updateMemory(mode, (m) => (noteControl(m, lamp), m));
      return { memory, lamp };
    }
    await nodes.send(mode, id, command);
    return { memory: store.memory(mode), lamp: null };
  });
}
