/**
 * The desktop node's wire types: what a node on a desktop (`apps/node`) says
 * about itself and the commands the server may send it. Shared by the node
 * and the server. Plan: docs/plans/desktop-node.md.
 */
import { z } from 'zod';

/** What a node advertises over mDNS. */
export const DESKTOP_NODE_SERVICE = '_livinglayer-node._tcp.local';
/** The port a node listens on unless told otherwise. */
export const DESKTOP_NODE_PORT = 43440;
/** The wire version in `/info` and the mDNS TXT record. */
export const DESKTOP_NODE_VERSION = 1;

export type DesktopNodeCap = 'display' | 'open' | 'banner';

/** The desktops a node knows how to drive. */
export type DesktopKind = 'kde' | 'gnome' | 'hyprland' | 'x11' | 'macos' | 'unknown';

const httpUrlSchema = z
  .string()
  .max(2048)
  .url()
  // Zod runs this even when `.url()` failed, so a half-typed `https://` must not throw here.
  .refine((u) => URL.canParse(u) && /^https?:$/.test(new URL(u).protocol), {
    message: 'Only http and https pages.',
  });

const openSchema = z
  .object({ kind: z.literal('open'), url: httpUrlSchema, kiosk: z.boolean().optional() })
  .strict();
const bannerSchema = z
  .object({
    kind: z.literal('banner'),
    title: z.string().trim().min(1).max(80),
    text: z.string().trim().max(400).optional(),
    seconds: z.number().int().min(1).max(120).optional(),
  })
  .strict();
/** What a zone step may send a node: the display is switched as an entity, by a `switch` step. */
export const desktopNodeMessageSchema = z.discriminatedUnion('kind', [openSchema, bannerSchema]);
export type DesktopNodeMessage = z.infer<typeof desktopNodeMessageSchema>;
export const desktopNodeCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('display'), to: z.enum(['on', 'off']) }).strict(),
  openSchema,
  bannerSchema,
]);
export type DesktopNodeCommand = z.infer<typeof desktopNodeCommandSchema>;

/** `GET /info`: open to anyone on the network. */
export interface DesktopNodeInfo {
  id: string;
  name: string;
  version: number;
  os: 'linux' | 'macos';
  desktop: DesktopKind;
  caps: DesktopNodeCap[];
  adopted: boolean;
}

/** `GET /status`: what the node last did. It can't read the display, only what it last set. */
export interface DesktopNodeStatus {
  display: 'on' | 'off' | null;
  last: { kind: DesktopNodeCommand['kind']; at: string; ok: boolean; error?: string } | null;
}

export const desktopNodePairSchema = z.object({ by: z.string().trim().min(1).max(80) }).strict();

/** A node's id as the server keeps it: what `/info` says, at most 64 characters. */
export const desktopNodeIdSchema = z.string().regex(/^[\w-]{1,64}$/);

/** The switch a node's display is, for fixtures, rules and Home Assistant. */
export function desktopNodeEntity(id: string): string {
  return `switch.node_${id
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12)}_display`;
}

/** Whether an entity is a desktop node's display, which needs no Home Assistant to switch. */
export const isDesktopNodeEntity = (entity: string) =>
  /^switch\.node_[a-z0-9]+_display$/.test(entity);

/** The node demo mode has: virtual, it makes no network calls and keeps what it was sent. */
export const DEMO_DESKTOP_NODE = {
  id: 'demo-desktop',
  name: 'Office desktop',
  desktop: 'kde',
  caps: ['display', 'open', 'banner'],
} as const satisfies Pick<DesktopNodeInfo, 'id' | 'name' | 'desktop' | 'caps'>;

/** A node as the lab shows it: found on the network, adopted, or both. Never its token. */
export interface DesktopNodeView {
  id: string;
  name: string;
  /** Where it answers, as `host:port`; `virtual` for the demo's. */
  address: string;
  desktop: DesktopKind;
  caps: DesktopNodeCap[];
  /** This lab holds its token. */
  adopted: boolean;
  /** Answered just now: on the network, or its status. */
  online: boolean;
  /** Adopted by another lab: it can't be adopted here until it is unpaired. */
  taken: boolean;
  entityId: string;
  /** The Thing its display is, once attached to a monitor. */
  fixtureId: string | null;
  status: DesktopNodeStatus | null;
}
